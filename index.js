import { z } from 'zod';
import { TypertRemoteService, RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import { NS, SERVICE, STARTED, createOperations, foldStarted } from './core.js';
import { createGitReader } from './git.js';
import { createWorktreeNamer } from './names.js';

export const inject = ['typert', 'storageDomain', 'sessionProjections', 'workingDirectory', 'fs', 'subprocess', 'sandbox', 'sandboxPolicy', 'worktrees'];

const createdSchema = z.strictObject({ path: z.string(), branch: z.string(), baseCommit: z.string(), repositoryRoot: z.string() });
const selectionSchema = z.strictObject({
  mode: z.enum(['local', 'worktree']), from: z.string(), baseCommit: z.string(), sourceCwd: z.string(), name: z.string(),
  status: z.enum(['staged', 'creating', 'created', 'failed']), revision: z.number().int().nonnegative(), error: z.string(),
  result: createdSchema.optional(),
});
const branchSchema = z.strictObject({ ref: z.string(), label: z.string(), kind: z.enum(['local', 'remote']) });
const snapshotSchema = z.strictObject({
  sessionId: z.string(), cwd: z.string(), editable: z.boolean(), revision: z.number().int().nonnegative(),
  selection: selectionSchema.nullable(),
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
    repository: { type: 'object', additionalProperties: true },
  }, required: ['sessionId', 'cwd', 'editable', 'revision', 'selection', 'repository'], additionalProperties: false,
};

/** Both the browser RPC and the agent tool enter this same service. */
class MinimalistWorktreeService extends TypertRemoteService {
  constructor(ctx, operations, lifetime) {
    super(ctx, SERVICE);
    this.operations = operations;
    this.lifetime = lifetime;
  }
  async operate(agent, request, signal) {
    const combined = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
    try { return snapshotSchema.parse(await this.operations.operate(agent, requestSchema.parse(request), combined)); }
    catch (error) {
      throw new RemoteError('minimalist-worktree/operation-failed', error instanceof Error ? error.message : String(error), {});
    }
  }
}

export async function apply(ctx) {
  const lifetime = new AbortController();
  const domain = await ctx.storageDomain.open({
    // Storage unit names must match /^[a-z][a-z0-9_]*$/ (package ids may contain hyphens).
    name: 'dsh_minimalist_worktree', version: 1, layout: 'per-record', tables: { selections: { valueSchema: selectionSchema } },
  });
  let operations;
  try {
    ctx.effect(() => async () => {
      lifetime.abort(new Error('Minimalist Worktree was unloaded.'));
      await operations?.drain();
      await domain.close();
    });
  } catch (error) { await domain.close(); throw error; }

  ctx.effect(() => ctx.sessionProjections.register({
    key: STARTED, stateVersion: 1, stateSchema: z.boolean(),
    init: (header, inheritedCount) => !!header.isSeeded || inheritedCount > 0,
    apply: foldStarted,
  }));
  const provider = (agent, key) => {
    const value = ctx.get('agentPresets')?.serviceFor(agent, key) ?? agent.ctx?.get(key) ?? ctx.get(key);
    if (value === undefined) throw new Error(`Required service is unavailable: ${key}`);
    return value;
  };
  const git = createGitReader(provider);
  operations = createOperations({
    table: domain.table('selections'),
    cwdOf: agent => provider(agent, 'workingDirectory').get(agent.session),
    started: agent => {
      const value = ctx.sessionProjections.stateOf(agent.session, STARTED);
      if (value === undefined) throw new Error('Worktree lifecycle projection is unavailable.');
      return value;
    },
    repository: git.inspect, resolveCommit: git.resolveCommit,
    createWorktree: (agent, request, signal) => provider(agent, 'worktrees').create(agent, request, signal),
    makeName: createWorktreeNamer({ isAvailable: git.branchAvailable }),
  });
  const service = new MinimalistWorktreeService(ctx, operations, lifetime);
  const codec = (name, schema) => ({ mode: 'strict', typeSymbol: `${NS}#${name}`, create: () => schema });
  const agentCodec = { mode: 'strict', typeSymbol: '@deepseek-ai/dsh-session/types#SessionId', create: () => z.string().min(1), jsonSchema: { type: 'string' } };
  ctx.effect(() => ctx.typert.register({
    package: NS, face: 'host', schemas: [],
    model: {
      services: [{
        key: SERVICE, exportName: 'MinimalistWorktreeService', description: 'New-session local/worktree choices and bounded local Git branch discovery.', tags: [],
        members: [{ kind: 'method', name: 'operate', signature: 'operate(agent: Agent, request: WorktreeChoiceRequest, signal?: AbortSignal): Promise<WorktreeChoiceSnapshot>' }],
        types: [
          { name: 'WorktreeChoiceRequest', declaration: "type WorktreeChoiceRequest = { action: 'inspect' } | { action: 'select'; mode: 'local' | 'worktree'; from?: string; expectedRevision?: number };" },
          { name: 'WorktreeChoiceSnapshot', declaration: 'interface WorktreeChoiceSnapshot { sessionId: string; cwd: string; editable: boolean; revision: number; selection: object | null; repository: object; }' },
        ],
      }], events: [], objects: [],
    },
    invocations: [{
      id: `${NS}#${SERVICE}/operate`, service: SERVICE, namespace: SERVICE, method: 'operate',
      invocation: { kind: 'direct' }, scope: { context: 'agent', wire: 'agentId' },
      parameters: [
        { name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent', codec: agentCodec },
        { name: 'request', wire: 'request', source: 'json', codec: codec('request', requestSchema) },
      ], cancellation: { parameter: 'signal' }, result: codec('snapshot', snapshotSchema),
    }],
  }));

  // Await preparation before allowing any model step. Errors propagate into the
  // normal visible Turn error path; no silent local fallback or duplicate retry.
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const combined = AbortSignal.any([signal, lifetime.signal]);
    await operations.prepare(agent, combined);
    return next();
  });

  ctx.inject(['tools', 'agents'], child => {
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
  });
}
