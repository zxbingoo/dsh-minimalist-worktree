import { createHash } from 'node:crypto';
import path from 'node:path';

const LIMIT = 256 * 1024;
const SELECTORS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CEILING_DIRECTORIES', 'GIT_PREFIX', 'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE', 'GIT_REPLACE_REF_BASE', 'GIT_ATTR_SOURCE'];
const ENV = { ...Object.fromEntries(SELECTORS.map(key => [key, undefined])), GIT_CONFIG_COUNT: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', LC_ALL: 'C' };
class Unsafe extends Error {}
function registrations(text) {
  const records = []; let current;
  for (const field of text.split('\0')) {
    if (!field) { if (current) records.push(current); current = undefined; continue; }
    const separator = field.indexOf(' '), key = separator < 0 ? field : field.slice(0, separator), value = separator < 0 ? true : field.slice(separator + 1);
    if (key === 'worktree') { if (current) throw new Error('Malformed Git worktree list'); current = { path: value }; }
    else { if (!current || key in current) throw new Error('Malformed Git worktree registration'); current[key] = value; }
  }
  if (current) records.push(current);
  return records;
}

/** Archive cleanup only. Explicit archive policy authorizes one
 * non-double-force Git worktree removal without a recovery snapshot. Never deletes branches or uses native Host FS. */
export function createWorktreeCleaner(provider) {
  return async function clean(agent, selection, { isStillSafe } = {}, callerSignal) {
    let targetPath = selection?.result?.path ?? '', branch = selection?.result?.branch ?? '';
    let removed = false;
    const result = (status, reason) => ({ status, reason, path: typeof targetPath === 'string' ? targetPath : '', branch: typeof branch === 'string' ? branch : '', at: Date.now() });
    try {
      if (selection?.status !== 'created' || selection.mode !== 'worktree' || !selection.result) throw new Unsafe('Not a completed plugin-owned worktree.');
      if (typeof isStillSafe !== 'function') throw new Unsafe('Archive occupancy guard is unavailable.');
      const source = selection.result.repositoryRoot;
      if (![source, targetPath, branch].every(value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0'))) throw new Unsafe('Invalid recorded worktree identity.');
      const paths = /^[a-z]:[\\/]|^\\\\/i.test(source) ? path.win32 : path.posix;
      if (!paths.isAbsolute(source) || !paths.isAbsolute(targetPath) || paths.normalize(source) !== source || paths.normalize(targetPath) !== targetPath) throw new Unsafe('Worktree paths must be canonical absolute paths.');
      const leaf = branch.startsWith('dsh/') ? branch.slice(4) : branch;
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(leaf) || leaf.includes('..') || leaf.endsWith('.lock') || branch !== selection.name) throw new Unsafe('Recorded branch does not match plugin ownership.');
      const signal = callerSignal ? AbortSignal.any([callerSignal, AbortSignal.timeout(10 * 60 * 1000)]) : AbortSignal.timeout(10 * 60 * 1000);
      const fs = provider(agent, 'fs'), subprocess = provider(agent, 'subprocess');
      const policy = provider(agent, 'sandboxPolicy').resolve({ session: agent.session });
      async function safe() { signal.throwIfAborted(); if (await isStillSafe() !== true) throw new Unsafe('Worktree is in use or archive state changed.'); signal.throwIfAborted(); }
      async function run(cwd, command, args, allowed = [0]) {
        await safe();
        let argv = [await subprocess.resolveExecutable(command, undefined, signal), ...args];
        if (policy.mode !== 'danger-full-access') argv = (await provider(agent, 'sandbox').confine(argv, policy, signal)).argv;
        await safe();
        const child = subprocess.spawn({ argv, cwd, env: { ...ENV }, signal, graceMs: 1000,
          stdio: { stdin: 'ignore', stdout: { maxBytes: LIMIT }, stderr: { maxBytes: LIMIT } } });
        try {
          const outcome = await child.done; signal.throwIfAborted();
          const stdout = child.collected.stdout.readFrom(0), stderr = child.collected.stderr.readFrom(0);
          if (stdout.lossy || stderr.lossy) throw new Error('Cleanup command output exceeded its bound.');
          if (!allowed.includes(outcome.exitCode)) throw new Error(`Cleanup command failed (${outcome.signal ?? outcome.exitCode}): ${stderr.text.slice(0, 2000)}`);
          return stdout.text;
        } finally { child.terminate(); await child.waitForExit(); }
      }
      let overrides = [];
      const git = (cwd, args, allowed) => run(cwd, 'git', ['--no-pager', '-c', `core.hooksPath=${paths === path.win32 ? 'NUL' : '/dev/null'}`, '-c', 'core.fsmonitor=false', ...overrides, ...args], allowed);
      const canonical = async value => fs.processPath(await fs.resolve(value, { cwd: source, signal }));
      await safe();
      if (source === targetPath || paths.relative(source, targetPath).startsWith('.agents' + paths.sep)) throw new Unsafe('Main and legacy in-project worktrees are not automatically cleaned.');
      if (await canonical(source) !== source || await canonical(targetPath) !== targetPath) throw new Unsafe('Recorded paths contain a symlink or changed identity.');
      const home = JSON.parse(await run(source, 'node', ['--input-type=module', '-e', "import os from 'node:os'; console.log(JSON.stringify(os.homedir()))"]));
      if (typeof home !== 'string' || !paths.isAbsolute(home)) throw new Unsafe('Execution home unavailable.');
      const canonicalHome = await canonical(home);
      const project = paths.basename(source).replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^[-.]+/, '').slice(0, 80) || 'repository';
      const hash = createHash('sha256').update(source).digest('hex').slice(0, 8);
      const expected = paths.join(canonicalHome, '.dsh', 'worktrees', `${project}-${hash}`, leaf);
      if (targetPath !== expected) throw new Unsafe('Target is not the exact plugin external worktree path.');
      let ancestor = canonicalHome;
      for (const part of paths.relative(canonicalHome, expected).split(paths.sep)) {
        ancestor = paths.join(ancestor, part);
        const info = await fs.lstat(ancestor, undefined, signal);
        if (info?.type !== 'directory') throw new Unsafe('Worktree path has a missing or symlink ancestor.');
      }
      if ((await git(source, ['rev-parse', '--show-toplevel'])).trimEnd() !== source) throw new Unsafe('Recorded repository root is no longer its Git top-level.');
      const config = await git(source, ['config', '--null', '--name-only', '--get-regexp', '^filter\\.'], [0, 1]);
      const drivers = new Set();
      for (const key of config.split('\0').filter(Boolean)) {
        const separator = key.lastIndexOf('.');
        if (separator <= 7 || !['clean', 'smudge', 'process', 'required'].includes(key.slice(separator + 1))) continue;
        const driver = key.slice(7, separator);
        if (/[\0\r\n=]/.test(driver)) throw new Unsafe('Unsafe Git filter configuration.');
        drivers.add(driver);
      }
      overrides = [...drivers].flatMap(driver => ['clean', 'smudge', 'process', 'required'].flatMap(attribute => ['-c', `filter.${driver}.${attribute}=${attribute === 'required' ? 'false' : ''}`]));
      const commonArgs = ['rev-parse', '--path-format=absolute', '--git-common-dir'];
      const common = await canonical((await git(source, commonArgs)).trimEnd());
      const verifyIdentity = async () => {
        const rows = registrations(await git(source, ['worktree', 'list', '--porcelain', '-z']));
        const row = rows.find(record => record.path === targetPath);
        if (!row || row.branch !== `refs/heads/${branch}` || row.bare || row.locked || row.prunable || row.detached || rows[0]?.path === targetPath) throw new Unsafe('Target registration is missing, locked, stale, detached or on another branch.');
        if (await canonical((await git(targetPath, commonArgs)).trimEnd()) !== common) throw new Unsafe('Target belongs to another Git repository.');
        const gitDir = await canonical((await git(targetPath, ['rev-parse', '--absolute-git-dir'])).trimEnd());
        if (gitDir === common) throw new Unsafe('Target is not a linked worktree.');
        if ((await git(targetPath, ['symbolic-ref', '--quiet', 'HEAD'])).trimEnd() !== `refs/heads/${branch}`) throw new Unsafe('Target branch changed.');
      };
      await verifyIdentity();
      // User-selected Paseo policy: discard checkout-local files without backup.
      // Recheck ownership and occupancy, never force a locked/foreign checkout.
      await verifyIdentity();
      await safe();
      await git(source, ['worktree', 'remove', '--force', '--', targetPath]);
      removed = true;
      if (registrations(await git(source, ['worktree', 'list', '--porcelain', '-z'])).some(row => row.path === targetPath)) throw new Error('Git still reports the worktree registration after removal.');
      await git(source, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
      return result('removed', 'Archived checkout removed without snapshot; branch preserved. Uncommitted and local files were discarded.');
    } catch (error) {
      return result(error instanceof Unsafe && !removed ? 'skipped' : 'failed', `${removed ? 'Git removal completed, but post-removal verification failed: ' : ''}${error instanceof Error ? error.message : String(error)}`);
    }
  };
}
