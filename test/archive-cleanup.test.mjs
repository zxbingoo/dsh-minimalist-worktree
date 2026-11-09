import test from 'node:test';
import assert from 'node:assert/strict';
import { createArchiveCleanup } from '../archive-cleanup.js';
const agent = { id: 's', session: {} };
const selection = { mode: 'worktree', status: 'created', result: { path: '/pool/tree', branch: 'dsh/tree' } };
function fixture({ initial = [], active = false, other = false, noAgent = false, proxy = false } = {}) {
  let archived = [...initial], calls = 0; const results = new Map();
  const fs = { processPath: path => path, processPathFromHostPath: path => path, resolve: async path => path, contains: (root, path) => path === root || path.startsWith(root + '/') };
  const cleanup = createArchiveCleanup({ initialArchived: initial, selections: { get: () => selection }, results: { put: async (id, result) => results.set(id, result) },
    getAgent: () => noAgent ? undefined : agent, listAgents: () => other ? [agent, { id: 'other', session: {} }] : [agent], archivedNow: () => archived,
    activity: async () => active ? [{ kind: 'running' }] : [], provider: (_agent, key) => key === 'fs' ? (proxy ? { ...fs } : fs) : { get: () => proxy ? '/unrelated/repo' : '/pool/tree/subdir' },
    clean: async (_agent, _selection, { isStillSafe, onSnapshot }) => { assert.ok(await isStillSafe()); await onSnapshot({ snapshotPath: '/home/.dsh/worktree-snapshots/repo/s/uuid', manifestHash: 'a'.repeat(64) }); assert.equal(results.get('s').status, 'snapshotted'); calls++; return { status: 'removed', reason: '', path: '/pool/tree', branch: 'dsh/tree', at: 1 }; }, signal: new AbortController().signal });
  return { cleanup, results, calls: () => calls, change(ids) { archived = ids; cleanup.changed({ domain: 'workspace', table: '', key: '', operation: 'put', value: { archivedSessionIds: ids } }); } };
}
test('only future newly archived Session triggers cleanup, not startup history or unrelated writes', async () => {
  const f = fixture({ initial: ['old'] }); f.change(['old']); await f.cleanup.drain(); assert.equal(f.calls(), 0);
  f.change(['old', 's']); await f.cleanup.drain(); assert.equal(f.calls(), 1); assert.equal(f.results.get('s').status, 'removed');
  f.change(['old', 's']); await f.cleanup.drain(); assert.equal(f.calls(), 1);
});
test('running, shared, or missing execution context skips without breaking archive', async () => {
  for (const options of [{ active: true }, { other: true }, { noAgent: true }]) {
    const f = fixture(options); assert.doesNotThrow(() => f.change(['s'])); await f.cleanup.drain(); assert.equal(f.calls(), 0); assert.equal(f.results.get('s').status, 'skipped');
  }
});
test('caller-scoped proxies of the same mapped filesystem do not block unrelated Sessions', async () => {
  const f = fixture({ other: true, proxy: true }); f.change(['s']); await f.cleanup.drain(); assert.equal(f.calls(), 1); assert.equal(f.results.get('s').status, 'removed');
});
test('immediate unarchive prevents pending cleanup', async () => {
  const f = fixture(); f.change(['s']); f.change([]); await f.cleanup.drain(); assert.equal(f.calls(), 0);
});
