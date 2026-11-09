import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { TypertRemoteService, RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import * as host from '../index.js';
import { NS, SERVICE, STARTED } from '../core.js';
import { REFRESH } from '../changes.js';

// Resolve the exact Cordis peer used by the real TypertRemoteService base class.
const require = createRequire(import.meta.resolve('@deepseek-ai/dsh-typert-protocol'));
const { Context } = require('@deepseek-ai/cordis');
const COMMIT = 'a'.repeat(40);
const clone = value => structuredClone(value);
const check = (name, run) => test(name, { timeout: 5000 }, run);

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

/** Real Cordis lifetime, service registration, injection, and waterfall; no live profile. */
async function fixture(t, { modernProjections = false } = {}) {
  const ctx = new Context();
  const session = { id: 'host-session' };
  const agent = { id: session.id, session };
  const agents = new Map([[agent.id, agent]]);
  const cwds = new Map([[session.id, '/source/repo']]);
  const begun = new Map([[session.id, false]]);
  const records = new Map();
  const contributions = new Set();
  const definitions = new Set();
  const tools = new Map();
  const hooks = {};
  const calls = { opened: [], puts: [], creates: [], subprocess: [], closed: 0 };
  let valueSchema;
  const table = {
    get(id) { return clone(records.get(id)); },
    async put(id, value) {
      const parsed = valueSchema.parse(value);
      await hooks.put?.(id, parsed);
      records.set(id, clone(parsed));
      calls.puts.push({ id, value: clone(parsed) });
    },
  };
  const dependencies = {
    storageDomain: {
      async open(options) {
        // Match the actual storage unit grammar, not package-name grammar.
        assert.match(options.name, /^[a-z][a-z0-9_]*$/);
        if (options.name === 'dsh_minimalist_worktree_progress') {
          const values = new Map(), schema = options.tables.preparations.valueSchema;
          return { table(name) { assert.equal(name, 'preparations'); return { get: id => clone(values.get(id)), async put(id, value) { values.set(id, schema.parse(value)); } }; }, async close() {} };
        }
        if (options.name === 'dsh_minimalist_worktree_recovery') {
          const values = new Map(), schema = options.tables.decisions.valueSchema;
          return { table(name) { assert.equal(name, 'decisions'); return { get: id => clone(values.get(id)), async put(id, value) { values.set(id, schema.parse(value)); } }; }, async close() {} };
        }
        assert.equal(options.name, 'dsh_minimalist_worktree');
        assert.deepEqual(Object.keys(options).sort(), ['layout', 'name', 'tables', 'version']);
        assert.equal(options.version, 1);
        assert.equal(options.layout, 'per-record');
        assert.deepEqual(Object.keys(options.tables), ['selections']);
        assert.deepEqual(Object.keys(options.tables.selections), ['valueSchema']);
        valueSchema = options.tables.selections.valueSchema;
        calls.opened.push(options);
        return {
          table(name) { assert.equal(name, 'selections'); return table; },
          async close() { calls.closed += 1; },
        };
      },
    },
    sessionProjections: {
      register(definition) {
        assert.ok([STARTED, REFRESH].includes(definition.key));
        if (modernProjections) return Promise.resolve().then(() => {
          definitions.add(definition);
          return {
            stateOf(target) { assert.equal(definition.key, STARTED); return begun.get(target.id); },
            async dispose() { definitions.delete(definition); },
          };
        });
        definitions.add(definition);
        return () => definitions.delete(definition);
      },
      stateOf(target, key) { assert.equal(key, STARTED); return begun.get(target.id); },
    },
    workingDirectory: {
      get: target => cwds.get(target.id), ensure: async target => cwds.get(target.session.id),
      async set(target, value) { cwds.set(target.session.id, value); return value; },
    },
    fs: {
      resolve: async (value, opts = {}) => { const resolved = value.startsWith('/') ? value : `${opts.cwd}/${value}`; return { targetKey: resolved, path: resolved }; },
      processPath: value => value.path,
      contains: (parent, child) => parent.path === child.path || child.path.startsWith(`${parent.path}/`),
      async lstat(value) { return calls.creates.length && [...cwds.values()].some(cwd => cwd === value && cwd !== '/source/repo') ? { type: 'directory', version: '1' } : undefined; },
      async stat() { return { type: 'directory', version: '1' }; },
    },
    sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) },
    sandbox: { confine() { throw new Error('Full-access fixture should not confine Git.'); } },
    subprocess: {
      resolveExecutable: async name => { assert.ok(['git', 'node'].includes(name)); return `/bin/${name}`; },
      spawn(options) {
        calls.subprocess.push(options);
        if (hooks.spawn) return hooks.spawn(options);
        let text, exitCode = 0;
        let allocation;
        if (options.argv.includes('worktree') && options.argv.includes('add')) {
          const branch = options.argv[options.argv.indexOf('-b') + 1];
          const request = { name: branch, from: options.argv.at(-1) };
          assert.equal(records.get(agent.id).status, 'creating');
          calls.creates.push({ agent, request, signal: options.signal });
          allocation = Promise.resolve().then(() => hooks.create?.(agent, request, options.signal));
          text = '';
        }
        else if (options.argv[0] === '/bin/node') text = options.argv.some(arg => arg.includes('os.homedir()')) ? '"/fixture-home"\n' : '';
        else if (options.argv.includes('check-ref-format') || options.argv.includes('reset')) text = '';
        else if (options.argv.includes('show-ref')) { text = ''; exitCode = 1; }
        else if (options.argv.includes('--show-toplevel')) text = `${options.cwd}\n`;
        else if (options.argv.includes('symbolic-ref')) { const branch = options.cwd === '/source/repo' ? 'main' : records.get(agent.id)?.name || 'main'; text = options.argv.includes('--short') ? `${branch}\n` : `refs/heads/${branch}\n`; }
        else if (options.argv.includes('--verify')) text = `${COMMIT}\n`;
        else if (options.argv.includes('--count=1')) text = '';
        else if (options.argv.includes('for-each-ref')) text = 'refs/heads/main\0main\0\nrefs/remotes/origin/main\0origin/main\0\n';
        else if (options.argv.includes('config')) { text = ''; exitCode = 1; }
        else if (options.argv.includes('--raw')) text = `:100644 100644 ${COMMIT} ${COMMIT} M\0tracked.js\0` + '2\t1\ttracked.js\0';
        else if (options.argv.includes('ls-files')) text = '';
        else if (options.argv.includes('--patch')) text = 'diff --git a/tracked.js b/tracked.js\n--- a/tracked.js\n+++ b/tracked.js\n@@ -1 +1,2 @@\n-before\n+after\n+added\n';
        else throw new Error(`Unexpected Git read: ${options.argv.join(' ')}`);
        return {
          done: allocation ? allocation.then(() => ({ exitCode, signal: null })) : Promise.resolve({ exitCode, signal: null }),
          collected: {
            stdout: { readFrom: () => ({ text, lossy: false }) },
            stderr: { readFrom: () => ({ text: '', lossy: false }) },
          },
          terminate() {},
          async waitForExit() {},
        };
      },
    },
    typert: {
      register(contribution) {
        contributions.add(contribution);
        return () => contributions.delete(contribution);
      },
    },
    tools: {
      register(tool) {
        tools.set(tool.name, tool);
        return () => tools.delete(tool.name);
      },
    },
    agents: { get: id => agents.get(id) },
  };
  if (modernProjections) delete dependencies.sessionProjections.stateOf;
  for (const [key, value] of Object.entries(dependencies)) ctx.provide(key, value);
  const fiber = ctx.plugin(host);
  let disposal;
  const dispose = () => disposal ??= Promise.resolve(fiber.dispose());
  t.after(dispose);
  await fiber.await();
  // Await the actual tools/agents injected child as well as the Host fiber.
  await Promise.all([...ctx.registry.values()].flatMap(runtime => [...runtime.fibers].map(child => child.await())));
  assert.equal(fiber.state, 2);
  assert.equal(tools.size, 3);
  const service = ctx.get(SERVICE);
  assert.ok(service);
  const tool = tools.get('dsh_worktree');
  const signal = new AbortController().signal;
  return {
    ctx, agent, session, agents, cwds, begun, records, table, contributions,
    definitions, tools, hooks, calls, service, tool, signal, dispose,
    schema: () => valueSchema,
    rpc: (request, target = agent) => service.operate(target, request, signal),
    runTool: args => tool.execute(args, { agent, signal }),
    changesRpc: (request, target = agent) => service.changes(target, request, signal),
    changesTool: args => tools.get('dsh_worktree_changes').execute(args, { agent, signal }),
    preStep: next => ctx.waterfall('agent/pre-step', { agent, signal, messages: [], turn: {}, step: {} }, next),
  };
}

check('progress RPC is Session-scoped, strict, cancellable, and preserves absent legacy history', async t => {
  const f = await fixture(t);
  assert.equal(await f.service.progress(f.agent, {}, f.signal), null);
  await assert.rejects(f.service.progress(f.agent, { after: -1 }, f.signal));
  const pending = new AbortController();
  const read = f.service.progress(f.agent, { after: 0 }, pending.signal);
  pending.abort(new Error('stop viewing'));
  await assert.rejects(read, /stop viewing/);
  const contribution = [...f.contributions][0];
  const descriptor = contribution.invocations.find(value => value.method === 'progress');
  assert.deepEqual(descriptor.scope, { context: 'agent', wire: 'agentId' });
  assert.deepEqual(descriptor.result.create().parse(null), null);
});

check('Host mounts with valid storage domain shape and lifecycle projection', async t => {
  const f = await fixture(t);
  assert.equal(f.calls.opened.length, 1);
  assert.equal(f.calls.closed, 0);
  const [definition] = f.definitions;
  assert.equal(definition.stateVersion, 1);
  assert.equal(definition.stateSchema.parse(false), false);
  assert.equal(definition.init({}, 0), false);
  assert.equal(definition.init({ isSeeded: true }, 0), true);
  assert.equal(definition.init({}, 1), true);
  assert.equal(definition.apply(false, { type: 'user/message' }), true);
  assert.equal(definition.apply(true, { type: 'unrelated' }), true);
  const selected = await f.rpc({ action: 'select', mode: 'local', expectedRevision: 0 });
  assert.deepEqual(f.schema().parse(selected.selection), selected.selection);
  assert.throws(() => f.schema().parse({ ...selected.selection, surprise: true }));
  assert.throws(() => f.schema().parse({ ...selected.selection, status: 'unknown' }));
});

check('DSH 0.2.2 awaits projection handles, reads through handles, and releases them', async t => {
  const f = await fixture(t, { modernProjections: true });
  assert.equal(f.definitions.size, 2);
  assert.equal(typeof f.ctx.sessionProjections.stateOf, 'undefined');
  assert.equal((await f.rpc({ action: 'inspect' })).editable, true);
  f.begun.set(f.session.id, true);
  assert.equal((await f.rpc({ action: 'inspect' })).editable, false);
  await assert.rejects(f.rpc({ action: 'select', mode: 'worktree' }));
  await f.dispose();
  assert.equal(f.definitions.size, 0);
  assert.equal(f.calls.closed, 1);
});

check('real Cordis Service binding and strict Typert invocation are contributed', async t => {
  const f = await fixture(t);
  assert.ok(f.service instanceof TypertRemoteService);
  assert.equal(f.service.typertRemote.serviceKey, SERVICE);
  assert.equal(f.service.typertRemote.namespace, SERVICE);
  assert.equal(f.contributions.size, 1);
  const [contribution] = f.contributions;
  assert.equal(contribution.package, NS);
  assert.equal(contribution.face, 'host');
  assert.equal(contribution.model.services[0].key, SERVICE);
  assert.ok(contribution.model.services[0].members.some(member => member.name === 'operate'));
  assert.equal(contribution.invocations.length, 6);
  const descriptor = contribution.invocations.find(value => value.method === 'operate');
  assert.equal(descriptor.id, `${NS}#${SERVICE}/operate`);
  assert.equal(descriptor.service, SERVICE);
  assert.equal(descriptor.namespace, SERVICE);
  assert.equal(descriptor.method, 'operate');
  assert.deepEqual(descriptor.invocation, { kind: 'direct' });
  assert.deepEqual(descriptor.scope, { context: 'agent', wire: 'agentId' });
  assert.deepEqual(descriptor.cancellation, { parameter: 'signal' });
  const [agentParameter, requestParameter] = descriptor.parameters;
  assert.equal(agentParameter.lookup, 'agent');
  assert.equal(agentParameter.codec.typeSymbol, '@deepseek-ai/dsh-session/types#SessionId');
  assert.equal(agentParameter.codec.create().parse(f.agent.id), f.agent.id);
  assert.equal(requestParameter.codec.mode, 'strict');
  assert.deepEqual(requestParameter.codec.create().parse({ action: 'inspect' }), { action: 'inspect' });
  assert.throws(() => requestParameter.codec.create().parse({ action: 'inspect', mode: 'local' }));
  const snapshot = await f.rpc({ action: 'inspect' });
  assert.equal(descriptor.result.mode, 'strict');
  assert.deepEqual(descriptor.result.create().parse(snapshot), snapshot);
});

check('tool and UI-facing service share snapshots and blank-only selection guards', async t => {
  const f = await fixture(t);
  const local = await f.runTool({ action: 'select', mode: 'local', expectedRevision: 0 });
  assert.deepEqual(await f.rpc({ action: 'inspect' }), local);
  const worktree = await f.rpc({ action: 'select', mode: 'worktree', from: 'refs/heads/main', expectedRevision: 1 });
  assert.deepEqual(await f.runTool({ action: 'inspect' }), worktree);
  assert.equal(worktree.selection.baseCommit, COMMIT);
  assert.match(worktree.selection.name, /^dsh\/[a-z]+-[a-z]+$/);
  assert.ok(f.calls.subprocess.some(call => call.argv.includes('show-ref') && call.argv.at(-1) === 'refs/heads/dsh'));
  assert.ok(f.calls.subprocess.some(call => call.argv.includes('--count=1') && call.argv.at(-1) === `refs/heads/${worktree.selection.name}`));
  assert.equal(f.calls.creates.length, 0);
  assert.equal(f.cwds.get(f.session.id), '/source/repo');
  f.begun.set(f.session.id, true);
  for (const attempt of [
    () => f.rpc({ action: 'select', mode: 'local' }),
    () => f.runTool({ action: 'select', mode: 'local' }),
  ]) {
    await assert.rejects(attempt(), error => error instanceof RemoteError && /before the first message/.test(error.message));
  }
  const inspected = await f.runTool({ action: 'inspect' });
  assert.equal(inspected.editable, false);
  assert.equal(inspected.revision, 2);
  assert.deepEqual(inspected.selection, worktree.selection);
  assert.equal(f.tool.isConcurrencySafe({ action: 'inspect' }), true);
  assert.equal(f.tool.isConcurrencySafe({ action: 'select' }), false);
  assert.deepEqual(f.tool.output.render({}, inspected), [{ type: 'text', text: JSON.stringify(inspected) }]);
});

check('tool resolves explicit live sessions and rejects unknown requests or missing targets', async t => {
  const f = await fixture(t);
  const other = { id: 'other-session', session: { id: 'other-session' } };
  f.agents.set(other.id, other);
  f.cwds.set(other.id, '/source/repo');
  f.begun.set(other.id, false);
  const chosen = await f.runTool({ action: 'select', sessionId: other.id, mode: 'local' });
  assert.equal(chosen.sessionId, other.id);
  assert.equal(f.records.has(f.agent.id), false);
  assert.deepEqual(await f.rpc({ action: 'inspect' }, other), chosen);
  await assert.rejects(f.runTool({ action: 'inspect', sessionId: 'missing' }), /must be open/);
  await assert.rejects(f.runTool({ action: 'inspect', surprise: true }), /Unknown argument/);
  await assert.rejects(f.rpc({ action: 'inspect', surprise: true }), RemoteError);
});

check('pre-step awaits durable preparation and returns next decisions unchanged', async t => {
  const f = await fixture(t);
  const staged = await f.rpc({ action: 'select', mode: 'worktree' });
  f.begun.set(f.session.id, true);
  const entered = deferred();
  const release = deferred();
  f.hooks.create = async (_agent, request, signal) => {
    entered.resolve();
    await release.promise;
    signal.throwIfAborted();
    return { path: '/isolated/fresh', branch: request.name, baseCommit: request.from, repositoryRoot: '/source/repo' };
  };
  let nextCalls = 0;
  const decision = { kind: 'enter', messages: [{ role: 'user', content: 'hello' }], startsRequestSeries: true };
  const pending = f.preStep(() => { nextCalls += 1; return decision; });
  try {
    await entered.promise;
    assert.equal(nextCalls, 0);
    assert.equal(f.records.get(f.agent.id).status, 'creating');
  } finally { release.resolve(); }
  assert.equal(await pending, decision);
  assert.equal(nextCalls, 1);
  assert.equal(f.records.get(f.agent.id).status, 'created');
  assert.deepEqual(f.calls.creates[0].request, { name: staged.selection.name, from: COMMIT });
  const rejectDecision = { kind: 'reject' };
  assert.equal(await f.preStep(() => rejectDecision), rejectDecision);
  assert.equal(f.calls.creates.length, 1);
});

check('pre-step creation failures never call next or silently retry in Local', async t => {
  const f = await fixture(t);
  await f.rpc({ action: 'select', mode: 'worktree' });
  const reason = new Error('mock Git allocation failed');
  f.hooks.create = () => { throw reason; };
  let nextCalls = 0;
  const next = () => { nextCalls += 1; return { kind: 'enter', messages: [] }; };
  await assert.rejects(f.preStep(next), error => error.cause?.cause === reason);
  await assert.rejects(f.preStep(next), /no automatic retry or local fallback/);
  assert.equal(nextCalls, 0);
  assert.equal(f.calls.creates.length, 1);
  assert.equal(f.cwds.get(f.session.id), '/source/repo');
  assert.equal(f.records.get(f.agent.id).mode, 'worktree');
  assert.equal(f.records.get(f.agent.id).status, 'failed');
});

check('disposal aborts in-flight preparation, drains storage, and removes registrations', async t => {
  const f = await fixture(t);
  await f.rpc({ action: 'select', mode: 'worktree' });
  const entered = deferred();
  const failureSaving = deferred();
  const releaseSave = deferred();
  f.hooks.create = (_agent, _request, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    entered.resolve();
  });
  f.hooks.put = async (_id, value) => {
    if (value.status === 'failed') { failureSaving.resolve(); await releaseSave.promise; }
  };
  let nextCalls = 0;
  const pending = f.preStep(() => { nextCalls += 1; return { kind: 'enter', messages: [] }; });
  const rejected = assert.rejects(pending, /unloaded/);
  await entered.promise;
  const disposing = f.dispose();
  try {
    await failureSaving.promise;
    assert.equal(f.service.lifetime.signal.aborted, true);
    assert.equal(f.calls.creates[0].signal.aborted, true);
    assert.equal(f.calls.closed, 0, 'domain must stay open until preparation persists failure');
  } finally { releaseSave.resolve(); }
  await rejected;
  await disposing;
  assert.equal(nextCalls, 0);
  assert.equal(f.calls.closed, 1);
  assert.equal(f.records.get(f.agent.id).status, 'failed');
  assert.equal(f.ctx.get(SERVICE), undefined);
  assert.equal(f.tools.size, 0);
  assert.equal(f.contributions.size, 0);
  assert.equal(f.definitions.size, 0);
  const decision = { kind: 'reject' };
  assert.equal(await f.preStep(() => decision), decision, 'pre-step listener was removed');
  await assert.rejects(f.rpc({ action: 'inspect' }), /unloaded/);
  await assert.rejects(f.changesRpc({ action: 'summary' }), /unloaded/);
});

check('changes service and tool share strict Session-bound read results after first message', async t => {
  const f = await fixture(t);
  f.begun.set(f.agent.id, true);
  const summary = await f.changesTool({ action: 'summary' });
  assert.deepEqual(await f.changesRpc({ action: 'summary' }), summary);
  assert.equal(summary.sessionId, f.agent.id);
  assert.equal(summary.cwd, '/source/repo');
  assert.equal(summary.repository.kind, 'git');
  assert.equal(summary.repository.branch, 'main');
  assert.equal(summary.selection, null);
  assert.equal(summary.files[0].path, 'tracked.js');
  assert.equal(summary.added, 2);
  assert.equal(summary.deleted, 1);
  assert.equal(summary.limited, false);
  const patch = await f.changesTool({ action: 'diff', scope: 'staged', path: 'tracked.js' });
  assert.deepEqual(await f.changesRpc({ action: 'diff', scope: 'staged', path: 'tracked.js' }), patch);
  assert.equal(patch.kind, 'text');
  assert.match(patch.patch, /\+after/);
  assert.equal(f.calls.puts.length, 0, 'read-only changes do not persist a selection');
  assert.equal(f.calls.creates.length, 0, 'read-only changes never allocate a checkout');
  const tool = f.tools.get('dsh_worktree_changes');
  assert.equal(tool.isConcurrencySafe({ action: 'diff' }), true);
  assert.deepEqual(tool.output.render({}, patch), [{ type: 'text', text: JSON.stringify(patch) }]);
  const [contribution] = f.contributions;
  const invocation = contribution.invocations.find(row => row.method === 'changes');
  assert.equal(invocation.id, `${NS}#${SERVICE}/changes`);
  assert.deepEqual(invocation.scope, { context: 'agent', wire: 'agentId' });
  assert.deepEqual(invocation.cancellation, { parameter: 'signal' });
  const codec = invocation.parameters.find(row => row.name === 'request').codec;
  assert.equal(codec.mode, 'strict');
  assert.deepEqual(codec.create().parse({ action: 'summary' }), { action: 'summary', scope: 'all' });
  assert.throws(() => codec.create().parse({ action: 'diff' }));
  assert.deepEqual(invocation.result.create().parse(summary), summary);
  assert.deepEqual(invocation.result.create().parse(patch), patch);
});

check('changes endpoint validates actions and resolves explicit open Sessions without writing', async t => {
  const f = await fixture(t);
  const other = { id: 'other-session', session: { id: 'other-session' } };
  f.agents.set(other.id, other);
  f.cwds.set(other.id, '/source/repo');
  const value = await f.changesTool({ action: 'summary', sessionId: other.id });
  assert.equal(value.sessionId, other.id);
  await assert.rejects(f.changesTool({ action: 'summary', sessionId: 'missing' }), /must be open/);
  await assert.rejects(f.changesTool({ action: 'summary', sessionId: null }), /non-empty string/);
  await assert.rejects(f.changesTool({ action: 'summary', extra: true }), /Unknown argument/);
  await assert.rejects(f.changesRpc({ action: 'select', mode: 'local' }), RemoteError);
  await assert.rejects(f.changesRpc({ action: 'diff' }), RemoteError);
  await assert.rejects(f.changesRpc({ action: 'summary', scope: 'branch' }), RemoteError);
  await assert.rejects(f.changesRpc({ action: 'summary', cwd: '/other' }), RemoteError);
  assert.equal(f.calls.puts.length, 0);
});

check('unloading cancels Git reads and reaps their child before storage closes', async t => {
  const f = await fixture(t);
  const entered = deferred();
  const reaping = deferred();
  const releaseReap = deferred();
  let terminated = false, readSignal;
  f.hooks.spawn = options => {
    readSignal = options.signal;
    const done = new Promise(resolve => {
      options.signal.addEventListener('abort', () => resolve({ exitCode: null, signal: 'SIGTERM' }), { once: true });
    });
    entered.resolve();
    return {
      done,
      collected: {
        stdout: { readFrom: () => ({ text: '', lossy: false }) },
        stderr: { readFrom: () => ({ text: '', lossy: false }) },
      },
      terminate() { terminated = true; },
      async waitForExit() { reaping.resolve(); await releaseReap.promise; },
    };
  };
  const pending = f.changesRpc({ action: 'summary' });
  const rejected = assert.rejects(pending, /unloaded/);
  await entered.promise;
  const disposing = f.dispose();
  try {
    await reaping.promise;
    assert.equal(readSignal.aborted, true);
    assert.equal(terminated, true);
    assert.equal(f.calls.closed, 0, 'closing the domain waits for all Git readers to drain');
    assert.equal(f.calls.puts.length, 0);
    assert.equal(f.calls.creates.length, 0);
  } finally { releaseReap.resolve(); }
  await rejected;
  await disposing;
  assert.equal(f.calls.closed, 1);
});

check('client-visible refresh projection changes only on committed turn boundaries', async t => {
  const f = await fixture(t);
  const definition = [...f.definitions].find(row => row.key === REFRESH);
  assert.equal(definition.init({}, 0), 0);
  assert.equal(definition.apply(0, { type: 'assistant/live-chunk' }), 0);
  assert.equal(definition.apply(0, { type: 'turn/end' }), 1);
  assert.equal(definition.wire.view(2), 2);
  assert.equal(definition.wire.viewSchema.parse(2), 2);
});
