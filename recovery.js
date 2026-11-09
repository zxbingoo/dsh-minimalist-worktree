import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createGitReader } from './git.js';

export const recoveryDecisionSchema = z.strictObject({
  status: z.enum(['source', 'creating', 'failed', 'rebuilt']), token: z.string(),
  sourceToken: z.string().optional(), error: z.string(), at: z.number(),
});
export const recoveryStateSchema = z.strictObject({
  sessionId: z.string(), blocked: z.boolean(), reason: z.string(), sourceCwd: z.string(), actualCwd: z.string(),
  expectedPath: z.string(), expectedBranch: z.string(), sourceBranch: z.string(), candidateCommit: z.string(),
  branchExists: z.boolean(), revision: z.number().int().nonnegative(), fingerprint: z.string(), stateToken: z.string(),
  token: z.string(), expectedExists: z.boolean(), canRebuild: z.boolean(), canUseSource: z.boolean(),
  decisionStatus: z.string(), sourceCommit: z.string(),
});
export const recoveryRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('inspect') }),
  z.strictObject({ action: z.literal('source'), token: z.string().length(64), confirmSource: z.literal(true) }),
  z.strictObject({ action: z.literal('rebuild'), token: z.string().length(64), confirmCommit: z.string().optional() }),
]);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const failure = error => error instanceof Error ? error.message : String(error);

/** No mutation on inspection or guard. Only explicit user choices may change checkout. */
export function createRecoveryOperations({ selections, decisions, provider, git = createGitReader(provider), rebuild, initialize,
  assertIdle = async () => {}, now = Date.now }) {
  const queues = new Map();
  function serial(agent, operation) {
    const task = (queues.get(agent.id) ?? Promise.resolve()).catch(() => {}).then(operation);
    const settled = task.then(() => {}, () => {}); queues.set(agent.id, settled);
    settled.then(() => { if (queues.get(agent.id) === settled) queues.delete(agent.id); }); return task;
  }
  async function exactBranch(agent, cwd, name, signal) {
    if (git.branchExists) return git.branchExists(agent, cwd, name, signal);
    // A failed revision lookup is not proof of absence. Probe a complete exact ref.
    const subprocess = provider(agent, 'subprocess');
    const policy = provider(agent, 'sandboxPolicy').resolve({ session: agent.session });
    let argv = [await subprocess.resolveExecutable('git', undefined, signal), '--no-pager', '--no-optional-locks', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', 'show-ref', '--verify', '--quiet', `refs/heads/${name}`];
    if (policy.mode !== 'danger-full-access') argv = (await provider(agent, 'sandbox').confine(argv, policy, signal)).argv;
    const env = Object.fromEntries(['GIT_DIR','GIT_WORK_TREE','GIT_COMMON_DIR','GIT_INDEX_FILE','GIT_OBJECT_DIRECTORY','GIT_ALTERNATE_OBJECT_DIRECTORIES','GIT_CONFIG','GIT_CONFIG_PARAMETERS','GIT_REPLACE_REF_BASE'].map(key => [key, undefined]));
    Object.assign(env, { GIT_CONFIG_COUNT: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' });
    signal?.throwIfAborted();
    const child = subprocess.spawn({ argv, cwd, env, signal, graceMs: 1000, stdio: { stdin: 'ignore', stdout: { maxBytes: 8192 }, stderr: { maxBytes: 8192 } } });
    try {
      const outcome = await child.done; signal?.throwIfAborted();
      const err = child.collected.stderr.readFrom(0);
      if (![0, 1].includes(outcome.exitCode) || err.lossy || err.text.trim()) throw new Error(`Cannot establish original branch state: ${err.text}`);
      return outcome.exitCode === 0;
    } finally { child.terminate(); await child.waitForExit(); }
  }
  async function inspect(agent, callerSignal) {
    const signal = callerSignal ? AbortSignal.any([callerSignal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000);
    signal.throwIfAborted();
    const selection = selections.get(agent.id), decision = decisions.get(agent.id);
    const wd = provider(agent, 'workingDirectory'), fs = provider(agent, 'fs');
    const actualCwd = wd.get(agent.session);
    const eligible = selection?.mode === 'worktree' && selection.status === 'created' && selection.result;
    const sourceCwd = eligible ? selection.result.repositoryRoot : '';
    const expectedPath = eligible ? selection.result.path : '';
    const expectedBranch = eligible ? selection.result.branch : '';
    const base = { sessionId: agent.id, blocked: false, reason: '', sourceCwd, actualCwd, expectedPath, expectedBranch,
      sourceBranch: '', sourceCommit: '', candidateCommit: '', branchExists: false, revision: selection?.revision ?? 0,
      expectedExists: false, canRebuild: false, canUseSource: false, decisionStatus: decision?.status ?? '' };
    let identity = null, sourceIdentity = null, sourceToken = '', inExpected = false;
    if (eligible) {
      try {
        const actual = await fs.resolve(actualCwd, { signal });
        const info = await fs.lstat(expectedPath, undefined, signal);
        const expected = await fs.resolve(expectedPath, { signal });
        base.expectedExists = info?.type === 'directory';
        identity = [expected.targetKey ?? fs.processPath(expected), info?.type ?? 'absent', info?.version ?? null];
        inExpected = base.expectedExists && fs.contains(expected, actual);
        if (inExpected) {
          const current = await git.inspect(agent, actualCwd, signal);
          inExpected = current.kind === 'git' && current.available && current.root === fs.processPath(expected) && current.branch === expectedBranch;
        }
        const source = await fs.resolve(sourceCwd, { signal });
        const sourceInfo = await fs.stat(source, signal);
        sourceIdentity = [source.targetKey ?? fs.processPath(source), sourceInfo?.type ?? 'absent'];
        if (sourceInfo?.type === 'directory') {
          const repository = await git.inspect(agent, sourceCwd, signal);
          base.sourceBranch = repository.branch ?? ''; base.sourceCommit = repository.commit ?? '';
          base.canUseSource = repository.kind === 'git' && repository.available && repository.root === fs.processPath(source);
          if (base.canUseSource) {
            base.branchExists = await exactBranch(agent, sourceCwd, expectedBranch, signal);
            try {
              base.candidateCommit = await git.resolveCommit(agent, sourceCwd, base.branchExists ? `refs/heads/${expectedBranch}` : selection.result.baseCommit, signal);
              base.canRebuild = !info && !!base.candidateCommit;
            } catch (error) {
              signal.throwIfAborted(); base.reason = `Original recovery commit cannot be read: ${failure(error)}`;
              base.canRebuild = false;
            }
          }
        }
        sourceToken = digest([selection, sourceIdentity, base.sourceBranch, base.sourceCommit]);
      } catch (error) {
        signal.throwIfAborted(); base.reason = `Cannot safely inspect worktree recovery: ${failure(error)}`;
        base.canRebuild = false; base.canUseSource = false;
      }
      base.blocked = !inExpected;
      // A created checkout is persisted before setup completes. A healthy checkout
      // with setup in flight is preparation, not a changed/missing worktree.
      // Keep recovery mutations disabled; assertReady separately guards model steps.
      if (['running', 'failed'].includes(selection.initialization?.status)) {
        base.canUseSource = false; base.canRebuild = false;
        if (selection.initialization.status === 'failed' || !inExpected) {
          base.blocked = true;
          base.reason = `Worktree initialization is ${selection.initialization.status}; inspect the existing failure before continuing.`;
        }
      }
      if (decision?.status === 'creating' || decision?.status === 'failed') {
        base.blocked = true; base.canRebuild = false; base.canUseSource = false; base.reason = `Recovery is ${decision.status}; no automatic retry or fallback. ${decision.error}`;
      } else if (!['running', 'failed'].includes(selection.initialization?.status) && decision?.status === 'source' && base.canUseSource && decision.sourceToken === sourceToken && actualCwd === sourceCwd) {
        base.blocked = false; base.reason = '';
      }
      if (base.blocked && !base.reason) base.reason = base.expectedExists ? 'Session directory or branch differs from its isolated worktree.' : 'The original isolated worktree is missing; explicitly choose how to continue.';
    }
    signal.throwIfAborted();
    if (wd.get(agent.session) !== actualCwd || digest(selections.get(agent.id) ?? null) !== digest(selection ?? null)) throw new Error('Recovery state changed during inspection. Refresh and choose again.');
    const token = digest([selection ?? null, actualCwd, identity, sourceIdentity, base.sourceBranch, base.sourceCommit, base.branchExists, base.candidateCommit, decision ?? null]);
    return { state: recoveryStateSchema.parse({ ...base, fingerprint: token, stateToken: token, token }), sourceToken };
  }
  async function publicInspect(agent, signal) { return (await inspect(agent, signal)).state; }
  async function assertReady(agent, signal) {
    const state = await publicInspect(agent, signal);
    if (state.blocked) { const error = new Error(state.reason); error.code = 'worktree-recovery-required'; error.recovery = state; throw error; }
    if (selections.get(agent.id)?.initialization?.status === 'running') {
      throw new Error('Worktree initialization is running; wait for preparation to complete before continuing.');
    }
    return state;
  }
  async function choose(agent, request, signal) {
    request = recoveryRequestSchema.parse(request);
    if (request.action === 'inspect') {
      if (Object.keys(request).length !== 1) throw new Error('inspect accepts no choice fields.');
      return publicInspect(agent, signal);
    }
    if (!['source', 'rebuild'].includes(request.action) || Object.keys(request).some(key => !['action','token','confirmSource','confirmCommit'].includes(key))) throw new Error('Invalid recovery choice.');
    return serial(agent, async () => {
      signal?.throwIfAborted(); await assertIdle(agent, signal);
      const current = await inspect(agent, signal), state = current.state;
      if (!state.blocked || request.token !== state.token) throw new Error('Recovery state changed. Review the current target and confirm again.');
      if (request.action === 'source') {
        if (request.confirmSource !== true) throw new Error('Source checkout requires explicit second confirmation.');
        if (!state.canUseSource) throw new Error('The original source repository is not safely available.');
        const confirmed = await inspect(agent, signal);
        if (confirmed.state.token !== request.token) throw new Error('Source repository state changed before confirmation.');
        await provider(agent, 'workingDirectory').set(agent, state.sourceCwd, signal);
        await decisions.put(agent.id, recoveryDecisionSchema.parse({ status: 'source', token: state.token, sourceToken: current.sourceToken, error: '', at: now() }));
        return publicInspect(agent, signal);
      }
      if (!state.canRebuild || !rebuild) throw new Error('Rebuilding requires an absent original directory and a verified local commit.');
      if (!state.branchExists && request.confirmCommit !== state.candidateCommit) throw new Error('Original branch is missing. Explicitly confirm the displayed fallback commit.');
      const selection = selections.get(agent.id);
      await decisions.put(agent.id, recoveryDecisionSchema.parse({ status: 'creating', token: state.token, error: '', at: now() }));
      try {
        signal?.throwIfAborted(); await assertIdle(agent, signal);
        const fs = provider(agent, 'fs');
        if (await fs.lstat(state.expectedPath, undefined, signal)) throw new Error('Recovery destination now exists; existing files were not overwritten.');
        const result = await rebuild(agent, { name: state.expectedBranch, branch: state.expectedBranch, from: state.candidateCommit, pinnedCommit: state.candidateCommit, commit: state.candidateCommit,
          path: state.expectedPath, repositoryRoot: selection.result.repositoryRoot, sourceCwd: state.sourceCwd, branchExists: state.branchExists }, signal);
        if (result.path !== state.expectedPath || result.branch !== state.expectedBranch) throw new Error('Rebuild returned an unexpected worktree identity.');
        const recovering = { ...selection, result, initialization: { status: 'running', reason: '' } };
        await selections.put(agent.id, recovering);
        const initialization = initialize ? await initialize(agent, result, signal) : { status: 'skipped', reason: 'No initializer configured.' };
        await selections.put(agent.id, { ...recovering, initialization });
        await decisions.put(agent.id, recoveryDecisionSchema.parse({ status: 'rebuilt', token: state.token, error: '', at: now() }));
        return publicInspect(agent, signal);
      } catch (error) {
        const reason = failure(error);
        const latest = selections.get(agent.id);
        if (latest?.initialization?.status === 'running') await selections.put(agent.id, { ...latest, initialization: { status: 'failed', reason } }).catch(() => {});
        await decisions.put(agent.id, recoveryDecisionSchema.parse({ status: 'failed', token: state.token, error: reason, at: now() })).catch(() => {});
        throw new Error(`Isolated worktree recovery failed; no retry or source fallback. ${reason}`, { cause: error });
      }
    });
  }
  return { inspect: publicInspect, assertReady, choose, async drain() { await Promise.all([...queues.values()]); } };
}
