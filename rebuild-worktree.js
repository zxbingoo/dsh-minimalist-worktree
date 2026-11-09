import { createHash } from 'node:crypto';
import path from 'node:path';

const LIMIT = 256 * 1024;
const SELECTORS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CEILING_DIRECTORIES', 'GIT_PREFIX', 'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE', 'GIT_REPLACE_REF_BASE', 'GIT_ATTR_SOURCE'];
const ENV = { ...Object.fromEntries(SELECTORS.map(key => [key, undefined])), GIT_CONFIG_COUNT: '0', GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', LC_ALL: 'C' };
const ALLOCATE = `
import fs from 'node:fs/promises';
import path from 'node:path';
const [home, destination] = process.argv.slice(1);
try {
  const relative = path.relative(home, destination);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Destination must remain inside home');
  let current = home;
  const homeInfo = await fs.lstat(home);
  if (!homeInfo.isDirectory() || homeInfo.isSymbolicLink()) throw new Error('Unsafe home');
  const parts = relative.split(path.sep);
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    try { await fs.mkdir(current); } catch (error) { if (i === parts.length - 1 || error.code !== 'EEXIST') throw error; }
    const info = await fs.lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe directory: ' + current);
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
`;

/** Explicit recovery only. Caller owns durable authorization, attempt intent and initializer.
 * No overwrite, broad prune, fetch, forced ref update, cleanup, or automatic retry.
 */
export function createWorktreeRebuilder(provider) {
  return async function rebuild(agent, request, callerSignal) {
    const { path: destination, branch, repositoryRoot, commit, branchExists } = request ?? {};
    if (typeof branch !== 'string' || !/^dsh\/[a-z][a-z0-9]*-[a-z][a-z0-9]*$/.test(branch) || branch.length > 200) throw new TypeError('Recovery requires a safe dsh/word-pair branch.');
    if (typeof branchExists !== 'boolean' || typeof commit !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(commit)) throw new TypeError('Recovery requires an explicit branch state and full pinned commit.');
    if (![destination, repositoryRoot].every(value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0'))) throw new TypeError('Invalid recovery paths.');
    const paths = /^[a-z]:[\\/]|^\\\\/i.test(repositoryRoot) ? path.win32 : path.posix;
    if (![destination, repositoryRoot].every(value => paths.isAbsolute(value) && paths.normalize(value) === value)) throw new TypeError('Recovery paths must be canonical and absolute.');
    const signal = callerSignal ? AbortSignal.any([callerSignal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000);
    signal.throwIfAborted();
    const fs = provider(agent, 'fs'), subprocess = provider(agent, 'subprocess'), wd = provider(agent, 'workingDirectory');
    const originalCwd = wd.get(agent.session);
    const policy = provider(agent, 'sandboxPolicy').resolve({ session: agent.session });
    const assertCwd = () => { signal.throwIfAborted(); if (wd.get(agent.session) !== originalCwd) throw new Error('Session directory changed during recovery.'); };
    async function run(cwd, command, args, allowed = [0], env = {}) {
      assertCwd();
      let argv = [await subprocess.resolveExecutable(command, undefined, signal), ...args];
      if (policy.mode !== 'danger-full-access') argv = (await provider(agent, 'sandbox').confine(argv, policy, signal)).argv;
      assertCwd();
      const child = subprocess.spawn({ argv, cwd, env: { ...ENV, ...env }, signal, graceMs: 1000,
        stdio: { stdin: 'ignore', stdout: { maxBytes: LIMIT }, stderr: { maxBytes: LIMIT } } });
      try {
        const outcome = await child.done; signal.throwIfAborted();
        const stdout = child.collected.stdout.readFrom(0), stderr = child.collected.stderr.readFrom(0);
        if (stdout.lossy || stderr.lossy) throw new Error('Recovery command output exceeded its bound.');
        if (!allowed.includes(outcome.exitCode)) throw new Error(`Recovery command failed (${outcome.signal ?? outcome.exitCode}): ${stderr.text.slice(-2000)}`);
        return { text: stdout.text, exitCode: outcome.exitCode };
      } finally { child.terminate(); await child.waitForExit(); }
    }
    const git = (cwd, args, allowed, env) => run(cwd, 'git', ['--no-pager', '-c', `core.hooksPath=${paths === path.win32 ? 'NUL' : '/dev/null'}`, '-c', 'core.fsmonitor=false', ...args], allowed, env);
    const canonical = async value => fs.processPath(await fs.resolve(value, { cwd: repositoryRoot, signal }));
    if (await canonical(repositoryRoot) !== repositoryRoot || await canonical(destination) !== destination) throw new Error('Recovery paths have changed identity or contain symlinks.');
    if ((await git(repositoryRoot, ['rev-parse', '--show-toplevel'])).text.replace(/\r?\n$/, '') !== repositoryRoot) throw new Error('Recorded source must remain its Git repository root.');
    const home = JSON.parse((await run(repositoryRoot, 'node', ['--input-type=module', '-e', "import os from 'node:os'; console.log(JSON.stringify(os.homedir()))"])).text);
    if (typeof home !== 'string' || !paths.isAbsolute(home)) throw new Error('Execution-world home is unavailable.');
    const canonicalHome = await canonical(home);
    const project = paths.basename(repositoryRoot).replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^[-.]+/, '').slice(0, 80) || 'repository';
    const hash = createHash('sha256').update(repositoryRoot).digest('hex').slice(0, 8);
    const expected = paths.join(canonicalHome, '.dsh', 'worktrees', `${project}-${hash}`, branch.slice(4));
    if (destination !== expected || destination === repositoryRoot) throw new Error('Recovery only supports the exact owned external worktree path; legacy paths are not rebuilt automatically.');
    if (await fs.lstat(destination, undefined, signal)) throw new Error('Recovery destination already exists; no files will be overwritten.');
    await git(repositoryRoot, ['check-ref-format', `refs/heads/${branch}`]);
    const resolved = (await git(repositoryRoot, ['rev-parse', '--verify', '--end-of-options', `${commit}^{commit}`])).text.trim();
    if (resolved.toLowerCase() !== commit.toLowerCase()) throw new Error('Pinned recovery commit is not available locally.');
    async function verifyBranch() {
      const found = await git(repositoryRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], [0, 1]);
      if ((found.exitCode === 0) !== branchExists) throw new Error('Branch existence changed; confirm recovery again.');
      if (branchExists && (await git(repositoryRoot, ['rev-parse', '--verify', '--end-of-options', `refs/heads/${branch}^{commit}`])).text.trim() !== resolved) throw new Error('Branch moved since recovery was confirmed.');
    }
    await verifyBranch();
    const registered = (await git(repositoryRoot, ['worktree', 'list', '--porcelain', '-z'])).text;
    let stale = false;
    for (const entry of registered.split('\0\0').filter(Boolean)) {
      const fields = entry.split('\0'), registeredPath = fields.find(value => value.startsWith('worktree '))?.slice(9);
      const ref = fields.find(value => value.startsWith('branch '))?.slice(7);
      if (registeredPath === destination) {
        if (ref !== `refs/heads/${branch}` || fields.some(value => value === 'locked' || value.startsWith('locked ')) || fields.includes('bare')) throw new Error('Stale registration has another branch or is locked; recovery refused.');
        stale = true;
      } else if (ref === `refs/heads/${branch}`) throw new Error('Branch is already in use by another worktree.');
    }
    if (stale) {
      if (await fs.lstat(destination, undefined, signal)) throw new Error('Recovery destination appeared; retained.');
      await git(repositoryRoot, ['worktree', 'remove', '--', destination]);
    }
    await verifyBranch();
    if (await fs.lstat(destination, undefined, signal)) throw new Error('Recovery destination appeared; retained.');
    try {
      await run(repositoryRoot, 'node', ['--input-type=module', '-e', ALLOCATE, canonicalHome, destination]);
      await verifyBranch();
      await git(repositoryRoot, ['--work-tree', repositoryRoot, 'worktree', 'add', '--no-checkout', ...(branchExists ? ['--', destination, branch] : ['-b', branch, '--', destination, resolved])]);
      const configured = (await git(destination, ['config', '--null', '--name-only', '--get-regexp', '^filter\\.'], [0, 1])).text;
      const drivers = new Set();
      for (const key of configured.split('\0').filter(Boolean)) {
        const separator = key.lastIndexOf('.');
        if (separator > 7 && ['clean', 'smudge', 'process', 'required'].includes(key.slice(separator + 1))) {
          const driver = key.slice(7, separator);
          if (/[\0\r\n=]/.test(driver)) throw new Error('Unsafe Git filter configuration.');
          drivers.add(driver);
        }
      }
      const env = { GIT_CONFIG_COUNT: String(drivers.size * 4) }; let index = 0;
      for (const driver of drivers) for (const attribute of ['clean', 'smudge', 'process', 'required']) {
        env[`GIT_CONFIG_KEY_${index}`] = `filter.${driver}.${attribute}`; env[`GIT_CONFIG_VALUE_${index++}`] = attribute === 'required' ? 'false' : '';
      }
      if ((await git(destination, ['rev-parse', '--verify', 'HEAD'])).text.trim() !== resolved) throw new Error('Branch moved during recovery checkout.');
      // Unlike reset --hard, read-tree never updates an existing branch ref when a
      // concurrent ref move occurs. Only this exclusively allocated checkout is populated.
      await git(destination, ['--work-tree', destination, 'read-tree', '--reset', '-u', '--no-recurse-submodules', resolved], undefined, env);
      if ((await git(destination, ['rev-parse', '--verify', 'HEAD'])).text.trim() !== resolved) throw new Error('Branch moved during recovery checkout; no ref was rewound.');
      assertCwd();
      return { path: await wd.set(agent, destination, signal), branch, baseCommit: resolved, repositoryRoot };
    } catch (error) {
      throw new Error(`Could not rebuild ${branch} at ${destination}. Any allocated directory and branch are retained; no automatic retry or cleanup. ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  };
}
