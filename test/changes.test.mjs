import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { changesRequestSchema, changesResultSchema, createChangesOperations, foldRefresh } from '../changes.js';

const selectionSchema = z.strictObject({ mode: z.enum(['local', 'worktree']), sourceCwd: z.string() });
const resultSchema = changesResultSchema(selectionSchema);
const agent = { id: 'session-1' };
const summary = () => ({
  repository: { kind: 'git', root: '/repo', branch: 'main', commit: 'a'.repeat(40), unborn: false },
  scope: 'all', files: [{ path: 'index.js', oldPath: '', status: 'M', added: 2, deleted: 1, binary: false }],
  added: 2, deleted: 1, untracked: 0, limited: false, reason: '',
});
function fixture() {
  let cwd = '/repo', selection;
  const calls = [];
  const reader = {
    async summary(...args) { calls.push(['summary', ...args]); return summary(); },
    async diff(...args) { calls.push(['diff', ...args]); return { kind: 'text', path: args[3], patch: '@@ -1 +1 @@\n-before\n+after\n', reason: '' }; },
  };
  const operations = createChangesOperations({ reader, cwdOf: () => cwd, selectionOf: () => selection, resultSchema });
  return { reader, calls, operations, setCwd(value) { cwd = value; }, setSelection(value) { selection = value; } };
}
function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

test('changes requests have explicit actions, scope default, and strict fields', () => {
  assert.deepEqual(changesRequestSchema.parse({ action: 'summary' }), { action: 'summary', scope: 'all' });
  assert.deepEqual(changesRequestSchema.parse({ action: 'diff', path: '-[file]\n名.js' }), { action: 'diff', path: '-[file]\n名.js', scope: 'all' });
  for (const request of [null, {}, { action: 'select' }, { action: 'summary', scope: 'branch' },
    { action: 'summary', path: 'index.js' }, { action: 'diff' }, { action: 'diff', path: '' },
    { action: 'diff', path: 'bad\0name' }, { action: 'summary', cwd: '/other' }]) {
    assert.throws(() => changesRequestSchema.parse(request));
  }
});

test('one read operation returns actual cwd, current selection, and summary identity', async () => {
  const f = fixture();
  const selection = { mode: 'worktree', sourceCwd: '/repo' };
  f.setSelection(selection);
  const value = await f.operations.operate(agent, { action: 'summary' });
  assert.equal(value.sessionId, agent.id);
  assert.equal(value.cwd, '/repo');
  assert.equal(value.scope, 'all');
  assert.deepEqual(value.selection, selection);
  assert.deepEqual(f.calls[0].slice(0, 4), ['summary', agent, '/repo', 'all']);
  assert.equal(value.files[0].path, 'index.js');
  await f.operations.drain();
});

test('diff reads only the requested scope and path and supplies Session identity', async () => {
  const f = fixture();
  const signal = new AbortController().signal;
  const value = await f.operations.operate(agent, { action: 'diff', scope: 'staged', path: 'index.js' }, signal);
  assert.deepEqual(f.calls[0], ['diff', agent, '/repo', 'staged', 'index.js', signal]);
  assert.equal(value.kind, 'text');
  assert.equal(value.cwd, '/repo');
  assert.equal(value.scope, 'staged');
  assert.equal('selection' in value, false);
});

test('directory changes during asynchronous reads reject obsolete checkout data', async () => {
  const f = fixture();
  const pause = deferred();
  f.reader.summary = async () => { await pause.promise; return summary(); };
  const pending = f.operations.operate(agent, { action: 'summary' });
  f.setCwd('/repo/.agents/worktrees/dsh/ripe-bird');
  pause.resolve();
  await assert.rejects(pending, /directory changed/);
});

test('cancellation is checked both before and after read and drain waits for settlement', async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort(new Error('cancel before read'));
  await assert.rejects(f.operations.operate(agent, { action: 'summary' }, controller.signal), /cancel before read/);
  assert.equal(f.calls.length, 0);
  const pause = deferred();
  const second = new AbortController();
  f.reader.summary = async () => { await pause.promise; return summary(); };
  const pending = f.operations.operate(agent, { action: 'summary' }, second.signal);
  let drained = false;
  const draining = f.operations.drain().then(() => { drained = true; });
  second.abort(new Error('cancel during read'));
  await Promise.resolve();
  assert.equal(drained, false);
  const rejected = assert.rejects(pending, /cancel during read/);
  pause.resolve();
  await rejected;
  await draining;
  assert.equal(drained, true);
});

test('reader failure never becomes a successful clean summary', async () => {
  const f = fixture();
  f.reader.summary = async () => { throw new Error('sandbox denied'); };
  await assert.rejects(f.operations.operate(agent, { action: 'summary' }), /sandbox denied/);
  await f.operations.drain();
  f.setCwd('');
  await assert.rejects(f.operations.operate(agent, { action: 'summary' }), /directory is unavailable/);
});

test('summary limits, unknown statistics, and typed preview fallbacks are validated', () => {
  const identity = { sessionId: 'test', cwd: '/repo', scope: 'all' };
  const base = { ...identity, ...summary(), selection: null };
  assert.deepEqual(resultSchema.parse(base), base);
  const untracked = { ...base, files: [{ ...base.files[0], status: '?', added: null, deleted: null }], limited: true };
  assert.equal(resultSchema.parse(untracked).files[0].added, null);
  assert.throws(() => resultSchema.parse({ ...base, files: Array.from({ length: 501 }, () => base.files[0]) }));
  assert.throws(() => resultSchema.parse({ ...base, added: -1 }));
  assert.throws(() => resultSchema.parse({ ...base, surprise: true }));
  for (const kind of ['binary', 'oversized', 'conflict', 'submodule', 'missing', 'unavailable']) {
    const value = { ...identity, kind, path: 'file', patch: '', reason: 'Cannot preview this file.' };
    assert.deepEqual(resultSchema.parse(value), value);
  }
  assert.throws(() => resultSchema.parse({ ...identity, kind: 'html', path: 'file', patch: '', reason: '' }));
});

test('refresh projection ignores streaming noise and changes only at committed turn end', () => {
  let state = 0;
  for (const type of ['assistant/live-chunk', 'step/start', 'tool/result', 'user/message', 'turn/start']) {
    assert.equal(foldRefresh(state, { type }), state);
  }
  state = foldRefresh(state, { type: 'turn/end' });
  assert.equal(state, 1);
  assert.equal(foldRefresh(state, { type: 'turn/end' }), 2);
});
