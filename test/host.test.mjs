import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { TypertRemoteService, RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import * as host from '../index.js';
import { NS, SERVICE, STARTED } from '../core.js';

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
async function fixture(t) {
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
        assert.equal(definition.key, STARTED);
        definitions.add(definition);
        return () => definitions.delete(definition);
      },
      stateOf(target, key) { assert.equal(key, STARTED); return begun.get(target.id); },
    },
    workingDirectory: { get: target => cwds.get(target.id) },
    fs: { resolve: async value => value, processPath: value => value },
    sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) },
    sandbox: { confine() { throw new Error('Full-access fixture should not confine Git.'); } },
    subprocess: {
      resolveExecutable: async name => { assert.equal(name, 'git'); return '/bin/git'; },
      spawn(options) {
        calls.subprocess.push(options);
        let text;
        if (options.argv.includes('--show-toplevel')) text = '/source/repo\n';
        else if (options.argv.includes('symbolic-ref')) text = 'main\n';
        else if (options.argv.includes('--verify')) text = `${COMMIT}\n`;
        else if (options.argv.includes('for-each-ref')) text = 'refs/heads/main\0main\0\nrefs/remotes/origin/main\0origin/main\0\n';
        else throw new Error(`Unexpected Git read: ${options.argv.join(' ')}`);
        return {
          done: Promise.resolve({ exitCode: 0, signal: null }),
          collected: {
            stdout: { readFrom: () => ({ text, lossy: false }) },
            stderr: { readFrom: () => ({ text: '', lossy: false }) },
          },
          terminate() {},
          async waitForExit() {},
        };
      },
    },
    worktrees: {
      async create(target, request, signal) {
        assert.equal(records.get(target.id).status, 'creating');
        calls.creates.push({ agent: target, request: clone(request), signal });
        if (hooks.create) return hooks.create(target, request, signal);
        signal?.throwIfAborted();
        const result = {
          path: `/isolated/${request.name}`, branch: request.name,
          baseCommit: request.from, repositoryRoot: '/source/repo',
        };
        cwds.set(target.session.id, result.path);
        return result;
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
  for (const [key, value] of Object.entries(dependencies)) ctx.provide(key, value);
  const fiber = ctx.plugin(host);
  let disposal;
  const dispose = () => disposal ??= Promise.resolve(fiber.dispose());
  t.after(dispose);
  await fiber.await();
  // Await the actual tools/agents injected child as well as the Host fiber.
  await Promise.all([...ctx.registry.values()].flatMap(runtime => [...runtime.fibers].map(child => child.await())));
  assert.equal(fiber.state, 2);
  assert.equal(tools.size, 1);
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
    preStep: next => ctx.waterfall('agent/pre-step', { agent, signal, messages: [], turn: {}, step: {} }, next),
  };
}

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
  assert.equal(contribution.model.services[0].members[0].name, 'operate');
  assert.equal(contribution.invocations.length, 1);
  const [descriptor] = contribution.invocations;
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
  assert.match(worktree.selection.name, /^worktree-[0-9a-f-]{36}$/);
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
  await assert.rejects(f.preStep(next), error => error.cause === reason);
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
});
