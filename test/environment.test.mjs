import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEnvironment, createEnvironmentInitializer, ENVIRONMENT_FILE } from '../environment.js';
import { createOperations } from '../core.js';

test('Codex v1 default setup supports real TOML multiline scripts and never executes actions', () => {
  assert.deepEqual(parseEnvironment('version = 1\n[setup]\nscript = """\ncd graph-front\npnpm install\n"""\n[[actions]]\ncommand="never"'), { script: 'cd graph-front\npnpm install\n', file: ENVIRONMENT_FILE });
  assert.equal(parseEnvironment('version=1\n[[actions]]\ncommand="never"'), null);
  assert.equal(parseEnvironment('version=1\n[setup]\nscript="  "'), null);
  for (const text of ['version=2', 'version=1\n[setup]\nscript=3', 'version=1\n[setup]\nscript="x"\n[setup.windows]\nscript="y"']) assert.throws(() => parseEnvironment(text));
});
function fixture({ exists = true, platform = 'posix', code = 0, mode = 'danger-full-access' } = {}) {
  const calls = [], agent = { id: 's', session: {} }, checkout = { path: '/new' };
  const services = {
    fs: { lstat: async () => exists ? { type: 'file', version: '1', size: 40 } : undefined,
      resolve: async value => value, contains: () => true,
      readBytes: async () => Buffer.from('version=1\n[setup]\nscript="printf setup"') },
    workingDirectory: { get: () => '/new' }, sandboxPolicy: { resolve: () => ({ mode }) },
    sandbox: { confine: async argv => { calls.push('sandbox'); return { argv: ['fenced', ...argv] }; } },
    subprocess: { terminalEnvironment: async () => ({ platform, defaultShell: '/bin/zsh' }), resolveExecutable: async x => x,
      spawn(spec) { calls.push(spec); return { done: Promise.resolve({ exitCode: code }),
        collected: { stdout: { readFrom: () => ({ text: 'setup output' }) }, stderr: { readFrom: () => ({ text: 'setup error' }) } },
        terminate() { calls.push('terminate'); }, async waitForExit() { calls.push('reaped'); } }; } },
  };
  return { calls, services, agent, checkout, run: signal => createEnvironmentInitializer((_a, key) => services[key])(agent, checkout, signal) };
}
test('setup runs in the NEW checkout through mounted shell and restricted sandbox, then reaps', async () => {
  const f = fixture({ mode: 'workspace-write' });
  assert.equal((await f.run()).status, 'succeeded');
  assert.equal(f.calls[0], 'sandbox');
  assert.equal(f.calls[1].cwd, '/new');
  assert.deepEqual(f.calls[1].argv, ['fenced', '/bin/zsh', '-lc', 'printf setup']);
  assert.deepEqual(f.calls.slice(-2), ['terminate', 'reaped']);
});
test('missing config skips; unsupported OS and process failure fail explicitly', async () => {
  const missing = fixture({ exists: false }); assert.equal((await missing.run()).status, 'skipped'); assert.deepEqual(missing.calls, []);
  const windows = fixture({ platform: 'windows' }); await assert.rejects(windows.run(), /not yet verified/); assert.deepEqual(windows.calls, []);
  const failed = fixture({ code: 1 }); await assert.rejects(failed.run(), /setup failed.*setup error/); assert.equal(failed.calls.at(-1), 'reaped');
});
test('cancellation, symlinks, escaping config and cwd change prevent execution', async () => {
  const f = fixture(); const abort = new AbortController(); abort.abort(); await assert.rejects(f.run(abort.signal));
  f.services.fs.lstat = async () => ({ type: 'symlink' }); await assert.rejects(f.run(), /regular file/);
  const g = fixture(); g.services.fs.contains = () => false; await assert.rejects(g.run(), /inside/);
  const h = fixture(); h.services.workingDirectory.get = () => '/other'; await assert.rejects(h.run(), /directory changed/);
});
test('durable setup success runs once and failures/interruption never reallocate or silently resume model', async () => {
  for (const fail of [false, true]) {
    let cwd = '/source', creates = 0, setups = 0; const records = new Map();
    records.set('s', { mode: 'worktree', name: 'dsh/cool-sun', baseCommit: 'a'.repeat(40), sourceCwd: cwd, status: 'staged', revision: 1 });
    const ops = createOperations({ table: { get: id => records.get(id), put: async (id, v) => records.set(id, v) }, cwdOf: () => cwd,
      repository: async () => ({ kind: 'git' }), started: () => true,
      createWorktree: async () => { creates++; cwd = '/new'; return { path: cwd }; },
      initializeWorktree: async () => { setups++; assert.equal(records.get('s').initialization.status, 'running'); if (fail) throw new Error('install failed'); return { status: 'succeeded', reason: '' }; } });
    if (fail) await assert.rejects(ops.prepare({ id: 's' }), /install failed/); else await ops.prepare({ id: 's' });
    assert.equal(records.get('s').status, 'created');
    if (fail) await assert.rejects(ops.prepare({ id: 's' }), /initialization failed/); else await ops.prepare({ id: 's' });
    assert.equal(creates, 1); assert.equal(setups, 1);
    records.get('s').initialization = { status: 'running', reason: '' };
    await assert.rejects(ops.prepare({ id: 's' }), /interrupted/);
  }
});
