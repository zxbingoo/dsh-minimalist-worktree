import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, realpath, lstat, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createWorktreeCleaner } from '../cleanup.js';
import { SNAPSHOT_PROGRAM } from '../snapshot-engine.mjs';

const PROJECT = await realpath(new URL('../', import.meta.url));
async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(PROJECT, '.mwt-cleanup-fixture-')); const marker = randomUUID();
  await writeFile(path.join(root, '.owner'), marker); const running = new Set();
  t.after(async () => {
    for (const child of running) child.kill('SIGKILL');
    await Promise.all([...running].map(child => new Promise(resolve => child.once('close', resolve))));
    assert.equal(path.dirname(root), PROJECT); assert.ok(path.basename(root).startsWith('.mwt-cleanup-fixture-'));
    assert.equal(await realpath(root), root); assert.equal(await readFile(path.join(root, '.owner'), 'utf8'), marker);
    await rm(root, { recursive: true, maxRetries: 3, retryDelay: 100 });
  });
  const home = path.join(root, 'home'), source = path.join(root, 'repo'); await mkdir(home); await mkdir(source);
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
  const git = (args, cwd = source) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '-q']); git(['symbolic-ref', 'HEAD', 'refs/heads/main']);
  await writeFile(path.join(source, 'file.txt'), 'original\n'); await writeFile(path.join(source, '.gitignore'), '.env\nnode_modules/\n');
  git(['add', '.']); git(['commit', '-qm', 'first']); const branch = 'dsh/calm-otter';
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 8);
  const target = path.join(home, '.dsh', 'worktrees', `repo-${hash}`, 'calm-otter'); await mkdir(path.dirname(target), { recursive: true });
  git(['worktree', 'add', '-b', branch, target]);
  const selection = { mode: 'worktree', status: 'created', name: branch, result: { path: target, branch, repositoryRoot: source } };
  const calls = [], reaped = [], confined = [];
  const services = {
    fs: { async resolve(p, opts = {}) { const absolute = path.resolve(opts.cwd ?? source, p); let canonical; try { canonical = await realpath(absolute); } catch (e) { if (e.code !== 'ENOENT') throw e; canonical = absolute; } return { targetKey: canonical, value: canonical }; }, processPath: target => target.value,
      async lstat(p) { try { const info = await lstat(p); return { type: info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : 'file' }; } catch(e) { if (e.code !== 'ENOENT') throw e; } } },
    sandboxPolicy: { resolve: () => ({ mode: options.mode ?? 'danger-full-access', workspaceRoot: source }) },
    sandbox: { async confine(argv, policy) { confined.push({ argv, policy }); if (options.deny) throw new Error('denied'); return { argv }; } },
    subprocess: { resolveExecutable: async name => name === 'node' ? process.execPath : 'git', spawn(spec) {
      calls.push(spec); options.beforeSpawn?.(spec);
      if (options.fail && spec.argv.includes('symbolic-ref')) return { done: Promise.resolve({ exitCode: 1 }), collected: { stdout: { readFrom: () => ({ text: '', lossy: false }) }, stderr: { readFrom: () => ({ text: 'forced failure', lossy: false }) } }, terminate() {}, async waitForExit() { reaped.push(spec); } };
      const processEnv = { ...env }; for (const [key, value] of Object.entries(spec.env)) value === undefined ? delete processEnv[key] : processEnv[key] = value;
      const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, env: processEnv, signal: spec.signal, stdio: ['ignore', 'pipe', 'pipe'] }); running.add(child);
      let out = '', err = ''; child.stdout.on('data', x => out += x); child.stderr.on('data', x => err += x);
      const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (exitCode, signal) => { running.delete(child); resolve({ exitCode, signal }); }); });
      return { done, collected: { stdout: { readFrom: () => ({ text: out, lossy: out.length > spec.stdio.stdout.maxBytes }) }, stderr: { readFrom: () => ({ text: err, lossy: err.length > spec.stdio.stderr.maxBytes }) } }, terminate() { child.kill('SIGTERM'); }, async waitForExit() { await done; reaped.push(spec); } };
    } },
  };
  const agent = { id: 'cleanup', session: { id: 'cleanup' } };
  const receipts = [];
  const persist = async receipt => { receipts.push(receipt); await options.onSnapshot?.(receipt); };
  const clean = (sel = selection, safe = async () => true, signal, onSnapshot = persist) => createWorktreeCleaner((_a, key) => services[key])(agent, sel, { isStillSafe: safe, onSnapshot }, signal);
  const worker = (action, args) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', SNAPSHOT_PROGRAM, action, JSON.stringify(args)], { cwd: source, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  return { root, home, source, target, branch, selection, git, clean, worker, receipts, calls, reaped, confined };
}
const removedCalls = f => f.calls.filter(spec => spec.argv.includes('remove'));

test('removes exact clean external worktree registration and directory while preserving branch', async t => {
  const f = await fixture(t); const result = await f.clean(); assert.equal(result.status, 'removed', result.reason);
  assert.equal(result.path, f.target); assert.equal(result.branch, f.branch); assert.ok(Number.isFinite(result.at));
  await assert.rejects(lstat(f.target), { code: 'ENOENT' }); assert.equal(f.git(['show-ref', '--verify', '--quiet', `refs/heads/${f.branch}`]), '');
  assert.equal(removedCalls(f).length, 1); assert.equal(removedCalls(f)[0].argv.filter(arg => arg === '--force').length, 1);
  assert.ok(!f.calls.some(spec => spec.argv.includes('prune'))); assert.equal(f.calls.length, f.reaped.length);
  assert.equal(f.receipts.length, 0); assert.equal(result.snapshotPath, undefined); assert.ok(!f.calls.some(x => x.argv.includes(SNAPSHOT_PROGRAM)));
});
for (const kind of ['tracked', 'untracked', 'ignored', 'cache']) test(`${kind} content is discarded on explicit Paseo-style archive without backup`, async t => {
  const f = await fixture(t);
  if (kind === 'tracked') await writeFile(path.join(f.target, 'file.txt'), 'modified');
  if (kind === 'untracked') await writeFile(path.join(f.target, 'new.txt'), 'valuable');
  if (kind === 'ignored') await writeFile(path.join(f.target, '.env'), 'SECRET=valuable');
  if (kind === 'cache') { await mkdir(path.join(f.target, 'node_modules')); await writeFile(path.join(f.target, 'node_modules', 'cache'), 'retained'); }
  const result = await f.clean(); assert.equal(result.status, 'removed', result.reason); assert.equal(removedCalls(f).length, 1); await assert.rejects(lstat(f.target), { code: 'ENOENT' });
  assert.equal(f.git(['rev-parse', '--verify', f.branch]).length, 40);
});
test('locked worktrees are skipped without force or unlock', async t => {
  const f = await fixture(t); f.git(['worktree', 'lock', f.target]); const result = await f.clean(); assert.equal(result.status, 'skipped'); assert.equal(removedCalls(f).length, 0);
});
test('occupancy guard false before or immediately before removal never removes', async t => {
  const f = await fixture(t); assert.equal((await f.clean(f.selection, async () => false)).status, 'skipped'); assert.equal(f.calls.length, 0);
  let allowed = true; const result = await f.clean(f.selection, async () => { if (f.calls.filter(x => x.argv.includes('symbolic-ref')).length >= 2) allowed = false; return allowed; });
  assert.equal(result.status, 'skipped'); assert.equal(removedCalls(f).length, 0);
});
test('forged target, source target, incomplete ownership and legacy paths are skipped', async t => {
  const f = await fixture(t);
  for (const sel of [{ ...f.selection, status: 'failed' }, { ...f.selection, name: 'different' }, { ...f.selection, result: { ...f.selection.result, path: f.source } }, { ...f.selection, result: { ...f.selection.result, path: path.join(f.source, '.agents', 'worktrees', f.branch) } }, { ...f.selection, result: { ...f.selection.result, path: path.join(f.home, 'other') } }]) {
    assert.equal((await f.clean(sel)).status, 'skipped');
  }
  assert.equal(removedCalls(f).length, 0);
});
test('branch switched after creation is not treated as owned clean target', async t => {
  const f = await fixture(t); f.git(['checkout', '-b', 'other'], f.target); const result = await f.clean(); assert.equal(result.status, 'skipped'); assert.equal(removedCalls(f).length, 0);
});
test('symlink replacement of pool is refused even if canonical destination points to a real linked checkout', async t => {
  const f = await fixture(t); const alias = path.join(f.home, 'alias'); await symlink(path.dirname(f.target), alias);
  const sel = { ...f.selection, result: { ...f.selection.result, path: path.join(alias, path.basename(f.target)) } };
  assert.equal((await f.clean(sel)).status, 'skipped'); assert.equal(removedCalls(f).length, 0);
});
test('subprocess failures and sandbox denial retain directory without fallback', async t => {
  const f = await fixture(t, { fail: true }); assert.equal((await f.clean()).status, 'failed'); assert.equal(removedCalls(f).length, 0);
  const g = await fixture(t, { mode: 'workspace-write', deny: true }); assert.equal((await g.clean()).status, 'failed'); assert.equal(g.calls.length, 0); assert.equal(g.confined.length, 1);
});
test('restricted policy is passed unchanged and every child is reaped', async t => {
  const f = await fixture(t, { mode: 'workspace-write' }); const result = await f.clean(); assert.equal(result.status, 'removed', result.reason); assert.equal(f.confined.length, f.calls.length); assert.ok(f.confined.every(x => x.policy.mode === 'workspace-write' && x.policy.workspaceRoot === f.source));
});
test('configured content filters do not execute during cleanup status checks', async t => {
  const f = await fixture(t); const marker = path.join(f.root, 'filter-executed');
  await writeFile(path.join(f.target, '.gitattributes'), 'file.txt filter=unsafe\n');
  f.git(['add', '.gitattributes'], f.target); f.git(['commit', '-qm', 'attributes'], f.target);
  f.git(['config', 'filter.unsafe.clean', `touch '${marker}'`]); f.git(['config', 'filter.unsafe.required', 'true']);
  const result = await f.clean(); assert.equal(result.status, 'removed', result.reason);
  await assert.rejects(lstat(marker), { code: 'ENOENT' });
  assert.equal(f.git(['show-ref', '--verify', '--quiet', `refs/heads/${f.branch}`]), '');
});
test('nonmerged committed changes remain reachable on preserved worktree branch', async t => {
  const f = await fixture(t); await writeFile(path.join(f.target, 'file.txt'), 'branch content\n');
  f.git(['add', 'file.txt'], f.target); f.git(['commit', '-qm', 'unmerged change'], f.target);
  const head = f.git(['rev-parse', 'HEAD'], f.target);
  assert.equal((await f.clean()).status, 'removed'); assert.equal(f.git(['rev-parse', f.branch]), head);
  assert.equal(f.git(['show', `${f.branch}:file.txt`]), 'branch content');
});
test('branch changing during preflight is caught by immediate identity revalidation', async t => {
  let f, changed = false;
  f = await fixture(t, { beforeSpawn(spec) { if (!changed && spec.argv.includes('symbolic-ref')) { changed = true; f.git(['checkout', '-b', 'raced'], f.target); } } });
  assert.equal((await f.clean()).status, 'skipped'); assert.equal(removedCalls(f).length, 0);
});
test('pre-cancellation performs no command or removal', async t => {
  const f = await fixture(t); const c = new AbortController(); c.abort(new Error('stop')); assert.equal((await f.clean(f.selection, async () => true, c.signal)).status, 'failed'); assert.equal(f.calls.length, 0);
});
