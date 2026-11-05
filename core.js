/** Quiet session choices and once-only preparation; no UI or Git implementation here. */
export const NS = 'dsh-minimalist-worktree';
export const SERVICE = 'minimalistWorktree';
export const STARTED = `${NS}.started`;

export function argumentsOf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Arguments must be an object');
  for (const key of Object.keys(value)) {
    if (!['action', 'mode', 'from', 'expectedRevision'].includes(key)) throw new TypeError(`Unknown argument: ${key}`);
  }
  if (!['inspect', 'select'].includes(value.action)) throw new TypeError('action must be inspect or select');
  if (value.action === 'inspect') {
    if (Object.keys(value).length !== 1) throw new TypeError('inspect takes no selection fields');
    return { action: 'inspect' };
  }
  if (!['local', 'worktree'].includes(value.mode)) throw new TypeError('mode must be local or worktree');
  if (value.from !== undefined && (typeof value.from !== 'string' || !value.from.length || value.from.length > 1024 || value.from.includes('\0'))) {
    throw new TypeError('from must be a local Git revision of at most 1024 characters');
  }
  if (value.mode === 'local' && value.from !== undefined) throw new TypeError('Local mode does not change branches; from is only for worktree mode');
  if (value.expectedRevision !== undefined && (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0)) {
    throw new TypeError('expectedRevision must be a non-negative safe integer');
  }
  return { ...value, ...(value.mode === 'worktree' ? { from: value.from ?? 'HEAD' } : {}) };
}

export function foldStarted(state, event) {
  return state || ['turn/start', 'user/message', 'assistant/message'].includes(event.type);
}

/** Serializes choices and preparation for the same Session, not unrelated Sessions. */
export function createOperations({ table, cwdOf, started, repository, resolveCommit, createWorktree, makeName, available = () => true }) {
  const queues = new Map();
  function serial(id, task) {
    const previous = queues.get(id) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(task);
    const settled = operation.then(() => {}, () => {});
    queues.set(id, settled);
    settled.then(() => { if (queues.get(id) === settled) queues.delete(id); });
    return operation;
  }
  async function snapshot(agent, signal, knownRepository) {
    signal?.throwIfAborted();
    const selection = table.get(agent.id) ?? null;
    const cwd = cwdOf(agent);
    const repo = knownRepository ?? await repository(agent, cwd, signal);
    return {
      sessionId: agent.id, cwd, editable: !started(agent),
      revision: selection?.revision ?? 0,
      selection,
      repository: { ...repo, ...(available(agent) ? {} : { available: false, reason: 'Worktree service is unavailable in this composition.' }) },
    };
  }
  function assertEditable(agent) {
    if (started(agent)) throw new Error('Worktree choices can only be changed before the first message. Start a new session to choose another checkout.');
  }
  async function operate(agent, raw, signal) {
    const request = argumentsOf(raw);
    return serial(agent.id, async () => {
      signal?.throwIfAborted();
      if (request.action === 'inspect') return snapshot(agent, signal);
      assertEditable(agent);
      const previous = table.get(agent.id);
      if (request.expectedRevision !== undefined && request.expectedRevision !== (previous?.revision ?? 0)) {
        throw new Error('This selection changed in another window. Refresh the choices and try again.');
      }
      const sourceCwd = cwdOf(agent);
      let repo;
      let baseCommit = '';
      if (request.mode === 'worktree') {
        if (!available(agent)) throw new Error('Worktree service is unavailable in this composition.');
        repo = await repository(agent, sourceCwd, signal);
        if (!repo.available) throw new Error(repo.reason || 'Choose a Git repository with at least one commit.');
        baseCommit = await resolveCommit(agent, sourceCwd, request.from, signal);
      }
      signal?.throwIfAborted();
      assertEditable(agent); // Sending during validation must not stage a late selection.
      if (cwdOf(agent) !== sourceCwd) throw new Error('The workspace changed while saving. Choose again in the current workspace.');
      const name = request.mode === 'worktree' ? (previous?.name || await makeName(agent, sourceCwd, signal)) : '';
      // Naming probes are asynchronous too: never persist after send, cwd change, or cancellation.
      signal?.throwIfAborted();
      assertEditable(agent);
      if (cwdOf(agent) !== sourceCwd) throw new Error('The workspace changed while saving. Choose again in the current workspace.');
      const selection = {
        mode: request.mode, from: request.from ?? 'HEAD', baseCommit, sourceCwd, name,
        status: 'staged', revision: (previous?.revision ?? 0) + 1, error: '',
      };
      await table.put(agent.id, selection);
      return snapshot(agent, signal, repo);
    });
  }
  async function prepare(agent, signal) {
    return serial(agent.id, async () => {
      signal?.throwIfAborted();
      const plan = table.get(agent.id);
      if (!plan || plan.mode === 'local' || plan.status === 'created') return;
      if (plan.status !== 'staged') {
        throw new Error(`Worktree preparation is ${plan.status}; no automatic retry or local fallback was performed. ${plan.error || 'A previous attempt may have retained files and a branch.'}`);
      }
      const cwd = cwdOf(agent);
      const repo = await repository(agent, cwd, signal);
      signal?.throwIfAborted();
      if (cwdOf(agent) !== cwd) throw new Error('The workspace changed while preparing the worktree. Start a new session and choose again.');
      // A new-session choice must not remain invisibly armed after the user
      // switches to a non-Git workspace. Only a confirmed absence, BEFORE any
      // allocation attempt, uses the implicit Local default; failures stay closed.
      if (repo.kind === 'none') {
        await table.put(agent.id, {
          mode: 'local', from: 'HEAD', baseCommit: '', sourceCwd: cwd, name: '',
          status: 'staged', revision: plan.revision + 1, error: '',
        });
        signal?.throwIfAborted();
        if (cwdOf(agent) !== cwd) throw new Error('The workspace changed while selecting the Local default. Start a new session and choose again.');
        return;
      }
      if (cwd !== plan.sourceCwd) throw new Error('The selected worktree belongs to a different workspace. Start a new session and choose again.');
      // Persist the intent before allocating. A crash/timeout must never allocate a second checkout.
      const creating = { ...plan, status: 'creating' };
      await table.put(agent.id, creating);
      try {
        signal?.throwIfAborted();
        if (cwdOf(agent) !== plan.sourceCwd) throw new Error('The workspace changed while preparing the worktree. No checkout was created. Start a new session and choose again.');
        const result = await createWorktree(agent, { name: plan.name, from: plan.baseCommit }, signal);
        await table.put(agent.id, { ...creating, status: 'created', result });
        return result;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        // If persistence itself is failing, the durable 'creating' intent still fails closed.
        await table.put(agent.id, { ...creating, status: 'failed', error: reason }).catch(() => {});
        throw new Error(`Worktree preparation failed; the model was not started in the local checkout. ${reason}`, { cause: error });
      }
    });
  }
  return { operate, prepare, async drain() { await Promise.all([...queues.values()]); } };
}
