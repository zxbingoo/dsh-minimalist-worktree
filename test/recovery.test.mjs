import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecoveryOperations, recoveryStateSchema, recoveryRequestSchema } from '../recovery.js';
const COMMIT = 'a'.repeat(40), TIP = 'b'.repeat(40);
function fixture(options = {}) {
  const agent = { id: 's', session: {} }, selection = { mode: 'worktree', status: 'created', revision: 3, sourceCwd: '/repo', result: { path: '/pool/tree', branch: 'dsh/tree', repositoryRoot: '/repo', baseCommit: COMMIT }, initialization: { status: 'succeeded', reason: '' } };
  const values = new Map([['s', selection]]), decisions = new Map(), calls = [];
  let cwd = options.cwd ?? '/repo', exists = options.exists ?? false, branchExists = options.branchExists ?? true, sourceBranch = 'main', sourceCommit = COMMIT;
  const fs = { resolve: async value => ({ targetKey: value, path: value }), processPath: target => target.path,
    contains: (parent, child) => child.path === parent.path || child.path.startsWith(parent.path + '/'),
    lstat: async value => value === '/pool/tree' && exists ? { type: 'directory', version: 'identity1' } : undefined,
    stat: async target => ({ type: target.path === '/repo' ? 'directory' : 'other' }) };
  const git = { inspect: async (_a, path) => path.startsWith('/pool/tree') ? { kind: 'git', available: true, root: '/pool/tree', branch: options.treeBranch ?? 'dsh/tree', commit: TIP } : { kind: 'git', available: true, root: '/repo', branch: sourceBranch, commit: sourceCommit },
    branchExists: async () => branchExists, resolveCommit: async (_a, _cwd, from) => from.startsWith('refs/heads/') ? TIP : from };
  const table = map => ({ get: id => structuredClone(map.get(id)), async put(id, value) { map.set(id, structuredClone(value)); } });
  const provider = (_a, key) => key === 'fs' ? fs : key === 'workingDirectory' ? { get: () => cwd, async set(_a, path) { calls.push(['set', path]); cwd = path; } } : null;
  const ops = createRecoveryOperations({ selections: table(values), decisions: table(decisions), provider, git,
    assertIdle: async () => { if (options.busy) throw new Error('Session busy'); },
    rebuild: async (_a, plan) => { calls.push(['rebuild', plan]); if (options.rebuildError) throw new Error('checkout failed'); exists = true; cwd = '/pool/tree'; return { ...selection.result, baseCommit: plan.commit }; },
    initialize: async () => { calls.push(['initialize']); if (options.initError) throw new Error('setup failed'); return { status: 'succeeded', reason: '' }; } });
  return { ops, agent, calls, values, decisions, setCwd: value => { cwd = value; }, setSource: (branch, commit = COMMIT) => { sourceBranch = branch; sourceCommit = commit; }, setExists: value => { exists = value; }, setBranchExists: value => { branchExists = value; } };
}
test('inspect/guard are read-only and missing worktree blocks source fallback', async () => {
  const f = fixture(), state = await f.ops.inspect(f.agent); recoveryStateSchema.parse(state);
  assert.equal(state.blocked, true); assert.equal(state.expectedPath, '/pool/tree'); assert.equal(state.sourceBranch, 'main'); assert.equal(state.candidateCommit, TIP); assert.equal(state.canRebuild, true);
  await assert.rejects(f.ops.assertReady(f.agent), /original isolated worktree is missing/); assert.deepEqual(f.calls, []); assert.equal(f.decisions.size, 0);
});
test('existing worktree descendants are allowed, unexpected cwd and changed branch are blocked', async () => {
  const f = fixture({ exists: true, cwd: '/pool/tree/subdir' }); assert.equal((await f.ops.assertReady(f.agent)).blocked, false);
  f.setCwd('/elsewhere'); assert.equal((await f.ops.inspect(f.agent)).blocked, true); assert.equal((await f.ops.inspect(f.agent)).canRebuild, false);
  const g = fixture({ exists: true, cwd: '/pool/tree', treeBranch: 'other' }); await assert.rejects(g.ops.assertReady(g.agent));
});
test('source choice requires token plus second confirmation and source HEAD/branch changes invalidate approval', async () => {
  const f = fixture(), state = await f.ops.inspect(f.agent);
  await assert.rejects(f.ops.choose(f.agent, { action: 'source', token: state.token }));
  assert.equal((await f.ops.choose(f.agent, { action: 'source', token: state.token, confirmSource: true })).blocked, false);
  assert.equal((await f.ops.assertReady(f.agent)).blocked, false); assert.deepEqual(f.calls, [['set', '/repo']]);
  f.setSource('main', TIP); await assert.rejects(f.ops.assertReady(f.agent));
  const next = await f.ops.inspect(f.agent); f.setSource('other'); await assert.rejects(f.ops.choose(f.agent, { action: 'source', token: next.token, confirmSource: true }), /state changed/);
});
test('a previous source approval cannot override failed or running initialization', async () => {
  const f = fixture(), state = await f.ops.inspect(f.agent);
  await f.ops.choose(f.agent, { action: 'source', token: state.token, confirmSource: true });
  for (const status of ['running', 'failed']) {
    f.values.get('s').initialization = { status, reason: 'setup interrupted' };
    const next = await f.ops.inspect(f.agent); assert.equal(next.blocked, true); assert.equal(next.canUseSource, false); assert.equal(next.canRebuild, false);
    await assert.rejects(f.ops.assertReady(f.agent));
  }
});
test('source approval never follows user to another cwd', async () => {
  const f = fixture(), state = await f.ops.inspect(f.agent); await f.ops.choose(f.agent, { action: 'source', token: state.token, confirmSource: true }); f.setCwd('/repo/sub'); await assert.rejects(f.ops.assertReady(f.agent));
});
test('rebuild pins existing branch tip and runs setup once; repeated choice cannot allocate again', async () => {
  const f = fixture(), state = await f.ops.inspect(f.agent);
  const result = await f.ops.choose(f.agent, { action: 'rebuild', token: state.token }); assert.equal(result.blocked, false); assert.equal(f.calls[0][1].commit, TIP);
  assert.equal(f.values.get('s').result.path, '/pool/tree'); assert.equal(f.decisions.get('s').status, 'rebuilt');
  await assert.rejects(f.ops.choose(f.agent, { action: 'rebuild', token: state.token })); assert.equal(f.calls.filter(x => x[0] === 'rebuild').length, 1);
});
test('deleted branch requires explicit confirmation of displayed original fallback, never current source HEAD', async () => {
  const f = fixture({ branchExists: false }); f.setSource('v4.56', TIP); const state = await f.ops.inspect(f.agent); assert.equal(state.candidateCommit, COMMIT);
  await assert.rejects(f.ops.choose(f.agent, { action: 'rebuild', token: state.token }), /confirm/);
  await assert.rejects(f.ops.choose(f.agent, { action: 'rebuild', token: state.token, confirmCommit: TIP }), /confirm/);
  await f.ops.choose(f.agent, { action: 'rebuild', token: state.token, confirmCommit: COMMIT }); assert.equal(f.calls[0][1].commit, COMMIT);
});
test('failed setup or checkout stays durably fail-closed across repeated guard and rebuild', async () => {
  for (const options of [{ initError: true }, { rebuildError: true }]) {
    const f = fixture(options), state = await f.ops.inspect(f.agent);
    await assert.rejects(f.ops.choose(f.agent, { action: 'rebuild', token: state.token }), /recovery failed/);
    assert.equal(f.decisions.get('s').status, 'failed'); await assert.rejects(f.ops.assertReady(f.agent));
    const current = await f.ops.inspect(f.agent); assert.equal(current.canRebuild, false); await assert.rejects(f.ops.choose(f.agent, { action: 'rebuild', token: current.token }));
    assert.equal(f.calls.filter(x => x[0] === 'rebuild').length, 1);
  }
});
test('stale selection revision/destination/branch invalidates token and busy Session cannot mutate', async () => {
  const f = fixture(), state = await f.ops.inspect(f.agent); f.values.get('s').revision++; await assert.rejects(f.ops.choose(f.agent, { action: 'source', token: state.token, confirmSource: true }), /state changed/);
  const g = fixture({ busy: true }), current = await g.ops.inspect(g.agent); await assert.rejects(g.ops.choose(g.agent, { action: 'source', token: current.token, confirmSource: true }), /busy/); assert.deepEqual(g.calls, []);
});
test('schemas reject unknown mutating fields; local selections and absent history need no recovery', async () => {
  assert.throws(() => recoveryRequestSchema.parse({ action: 'source', token: 'a'.repeat(64), confirmSource: true, force: true }));
  const f = fixture(); f.values.delete('s'); assert.equal((await f.ops.assertReady(f.agent)).blocked, false);
  const c = new AbortController(); c.abort(); await assert.rejects(f.ops.inspect(f.agent, c.signal)); await f.ops.drain();
});
