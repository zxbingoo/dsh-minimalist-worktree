import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { devNull } from 'node:os';
import path from 'node:path';
import { createGitReader, GitReadError, BRANCH_LIMIT } from '../git.js';

const PROJECT_ROOT = await realpath(new URL('../', import.meta.url));
const FIXTURE_PREFIX = '.mwt-git-fixture-';
const SELECTORS = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CEILING_DIRECTORIES',
  'GIT_PREFIX', 'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE', 'GIT_REPLACE_REF_BASE', 'GIT_ATTR_SOURCE',
];
const TEST_OPTIONS = { timeout: 20_000 };

async function fixture(t) {
  const root = await mkdtemp(path.join(PROJECT_ROOT, FIXTURE_PREFIX));
  const owner = randomUUID();
  await writeFile(path.join(root, '.fixture-owner'), owner);
  const running = new Set();
  // Every fixture belongs to this workspace; never use the user's checkout or shared /tmp.
  t.after(async () => {
    for (const child of running) child.terminate();
    await Promise.all([...running].map(child => child.done));
    const absolute = path.resolve(root);
    assert.equal(path.dirname(absolute), PROJECT_ROOT, 'cleanup must target this project only');
    assert.ok(path.basename(absolute).startsWith(FIXTURE_PREFIX));
    assert.equal(await realpath(absolute), absolute, 'cleanup must not follow a replacement symlink');
    const entry = await lstat(absolute);
    assert.ok(entry.isDirectory() && !entry.isSymbolicLink());
    assert.equal(await readFile(path.join(absolute, '.fixture-owner'), 'utf8'), owner);
    await rm(absolute, { recursive: true, force: false });
  });
  const home = path.join(root, 'home');
  await mkdir(home);
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const env = {
    ...inherited, HOME: home, XDG_CONFIG_HOME: home, LC_ALL: 'C',
    GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0',
    GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_PAGER: 'cat',
    GIT_AUTHOR_NAME: 'Minimalist Worktree Test', GIT_AUTHOR_EMAIL: 'worktree-test@example.invalid',
    GIT_COMMITTER_NAME: 'Minimalist Worktree Test', GIT_COMMITTER_EMAIL: 'worktree-test@example.invalid',
    GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
  };
  return { root, env, running };
}

function git(f, cwd, args, input = '') {
  return new Promise((resolve, reject) => {
    const child = execFile('git', ['--no-pager', '--no-optional-locks', '-c', `core.hooksPath=${devNull}`, ...args], {
      cwd, env: f.env, shell: false, encoding: 'utf8', timeout: 5_000,
      killSignal: 'SIGKILL', maxBuffer: 512 * 1024, windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(`Fixture Git failed: ${args.join(' ')}\n${stderr}`, { cause: error }));
      else resolve(stdout);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

async function repository(f, name = 'source repo; literal') {
  const cwd = path.join(f.root, name);
  await mkdir(cwd);
  await git(f, cwd, ['init', '--quiet']);
  await git(f, cwd, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  await writeFile(path.join(cwd, 'tracked.txt'), `Initial content for ${name}\n`);
  await git(f, cwd, ['add', '--', 'tracked.txt']);
  await git(f, cwd, ['commit', '--quiet', '-m', `Initial ${name}`]);
  const commit = (await git(f, cwd, ['rev-parse', 'HEAD'])).trim();
  return { cwd, commit };
}

function mergeEnv(base, overrides) {
  const env = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

function collector(stream, maxBytes) {
  let data = Buffer.alloc(0);
  let lossy = false;
  stream.on('data', chunk => {
    const room = Math.max(0, maxBytes - data.length);
    if (chunk.length > room) lossy = true;
    if (room) data = Buffer.concat([data, chunk.subarray(0, room)]);
  });
  return { readFrom(offset) { assert.equal(offset, 0); return { text: data.toString('utf8'), lossy }; } };
}

/** Minimal Session provider adapter; all processes use argv, never a shell. */
function adapter(f, options = {}) {
  const agent = { id: 'git-fixture-session', session: { id: 'git-fixture-session' } };
  const policy = { mode: options.mode ?? 'danger-full-access', writeRoots: [f.root] };
  const calls = [], confineCalls = [], policyCalls = [], fsCalls = [], requestedServices = [], executableCalls = [];
  const services = {
    sandboxPolicy: { resolve(value) { policyCalls.push(value); assert.equal(value.session, agent.session); return policy; } },
    sandbox: { async confine(argv, actualPolicy, signal) {
      assert.equal(actualPolicy, policy);
      signal.throwIfAborted();
      const confined = [argv[0], '-c', 'minimalist.testConfined=true', ...argv.slice(1)];
      confineCalls.push({ argv, policy: actualPolicy, signal, confined });
      if (options.deny) throw options.deny;
      return { argv: confined };
    } },
    fs: {
      async resolve(value, opts) {
        opts.signal.throwIfAborted();
        fsCalls.push({ value, ...opts });
        return { fixturePath: path.resolve(opts.cwd, value) };
      },
      processPath(value) { assert.equal(typeof value.fixturePath, 'string'); return value.fixturePath; },
    },
    subprocess: {
      async resolveExecutable(name, unused, signal) {
        assert.equal(name, 'git'); assert.equal(unused, undefined); signal.throwIfAborted();
        executableCalls.push({ name, signal });
        if (options.resolveError) throw options.resolveError;
        return 'git';
      },
      spawn(spec) {
        assert.ok(path.isAbsolute(spec.cwd));
        assert.ok(spec.cwd === f.root || spec.cwd.startsWith(`${f.root}${path.sep}`));
        assert.ok(spec.signal instanceof AbortSignal);
        assert.equal(spec.stdio.stdin, 'ignore');
        assert.equal(spec.graceMs, 1000);
        assert.equal(spec.stdio.stdout.maxBytes, 256 * 1024);
        assert.equal(spec.stdio.stderr.maxBytes, 8192);
        const entry = { spec, terminated: 0, waited: 0, closed: false };
        calls.push(entry);
        const child = spawn(spec.argv[0], spec.argv.slice(1), {
          cwd: spec.cwd,
          // Fixture-only boundary: a plain directory must never discover the user's ancestor checkout.
          env: { ...mergeEnv({ ...f.env, ...options.env }, spec.env), GIT_CEILING_DIRECTORIES: f.root },
          shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
          signal: spec.signal, timeout: 5_000, killSignal: 'SIGKILL',
        });
        const collected = { stdout: collector(child.stdout, spec.stdio.stdout.maxBytes), stderr: collector(child.stderr, spec.stdio.stderr.maxBytes) };
        child.on('error', error => { entry.error = error; });
        const done = new Promise(resolve => child.once('close', (exitCode, signal) => {
          entry.closed = true;
          f.running.delete(handle);
          resolve({ exitCode, signal });
        }));
        const handle = {
          done, collected,
          terminate() {
            entry.terminated += 1;
            if (!entry.closed) child.kill('SIGKILL');
          },
          async waitForExit() { entry.waited += 1; return done; },
        };
        f.running.add(handle);
        child.once('spawn', () => options.onSpawn?.({ child, entry }));
        return handle;
      },
    },
  };
  const reader = createGitReader((actualAgent, service) => {
    assert.equal(actualAgent, agent, 'all provider lookups remain in the same Session execution world');
    requestedServices.push(service);
    assert.ok(Object.hasOwn(services, service), `unexpected provider ${service}`);
    return services[service];
  });
  return { reader, agent, calls, confineCalls, policyCalls, fsCalls, requestedServices, executableCalls };
}

function assertReaped(calls) {
  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.ok(call.closed, 'subprocess exit must be observed');
    assert.equal(call.terminated, 1, 'reader always disposes each child');
    assert.equal(call.waited, 1, 'reader waits after disposal');
  }
}

test('inspect returns full local/remote refs and excludes symbolic origin/HEAD and tags', TEST_OPTIONS, async t => {
  const f = await fixture(t);
  const repo = await repository(f);
  await git(f, repo.cwd, ['branch', 'feature/slash']);
  await git(f, repo.cwd, ['update-ref', 'refs/remotes/origin/main', repo.commit]);
  await git(f, repo.cwd, ['update-ref', 'refs/remotes/origin/feature/slash', repo.commit]);
  await git(f, repo.cwd, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  await git(f, repo.cwd, ['tag', 'not-a-branch']);
  const nested = path.join(repo.cwd, 'nested directory');
  await mkdir(nested);
  const a = adapter(f);
  const value = await a.reader.inspect(a.agent, nested);
  assert.equal(value.kind, 'git');
  assert.equal(value.available, true);
  assert.equal(value.root, repo.cwd);
  assert.equal(value.branch, 'main');
  assert.equal(value.commit, repo.commit);
  assert.equal(value.reason, '');
  assert.equal(value.truncated, false);
  assert.deepEqual(value.branches, [
    { ref: 'refs/heads/feature/slash', label: 'feature/slash', kind: 'local' },
    { ref: 'refs/heads/main', label: 'main', kind: 'local' },
    { ref: 'refs/remotes/origin/feature/slash', label: 'origin/feature/slash', kind: 'remote' },
    { ref: 'refs/remotes/origin/main', label: 'origin/main', kind: 'remote' },
  ]);
  assert.equal(a.fsCalls.length, 1);
  assert.equal(a.fsCalls[0].cwd, nested);
  assert.equal(a.fsCalls[0].value, repo.cwd);
  assert.equal(a.confineCalls.length, 0, 'Full Access must not ask a sandbox adapter to confine');
  assert.ok(a.policyCalls.length === a.calls.length);
  assertReaped(a.calls);
});

test('detached HEAD remains available without inventing or switching a branch', TEST_OPTIONS, async t => {
  const f = await fixture(t);
  const repo = await repository(f);
  await git(f, repo.cwd, ['checkout', '--quiet', '--detach', repo.commit]);
  const before = await readFile(path.join(repo.cwd, '.git', 'HEAD'));
  const a = adapter(f);
  const value = await a.reader.inspect(a.agent, repo.cwd);
  assert.equal(value.kind, 'git');
  assert.equal(value.available, true);
  assert.equal(value.branch, '');
  assert.equal(value.commit, repo.commit);
  assert.ok(value.branches.some(branch => branch.ref === 'refs/heads/main'));
  assert.equal(await a.reader.resolveCommit(a.agent, repo.cwd, 'HEAD'), repo.commit);
  assert.deepEqual(await readFile(path.join(repo.cwd, '.git', 'HEAD')), before);
  assertReaped(a.calls);
});

test('plain nonrepository is confirmed none without reporting a normal folder as an error', TEST_OPTIONS, async t => {
  const f = await fixture(t);
  const nonrepo = path.join(f.root, 'not a repository');
  await mkdir(nonrepo);
  const a = adapter(f);
  const value = await a.reader.inspect(a.agent, nonrepo);
  assert.deepEqual(value, {
    kind: 'none', available: false, root: '', branch: '', commit: '',
    branches: [], truncated: false, reason: '',
  });
  assert.deepEqual(await readdir(nonrepo), [], 'plain nonrepository must not require a fake .git marker');
  assert.equal(a.calls.length, 1, 'a confirmed nonrepository needs only the initial probe');
  assert.equal(a.calls[0].spec.env.LC_ALL, 'C', 'classification must use stable Git diagnostics');
  await assert.rejects(a.reader.resolveCommit(a.agent, nonrepo, 'HEAD'), error => {
    assert.ok(error instanceof GitReadError);
    assert.equal(error.exitCode, 128);
    assert.match(error.stderr, /fatal: not a git repository/);
    return true;
  });
  assertReaped(a.calls);
});

test('unborn repository remains git even though a worktree needs its first commit', TEST_OPTIONS, async t => {
  const f = await fixture(t);
  const unborn = path.join(f.root, 'unborn');
  await mkdir(unborn);
  await git(f, unborn, ['init', '--quiet']);
  await git(f, unborn, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  const a = adapter(f);
  const empty = await a.reader.inspect(a.agent, unborn);
  assert.equal(empty.kind, 'git');
  assert.equal(empty.available, false);
  assert.equal(empty.root, unborn);
  assert.equal(empty.branch, 'main');
  assert.equal(empty.commit, '');
  assert.deepEqual(empty.branches, []);
  assert.equal(empty.truncated, false);
  assert.match(empty.reason, /first commit|HEAD commit/);
  await assert.rejects(a.reader.resolveCommit(a.agent, unborn, 'HEAD'), GitReadError);
  assertReaped(a.calls);
});

test('general Git probe failure is unknown rather than a confirmed nonrepository', TEST_OPTIONS, async t => {
  const f = await fixture(t);
  const broken = path.join(f.root, 'invalid gitfile');
  await mkdir(broken);
  await writeFile(path.join(broken, '.git'), 'not a valid gitdir file\n');
  const a = adapter(f);
  const value = await a.reader.inspect(a.agent, broken);
  assert.equal(value.kind, 'unknown');
  assert.equal(value.available, false);
  assert.equal(value.root, '');
  assert.deepEqual(value.branches, []);
  assert.match(value.reason, /Git inspection failed.*invalid gitfile format/);
  assert.equal(a.calls.length, 1);
  assertReaped(a.calls);
});

test('GitReadError preserves structured stderr separately from its message', () => {
  const message = 'Fixture probe failed';
  const stderr = 'fatal: not a git repository (or any of the parent directories): .git\n';
  const error = new GitReadError(message, 128, stderr);
  assert.equal(error.message, message);
  assert.equal(error.exitCode, 128);
  assert.equal(error.stderr, stderr);
  assert.equal(new GitReadError(message, 128).stderr, '');
});

test('revisions are literal argv, including option-like invalid refs, with early input validation', TEST_OPTIONS, async t => {
  const f = await fixture(t);
  const repo = await repository(f);
  await git(f, repo.cwd, ['branch', 'feature/base']);
  await git(f, repo.cwd, ['update-ref', 'refs/remotes/origin/base', repo.commit]);
  await git(f, repo.cwd, ['tag', 'v1']);
  const a = adapter(f);
  for (const from of ['HEAD', 'HEAD~0', 'refs/heads/feature/base', 'refs/remotes/origin/base', 'refs/tags/v1', repo.commit]) {
    assert.equal(await a.reader.resolveCommit(a.agent, repo.cwd, from), repo.commit);
    assert.deepEqual(a.calls.at(-1).spec.argv.slice(-4), ['rev-parse', '--verify', '--end-of-options', `${from}^{commit}`]);
  }
  const marker = path.join(f.root, 'must-not-be-created');
  for (const from of ['--help', `--output=${marker}`, `HEAD; touch ${marker}`, `$(touch ${marker})`]) {
    await assert.rejects(a.reader.resolveCommit(a.agent, repo.cwd, from), GitReadError);
    assert.deepEqual(a.calls.at(-1).spec.argv.slice(-4), ['rev-parse', '--verify', '--end-of-options', `${from}^{commit}`]);
  }
  await assert.rejects(lstat(marker), { code: 'ENOENT' });
  const count = a.calls.length;
  for (const from of [undefined, null, 0, '', 'bad\0ref', 'x'.repeat(1025)]) {
    await assert.rejects(a.reader.resolveCommit(a.agent, repo.cwd, from), { name: 'TypeError', message: 'Invalid Git revision.' });
  }
  assert.equal(a.calls.length, count, 'invalid revisions must never launch Git');
  assertReaped(a.calls);
});

test('resolved commit stays pinned when its source branch moves later', TEST_OPTIONS, async t => {
  const f = await fixture(t);
  const repo = await repository(f);
  await git(f, repo.cwd, ['branch', 'base']);
  const a = adapter(f);
  const pinned = await a.reader.resolveCommit(a.agent, repo.cwd, 'refs/heads/base');
  const tree = (await git(f, repo.cwd, ['rev-parse', `${repo.commit}^{tree}`])).trim();
  const moved = (await git(f, repo.cwd, ['commit-tree', tree, '-p', repo.commit, '-m', 'Move base without checking it out'])).trim();
  assert.notEqual(moved, pinned);
  await git(f, repo.cwd, ['update-ref', 'refs/heads/base', moved]);
  assert.equal(await a.reader.resolveCommit(a.agent, repo.cwd, 'refs/heads/base'), moved);
  assert.equal(await a.reader.resolveCommit(a.agent, repo.cwd, pinned), repo.commit);
  assert.equal((await git(f, repo.cwd, ['rev-parse', 'HEAD'])).trim(), repo.commit);
  assert.equal((await git(f, repo.cwd, ['symbolic-ref', '--short', 'HEAD'])).trim(), 'main');
  assertReaped(a.calls);
});

test('inspection never changes tracked, staged, untracked files, source HEAD, or index', TEST_OPTIONS, async t => {
  const f = await fixture(t);
  const repo = await repository(f);
  await writeFile(path.join(repo.cwd, 'tracked.txt'), 'Staged content\n');
  await git(f, repo.cwd, ['add', '--', 'tracked.txt']);
  await writeFile(path.join(repo.cwd, 'tracked.txt'), 'Staged content\nUnstaged content\n');
  const untracked = path.join(repo.cwd, 'untracked notes; literal.txt');
  await writeFile(untracked, 'Must remain byte-for-byte unchanged.\n');
  async function sourceState() {
    return {
      tracked: await readFile(path.join(repo.cwd, 'tracked.txt')),
      untracked: await readFile(untracked),
      head: await readFile(path.join(repo.cwd, '.git', 'HEAD')),
      index: await readFile(path.join(repo.cwd, '.git', 'index')),
      entries: (await readdir(repo.cwd)).sort(),
      status: await git(f, repo.cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
      refs: await git(f, repo.cwd, ['show-ref', '--head']),
    };
  }
  const before = await sourceState();
  const a = adapter(f);
  assert.equal((await a.reader.inspect(a.agent, repo.cwd)).available, true);
  assert.equal(await a.reader.resolveCommit(a.agent, repo.cwd, 'refs/heads/main'), repo.commit);
  await assert.rejects(a.reader.resolveCommit(a.agent, repo.cwd, '--not-a-ref'), GitReadError);
  assert.deepEqual(await sourceState(), before);
  for (const { spec } of a.calls) {
    assert.ok(spec.argv.includes('core.hooksPath=/dev/null'));
    assert.ok(spec.argv.includes('core.fsmonitor=false'));
    assert.equal(spec.env.GIT_OPTIONAL_LOCKS, '0');
    assert.equal(spec.env.GIT_NO_LAZY_FETCH, '1');
    assert.equal(spec.env.GIT_TERMINAL_PROMPT, '0');
  }
  assertReaped(a.calls);
});

test('Git selector environment is cleared and restricted policy/FS adapters receive Session paths', TEST_OPTIONS, async t => {
  const f = await fixture(t);
  const repo = await repository(f);
  const decoy = await repository(f, 'decoy repository');
  assert.notEqual(repo.commit, decoy.commit);
  const poison = Object.fromEntries(SELECTORS.map(key => [key, path.join(decoy.cwd, 'poison-selector')]));
  Object.assign(poison, { GIT_DIR: path.join(decoy.cwd, '.git'), GIT_WORK_TREE: decoy.cwd,
    GIT_CONFIG_PARAMETERS: 'malformed config that must not reach Git', GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.bare', GIT_CONFIG_VALUE_0: 'true' });
  const a = adapter(f, { env: poison, mode: 'workspace-write' });
  const value = await a.reader.inspect(a.agent, repo.cwd);
  assert.equal(value.kind, 'git');
  assert.equal(value.available, true);
  assert.equal(value.root, repo.cwd);
  assert.equal(value.commit, repo.commit);
  assert.equal(a.confineCalls.length, a.calls.length);
  assert.equal(a.policyCalls.length, a.calls.length);
  for (let i = 0; i < a.calls.length; i += 1) {
    const { spec } = a.calls[i];
    assert.equal(spec.argv, a.confineCalls[i].confined, 'spawn must use the confinement result, not the original argv');
    assert.equal(spec.cwd, repo.cwd);
    assert.equal(a.confineCalls[i].signal, spec.signal);
    assert.equal(a.confineCalls[i].policy.mode, 'workspace-write');
    for (const key of SELECTORS) {
      assert.ok(Object.hasOwn(spec.env, key), `${key} must explicitly unset an inherited selector`);
      assert.equal(spec.env[key], undefined);
    }
    assert.equal(spec.env.GIT_CONFIG_COUNT, '0');
  }
  assert.equal(a.fsCalls[0].cwd, repo.cwd);
  assertReaped(a.calls);
});

test('sandbox denial is not retried outside the policy boundary', TEST_OPTIONS, async t => {
  const f = await fixture(t);
  const repo = await repository(f);
  const denial = new Error('fixture policy denied Git inspection');
  const a = adapter(f, { mode: 'workspace-write', deny: denial });
  const value = await a.reader.inspect(a.agent, repo.cwd);
  assert.equal(value.kind, 'unknown');
  assert.equal(value.available, false);
  assert.equal(value.reason, denial.message);
  await assert.rejects(a.reader.resolveCommit(a.agent, repo.cwd, 'HEAD'), error => error === denial);
  assert.equal(a.confineCalls.length, 2);
  assert.equal(a.calls.length, 0);
});

test('missing Git executable is unknown and never treated as a confirmed nonrepository', TEST_OPTIONS, async t => {
  const f = await fixture(t);
  const missing = Object.assign(new Error('fixture Git executable not found'), { code: 'ENOENT' });
  const a = adapter(f, { resolveError: missing });
  const value = await a.reader.inspect(a.agent, f.root);
  assert.deepEqual(value, {
    kind: 'unknown', available: false, root: '', branch: '', commit: '',
    branches: [], truncated: false, reason: missing.message,
  });
  assert.equal(a.executableCalls.length, 1);
  await assert.rejects(a.reader.resolveCommit(a.agent, f.root, 'HEAD'), error => error === missing);
  assert.equal(a.executableCalls.length, 2);
  assert.equal(a.confineCalls.length, 0);
  assert.equal(a.calls.length, 0, 'lookup failure must not launch a fallback process');
});

test('caller cancellation propagates before launch and during a real Git process, with child cleanup', TEST_OPTIONS, async t => {
  const f = await fixture(t);
  const repo = await repository(f);
  const aborted = new AbortController();
  const reason = new Error('fixture pre-cancelled');
  aborted.abort(reason);
  const initial = adapter(f);
  await assert.rejects(initial.reader.inspect(initial.agent, repo.cwd, aborted.signal), error => error === reason);
  await assert.rejects(initial.reader.resolveCommit(initial.agent, repo.cwd, 'HEAD', aborted.signal), error => error === reason);
  assert.equal(initial.requestedServices.length, 0);
  for (const action of ['inspect', 'resolveCommit']) {
    const controller = new AbortController();
    const stop = new Error(`fixture cancelled ${action} on native spawn`);
    const a = adapter(f, { onSpawn: () => controller.abort(stop) });
    const pending = action === 'inspect' ? a.reader.inspect(a.agent, repo.cwd, controller.signal)
      : a.reader.resolveCommit(a.agent, repo.cwd, 'HEAD', controller.signal);
    await assert.rejects(pending, error => error === stop);
    assert.equal(a.calls.length, 1, 'cancellation must stop subsequent inspection commands');
    assert.ok(a.calls[0].spec.signal.aborted);
    assert.equal(f.running.size, 0);
    assertReaped(a.calls);
  }
});

test('branch enumeration is bounded and reports truncation', TEST_OPTIONS, async t => {
  const f = await fixture(t);
  const repo = await repository(f);
  const commands = Array.from({ length: BRANCH_LIMIT + 2 }, (_, i) =>
    `update refs/heads/many/${String(i).padStart(4, '0')} ${repo.commit}\n`).join('');
  await git(f, repo.cwd, ['update-ref', '--stdin'], commands);
  const a = adapter(f);
  const value = await a.reader.inspect(a.agent, repo.cwd);
  assert.equal(value.kind, 'git');
  assert.equal(value.available, true);
  assert.equal(value.branches.length, BRANCH_LIMIT);
  assert.equal(value.truncated, true);
  const enumeration = a.calls.find(({ spec }) => spec.argv.includes('for-each-ref'));
  assert.ok(enumeration.spec.argv.includes(`--count=${BRANCH_LIMIT + 1}`));
  assertReaped(a.calls);
});
