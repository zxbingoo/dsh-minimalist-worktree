import { z } from 'zod';
import { TypertRemoteService, RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import { NS, SERVICE, STARTED, createOperations, foldStarted } from './core.js';
import { createGitReader } from './git.js';
import { createExternalWorktreeCreator } from './external-worktree.js';
import { createEnvironmentInitializer } from './environment.js';
import { createProgressTracker, progressSchema } from './progress.js';
import { createWorktreeCleaner } from './cleanup.js';
import { createSnapshotRestorer } from './snapshot-restore.js';
import { createRecoveryOperations, recoveryStateSchema, recoveryDecisionSchema, recoveryRequestSchema } from './recovery.js';
import { createWorktreeRebuilder } from './rebuild-worktree.js';
import { createArchiveCleanup, cleanupResultSchema } from './archive-cleanup.js';

const progressRequestSchema = z.strictObject({ after: z.number().int().nonnegative().optional() });
import { createWorktreeNamer } from './names.js';
import { createChangesReader } from './git-changes.js';
import { createBrowserOperations, browserRequestSchema, browserResultSchema } from './browser.js';
import { REFRESH, changesRequestSchema, changesResultSchema, createChangesOperations, foldRefresh, changesToolParameters, changesToolOutput } from './changes.js';

export const inject = ['typert', 'storageDomain', 'sessionProjections', 'workingDirectory', 'fs', 'subprocess', 'sandbox', 'sandboxPolicy'];

const createdSchema = z.strictObject({ path: z.string(), branch: z.string(), baseCommit: z.string(), repositoryRoot: z.string() });
const selectionSchema = z.strictObject({
  mode: z.enum(['local', 'worktree']), from: z.string(), baseCommit: z.string(), sourceCwd: z.string(), name: z.string(),
  status: z.enum(['staged', 'creating', 'created', 'failed']), revision: z.number().int().nonnegative(), error: z.string(),
  result: createdSchema.optional(),
  initialization: z.strictObject({ status: z.enum(['running', 'succeeded', 'skipped', 'failed']), reason: z.string(), file: z.string().optional() }).optional(),
});
const changesSchema = changesResultSchema(selectionSchema);
const branchSchema = z.strictObject({ ref: z.string(), label: z.string(), kind: z.enum(['local', 'remote']) });
const snapshotSchema = z.strictObject({
  sessionId: z.string(), cwd: z.string(), editable: z.boolean(), revision: z.number().int().nonnegative(),
  selection: selectionSchema.nullable(),
  cleanup: cleanupResultSchema.nullable().optional(),
  recovery: recoveryStateSchema.optional(),
  repository: z.strictObject({
    kind: z.enum(['git', 'none', 'unknown']),
    available: z.boolean(), root: z.string(), branch: z.string(), commit: z.string(),
    branches: z.array(branchSchema).max(200), truncated: z.boolean(), reason: z.string(),
  }),
});
const requestSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('inspect') }),
  z.strictObject({
    action: z.literal('select'), mode: z.enum(['local', 'worktree']),
    from: z.string().min(1).max(1024).optional(), expectedRevision: z.number().int().nonnegative().optional(),
  }),
]);
const toolParameters = {
  type: 'object', properties: {
    action: { type: 'string', enum: ['inspect', 'select'] },
    sessionId: { type: 'string', description: 'Target live Session ID; defaults to the calling Session. select only accepts a Session with no messages or turns.' },
    mode: { type: 'string', enum: ['local', 'worktree'], description: 'Required for select. local leaves the source checkout unchanged; worktree prepares a fresh branch on the first message.' },
    from: { type: 'string', description: 'Worktree base: a locally available branch, tag, or commit. Defaults to HEAD; pinned when selected. Does not fetch or copy uncommitted files.' },
    expectedRevision: { type: 'integer', description: 'Optional revision from inspect; refuses a stale selection.' },
  }, required: ['action'], additionalProperties: false,
};
const snapshotOutput = {
  type: 'object', properties: {
    sessionId: { type: 'string' }, cwd: { type: 'string' }, editable: { type: 'boolean' }, revision: { type: 'integer' },
    selection: { oneOf: [{ type: 'null' }, { type: 'object', additionalProperties: true }] },
    cleanup: { oneOf: [{ type: 'null' }, { type: 'object', additionalProperties: true }] },
    recovery: { type: 'object', additionalProperties: true },
    repository: { type: 'object', additionalProperties: true },
  }, required: ['sessionId', 'cwd', 'editable', 'revision', 'selection', 'repository'], additionalProperties: false,
};

/** Both the browser RPC and the agent tool enter this same service. */
class MinimalistWorktreeService extends TypertRemoteService {
  constructor(ctx, operations, changeOperations, lifetime, progress) {
    super(ctx, SERVICE);
    this.operations = operations;
    this.changeOperations = changeOperations;
    this.lifetime = lifetime;
    this.preparationProgress = progress;
  }
  async operate(agent, request, signal) {
    const combined = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
    try {
      const snapshot = await this.operations.operate(agent, requestSchema.parse(request), combined);
      return snapshotSchema.parse({ ...snapshot, cleanup: this.cleanupOf?.(agent.id) ?? null, ...(this.recoveryOperations ? { recovery: await this.recoveryOperations.inspect(agent, combined) } : {}) });
    }
    catch (error) {
      throw new RemoteError('minimalist-worktree/operation-failed', error instanceof Error ? error.message : String(error), {});
    }
  }
  async browser(agent, request, signal) {
    const combined = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
    try { return await this.browserOperations.operate(agent, request, combined); }
    catch (error) { throw new RemoteError('minimalist-worktree/browser-failed', error instanceof Error ? error.message : String(error), {}); }
  }
  async recovery(agent, request, signal) {
    const combined = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
    const parsed = recoveryRequestSchema.parse(request);
    try { return parsed.action === 'inspect' ? await this.recoveryOperations.inspect(agent, combined) : await this.recoveryOperations.choose(agent, parsed, combined); }
    catch (error) { throw new RemoteError('minimalist-worktree/recovery-failed', error instanceof Error ? error.message : String(error), {}); }
  }
  async restore(agent, request, signal) {
    if (!request || Object.keys(request).length) throw new Error('restore takes an empty request.');
    const combined = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
    if (!this.restoreSnapshot) throw new Error('Snapshot restoration is unavailable in this composition.');
    return this.restoreSnapshot(agent, combined);
  }
  async progress(agent, request, signal) {
    const combined = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
    const { after } = progressRequestSchema.parse(request);
    return this.preparationProgress.read(agent, after, combined);
  }
  async changes(agent, request, signal) {
    const combined = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
    try { return await this.changeOperations.operate(agent, request, combined); }
    catch (error) {
      throw new RemoteError('minimalist-worktree/changes-failed', error instanceof Error ? error.message : String(error), {});
    }
  }
}

export async function apply(ctx) {
  const lifetime = new AbortController();
  const restores = new Set();
  const domain = await ctx.storageDomain.open({
    // Storage unit names must match /^[a-z][a-z0-9_]*$/ (package ids may contain hyphens).
    name: 'dsh_minimalist_worktree', version: 1, layout: 'per-record', tables: { selections: { valueSchema: selectionSchema } },
  });
  let progressDomain;
  try {
    progressDomain = await ctx.storageDomain.open({ name: 'dsh_minimalist_worktree_progress', version: 1, layout: 'per-record', tables: { preparations: { valueSchema: progressSchema } } });
  } catch (error) { await domain.close(); throw error; }
  const progress = createProgressTracker(progressDomain.table('preparations'));
  let operations, changeOperations, browserOperations, archiveCleanup, cleanupDomain, recovery, recoveryDomain;
  try {
    ctx.effect(() => async () => {
      lifetime.abort(new Error('Minimalist Worktree was unloaded.'));
      await Promise.all([operations?.drain(), changeOperations?.drain(), browserOperations?.drain()]);
      await recovery?.drain();
      await recoveryDomain?.close();
      await archiveCleanup?.drain();
      await Promise.allSettled([...restores]);
      await cleanupDomain?.close();
      await progress.drain();
      await progressDomain.close();
      await domain.close();
    });
  } catch (error) { await progressDomain.close(); await domain.close(); throw error; }

  // 0.2.2 returns an async ready handle; 0.2.1 returns a callable disposer
  // and reads through the registry. Await readiness before publishing consumers.
  async function registerProjection(definition) {
    const handle = await ctx.sessionProjections.register(definition);
    const dispose = typeof handle === 'function' ? handle : () => handle.dispose();
    try { ctx.effect(() => dispose); }
    catch (error) { await dispose(); throw error; }
    if (typeof handle?.stateOf === 'function') return session => handle.stateOf(session);
    if (typeof ctx.sessionProjections.stateOf === 'function') {
      return session => ctx.sessionProjections.stateOf(session, definition.key);
    }
    throw new Error('Unsupported DSH session projection API; update Minimalist Worktree.');
  }
  const startedOf = await registerProjection({
    key: STARTED, stateVersion: 1, stateSchema: z.boolean(),
    init: (header, inheritedCount) => !!header.isSeeded || inheritedCount > 0,
    apply: foldStarted,
  });
  await registerProjection({
    key: REFRESH, stateVersion: 1, stateSchema: z.number().int().nonnegative(),
    init: () => 0, apply: foldRefresh,
    wire: { viewSchema: z.number().int().nonnegative(), view: state => state },
  });
  const provider = (agent, key) => {
    const value = ctx.get('agentPresets')?.serviceFor(agent, key) ?? agent.ctx?.get(key) ?? ctx.get(key);
    if (value === undefined) throw new Error(`Required service is unavailable: ${key}`);
    return value;
  };
  const git = createGitReader(provider);
  recoveryDomain = await ctx.storageDomain.open({ name: 'dsh_minimalist_worktree_recovery', version: 1, layout: 'per-record', tables: { decisions: { valueSchema: recoveryDecisionSchema } } });
  recovery = createRecoveryOperations({ selections: domain.table('selections'), decisions: recoveryDomain.table('decisions'), provider,
    rebuild: createWorktreeRebuilder(provider), initialize: createEnvironmentInitializer(provider),
    assertIdle: async agent => {
      await archiveCleanup?.assertNotCleaning(agent);
      if ((await ctx.waterfall('workspace/session-activity', { sessionId: agent.id }, async () => [])).length) throw new Error('Stop the Session task before choosing a recovery action.');
    },
  });
  operations = createOperations({
    table: domain.table('selections'),
    cwdOf: agent => provider(agent, 'workingDirectory').get(agent.session),
    started: agent => {
      const value = startedOf(agent.session);
      if (value === undefined) throw new Error('Worktree lifecycle projection is unavailable.');
      return value;
    },
    repository: git.inspect, resolveCommit: git.resolveCommit,
    createWorktree: createExternalWorktreeCreator(provider),
    initializeWorktree: createEnvironmentInitializer(provider),
    progress,
    makeName: createWorktreeNamer({ isAvailable: git.branchAvailable }),
  });
  changeOperations = createChangesOperations({
    reader: createChangesReader(provider),
    cwdOf: agent => provider(agent, 'workingDirectory').get(agent.session),
    selectionOf: agent => domain.table('selections').get(agent.id),
    resultSchema: changesSchema,
  });
  ctx.inject(['workspaceRegistry', 'agents'], async owner => {
    const workspace = owner.storageDomain.get('workspace');
    if (!workspace) return;
    cleanupDomain = await owner.storageDomain.open({ name: 'dsh_minimalist_worktree_cleanup', version: 1, layout: 'per-record', tables: { results: { valueSchema: cleanupResultSchema } } });
    archiveCleanup = createArchiveCleanup({
      initialArchived: workspace.global.get().archivedSessionIds ?? [], selections: domain.table('selections'), results: cleanupDomain.table('results'),
      getAgent: id => owner.agents.get(id), listAgents: () => owner.agents.list(),
      archivedNow: () => workspace.global.get().archivedSessionIds ?? [],
      activity: id => owner.waterfall('workspace/session-activity', { sessionId: id }, async () => []),
      provider, clean: createWorktreeCleaner(provider), signal: lifetime.signal,
    });
    owner.on('domain/changed', change => archiveCleanup.changed(change));
  });
  const restore = createSnapshotRestorer(provider);

  const service = new MinimalistWorktreeService(ctx, operations, changeOperations, lifetime, progress);
  service.restoreSnapshot = (agent, signal) => {
    const task = (async () => {
      if ((await ctx.waterfall('workspace/session-activity', { sessionId: agent.id }, async () => [])).length) throw new Error('Stop Session activity before restoring its worktree.');
      await archiveCleanup?.assertNotCleaning(agent);
      const receipt = cleanupDomain?.table('results').get(agent.id);
      const result = await restore(agent, receipt, signal);
      await cleanupDomain.table('results').put(agent.id, cleanupResultSchema.parse(result));
      return result;
    })();
    restores.add(task); task.then(() => restores.delete(task), () => restores.delete(task)); return task;
  };
  browserOperations = createBrowserOperations(provider);
  service.browserOperations = browserOperations;
  service.recoveryOperations = recovery;
  service.cleanupOf = id => cleanupDomain?.table('results').get(id);
  const codec = (name, schema) => ({ mode: 'strict', typeSymbol: `${NS}#${name}`, create: () => schema });
  const agentCodec = { mode: 'strict', typeSymbol: '@deepseek-ai/dsh-session/types#SessionId', create: () => z.string().min(1), jsonSchema: { type: 'string' } };
  ctx.effect(() => ctx.typert.register({
    package: NS, face: 'host', schemas: [],
    model: {
      services: [{
        key: SERVICE, exportName: 'MinimalistWorktreeService', description: 'Local/worktree choices, effective Session directories, and bounded read-only Git changes.', tags: [],
        members: [
          { kind: 'method', name: 'restore', signature: 'restore(agent: Agent, request: {}, signal?: AbortSignal): Promise<WorktreeCleanupResult>' },
          { kind: 'method', name: 'progress', signature: 'progress(agent: Agent, request: { after?: number }, signal?: AbortSignal): Promise<PreparationProgress | null>' },
          { kind: 'method', name: 'operate', signature: 'operate(agent: Agent, request: WorktreeChoiceRequest, signal?: AbortSignal): Promise<WorktreeChoiceSnapshot>' },
          { kind: 'method', name: 'changes', signature: 'changes(agent: Agent, request: WorktreeChangesRequest, signal?: AbortSignal): Promise<WorktreeChangesResult>' },
        ],
        types: [
          { name: 'WorktreeChoiceRequest', declaration: "type WorktreeChoiceRequest = { action: 'inspect' } | { action: 'select'; mode: 'local' | 'worktree'; from?: string; expectedRevision?: number };" },
          { name: 'WorktreeChoiceSnapshot', declaration: 'interface WorktreeChoiceSnapshot { sessionId: string; cwd: string; editable: boolean; revision: number; selection: object | null; repository: object; }' },
          { name: 'WorktreeChangesRequest', declaration: "type WorktreeChangesRequest = { action: 'summary'; scope?: 'all' | 'unstaged' | 'staged' } | { action: 'diff'; scope?: 'all' | 'unstaged' | 'staged'; path: string };" },
          { name: 'WorktreeChangesResult', declaration: "type WorktreeChangesResult = { sessionId: string; cwd: string; scope: 'all' | 'unstaged' | 'staged'; selection: object | null; repository: {kind: 'git' | 'none' | 'unknown'; root: string; branch: string; commit: string; unborn: boolean}; files: {path: string; oldPath: string; status: string; added: number | null; deleted: number | null; binary: boolean}[]; added: number; deleted: number; untracked: number; limited: boolean; reason: string } | { sessionId: string; cwd: string; scope: 'all' | 'unstaged' | 'staged'; kind: 'text' | 'binary' | 'oversized' | 'conflict' | 'submodule' | 'missing' | 'unavailable'; path: string; patch: string; reason: string };" },
        ],
      }], events: [], objects: [],
    },
    invocations: [{
      id: `${NS}#${SERVICE}/browser`, service: SERVICE, namespace: SERVICE, method: 'browser',
      invocation: { kind: 'direct' }, scope: { context: 'agent', wire: 'agentId' },
      parameters: [
        { name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent', codec: agentCodec },
        { name: 'request', wire: 'request', source: 'json', codec: codec('browserRequest', browserRequestSchema) },
      ], cancellation: { parameter: 'signal' }, result: codec('browserResult', browserResultSchema),
    }, {
      id: `${NS}#${SERVICE}/recovery`, service: SERVICE, namespace: SERVICE, method: 'recovery',
      invocation: { kind: 'direct' }, scope: { context: 'agent', wire: 'agentId' },
      parameters: [
        { name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent', codec: agentCodec },
        { name: 'request', wire: 'request', source: 'json', codec: codec('recoveryRequest', recoveryRequestSchema) },
      ], cancellation: { parameter: 'signal' }, result: codec('recoveryResult', recoveryStateSchema),
    }, {
      id: `${NS}#${SERVICE}/restore`, service: SERVICE, namespace: SERVICE, method: 'restore',
      invocation: { kind: 'direct' }, scope: { context: 'agent', wire: 'agentId' },
      parameters: [
        { name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent', codec: agentCodec },
        { name: 'request', wire: 'request', source: 'json', codec: codec('restoreRequest', z.strictObject({})) },
      ], cancellation: { parameter: 'signal' }, result: codec('restoreResult', cleanupResultSchema),
    }, {
      id: `${NS}#${SERVICE}/progress`, service: SERVICE, namespace: SERVICE, method: 'progress',
      invocation: { kind: 'direct' }, scope: { context: 'agent', wire: 'agentId' },
      parameters: [
        { name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent', codec: agentCodec },
        { name: 'request', wire: 'request', source: 'json', codec: codec('progressRequest', progressRequestSchema) },
      ], cancellation: { parameter: 'signal' }, result: codec('progressResult', progressSchema.nullable()),
    }, {
      id: `${NS}#${SERVICE}/operate`, service: SERVICE, namespace: SERVICE, method: 'operate',
      invocation: { kind: 'direct' }, scope: { context: 'agent', wire: 'agentId' },
      parameters: [
        { name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent', codec: agentCodec },
        { name: 'request', wire: 'request', source: 'json', codec: codec('request', requestSchema) },
      ], cancellation: { parameter: 'signal' }, result: codec('snapshot', snapshotSchema),
    }, {
      id: `${NS}#${SERVICE}/changes`, service: SERVICE, namespace: SERVICE, method: 'changes',
      invocation: { kind: 'direct' }, scope: { context: 'agent', wire: 'agentId' },
      parameters: [
        { name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent', codec: agentCodec },
        { name: 'request', wire: 'request', source: 'json', codec: codec('changesRequest', changesRequestSchema) },
      ], cancellation: { parameter: 'signal' }, result: codec('changesResult', changesSchema),
    }],
  }));

  // Await preparation before allowing any model step. Errors propagate into the
  // normal visible Turn error path; no silent local fallback or duplicate retry.
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const combined = AbortSignal.any([signal, lifetime.signal]);
    await archiveCleanup?.assertNotCleaning(agent);
    await recovery.assertReady(agent, combined);
    await operations.prepare(agent, combined);
    await archiveCleanup?.assertNotCleaning(agent);
    await recovery.assertReady(agent, combined);
    return next();
  });

  ctx.inject(['tools', 'agents'], child => {
    child.effect(() => child.tools.register({
      name: 'dsh_worktree_restore', deferLoading: true,
      description: 'Restore a Session’s verified archive snapshot offline to its absent original worktree directory in detached HEAD. Preserves staged, unstaged and local files; never overwrites an existing directory or fetches.',
      parameters: { type: 'object', properties: { sessionId: { type: 'string', description: 'Target open Session; defaults to the calling Session.' } }, additionalProperties: false },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => key !== 'sessionId')) throw new Error('Only optional sessionId is accepted.');
        const target = args.sessionId === undefined ? exec.agent : child.agents.get(args.sessionId);
        if (!target) throw new Error('The target Session must be open.');
        return service.restore(target, {}, exec.signal);
      },
    }));
    child.effect(() => child.tools.register({
      name: 'dsh_worktree', deferLoading: true,
      description: 'Inspect local Git branches and a Session’s checkout choice, or select Local / New worktree for a blank Session. Worktrees are created before its first model step; source files and branches stay unchanged.',
      parameters: toolParameters,
      output: { schema: snapshotOutput, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      isConcurrencySafe: args => args?.action === 'inspect',
      async execute(args, exec) {
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new TypeError('Arguments must be an object.');
        for (const key of Object.keys(args)) if (!['action', 'sessionId', 'mode', 'from', 'expectedRevision'].includes(key)) throw new TypeError(`Unknown argument: ${key}`);
        const { sessionId, ...request } = args;
        const agent = sessionId === undefined ? exec.agent : child.agents.get(sessionId);
        if (!agent) throw new Error('The target Session must be open.');
        return service.operate(agent, request, exec.signal);
      },
    }));
    child.effect(() => child.tools.register({
      name: 'dsh_worktree_changes', deferLoading: true,
      description: 'Read a Session’s effective directory and current Git changes, or one changed file’s unified diff. Includes non-AI edits; never stages, commits, switches branches, or fetches.',
      parameters: changesToolParameters,
      output: { schema: changesToolOutput, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new TypeError('Arguments must be an object.');
        for (const key of Object.keys(args)) if (!['action', 'scope', 'path', 'sessionId'].includes(key)) throw new TypeError(`Unknown argument: ${key}`);
        const { sessionId, ...request } = args;
        if (sessionId !== undefined && (typeof sessionId !== 'string' || !sessionId)) throw new TypeError('sessionId must be a non-empty string.');
        const agent = sessionId === undefined ? exec.agent : child.agents.get(sessionId);
        if (!agent) throw new Error('The target Session must be open.');
        return service.changes(agent, request, exec.signal);
      },
    }));
  });
}
