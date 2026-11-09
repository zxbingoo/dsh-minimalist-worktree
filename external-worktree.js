import { createHash } from 'node:crypto';
import path from 'node:path';

const LIMIT = 256 * 1024;
const SELECTORS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CEILING_DIRECTORIES', 'GIT_PREFIX', 'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE', 'GIT_REPLACE_REF_BASE', 'GIT_ATTR_SOURCE'];
const ENV = { ...Object.fromEntries(SELECTORS.map(key => [key, undefined])), GIT_CONFIG_COUNT: '0', GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', GIT_NO_LAZY_FETCH: '1', GIT_PAGER: 'cat', LC_ALL: 'C' };
// All filesystem writes execute in the mounted subprocess world under its policy.
// Reject visible symlink ancestors; descriptor-level symlink-swap races are not solved by this API.
const ALLOCATE = `
import fs from 'node:fs/promises';
import path from 'node:path';
const [home, pool, destination] = process.argv.slice(1);
async function directory(p, exclusive = false) {
  try { await fs.mkdir(p); }
  catch (e) { if (exclusive || e.code !== 'EEXIST') throw e; }
  const info = await fs.lstat(p);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe worktree directory: ' + p);
}
try {
  const relative = path.relative(home, destination);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Worktree destination must be inside home');
  let current = home;
  await directory(current);
  const parts = relative.split(path.sep);
  for (let i = 0; i < parts.length; i++) { current = path.join(current, parts[i]); await directory(current, i === parts.length - 1); }
} catch (e) { console.error(e.message); process.exitCode = 1; }
`;

/** Create retained external checkouts with mounted FS/process/policy capabilities only.
 * `home`, when supplied, is an absolute path in that execution world (not Host home).
 * Otherwise a sandboxed Node probe obtains os.homedir() in the same world.
 * Caller owns durable once-only intent, cancellation lifetime and failure recovery.
 */
export function createExternalWorktreeCreator(provider, { home } = {}) {
  return async (agent, request = {}, callerSignal, onProgress) => {
    const branch = request.name;
    const leaf = typeof branch === 'string' && branch.startsWith('dsh/') ? branch.slice(4) : branch;
    if (typeof branch !== 'string' || branch.length > 200 || typeof leaf !== 'string'
      || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(leaf) || leaf.includes('..') || leaf.endsWith('.lock') || leaf.endsWith('.')) throw new TypeError('Invalid external worktree name.');
    const revision = request.from ?? 'HEAD';
    if (typeof revision !== 'string' || !revision || revision.includes('\0') || revision.length > 1024) throw new TypeError('Invalid worktree revision.');
    const signal = callerSignal ? AbortSignal.any([callerSignal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000);
    signal.throwIfAborted();
    const fs = provider(agent, 'fs'), subprocess = provider(agent, 'subprocess');
    const wd = provider(agent, 'workingDirectory');
    const cwd = await wd.ensure(agent, signal);
    const policy = provider(agent, 'sandboxPolicy').resolve({ session: agent.session });
    async function run(directory, command, args, allowed = [0], env = {}) {
      signal.throwIfAborted();
      let argv = [await subprocess.resolveExecutable(command, undefined, signal), ...args];
      if (policy.mode !== 'danger-full-access') argv = (await provider(agent, 'sandbox').confine(argv, policy, signal)).argv;
      signal.throwIfAborted();
      const child = subprocess.spawn({ argv, cwd: directory, env: { ...ENV, ...env }, signal, graceMs: 1000,
        stdio: { stdin: 'ignore', stdout: { maxBytes: LIMIT }, stderr: { maxBytes: LIMIT } } });
      try {
        const outcome = await child.done;
        signal.throwIfAborted();
        const stdout = child.collected.stdout.readFrom(0), stderr = child.collected.stderr.readFrom(0);
        if (stdout.lossy || stderr.lossy) throw new Error('Worktree command output exceeded its bound.');
        if (!allowed.includes(outcome.exitCode)) throw new Error(`Worktree command failed (${outcome.signal ?? outcome.exitCode}): ${stderr.text.trim().slice(0, 2000)}`);
        return { text: stdout.text, exitCode: outcome.exitCode };
      } finally { child.terminate(); await child.waitForExit(); }
    }
    const git = (directory, args, allowed, env) => run(directory, 'git', ['--no-pager', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], allowed, env);
    await git(cwd, ['check-ref-format', `refs/heads/${branch}`]);
    const rootOutput = await git(cwd, ['rev-parse', '--show-toplevel']);
    const root = await fs.resolve(rootOutput.text.replace(/\r?\n$/, ''), { cwd, signal });
    const repositoryRoot = fs.processPath(root);
    const baseCommit = (await git(repositoryRoot, ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`])).text.trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(baseCommit)) throw new Error('Git returned an invalid pinned commit.');
    if ((await git(repositoryRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], [0, 1])).exitCode === 0) throw new Error(`Worktree branch already exists: ${branch}`);
    const executionHome = home ?? JSON.parse((await run(repositoryRoot, 'node', ['--input-type=module', '-e', "import os from 'node:os'; console.log(JSON.stringify(os.homedir()))"])).text);
    if (typeof executionHome !== 'string' || !executionHome || executionHome.includes('\0')) throw new Error('Execution-world home is unavailable.');
    const paths = /^[a-z]:[\\/]|^\\\\/i.test(executionHome) ? path.win32 : path.posix;
    if (!paths.isAbsolute(executionHome)) throw new Error('Execution-world home must be absolute.');
    const homeTarget = await fs.resolve(executionHome, { cwd: repositoryRoot, signal });
    const homePath = fs.processPath(homeTarget);
    const project = paths.basename(repositoryRoot).replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^[-.]+/, '').slice(0, 80) || 'repository';
    const hash = createHash('sha256').update(repositoryRoot).digest('hex').slice(0, 8);
    const pool = await fs.resolve(paths.join(homePath, '.dsh', 'worktrees', `${project}-${hash}`), { cwd: homePath, signal });
    const destination = await fs.resolve(leaf, { cwd: fs.processPath(pool), signal });
    const destinationPath = fs.processPath(destination);
    if (!fs.contains(homeTarget, pool) || !fs.contains(pool, destination) || fs.contains(root, destination) || destination.targetKey === pool.targetKey) throw new Error('External worktree destination escaped its pool or is inside the source repository.');
    if (await fs.lstat(destinationPath, undefined, signal)) throw new Error(`Worktree path already exists: ${destinationPath}`);
    try {
      await onProgress?.({ phase: 'creating', cwd: destinationPath, branch, text: `Creating worktree ${branch}\n` });
      await run(repositoryRoot, 'node', ['--input-type=module', '-e', ALLOCATE, homePath, fs.processPath(pool), destinationPath]);
      await git(repositoryRoot, ['--work-tree', repositoryRoot, 'worktree', 'add', '--no-checkout', '-b', branch, '--', destinationPath, baseCommit]);
      const configured = await git(destinationPath, ['config', '--null', '--name-only', '--get-regexp', '^filter\\.'], [0, 1]);
      const drivers = new Set();
      for (const key of configured.text.split('\0').filter(Boolean)) {
        const separator = key.lastIndexOf('.');
        if (separator > 7 && ['clean', 'smudge', 'process', 'required'].includes(key.slice(separator + 1))) {
          const driver = key.slice(7, separator);
          if (/[\0\r\n=]/.test(driver)) throw new Error('Unsafe Git filter configuration.');
          drivers.add(driver);
        }
      }
      const overrides = { GIT_CONFIG_COUNT: String(drivers.size * 4) };
      let index = 0;
      for (const driver of drivers) for (const attribute of ['clean', 'smudge', 'process', 'required']) {
        overrides[`GIT_CONFIG_KEY_${index}`] = `filter.${driver}.${attribute}`;
        overrides[`GIT_CONFIG_VALUE_${index++}`] = attribute === 'required' ? 'false' : '';
      }
      await git(destinationPath, ['--work-tree', destinationPath, 'reset', '--hard', '--no-recurse-submodules', baseCommit], undefined, overrides);
      // Never publish a stale operation into a Session whose source cwd changed.
      if (wd.get(agent.session) !== cwd) throw new Error('Session directory changed during worktree creation.');
      const published = await wd.set(agent, destinationPath, signal);
      await onProgress?.({ cwd: published, branch, text: 'Worktree checkout complete.\n' });
      return { path: published, branch, baseCommit, repositoryRoot };
    } catch (error) {
      throw new Error(`Could not finish worktree ${branch} at ${destinationPath}. Any allocated checkout and branch are retained; no automatic retry or cleanup. ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  };
}
