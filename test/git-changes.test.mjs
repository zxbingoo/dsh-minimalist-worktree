import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, stat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { devNull } from 'node:os';
import path from 'node:path';
import { createChangesReader, CHANGE_FILE_LIMIT, CHANGE_OUTPUT_LIMIT, PATCH_BYTE_LIMIT, PATCH_LINE_LIMIT } from '../git-changes.js';

const ROOT = await realpath(new URL('../', import.meta.url));
const PREFIX = '.mwt-changes-fixture-';
const check = (name, run) => test(name, { timeout: 30000 }, run);

async function fixture(t) {
  const root = await mkdtemp(path.join(ROOT, PREFIX)), owner = randomUUID(), running = new Set();
  await writeFile(path.join(root, '.owner'), owner);
  const home = path.join(root, 'home');
  await mkdir(home);
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    HOME: home, XDG_CONFIG_HOME: home, LC_ALL: 'C',
    GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0',
    GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_PAGER: 'cat',
    GIT_AUTHOR_NAME: 'Changes Test', GIT_AUTHOR_EMAIL: 'changes@example.invalid',
    GIT_COMMITTER_NAME: 'Changes Test', GIT_COMMITTER_EMAIL: 'changes@example.invalid',
    GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
  };
  t.after(async () => {
    for (const child of running) child.terminate();
    await Promise.all([...running].map(child => child.done));
    const absolute = path.resolve(root);
    assert.equal(path.dirname(absolute), ROOT);
    assert.ok(path.basename(absolute).startsWith(PREFIX));
    assert.equal(await realpath(absolute), absolute);
    assert.ok((await lstat(absolute)).isDirectory());
    assert.equal(await readFile(path.join(absolute, '.owner'), 'utf8'), owner);
    await rm(absolute, { recursive: true, force: false });
  });
  return { root, env, running };
}

function git(f, cwd, args, input = '', expected = 0) {
  return new Promise((resolve, reject) => {
    const child = execFile('git', ['--no-pager', '--no-optional-locks', '--literal-pathspecs', '-c', `core.hooksPath=${devNull}`, ...args], {
      cwd, env: f.env, shell: false, encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if ((error?.code ?? 0) !== expected) reject(new Error(`Fixture Git ${args.join(' ')} failed: ${stderr}`, { cause: error }));
      else resolve(stdout);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
async function repo(f, options = {}) {
  const cwd = path.join(f.root, options.name ?? 'repo with spaces; literal');
  await mkdir(cwd);
  await git(f, cwd, ['init', '--quiet', ...(options.sha256 ? ['--object-format=sha256'] : [])]);
  await git(f, cwd, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  if (!options.unborn) {
    await writeFile(path.join(cwd, 'tracked.txt'), 'before\nstable\n');
    await git(f, cwd, ['add', '--', 'tracked.txt']);
    await git(f, cwd, ['commit', '--quiet', '-m', 'base']);
  }
  return cwd;
}
function collect(stream, cap) {
  let bytes = Buffer.alloc(0), lossy = false;
  stream.on('data', chunk => {
    const room = Math.max(0, cap - bytes.length);
    if (chunk.length > room) lossy = true;
    if (room) bytes = Buffer.concat([bytes, chunk.subarray(0, room)]);
  });
  return { readFrom: () => ({ text: bytes.toString('utf8'), lossy }) };
}
function info(value, isLstat = false) {
  return {
    type: isLstat && value.isSymbolicLink() ? 'symlink' : value.isFile() ? 'file' : value.isDirectory() ? 'directory' : 'other',
    size: Number(value.size), version: [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(':'),
  };
}
function adapter(f, t, options = {}) {
  const agent = { id: 'changes-session', session: { id: 'changes-session' } }, calls = [], reads = [], confined = [];
  const services = {
    sandboxPolicy: { resolve: value => { assert.equal(value.session, agent.session); return { mode: options.mode ?? 'danger-full-access', workspaceRoot: f.root }; } },
    sandbox: { async confine(argv, policy, signal) {
      signal.throwIfAborted(); confined.push({ argv, policy });
      if (options.deny) throw options.deny;
      return { argv };
    } },
    fs: {
      async resolve(value, opts = {}) {
        opts.signal?.throwIfAborted();
        return { fixturePath: await realpath(path.resolve(opts.cwd ?? f.root, value)) };
      },
      processPath: target => target.fixturePath,
      contains(parent, child) { const relative = path.relative(parent.fixturePath, child.fixturePath); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); },
      async lstat(value, opts = {}, signal) {
        signal?.throwIfAborted();
        try { return info(await lstat(path.resolve(opts.cwd ?? f.root, value), { bigint: true }), true); }
        catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
      },
      async stat(target, signal) { signal?.throwIfAborted(); return info(await stat(target.fixturePath, { bigint: true })); },
      async readBytes(target, signal, cap) {
        signal?.throwIfAborted(); reads.push(target.fixturePath);
        const size = (await stat(target.fixturePath)).size;
        if (size > cap) throw Object.assign(new Error('bounded read exceeded'), { code: 'FS_TOO_LARGE' });
        const data = await readFile(target.fixturePath);
        if (data.length > cap) throw Object.assign(new Error('bounded read exceeded'), { code: 'FS_TOO_LARGE' });
        await options.afterRead?.(target);
        return data;
      },
    },
    subprocess: {
      async resolveExecutable(name, unused, signal) { assert.equal(name, 'git'); assert.equal(unused, undefined); signal.throwIfAborted(); if (options.resolveError) throw options.resolveError; return 'git'; },
      spawn(spec) {
        assert.ok(spec.cwd.startsWith(`${f.root}${path.sep}`));
        assert.equal(spec.stdio.stdin, 'ignore'); assert.equal(spec.graceMs, 1000);
        assert.ok([CHANGE_OUTPUT_LIMIT, PATCH_BYTE_LIMIT].includes(spec.stdio.stdout.maxBytes));
        const entry = { spec, terminated: 0, waited: 0, closed: false }; calls.push(entry);
        const mocked = options.mock?.(spec);
        if (mocked) {
          entry.closed = true;
          return {
            done: Promise.resolve({ exitCode: mocked.exitCode ?? 0, signal: null }),
            collected: { stdout: { readFrom: () => ({ text: mocked.text ?? '', lossy: mocked.lossy ?? false }) }, stderr: { readFrom: () => ({ text: mocked.stderr ?? '', lossy: false }) } },
            terminate() { entry.terminated++; }, async waitForExit() { entry.waited++; },
          };
        }
        const env = { ...f.env, ...options.env };
        for (const [key, value] of Object.entries(spec.env)) { if (value === undefined) delete env[key]; else env[key] = value; }
        env.GIT_CEILING_DIRECTORIES = f.root; // A plain fixture must not discover the user's ancestor checkout.
        const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'], signal: spec.signal, timeout: 10000, killSignal: 'SIGKILL' });
        const collected = { stdout: collect(child.stdout, spec.stdio.stdout.maxBytes), stderr: collect(child.stderr, spec.stdio.stderr.maxBytes) };
        child.on('error', error => { entry.error = error; });
        const done = new Promise(resolve => child.once('close', (exitCode, signal) => { entry.closed = true; f.running.delete(handle); resolve({ exitCode, signal }); }));
        const handle = { done, collected, terminate() { entry.terminated++; if (!entry.closed) child.kill('SIGKILL'); }, async waitForExit() { entry.waited++; return done; } };
        f.running.add(handle);
        child.once('spawn', () => options.onSpawn?.(spec, child));
        return handle;
      },
    },
  };
  const reader = createChangesReader((actual, key) => { assert.equal(actual, agent); assert.ok(Object.hasOwn(services, key), key); return services[key]; });
  t.after(() => { for (const call of calls) { assert.equal(call.closed, true); assert.equal(call.terminated, 1); assert.equal(call.waited, 1); } });
  return { agent, reader, calls, reads, confined, services, summary: (cwd, scope = 'all', signal) => reader.summary(agent, cwd, scope, signal), diff: (cwd, path, scope = 'all', signal) => reader.diff(agent, cwd, scope, path, signal) };
}

check('mixed staged and working changes use distinct scopes, read-only net totals, and lazy untracked reads', async t => {
  const f = await fixture(t), cwd = await repo(f);
  await writeFile(path.join(cwd, 'tracked.txt'), 'staged\nstable\n');
  await git(f, cwd, ['add', '--', 'tracked.txt']);
  await writeFile(path.join(cwd, 'tracked.txt'), 'after\nstable\nextra\n');
  await writeFile(path.join(cwd, 'new.txt'), 'untracked\n');
  const head = await readFile(path.join(cwd, '.git/HEAD')), index = await readFile(path.join(cwd, '.git/index'));
  const a = adapter(f, t), all = await a.summary(cwd), staged = await a.summary(cwd, 'staged'), unstaged = await a.summary(cwd, 'unstaged');
  assert.equal(all.repository.kind, 'git'); assert.equal(all.repository.branch, 'main');
  assert.deepEqual([all.added, all.deleted], [2, 1]); assert.equal(all.untracked, 1); assert.equal(all.limited, true);
  assert.deepEqual([staged.added, staged.deleted, staged.untracked, staged.limited], [1, 1, 0, false]);
  assert.deepEqual([unstaged.added, unstaged.deleted], [2, 1]); assert.equal(a.reads.length, 0);
  assert.equal(all.files.find(file => file.path === 'new.txt').added, null);
  const patch = await a.diff(cwd, 'tracked.txt'); assert.equal(patch.kind, 'text'); assert.match(patch.patch, /\+after/); assert.doesNotMatch(patch.patch, /\+staged/);
  assert.match((await a.diff(cwd, 'tracked.txt', 'staged')).patch, /\+staged/);
  assert.deepEqual(await readFile(path.join(cwd, '.git/HEAD')), head); assert.deepEqual(await readFile(path.join(cwd, '.git/index')), index);
});
check('all shows net HEAD-to-disk changes, not the sum of opposing staged and unstaged changes', async t => {
  const f = await fixture(t), cwd = await repo(f), a = adapter(f, t);
  await writeFile(path.join(cwd, 'tracked.txt'), 'staged\nstable\n'); await git(f, cwd, ['add', '--', 'tracked.txt']);
  await writeFile(path.join(cwd, 'tracked.txt'), 'before\nstable\n');
  assert.equal((await a.summary(cwd)).files.length, 0); assert.equal((await a.summary(cwd, 'staged')).files.length, 1); assert.equal((await a.summary(cwd, 'unstaged')).files.length, 1);
});
check('unborn SHA1 and SHA256 repositories support all three scopes without creating objects for inspection', async t => {
  const f = await fixture(t), a = adapter(f, t);
  for (const sha256 of [false, true]) {
    const cwd = await repo(f, { unborn: true, sha256, name: sha256 ? 'unborn256' : 'unborn1' });
    await writeFile(path.join(cwd, 'added.txt'), 'new\n'); await git(f, cwd, ['add', '--', 'added.txt']);
    const index = await readFile(path.join(cwd, '.git/index'));
    for (const scope of ['all', 'staged', 'unstaged']) {
      const value = await a.summary(cwd, scope); assert.equal(value.repository.kind, 'git', value.reason); assert.equal(value.repository.unborn, true); assert.equal(value.reason, '');
      assert.equal(value.files.length, scope === 'unstaged' ? 0 : 1);
    }
    assert.equal((await a.diff(cwd, 'added.txt')).kind, 'text'); assert.deepEqual(await readFile(path.join(cwd, '.git/index')), index);
  }
});
check('only ordinary non-Git directories are none; broken repositories, denied sandboxes and missing Git remain errors', async t => {
  const f = await fixture(t), plain = path.join(f.root, 'plain'), broken = path.join(f.root, 'broken'); await mkdir(plain); await mkdir(broken);
  await writeFile(path.join(broken, '.git'), 'gitdir: /missing/invalid-git-dir\n');
  const a = adapter(f, t); const none = await a.summary(plain); assert.equal(none.repository.kind, 'none'); assert.equal(none.limited, false); assert.equal(none.reason, '');
  const bad = await a.summary(broken); assert.equal(bad.repository.kind, 'unknown'); assert.equal(bad.limited, true); assert.ok(bad.reason);
  const b = adapter(f, t, { mode: 'read-only', deny: new Error('sandbox denied') }); assert.match((await b.summary(plain)).reason, /sandbox denied/); assert.equal(b.calls.length, 0);
  const c = adapter(f, t, { resolveError: new Error('Git missing') }); assert.match((await c.summary(plain)).reason, /Git missing/); assert.equal(c.calls.length, 0);
});
check('nested cwd includes repository-wide paths while linked worktrees stay isolated', async t => {
  const f = await fixture(t), cwd = await repo(f), linked = path.join(f.root, 'linked'), nested = path.join(cwd, 'nested'); await mkdir(nested);
  await git(f, cwd, ['worktree', 'add', '--quiet', '-b', 'dsh/calm-otter', linked]);
  await writeFile(path.join(cwd, 'tracked.txt'), 'source only\n'); await writeFile(path.join(linked, 'tracked.txt'), 'linked only\n');
  const a = adapter(f, t), source = await a.summary(nested), isolated = await a.summary(linked);
  assert.equal(source.repository.root, cwd); assert.equal(isolated.repository.root, linked); assert.equal(isolated.repository.branch, 'dsh/calm-otter');
  assert.match((await a.diff(nested, 'tracked.txt')).patch, /\+source only/); assert.match((await a.diff(linked, 'tracked.txt')).patch, /\+linked only/);
});
check('renames, deletions, tabs, newlines, Unicode and option-like names are literal exact paths', async t => {
  const f = await fixture(t), cwd = await repo(f), a = adapter(f, t);
  const names = ['-option.txt', ':(glob)*.txt', 'tab\tline\n名.txt'];
  for (const name of names) await writeFile(path.join(cwd, name), 'literal before\n');
  await git(f, cwd, ['add', '--', ...names]); await git(f, cwd, ['commit', '--quiet', '-m', 'names']);
  await git(f, cwd, ['mv', '--', 'tracked.txt', 'renamed.txt']);
  await writeFile(path.join(cwd, names[0]), 'literal after\n');
  await writeFile(path.join(cwd, names[1]), 'glob after\n');
  await writeFile(path.join(cwd, names[2]), 'unicode after\n');
  const value = await a.summary(cwd); assert.equal(value.reason, '');
  const renamed = value.files.find(file => file.path === 'renamed.txt'); assert.equal(renamed.status, 'R'); assert.equal(renamed.oldPath, 'tracked.txt');
  assert.equal((await a.diff(cwd, 'renamed.txt')).kind, 'text');
  for (const name of names) { assert.ok(value.files.some(file => file.path === name)); assert.equal((await a.diff(cwd, name)).kind, 'text'); }
  assert.equal((await a.diff(cwd, ':')).kind, 'missing'); assert.equal((await a.diff(cwd, '.')).kind, 'unavailable'); assert.equal((await a.diff(cwd, '../outside')).kind, 'unavailable');
  await git(f, cwd, ['commit', '--quiet', '-m', 'rename']);
  const deleting = path.resolve(cwd, 'renamed.txt'); assert.equal(path.dirname(deleting), cwd); assert.ok(cwd.startsWith(`${f.root}${path.sep}`));
  await git(f, cwd, ['rm', '--', 'renamed.txt']); const deletion = await a.summary(cwd, 'staged'); assert.ok(deletion.files.some(file => file.status === 'D'));
});
check('untracked text is lazy and bounded; empty, binary, invalid UTF8 and large files have explicit outcomes', async t => {
  const f = await fixture(t), cwd = await repo(f), a = adapter(f, t);
  const files = { 'new.txt': 'hello\nlast', 'empty.txt': '', 'binary': Buffer.from([1, 0, 2]), 'invalid': Buffer.from([0xff, 0xfe]), 'large': 'x'.repeat(PATCH_BYTE_LIMIT + 1), 'lines': 'x\n'.repeat(PATCH_LINE_LIMIT + 1) };
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(cwd, name), content);
  await a.summary(cwd); assert.equal(a.reads.length, 0);
  const text = await a.diff(cwd, 'new.txt'); assert.equal(text.kind, 'text', text.reason); assert.match(text.patch, /\+hello/); assert.match(text.patch, /No newline at end of file/);
  assert.equal((await a.diff(cwd, 'empty.txt')).kind, 'text');
  for (const name of ['binary', 'invalid']) assert.equal((await a.diff(cwd, name)).kind, 'binary');
  for (const name of ['large', 'lines']) { const value = await a.diff(cwd, name); assert.equal(value.kind, 'oversized', value.reason); assert.equal(value.patch, ''); }
  assert.ok(!a.reads.some(file => file.endsWith('/large')));
});
check('untracked symlinks and nested repositories are not followed or traversed', async t => {
  const f = await fixture(t), cwd = await repo(f), outside = path.join(f.root, 'outside'); await writeFile(outside, 'outside secret\n');
  await symlink(outside, path.join(cwd, 'link')); const nested = path.join(cwd, 'nested-repo'); await mkdir(nested); await git(f, nested, ['init', '--quiet']);
  await writeFile(path.join(nested, 'private.txt'), 'nested secret\n');
  const a = adapter(f, t), link = await a.diff(cwd, 'link'); assert.equal(link.kind, 'unavailable'); assert.equal(link.patch, '');
  assert.equal((await a.diff(cwd, 'nested-repo')).kind, 'submodule'); assert.equal((await a.diff(cwd, 'nested-repo/private.txt')).kind, 'missing'); assert.equal(a.reads.length, 0);
});
check('changed untracked file versions are revalidated after reading', async t => {
  const f = await fixture(t), cwd = await repo(f); await writeFile(path.join(cwd, 'moving.txt'), 'before\n');
  const a = adapter(f, t, { afterRead: target => writeFile(target.fixturePath, 'after content of a different length\n') });
  const value = await a.diff(cwd, 'moving.txt'); assert.equal(value.kind, 'unavailable'); assert.equal(value.patch, ''); assert.match(value.reason, /moved/);
});
check('tracked binary patches and oversized patches are not returned as partial text', async t => {
  const f = await fixture(t), cwd = await repo(f), a = adapter(f, t);
  await writeFile(path.join(cwd, 'blob'), Buffer.from([0, 1])); await git(f, cwd, ['add', '--', 'blob']); await git(f, cwd, ['commit', '--quiet', '-m', 'binary']);
  await writeFile(path.join(cwd, 'blob'), Buffer.from([0, 2])); assert.equal((await a.diff(cwd, 'blob')).kind, 'binary');
  await writeFile(path.join(cwd, 'tracked.txt'), 'x'.repeat(PATCH_BYTE_LIMIT + 1)); const bytes = await a.diff(cwd, 'tracked.txt'); assert.equal(bytes.kind, 'oversized'); assert.equal(bytes.patch, '');
  await writeFile(path.join(cwd, 'tracked.txt'), 'line\n'.repeat(PATCH_LINE_LIMIT + 1)); assert.equal((await a.diff(cwd, 'tracked.txt')).kind, 'oversized');
});
check('file-list truncation is explicit and does not authorize directory or prefix patch reads', async t => {
  const f = await fixture(t), cwd = await repo(f), a = adapter(f, t);
  for (let i = 0; i < CHANGE_FILE_LIMIT + 1; i++) await writeFile(path.join(cwd, `new-${String(i).padStart(4, '0')}`), 'new\n');
  const value = await a.summary(cwd); assert.equal(value.files.length, CHANGE_FILE_LIMIT); assert.equal(value.limited, true); assert.match(value.reason, /first 500/);
  assert.equal((await a.diff(cwd, 'new-0500')).kind, 'text'); assert.equal((await a.diff(cwd, 'new-')).kind, 'missing'); assert.equal(a.reads.length, 1);
});
check('external helpers from diff, textconv, content filters and fsmonitor are never invoked', async t => {
  const f = await fixture(t), cwd = await repo(f), marker = path.join(f.root, 'HELPER-RAN'), a = adapter(f, t);
  const command = `touch '${marker.replaceAll("'", "'\\''")}'`;
  await writeFile(path.join(cwd, '.gitattributes'), 'tracked.txt filter=evil diff=evil\n');
  for (const [key, value] of Object.entries({ 'filter.evil.clean': command, 'filter.evil.process': command, 'filter.evil.required': 'true', 'diff.evil.command': command, 'diff.evil.textconv': command, 'diff.external': command, 'core.fsmonitor': command })) await git(f, cwd, ['config', key, value]);
  await writeFile(path.join(cwd, 'tracked.txt'), 'after\n');
  const summary = await a.summary(cwd); assert.equal(summary.repository.kind, 'git'); assert.ok(summary.files.some(file => file.path === 'tracked.txt'), summary.reason);
  assert.equal((await a.diff(cwd, 'tracked.txt')).kind, 'text');
  await assert.rejects(stat(marker), { code: 'ENOENT' });
  assert.ok(a.calls.filter(call => call.spec.argv.includes('diff')).every(call => call.spec.argv.includes('filter.evil.process=') && call.spec.argv.includes('filter.evil.clean=')));
});
check('bounded metadata and diagnostics fail closed, never as a clean success', async t => {
  const f = await fixture(t), cwd = await repo(f);
  for (const mocked of [{ text: 'partial', lossy: true }, { text: ':invalid\0' }, { text: '', stderr: 'warning: cannot read directory\n' }]) {
    const a = adapter(f, t, { mock: spec => spec.argv.includes('--raw') ? mocked : undefined }); const value = await a.summary(cwd); assert.equal(value.limited, true); assert.ok(value.reason);
  }
  const a = adapter(f, t, { mock: spec => spec.argv.includes('ls-files') ? { text: '', stderr: 'warning: unreadable\n' } : undefined }); assert.match((await a.summary(cwd)).reason, /unreadable/);
});
check('unresolved native merge conflicts remain explicit in every scope', async t => {
  const f = await fixture(t), cwd = await repo(f), a = adapter(f, t);
  await git(f, cwd, ['checkout', '--quiet', '-b', 'other']);
  await writeFile(path.join(cwd, 'tracked.txt'), 'other\nstable\n');
  await git(f, cwd, ['add', '--', 'tracked.txt']); await git(f, cwd, ['commit', '--quiet', '-m', 'other']);
  await git(f, cwd, ['checkout', '--quiet', 'main']);
  await writeFile(path.join(cwd, 'tracked.txt'), 'main\nstable\n');
  await git(f, cwd, ['add', '--', 'tracked.txt']); await git(f, cwd, ['commit', '--quiet', '-m', 'main']);
  await git(f, cwd, ['merge', '--no-edit', 'other'], '', 1);
  for (const scope of ['all', 'staged', 'unstaged']) {
    const value = await a.summary(cwd, scope);
    assert.equal(value.repository.kind, 'git'); assert.ok(value.files.some(file => file.path === 'tracked.txt' && file.status === 'U'), value.reason);
    assert.equal(value.limited, true); assert.match(value.reason, /conflict/);
    const patch = await a.diff(cwd, 'tracked.txt', scope); assert.equal(patch.kind, 'conflict'); assert.equal(patch.patch, '');
  }
});
check('staged submodule pointers are not expanded and cannot read nested files', async t => {
  const f = await fixture(t), cwd = await repo(f), a = adapter(f, t);
  const commit = (await git(f, cwd, ['rev-parse', 'HEAD'])).trim();
  await git(f, cwd, ['update-index', '--add', '--cacheinfo', `160000,${commit},module`]);
  const summary = await a.summary(cwd, 'staged');
  assert.ok(summary.files.some(file => file.path === 'module'), summary.reason);
  assert.equal((await a.diff(cwd, 'module', 'staged')).kind, 'submodule');
  assert.equal((await a.diff(cwd, 'module/private.txt', 'staged')).kind, 'missing'); assert.equal(a.reads.length, 0);
});
check('unrepresentable filter keys fail closed before invoking any diff process', async t => {
  const f = await fixture(t), cwd = await repo(f);
  const a = adapter(f, t, { mock: spec => spec.argv.includes('config') ? { text: 'filter.unsafe name.clean\0' } : undefined });
  const value = await a.summary(cwd);
  assert.equal(value.limited, true); assert.match(value.reason, /unsupported Git filter/);
  assert.equal(a.calls.some(call => call.spec.argv.includes('diff')), false);
});
check('mounted file read denials are surfaced without falling back to host filesystem reads', async t => {
  const f = await fixture(t), cwd = await repo(f), a = adapter(f, t);
  await writeFile(path.join(cwd, 'denied.txt'), 'private\n');
  a.services.fs.readBytes = async () => { throw new Error('mounted FS denied'); };
  const value = await a.diff(cwd, 'denied.txt'); assert.equal(value.kind, 'unavailable'); assert.match(value.reason, /mounted FS denied/); assert.equal(value.patch, '');
});
check('caller cancellation is propagated and every started child is disposed and reaped', async t => {
  const f = await fixture(t), cwd = await repo(f), controller = new AbortController();
  const a = adapter(f, t, { onSpawn: () => controller.abort(new Error('test cancellation')) });
  await assert.rejects(a.summary(cwd, 'all', controller.signal), /test cancellation/); assert.equal(a.calls.length, 1);
  const b = adapter(f, t), before = new AbortController(); before.abort(new Error('cancel before launch'));
  await assert.rejects(b.summary(cwd, 'all', before.signal), /before launch/); assert.equal(b.calls.length, 0);
});
