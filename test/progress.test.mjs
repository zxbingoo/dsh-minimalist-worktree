import test from 'node:test';
import assert from 'node:assert/strict';
import { createProgressTracker, progressSchema, PROGRESS_LOG_LIMIT } from '../progress.js';
import { createOperations } from '../core.js';
import { createEnvironmentInitializer } from '../environment.js';

function fixture(options) {
  const records = new Map(), puts = [];
  const table = { get: id => records.get(id), async put(id, value) { puts.push(value); records.set(id, structuredClone(value)); } };
  return { records, puts, table, tracker: createProgressTracker(table, options) };
}
const a = { id: 'a' }, b = { id: 'b' };
test('pre-step inbox acceptance anchors progress before a user/message exists and repairs legacy null anchors', async () => {
  const f = fixture();
  const events = [{ type: 'permission/preset' }, { type: 'agent/inbox/spliced', data: { target: 'next-turn', inserted: [{ role: 'user', source: { kind: 'user' } }] } }, { type: 'turn/start' }];
  const agent = { id: 'a', session: { seq: events.length, eventAt: seq => events[seq] } };
  await f.tracker.start(agent); assert.equal((await f.tracker.read(agent)).anchorSeq, 1);
  await f.tracker.finish(agent, 'failed', 'cancelled'); f.records.get('a').anchorSeq = null;
  const restored = createProgressTracker(f.table);
  const repaired = await restored.read(agent); assert.equal(repaired.anchorSeq, 1); assert.equal(repaired.phase, 'failed');
});
test('persistent records have stable start, monotonic revisions, actual metadata and terminal timestamps', async () => {
  let time = 10; const f = fixture({ now: () => time++ });
  await f.tracker.start(a); await f.tracker.update(a, { phase: 'initializing', cwd: '/checkout', branch: 'dsh/bird', command: 'pnpm setup' });
  await f.tracker.append(a, 'hello\n'); await f.tracker.finish(a, 'succeeded');
  const record = await f.tracker.read(a, 4); assert.equal(record.phase, 'succeeded'); assert.equal(record.revision, 4);
  assert.equal(record.startedAt, 10); assert.equal(record.endedAt, record.updatedAt); assert.equal(record.cwd, '/checkout');
  progressSchema.parse(record); record.logs = 'tamper'; assert.equal((await f.tracker.read(a)).logs, 'hello\n');
});
test('same-session writes serialize without losing log chunks while another Session remains independent', async () => {
  const f = fixture(); await f.tracker.start(a); await f.tracker.start(b);
  await Promise.all(Array.from({ length: 25 }, (_, i) => f.tracker.append(a, `${i},`)));
  assert.equal((await f.tracker.read(a)).logs, Array.from({ length: 25 }, (_, i) => `${i},`).join(''));
  assert.equal((await f.tracker.read(b)).logs, '');
});
test('read initial absence is null; explicit cursor waits for start, then unchanged active cursor waits for publish', async () => {
  const f = fixture({ waitMs: 500 }); assert.equal(await f.tracker.read(a), null);
  let resolved = false; const pending = f.tracker.read(a, 0).then(v => { resolved = true; return v; });
  await Promise.resolve(); assert.equal(resolved, false); await f.tracker.start(a); assert.equal((await pending).revision, 1);
  const next = f.tracker.read(a, 1); await f.tracker.append(a, 'x'); assert.equal((await next).logs, 'x');
  await f.tracker.finish(a, 'skipped'); assert.equal((await f.tracker.read(a, 3)).phase, 'skipped');
});
test('long-poll timeout, cancellation and drain release listeners without polling table', async () => {
  const f = fixture({ waitMs: 10 }); await f.tracker.start(a);
  assert.equal((await f.tracker.read(a, 1)).revision, 1);
  const ctrl = new AbortController(), read = f.tracker.read(a, 1, ctrl.signal); ctrl.abort(new Error('gone')); await assert.rejects(read, /gone/);
  const pending = f.tracker.read(a, 1); await f.tracker.drain(); assert.equal((await pending).revision, 1);
});
test('restart turns orphaned active progress into interrupted failure but does not create records for old worktrees', async () => {
  const f = fixture(); await f.tracker.start(a); const restored = createProgressTracker(f.table);
  const value = await restored.read(a, 1); assert.equal(value.phase, 'failed'); assert.match(value.error, /interrupted/);
  assert.equal(await restored.read(b), null);
});
test('logs are UTF8 byte bounded, ANSI stripped and common secrets redacted across append boundaries', async () => {
  const f = fixture(); await f.tracker.start(a);
  await f.tracker.append(a, '\x1b[31mred\x1b[0m\npassword='); await f.tracker.append(a, 'supersecret\nAuthorization: Bearer abcdef\nhttps://u:p@example.com\n');
  let v = await f.tracker.read(a); assert.ok(!v.logs.includes('\x1b')); assert.ok(!v.logs.includes('supersecret')); assert.ok(!v.logs.includes('abcdef')); assert.ok(!v.logs.includes('u:p@'));
  await f.tracker.append(a, '字'.repeat(20000)); v = await f.tracker.read(a); assert.ok(Buffer.byteLength(v.logs) <= PROGRESS_LOG_LIMIT); assert.equal(v.limited, true);
});
test('writes reject before notification and fail closed; reading never writes fake executing progress', async () => {
  const f = fixture(); await f.tracker.start(a); f.table.put = async () => { throw new Error('disk failed'); };
  await assert.rejects(f.tracker.update(a, { command: 'x' }), /disk failed/); assert.equal((await f.tracker.read(a)).revision, 1);
  await assert.rejects(f.tracker.update(a, { sessionId: 'other' }), /Invalid/);
});
test('progress persistence failure prevents checkout allocation', async () => {
  const f = fixture(); f.table.put = async () => { throw new Error('progress storage failed'); }; let creates = 0;
  const selections = new Map([['a', { mode: 'worktree', sourceCwd: '/source', name: 'dsh/bird', baseCommit: 'a'.repeat(40), status: 'staged', revision: 1 }]]);
  const ops = createOperations({ table: { get: id => selections.get(id), put: async (id,v) => selections.set(id,v) }, progress: f.tracker,
    cwdOf: () => '/source', repository: async () => ({ kind: 'git' }), createWorktree: async () => { creates++; } });
  await assert.rejects(ops.prepare(a), /progress storage failed/); assert.equal(creates, 0); assert.equal(selections.get('a').status, 'failed');
});

test('start anchors to first append user message when multiple inputs arrive before first step', async () => {
  const f = fixture(); await f.tracker.start({ id: 'a', session: { seq: 4, eventAt: seq => ({ type: seq >= 1 ? 'agent/inbox/spliced' : 'step/start', data: { target: 'next-turn', inserted: [{ role: 'user', source: { kind: 'user' } }] } }) } });
  assert.equal((await f.tracker.read(a)).anchorSeq, 1);
});
test('core publishes creating then initializing then terminal and refuses repeated setup', async () => {
  for (const fail of [false, true]) {
    const f = fixture(), selections = new Map([['a', { mode: 'worktree', sourceCwd: '/source', name: 'dsh/bird', baseCommit: 'a'.repeat(40), status: 'staged', revision: 1 }]]); let cwd = '/source', creates = 0;
    const ops = createOperations({ table: { get: id => selections.get(id), put: async (id,v) => selections.set(id,v) }, progress: f.tracker,
      cwdOf: () => cwd, repository: async () => ({ kind: 'git' }),
      createWorktree: async (_a,_r,_s,emit) => { creates++; cwd = '/new'; await emit({ text: 'created\n' }); return { path: cwd, branch: 'dsh/bird' }; },
      initializeWorktree: async (_a,_r,_s,emit) => { await emit({ command: 'setup', text: 'output\n' }); if (fail) throw new Error('setup bad'); return { status: 'succeeded', reason: '' }; } });
    if (fail) await assert.rejects(ops.prepare(a), /setup bad/); else await ops.prepare(a);
    assert.equal((await f.tracker.read(a)).phase, fail ? 'failed' : 'succeeded'); assert.equal((await f.tracker.read(a)).cwd, '/new');
    if (fail) await assert.rejects(ops.prepare(a)); else await ops.prepare(a); assert.equal(creates, 1);
  }
});
test('setup collects incremental stdout/stderr by offset while active and flushes before success', async () => {
  let resolveDone; const events = [], offsets = [], output = { stdout: '', stderr: '' }; let terminated = false, reaped = false;
  const services = { fs: { lstat: async () => ({ type: 'file', size: 50, version: '1' }), resolve: async x => x, contains: () => true,
    readBytes: async () => Buffer.from('version=1\n[setup]\nscript="echo setup"') },
    workingDirectory: { get: () => '/new' }, sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) },
    subprocess: { terminalEnvironment: async () => ({ platform: 'posix', defaultShell: '/bin/sh' }), resolveExecutable: async x => x,
      spawn() { return { done: new Promise(r => { resolveDone = r; }), collected: Object.fromEntries(['stdout','stderr'].map(key => [key, { readFrom(offset) {
        offsets.push([key,offset]); return { text: output[key].slice(offset), nextOffset: output[key].length, lossy: false };
      } }])), terminate() { terminated = true; }, async waitForExit() { reaped = true; } }; } } };
  const init = createEnvironmentInitializer((_a,key) => services[key]);
  let first; const sampled = new Promise(r => { first = r; });
  const pending = init(a, { path: '/new' }, undefined, async e => { events.push(e); if (e.text === 'one') first(); });
  while (!resolveDone) await new Promise(r => setImmediate(r));
  output.stdout = 'one'; await sampled; output.stdout = 'onetwo'; output.stderr = 'warn'; resolveDone({ exitCode: 0 });
  await pending; assert.deepEqual(events.filter(e => e.text).map(e => e.text).sort(), ['one','two','warn'].sort());
  assert.ok(offsets.some(([k,n]) => k === 'stdout' && n === 3)); assert.ok(terminated && reaped);
  // A progress-storage rejection during live output must stop/reap, not leave
  // an unobserved sampler rejection or a timer keeping the operation alive.
  terminated = false; reaped = false; output.stdout = 'another';
  const broken = init(a, { path: '/new' }, undefined, async event => { if (event.text) throw new Error('progress disk unavailable'); });
  await assert.rejects(broken, /progress disk unavailable/);
  assert.ok(terminated && reaped);
});
