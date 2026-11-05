/** Read Git metadata with literal argv in the Session's execution world and policy. */
export const BRANCH_LIMIT = 200;
const OUTPUT_LIMIT = 256 * 1024;
const READ_TIMEOUT_MS = 10000;
const SELECTORS = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CEILING_DIRECTORIES',
  'GIT_PREFIX', 'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE', 'GIT_REPLACE_REF_BASE', 'GIT_ATTR_SOURCE',
];
const READ_ENV = {
  ...Object.fromEntries(SELECTORS.map(key => [key, undefined])),
  GIT_CONFIG_COUNT: '0', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0',
  GIT_NO_LAZY_FETCH: '1', GIT_PAGER: 'cat', LC_ALL: 'C',
};

export class GitReadError extends Error {
  constructor(message, exitCode, stderr = '') {
    super(message); this.name = 'GitReadError'; this.exitCode = exitCode; this.stderr = stderr;
  }
}

export function createGitReader(provider) {
  async function run(agent, cwd, args, signal, allowed = [0]) {
    signal?.throwIfAborted();
    const subprocess = provider(agent, 'subprocess');
    const policy = provider(agent, 'sandboxPolicy').resolve({ session: agent.session });
    const executable = await subprocess.resolveExecutable('git', undefined, signal);
    let argv = [executable, '--no-pager', '--no-optional-locks', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args];
    if (policy.mode !== 'danger-full-access') argv = (await provider(agent, 'sandbox').confine(argv, policy, signal)).argv;
    signal?.throwIfAborted();
    const child = subprocess.spawn({
      argv, cwd, env: { ...READ_ENV }, signal, graceMs: 1000,
      stdio: { stdin: 'ignore', stdout: { maxBytes: OUTPUT_LIMIT }, stderr: { maxBytes: 8192 } },
    });
    try {
      const outcome = await child.done;
      signal?.throwIfAborted();
      const stdout = child.collected.stdout.readFrom(0);
      const stderr = child.collected.stderr.readFrom(0);
      if (!allowed.includes(outcome.exitCode)) {
        throw new GitReadError(`Git inspection failed (${outcome.signal ?? outcome.exitCode}): ${stderr.text.trim().slice(0, 1000)}`, outcome.exitCode, stderr.text);
      }
      if (stdout.lossy) throw new Error('Git inspection exceeded its output limit.');
      return { text: stdout.text, exitCode: outcome.exitCode };
    } finally {
      child.terminate();
      await child.waitForExit();
    }
  }
  function bounded(signal) {
    return signal ? AbortSignal.any([signal, AbortSignal.timeout(READ_TIMEOUT_MS)]) : AbortSignal.timeout(READ_TIMEOUT_MS);
  }
  async function resolveCommit(agent, cwd, from, signal) {
    if (typeof from !== 'string' || !from || from.includes('\0') || from.length > 1024) throw new TypeError('Invalid Git revision.');
    const output = await run(agent, cwd, ['rev-parse', '--verify', '--end-of-options', `${from}^{commit}`], bounded(signal));
    const commit = output.text.trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new Error('Git returned an invalid commit object name.');
    return commit;
  }
  async function inspect(agent, cwd, callerSignal) {
    const signal = bounded(callerSignal);
    const empty = { kind: 'unknown', available: false, root: '', branch: '', commit: '', branches: [], truncated: false, reason: '' };
    let kind = 'unknown', root = '', branch = '', commit = '';
    try {
      const rootOutput = await run(agent, cwd, ['rev-parse', '--show-toplevel'], signal);
      kind = 'git';
      const fs = provider(agent, 'fs');
      root = fs.processPath(await fs.resolve(rootOutput.text.replace(/\r?\n$/, ''), { cwd, signal }));
      branch = (await run(agent, cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], signal, [0, 1])).text.trim();
      try { commit = await resolveCommit(agent, cwd, 'HEAD', signal); }
      catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof GitReadError)) throw error;
        return { ...empty, kind, root, branch, reason: 'This repository has no readable HEAD commit. Make the first commit before creating a worktree.' };
      }
      const output = await run(agent, cwd, [
        'for-each-ref', `--count=${BRANCH_LIMIT + 1}`, '--sort=refname',
        '--format=%(refname)%00%(refname:short)%00%(symref)', 'refs/heads/', 'refs/remotes/',
      ], signal);
      const branches = output.text.split('\n').filter(Boolean).map(line => {
        const [ref, label, symbolic] = line.replace(/\r$/, '').split('\0');
        if (symbolic || !ref || !label) return null; // origin/HEAD is an alias, not a base branch.
        const kind = ref.startsWith('refs/heads/') ? 'local' : ref.startsWith('refs/remotes/') ? 'remote' : null;
        return kind ? { ref, label, kind } : null;
      }).filter(Boolean);
      return { kind, available: true, root, branch, commit, branches: branches.slice(0, BRANCH_LIMIT), truncated: output.text.split('\n').filter(Boolean).length > BRANCH_LIMIT, reason: '' };
    } catch (error) {
      callerSignal?.throwIfAborted();
      // Absence is normal. Missing Git, sandbox denials and other read failures
      // remain unknown, not evidence that the workspace is outside a repository.
      if (kind === 'unknown' && error instanceof GitReadError && error.exitCode === 128
        && /(?:^|\n)fatal: not a git repository(?:\s|:)/.test(error.stderr)) {
        return { ...empty, kind: 'none' };
      }
      return { ...empty, kind, root, branch, commit, reason: error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000) };
    }
  }
  return { inspect, resolveCommit };
}
