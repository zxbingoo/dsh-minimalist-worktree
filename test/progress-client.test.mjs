import test from 'node:test';
import assert from 'node:assert/strict';
import { createPreparationFeed, decodePreparationResponse, createPreparationUI } from '../src/progress-client.js';
const snapshot = (extra = {}) => ({ sessionId: 's', revision: 1, phase: 'initializing', anchorSeq: 5, logs: 'output', cwd: '/new', branch: 'dsh/calm-otter', command: 'pnpm run setup', error: '', startedAt: 1, updatedAt: 2, endedAt: null, ...extra });
const wrap = value => ({ ok: true, value });
test('progress response validates Session, phase, bounded text and times', () => {
  assert.equal(decodePreparationResponse(wrap(null), 's'), null);
  assert.equal(decodePreparationResponse(wrap(snapshot()), 's').anchorSeq, 5);
  for (const value of [snapshot({ sessionId: 'other' }), snapshot({ phase: 'fake' }), snapshot({ logs: 'x'.repeat(32769) }), snapshot({ startedAt: NaN })]) assert.throws(() => decodePreparationResponse(wrap(value), 's'));
});
test('feed waits for start, follows revisions and stops reading after completion', async () => {
  const reads = [], states = []; const values = [null, snapshot(), snapshot({ revision: 2, phase: 'succeeded', endedAt: 10 })];
  await createPreparationFeed(async after => { reads.push(after); return wrap(values.shift()); }, value => states.push(value), new AbortController().signal, 's');
  assert.deepEqual(reads, [undefined, 0, 1]); assert.equal(states.at(-1).value.phase, 'succeeded');
});
test('cancelled feed ignores late responses and reports no false completion', async () => {
  const c = new AbortController(); let resolve; const pending = new Promise(yes => { resolve = yes; }); const states = [];
  const task = createPreparationFeed(() => pending, value => states.push(value), c.signal, 's'); c.abort(); resolve(wrap(snapshot())); await task; assert.deepEqual(states, []);
});
test('feed failure is explicit, not a successful initialization', async () => {
  const states = []; await createPreparationFeed(async () => ({ ok: false, error: { message: 'denied' } }), x => states.push(x), new AbortController().signal, 's');
  assert.equal(states[0].value, null); assert.equal(states[0].error, 'denied');
});
test('conversation entry is additive, anchors after the first human input and stays outside process folding', () => {
  let definition; const effects = [], registrations = [];
  const ctx = { effect: fn => { effects.push(fn()); }, uiConversation: { events: { register: def => { definition = def; return () => {}; } } }, slots: { inject: (_name, fn) => fn(), register: options => registrations.push(options) } };
  createPreparationUI({}, ctx, key => key).install();
  assert.equal(definition.match['agent/inbox/spliced']({ seq: 5, data: { target: 'next-turn', inserted: [{ role: 'user', source: { kind: 'user' } }] } }).id, 'preparation');
  assert.equal(definition.match['agent/inbox/spliced']({ seq: 6, data: { target: 'next-turn', inserted: [], removedCount: 1 } }), null);
  const node = definition.buildViewNode({ key: 'k', id: 'preparation', state: { seq: 5 }, matches: [] });
  assert.equal(node.anchorSeq, 5.1); assert.equal(node.groupTree, 'turn'); assert.equal(node.kind, 'dsh-minimalist-worktree.preparation');
  assert.equal(registrations[0].name, 'conversation.chat.node');
});
