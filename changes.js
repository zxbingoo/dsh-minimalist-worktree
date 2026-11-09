import { z } from 'zod';

export const CHANGES_ENDPOINT = 'minimalistWorktree/changes';
export const REFRESH = 'dsh-minimalist-worktree.refresh';
const scopeSchema = z.enum(['all', 'unstaged', 'staged']).default('all');
const pathSchema = z.string().min(1).max(4096).refine(path => !path.includes('\0'), 'A path cannot contain NUL.');
export const changesRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('summary'), scope: scopeSchema }),
  z.strictObject({ action: z.literal('diff'), scope: scopeSchema, path: pathSchema }),
]);
const number = z.number().int().nonnegative();
const fileSchema = z.strictObject({
  path: z.string(), oldPath: z.string(), status: z.string(),
  added: number.nullable(), deleted: number.nullable(), binary: z.boolean(),
});

/** Share the already-versioned selection schema; reading changes never writes it. */
export function changesResultSchema(selectionSchema) {
  const identity = { sessionId: z.string(), cwd: z.string(), scope: z.enum(['all', 'unstaged', 'staged']) };
  return z.union([
    z.strictObject({
      ...identity, selection: selectionSchema.nullable(),
      repository: z.strictObject({
        kind: z.enum(['git', 'none', 'unknown']), root: z.string(), branch: z.string(), commit: z.string(), unborn: z.boolean(),
      }),
      files: z.array(fileSchema).max(500), added: number, deleted: number, untracked: number,
      limited: z.boolean(), reason: z.string(),
    }),
    z.strictObject({
      ...identity, kind: z.enum(['text', 'binary', 'oversized', 'conflict', 'submodule', 'missing', 'unavailable']),
      path: z.string(), patch: z.string().max(1024 * 1024), reason: z.string(),
    }),
  ]);
}

export function foldRefresh(state, event) {
  return event.type === 'turn/end' ? state + 1 : state;
}

/** Session-bound, cancellable read operation shared by UI and tools. */
export function createChangesOperations({ reader, cwdOf, selectionOf, resultSchema }) {
  const active = new Set();
  function operate(agent, raw, signal) {
    const operation = (async () => {
      signal?.throwIfAborted();
      const request = changesRequestSchema.parse(raw);
      const cwd = cwdOf(agent);
      if (typeof cwd !== 'string' || !cwd) throw new Error('The Session working directory is unavailable.');
      const result = request.action === 'summary'
        ? await reader.summary(agent, cwd, request.scope, signal)
        : await reader.diff(agent, cwd, request.scope, request.path, signal);
      signal?.throwIfAborted();
      // A Git command can overlap worktree creation or an explicit directory change.
      // Reject the old result rather than labelling the source checkout as current.
      if (cwdOf(agent) !== cwd) throw new Error('The Session directory changed while reading Git changes. Refresh and try again.');
      const value = { ...result, sessionId: agent.id, cwd, scope: request.scope };
      if (request.action === 'summary') value.selection = selectionOf(agent) ?? null;
      return resultSchema.parse(value);
    })();
    active.add(operation);
    const release = () => active.delete(operation);
    operation.then(release, release);
    return operation;
  }
  return { operate, async drain() { await Promise.allSettled([...active]); } };
}

export const changesToolParameters = {
  type: 'object', properties: {
    action: { type: 'string', enum: ['summary', 'diff'], description: 'summary lists changed files and counts; diff reads one file’s unified patch.' },
    scope: { type: 'string', enum: ['all', 'unstaged', 'staged'], description: 'Defaults to all: HEAD → working tree plus untracked files. unstaged: index → working tree plus untracked; staged: HEAD → index.' },
    path: { type: 'string', description: 'Required for diff: exact repository-relative path returned by summary.' },
    sessionId: { type: 'string', description: 'Target open Session; defaults to the calling Session.' },
  }, required: ['action'], additionalProperties: false,
};
export const changesToolOutput = {
  type: 'object', properties: {
    sessionId: { type: 'string' }, cwd: { type: 'string' }, scope: { type: 'string' },
    repository: { type: 'object', additionalProperties: true }, selection: { oneOf: [{ type: 'null' }, { type: 'object', additionalProperties: true }] },
    files: { type: 'array', items: { type: 'object', additionalProperties: true } },
    added: { type: 'integer' }, deleted: { type: 'integer' }, untracked: { type: 'integer' }, limited: { type: 'boolean' },
    kind: { type: 'string' }, path: { type: 'string' }, patch: { type: 'string' }, reason: { type: 'string' },
  }, required: ['sessionId', 'cwd', 'scope'], additionalProperties: false,
};
