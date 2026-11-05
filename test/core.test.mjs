import test from 'node:test';
import assert from 'node:assert/strict';
import { argumentsOf, createOperations, foldStarted } from '../core.js';

const COMMIT_A = 'a'.repeat(40);
const COMMIT_B = 'b'.repeat(40);
const clone = value => structuredClone(value);
const check = (name, run) => test(name, { timeout: 5000 }, run);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Clone values like a durable table: callers cannot mutate stored intent by reference. */
function fixture() {
  const agent = { id: 'session-a', cwd: '/source/repo', hasStarted: false };
  const records = new Map();
  const hooks = {};
  const repositoryState = {
    kind: 'git', available: true, root: agent.cwd, branch: 'main', commit: COMMIT_A,
    branches: [{ ref: 'refs/heads/main', label: 'main', kind: 'local' }],
    truncated: false, reason: '',
  };
  const calls = { puts: [], putAttempts: [], repositories: [], resolves: [], creates: [], names: [] };
  const table = {
    get(id) { return clone(records.get(id)); },
    async put(id, value) {
      calls.putAttempts.push({ id, value: clone(value) });
      await hooks.put?.(id, clone(value));
      records.set(id, clone(value));
      calls.puts.push({ id, value: clone(value) });
    },
  };
  function finishCreation(target, request, signal) {
    signal?.throwIfAborted();
    const result = {
      path: `/isolated/${request.name}`, branch: request.name,
      baseCommit: request.from, repositoryRoot: repositoryState.root,
    };
    target.cwd = result.path;
    return result;
  }
  const dependencies = {
    table,
    cwdOf: target => target.cwd,
    started: target => target.hasStarted,
    available: target => hooks.available?.(target) ?? true,
    async repository(target, cwd, signal) {
      calls.repositories.push({ agent: target, cwd, signal });
      return hooks.repository ? hooks.repository(target, cwd, signal) : clone(repositoryState);
    },
    async resolveCommit(target, cwd, from, signal) {
      calls.resolves.push({ agent: target, cwd, from, signal });
      return hooks.resolveCommit ? hooks.resolveCommit(target, cwd, from, signal) : repositoryState.commit;
    },
    async createWorktree(target, request, signal) {
      calls.creates.push({ agent: target, request: clone(request), signal, cwd: target.cwd });
      return hooks.createWorktree
        ? hooks.createWorktree(target, request, signal)
        : finishCreation(target, request, signal);
    },
    makeName(target) {
      const name = `fresh-${calls.names.length + 1}`;
      calls.names.push({ agent: target, name });
      return name;
    },
  };
  return {
    agent, records, table, hooks, calls, repositoryState, finishCreation,
    operations: createOperations(dependencies),
    restart: () => createOperations(dependencies),
  };
}

const select = (f, fields = {}, signal) => f.operations.operate(
  f.agent, { action: 'select', mode: 'worktree', ...fields }, signal,
);
const selection = f => f.table.get(f.agent.id);

check('argumentsOf accepts strict valid shapes, defaults HEAD, and does not mutate input', () => {
  assert.deepEqual(argumentsOf({ action: 'inspect' }), { action: 'inspect' });
  assert.deepEqual(argumentsOf({ action: 'select', mode: 'local' }), { action: 'select', mode: 'local' });
  const input = Object.freeze({ action: 'select', mode: 'worktree', expectedRevision: 0 });
  assert.deepEqual(argumentsOf(input), { ...input, from: 'HEAD' });
  assert.equal(Object.hasOwn(input, 'from'), false);
  const bounded = { action: 'select', mode: 'worktree', from: 'x'.repeat(1024), expectedRevision: Number.MAX_SAFE_INTEGER };
  assert.deepEqual(argumentsOf(bounded), bounded);
});

const invalidArguments = [
  ['null', null], ['boolean', true], ['number', 0], ['string', 'inspect'], ['array', []],
  ['missing action', {}], ['unsupported action', { action: 'prepare' }],
  ['unknown field', { action: 'inspect', cwd: '/elsewhere' }],
  ['inspect selection field', { action: 'inspect', mode: 'local' }],
  ['inspect undefined selection field', { action: 'inspect', from: undefined }],
  ['missing mode', { action: 'select' }],
  ['unsupported mode', { action: 'select', mode: 'existing-worktree' }],
  ['Local branch change', { action: 'select', mode: 'local', from: 'main' }],
  ['non-string revision', { action: 'select', mode: 'worktree', from: 123 }],
  ['empty revision', { action: 'select', mode: 'worktree', from: '' }],
  ['oversized revision', { action: 'select', mode: 'worktree', from: 'x'.repeat(1025) }],
  ['NUL revision', { action: 'select', mode: 'worktree', from: 'main\0other' }],
  ['negative selection revision', { action: 'select', mode: 'worktree', expectedRevision: -1 }],
  ['fractional selection revision', { action: 'select', mode: 'worktree', expectedRevision: 1.5 }],
  ['unsafe selection revision', { action: 'select', mode: 'worktree', expectedRevision: Number.MAX_SAFE_INTEGER + 1 }],
  ['NaN selection revision', { action: 'select', mode: 'worktree', expectedRevision: NaN }],
  ['infinite selection revision', { action: 'select', mode: 'worktree', expectedRevision: Infinity }],
  ['string selection revision', { action: 'select', mode: 'worktree', expectedRevision: '0' }],
  ['null selection revision', { action: 'select', mode: 'worktree', expectedRevision: null }],
  ['unknown select field', { action: 'select', mode: 'worktree', branch: 'main' }],
];
for (const [label, value] of invalidArguments) {
  check(`argumentsOf rejects ${label}`, () => assert.throws(() => argumentsOf(value), TypeError));
}

check('invalid operation arguments have no persistence or repository side effects', async () => {
  const f = fixture();
  await assert.rejects(select(f, { mode: 'local', from: 'main' }), TypeError);
  assert.equal(f.records.size, 0);
  assert.equal(f.calls.repositories.length + f.calls.resolves.length + f.calls.creates.length, 0);
});

check('foldStarted recognizes message/turn events and remains sticky', () => {
  for (const type of ['turn/start', 'user/message', 'assistant/message']) {
    assert.equal(foldStarted(false, { type }), true, type);
  }
  assert.equal(foldStarted(false, { type: 'command/run' }), false);
  assert.equal(foldStarted(false, { type: 'working-directory/change' }), false);
  assert.equal(foldStarted(true, { type: 'unrelated' }), true);
});

check('inspect returns a blank editable snapshot without persisting or allocating', async () => {
  const f = fixture();
  const value = await f.operations.operate(f.agent, { action: 'inspect' });
  assert.deepEqual(value, {
    sessionId: f.agent.id, cwd: f.agent.cwd, editable: true,
    revision: 0, selection: null, repository: f.repositoryState,
  });
  assert.equal(f.records.size, 0);
  assert.equal(f.calls.puts.length + f.calls.resolves.length + f.calls.creates.length, 0);
});

check('prepare with no choice is a complete no-op', async () => {
  const f = fixture();
  f.agent.hasStarted = true;
  assert.equal(await f.operations.prepare(f.agent), undefined);
  assert.equal(f.records.size, 0);
  assert.equal(Object.values(f.calls).flat().length, 0);
});

check('Local selection never resolves a base, allocates a worktree, or changes branch/cwd', async () => {
  const f = fixture();
  const cwd = f.agent.cwd;
  const branch = f.repositoryState.branch;
  const value = await select(f, { mode: 'local', expectedRevision: 0 });
  assert.equal(value.selection.mode, 'local');
  assert.equal(value.selection.baseCommit, '');
  assert.equal(value.selection.name, '');
  assert.equal(value.revision, 1);
  f.agent.hasStarted = true;
  assert.equal(await f.operations.prepare(f.agent), undefined);
  assert.equal(f.agent.cwd, cwd);
  assert.equal(f.repositoryState.branch, branch);
  assert.equal(f.calls.resolves.length + f.calls.creates.length + f.calls.names.length, 0);
  assert.equal(f.calls.puts.length, 1);
});

check('worktree selection pins the commit and generated name before the first message', async () => {
  const f = fixture();
  const value = await select(f, { from: 'refs/heads/release', expectedRevision: 0 });
  assert.deepEqual(value.selection, {
    mode: 'worktree', from: 'refs/heads/release', baseCommit: COMMIT_A,
    sourceCwd: '/source/repo', name: 'fresh-1', status: 'staged', revision: 1, error: '',
  });
  assert.equal(f.calls.creates.length, 0);
  assert.equal(f.agent.cwd, '/source/repo');
  f.repositoryState.commit = COMMIT_B;
  f.agent.hasStarted = true;
  const result = await f.operations.prepare(f.agent);
  assert.deepEqual(f.calls.creates[0].request, { name: 'fresh-1', from: COMMIT_A });
  assert.equal(result.baseCommit, COMMIT_A);
  assert.equal(f.calls.resolves[0].from, 'refs/heads/release');
  assert.equal(f.calls.resolves.length, 1);
  assert.equal(f.calls.names.length, 1);
  assert.equal(selection(f).status, 'created');
});

check('reselecting a worktree updates the pinned base but retains its stable name', async () => {
  const f = fixture();
  const first = await select(f);
  f.repositoryState.commit = COMMIT_B;
  const second = await select(f, { from: 'refs/heads/next', expectedRevision: 1 });
  assert.equal(second.selection.name, first.selection.name);
  assert.equal(second.selection.baseCommit, COMMIT_B);
  assert.equal(second.selection.from, 'refs/heads/next');
  assert.equal(second.revision, 2);
  assert.equal(f.calls.names.length, 1);
  assert.equal(f.calls.creates.length, 0);
});

check('switching back to Local clears the worktree plan without changing branches', async () => {
  const f = fixture();
  await select(f);
  const value = await select(f, { mode: 'local', expectedRevision: 1 });
  assert.equal(value.selection.mode, 'local');
  assert.equal(value.selection.name, '');
  assert.equal(value.selection.baseCommit, '');
  assert.equal(value.revision, 2);
  f.agent.hasStarted = true;
  await f.operations.prepare(f.agent);
  assert.equal(f.calls.creates.length, 0);
  assert.equal(f.agent.cwd, '/source/repo');
  assert.equal(f.repositoryState.branch, 'main');
});

check('a fresh non-Git workspace stays implicitly Local without saving or allocating', async () => {
  const f = fixture();
  Object.assign(f.repositoryState, { kind: 'none', available: false, root: '', branch: '', commit: '', branches: [] });
  const inspected = await f.operations.operate(f.agent, { action: 'inspect' });
  assert.equal(inspected.selection, null);
  assert.equal(inspected.repository.kind, 'none');
  await f.operations.prepare(f.agent);
  assert.equal(f.records.size, 0);
  assert.equal(f.calls.creates.length, 0);
  assert.equal(f.agent.cwd, '/source/repo');
});

check('switching a staged session to a non-Git workspace selects Local before running', async () => {
  const f = fixture();
  await select(f);
  f.agent.cwd = '/plain/workspace';
  f.agent.hasStarted = true;
  Object.assign(f.repositoryState, { kind: 'none', available: false, root: '', branch: '', commit: '', branches: [] });
  await f.operations.prepare(f.agent);
  assert.deepEqual(selection(f), {
    mode: 'local', from: 'HEAD', baseCommit: '', sourceCwd: '/plain/workspace', name: '',
    status: 'staged', revision: 2, error: '',
  });
  await f.restart().prepare(f.agent);
  assert.equal(f.calls.creates.length, 0);
  assert.equal(f.agent.cwd, '/plain/workspace');
});

check('non-Git Local default is committed before preparation returns', async () => {
  const f = fixture();
  await select(f);
  f.repositoryState.kind = 'none';
  f.repositoryState.available = false;
  const saved = selection(f);
  f.hooks.put = () => { throw new Error('Local default could not be persisted'); };
  await assert.rejects(f.operations.prepare(f.agent), /could not be persisted/);
  assert.deepEqual(selection(f), saved);
  assert.equal(f.calls.creates.length, 0);
});

check('non-Git detection never masks a previous failed or interrupted allocation', async () => {
  for (const status of ['creating', 'failed']) {
    const f = fixture();
    await select(f);
    await f.table.put(f.agent.id, { ...selection(f), status });
    f.repositoryState.kind = 'none';
    f.repositoryState.available = false;
    await assert.rejects(f.operations.prepare(f.agent), /no automatic retry or local fallback/);
    assert.equal(selection(f).status, status);
    assert.equal(selection(f).mode, 'worktree');
    assert.equal(f.calls.creates.length, 0);
  }
});

check('unknown Git inspection does not silently change a staged worktree to Local', async () => {
  const f = fixture();
  await select(f);
  Object.assign(f.repositoryState, { kind: 'unknown', available: false, reason: 'Git inspection denied' });
  f.hooks.createWorktree = () => { throw new Error('policy denied creation'); };
  await assert.rejects(f.operations.prepare(f.agent), /policy denied creation/);
  assert.equal(selection(f).mode, 'worktree');
  assert.equal(selection(f).status, 'failed');
});

check('only blank sessions accept either mode; nonblank sessions remain inspectable', async () => {
  const f = fixture();
  f.agent.hasStarted = true;
  for (const mode of ['local', 'worktree']) {
    await assert.rejects(select(f, { mode }), /before the first message/);
  }
  assert.equal(f.records.size, 0);
  assert.equal(f.calls.repositories.length + f.calls.resolves.length + f.calls.names.length, 0);
  const value = await f.operations.operate(f.agent, { action: 'inspect' });
  assert.equal(value.editable, false);
});

check('stale expectedRevision refuses both missing and changed selections without mutation', async () => {
  const f = fixture();
  await assert.rejects(select(f, { expectedRevision: 1 }), /another window/);
  assert.equal(f.records.size, 0);
  await select(f, { expectedRevision: 0 });
  const saved = selection(f);
  await assert.rejects(select(f, { mode: 'local', expectedRevision: 0 }), /another window/);
  assert.deepEqual(selection(f), saved);
  assert.equal(f.calls.puts.length, 1);
  assert.equal(f.calls.repositories.length, 1);
});

for (const phase of ['repository', 'resolveCommit']) {
  check(`sending during ${phase} validation rejects a late selection`, async t => {
    const f = fixture();
    const entered = deferred();
    const release = deferred();
    t.after(() => release.resolve());
    f.hooks[phase] = async () => {
      entered.resolve();
      await release.promise;
      return phase === 'repository' ? clone(f.repositoryState) : COMMIT_A;
    };
    const pending = select(f);
    const rejected = assert.rejects(pending, /before the first message/);
    await entered.promise;
    f.agent.hasStarted = true;
    release.resolve();
    await rejected;
    assert.equal(f.records.size, 0);
    assert.equal(f.calls.creates.length + f.calls.names.length, 0);
  });

  check(`cwd changes during ${phase} validation reject the old workspace choice`, async t => {
    const f = fixture();
    const entered = deferred();
    const release = deferred();
    t.after(() => release.resolve());
    f.hooks[phase] = async () => {
      entered.resolve();
      await release.promise;
      return phase === 'repository' ? clone(f.repositoryState) : COMMIT_A;
    };
    const pending = select(f);
    const rejected = assert.rejects(pending, /workspace changed while saving/);
    await entered.promise;
    f.agent.cwd = '/another/repository';
    release.resolve();
    await rejected;
    assert.equal(f.records.size, 0);
    assert.equal(f.calls.creates.length + f.calls.names.length, 0);
  });
}

check('cancellation during validation rejects without saving a late choice', async t => {
  const f = fixture();
  const entered = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  const controller = new AbortController();
  const reason = new Error('selection cancelled');
  f.hooks.resolveCommit = async () => { entered.resolve(); await release.promise; return COMMIT_A; };
  const pending = select(f, {}, controller.signal);
  const rejected = assert.rejects(pending, error => error === reason);
  await entered.promise;
  controller.abort(reason);
  release.resolve();
  await rejected;
  assert.equal(f.records.size, 0);
  assert.equal(f.calls.creates.length, 0);
});

check('pre-aborted inspect and select do not access the repository or storage', async () => {
  const f = fixture();
  const controller = new AbortController();
  const reason = new Error('already cancelled');
  controller.abort(reason);
  await assert.rejects(f.operations.operate(f.agent, { action: 'inspect' }, controller.signal), error => error === reason);
  await assert.rejects(select(f, {}, controller.signal), error => error === reason);
  assert.equal(Object.values(f.calls).flat().length, 0);
  assert.equal(f.records.size, 0);
});

check('unavailable worktree service refuses worktree selection but not Local', async () => {
  const f = fixture();
  f.hooks.available = () => false;
  await assert.rejects(select(f), /service is unavailable/);
  assert.equal(f.records.size, 0);
  assert.equal(f.calls.resolves.length, 0);
  const local = await select(f, { mode: 'local' });
  assert.equal(local.selection.mode, 'local');
  assert.equal(local.repository.available, false);
  assert.match(local.repository.reason, /service is unavailable/);
  assert.equal(f.calls.creates.length, 0);
});

check('an unavailable repository refuses selection before resolving or allocating', async () => {
  const f = fixture();
  f.repositoryState.available = false;
  f.repositoryState.reason = 'This repository has no commits.';
  await assert.rejects(select(f), /repository has no commits/);
  assert.equal(f.records.size, 0);
  assert.equal(f.calls.resolves.length + f.calls.creates.length, 0);
});

check('prepare refuses a workspace changed since staging and never allocates', async () => {
  const f = fixture();
  await select(f);
  const saved = selection(f);
  f.agent.hasStarted = true;
  f.agent.cwd = '/another/repository';
  await assert.rejects(f.operations.prepare(f.agent), /different workspace/);
  assert.deepEqual(selection(f), saved);
  assert.equal(f.calls.creates.length, 0);
});

check('concurrent choice and prepare are serialized for the same session', async t => {
  const f = fixture();
  const entered = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  f.hooks.resolveCommit = async () => { entered.resolve(); await release.promise; return COMMIT_A; };
  const choosing = select(f);
  await entered.promise;
  const preparing = f.operations.prepare(f.agent);
  assert.equal(f.calls.creates.length, 0);
  assert.equal(f.calls.puts.length, 0);
  release.resolve();
  const [chosen, created] = await Promise.all([choosing, preparing]);
  assert.equal(chosen.selection.status, 'staged');
  assert.equal(created.baseCommit, COMMIT_A);
  assert.deepEqual(f.calls.puts.map(call => call.value.status), ['staged', 'creating', 'created']);
  assert.equal(f.calls.creates.length, 1);
});

check('concurrent choices cannot both commit the same expectedRevision', async t => {
  const f = fixture();
  const entered = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  f.hooks.resolveCommit = async () => { entered.resolve(); await release.promise; return COMMIT_A; };
  const first = select(f, { expectedRevision: 0 });
  await entered.promise;
  const second = select(f, { mode: 'local', expectedRevision: 0 });
  const rejected = assert.rejects(second, /another window/);
  release.resolve();
  await first;
  await rejected;
  assert.equal(selection(f).mode, 'worktree');
  assert.equal(selection(f).revision, 1);
  assert.equal(f.calls.puts.length, 1);
});

check('a blocked choice in one session does not serialize unrelated sessions', async t => {
  const f = fixture();
  const entered = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  f.hooks.resolveCommit = async () => { entered.resolve(); await release.promise; return COMMIT_A; };
  const first = select(f);
  await entered.promise;
  const other = { id: 'session-b', cwd: '/another/repo', hasStarted: false };
  const second = await f.operations.operate(other, { action: 'select', mode: 'local' });
  assert.equal(second.sessionId, other.id);
  assert.equal(f.table.get(f.agent.id), undefined);
  assert.equal(f.table.get(other.id).mode, 'local');
  release.resolve();
  await first;
  await f.operations.drain();
});

check('concurrent preparations allocate once and subsequent success is a no-op', async t => {
  const f = fixture();
  await select(f);
  f.agent.hasStarted = true;
  const entered = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  f.hooks.createWorktree = async (agent, request, signal) => {
    entered.resolve();
    await release.promise;
    return f.finishCreation(agent, request, signal);
  };
  const first = f.operations.prepare(f.agent);
  await entered.promise;
  const second = f.operations.prepare(f.agent);
  assert.equal(selection(f).status, 'creating');
  assert.equal(f.calls.creates.length, 1);
  release.resolve();
  const [result, duplicate] = await Promise.all([first, second]);
  assert.equal(duplicate, undefined);
  assert.deepEqual(selection(f).result, result);
  const saved = selection(f);
  assert.equal(await f.operations.prepare(f.agent), undefined);
  assert.equal(await f.restart().prepare(f.agent), undefined);
  assert.deepEqual(selection(f), saved);
  assert.equal(f.calls.creates.length, 1);
  assert.equal(f.calls.puts.length, 3);
});

check('creating intent is durably committed before the allocation call', async t => {
  const f = fixture();
  await select(f);
  f.agent.hasStarted = true;
  const entered = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  f.hooks.put = async (_id, value) => {
    if (value.status === 'creating') { entered.resolve(); await release.promise; }
  };
  f.hooks.createWorktree = (agent, request, signal) => {
    assert.equal(selection(f).status, 'creating');
    assert.deepEqual(f.calls.puts.map(call => call.value.status), ['staged', 'creating']);
    return f.finishCreation(agent, request, signal);
  };
  const pending = f.operations.prepare(f.agent);
  await entered.promise;
  assert.equal(selection(f).status, 'staged');
  assert.equal(f.calls.creates.length, 0);
  release.resolve();
  await pending;
  assert.equal(selection(f).status, 'created');
});

check('failure to persist creating intent prevents any allocation', async () => {
  const f = fixture();
  await select(f);
  const saved = selection(f);
  const reason = new Error('storage unavailable before allocation');
  f.hooks.put = (_id, value) => { if (value.status === 'creating') throw reason; };
  await assert.rejects(f.operations.prepare(f.agent), error => error === reason);
  assert.deepEqual(selection(f), saved);
  assert.equal(f.calls.creates.length, 0);
});

check('allocation failure stays failed across retries/restart with no Local fallback', async () => {
  const f = fixture();
  await select(f);
  f.agent.hasStarted = true;
  const reason = new Error('Git failed after retaining a branch');
  f.hooks.createWorktree = () => { throw reason; };
  await assert.rejects(f.operations.prepare(f.agent), error => {
    assert.match(error.message, /model was not started in the local checkout/);
    assert.equal(error.cause, reason);
    return true;
  });
  const failed = selection(f);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.mode, 'worktree');
  assert.equal(failed.error, reason.message);
  await assert.rejects(f.operations.prepare(f.agent), /no automatic retry or local fallback/);
  await assert.rejects(f.restart().prepare(f.agent), /no automatic retry or local fallback/);
  assert.deepEqual(selection(f), failed);
  assert.equal(f.calls.creates.length, 1);
  assert.equal(f.agent.cwd, '/source/repo');
});

check('cancellation during allocation persists failure and cannot retry or fall back', async () => {
  const f = fixture();
  await select(f);
  f.agent.hasStarted = true;
  const controller = new AbortController();
  const entered = deferred();
  const reason = new Error('creation cancelled after intent');
  f.hooks.createWorktree = (_agent, _request, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    entered.resolve();
  });
  const pending = f.operations.prepare(f.agent, controller.signal);
  const rejected = assert.rejects(pending, error => error.cause === reason);
  await entered.promise;
  assert.equal(selection(f).status, 'creating');
  controller.abort(reason);
  await rejected;
  assert.equal(f.calls.creates[0].signal, controller.signal);
  assert.equal(selection(f).status, 'failed');
  assert.equal(selection(f).error, reason.message);
  await assert.rejects(f.operations.prepare(f.agent), /no automatic retry or local fallback/);
  await assert.rejects(f.restart().prepare(f.agent), /no automatic retry or local fallback/);
  assert.equal(f.calls.creates.length, 1);
  assert.equal(selection(f).mode, 'worktree');
  assert.equal(f.agent.cwd, '/source/repo');
});

check('pre-aborted preparation leaves the staged plan untouched without allocating', async () => {
  const f = fixture();
  await select(f);
  const saved = selection(f);
  const controller = new AbortController();
  const reason = new Error('cancelled before attempt');
  controller.abort(reason);
  await assert.rejects(f.operations.prepare(f.agent, controller.signal), error => error === reason);
  assert.deepEqual(selection(f), saved);
  assert.equal(f.calls.creates.length, 0);
  assert.equal(f.calls.puts.length, 1);
});

check('failure to save failure leaves durable creating intent that prevents duplicate allocation', async () => {
  const f = fixture();
  await select(f);
  const reason = new Error('allocation failed');
  f.hooks.createWorktree = () => { throw reason; };
  f.hooks.put = (_id, value) => { if (value.status === 'failed') throw new Error('storage still unavailable'); };
  await assert.rejects(f.operations.prepare(f.agent), error => error.cause === reason);
  assert.equal(selection(f).status, 'creating');
  await assert.rejects(f.operations.prepare(f.agent), /preparation is creating.*no automatic retry/);
  await assert.rejects(f.restart().prepare(f.agent), /previous attempt may have retained files and a branch/);
  assert.equal(f.calls.creates.length, 1);
});

check('failure to save created result never allocates again even after cwd changed', async () => {
  const f = fixture();
  await select(f);
  const reason = new Error('result persistence failed');
  f.hooks.put = (_id, value) => { if (value.status === 'created') throw reason; };
  await assert.rejects(f.operations.prepare(f.agent), error => error.cause === reason);
  assert.equal(f.agent.cwd, '/isolated/fresh-1');
  assert.equal(selection(f).status, 'failed');
  assert.equal(selection(f).error, reason.message);
  await assert.rejects(f.restart().prepare(f.agent), /no automatic retry or local fallback/);
  assert.equal(f.calls.creates.length, 1);
});

check('restart with only a durable creating record refuses duplicate allocation', async () => {
  const f = fixture();
  await select(f);
  await f.table.put(f.agent.id, { ...selection(f), status: 'creating' });
  const recovered = f.restart();
  await assert.rejects(recovered.prepare(f.agent), /preparation is creating.*no automatic retry/);
  assert.equal(selection(f).status, 'creating');
  assert.equal(f.calls.creates.length, 0);
});

check('cwd change while creating intent is persisted must not allocate in another checkout', async t => {
  const f = fixture();
  await select(f);
  f.agent.hasStarted = true;
  const entered = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  f.hooks.put = async (_id, value) => {
    if (value.status === 'creating') { entered.resolve(); await release.promise; }
  };
  const pending = f.operations.prepare(f.agent);
  const rejected = assert.rejects(pending, /workspace/i);
  await entered.promise;
  f.agent.cwd = '/another/repository';
  release.resolve();
  await rejected;
  assert.equal(f.calls.creates.length, 0);
  assert.ok(['creating', 'failed'].includes(selection(f).status));
  await assert.rejects(f.restart().prepare(f.agent), /no automatic retry or local fallback/);
});

check('cancellation while persisting creating intent must not call the allocator', async t => {
  const f = fixture();
  await select(f);
  f.agent.hasStarted = true;
  const entered = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  const controller = new AbortController();
  const reason = new Error('cancelled while saving creating intent');
  f.hooks.put = async (_id, value) => {
    if (value.status === 'creating') { entered.resolve(); await release.promise; }
  };
  const pending = f.operations.prepare(f.agent, controller.signal);
  const rejected = assert.rejects(pending, error => error === reason || error.cause === reason);
  await entered.promise;
  controller.abort(reason);
  release.resolve();
  await rejected;
  assert.equal(f.calls.creates.length, 0);
  assert.ok(['creating', 'failed'].includes(selection(f).status));
  await assert.rejects(f.restart().prepare(f.agent), /no automatic retry or local fallback/);
});
