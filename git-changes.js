import { GitReadError } from './git.js';

export const CHANGE_FILE_LIMIT = 500;
export const CHANGE_OUTPUT_LIMIT = 2 * 1024 * 1024;
export const PATCH_BYTE_LIMIT = 512 * 1024;
export const PATCH_LINE_LIMIT = 10000;
const READ_TIMEOUT_MS = 10000;
// Git recognizes its empty tree even in an object database with no objects.
// Never materialize a tree, index or blob merely to inspect an unborn repository.
const EMPTY_TREES = {
  sha1: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
  sha256: '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321',
};
const SELECTORS = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CEILING_DIRECTORIES',
  'GIT_PREFIX', 'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE', 'GIT_REPLACE_REF_BASE', 'GIT_ATTR_SOURCE',
  'GIT_EXTERNAL_DIFF', 'GIT_DIFF_OPTS', 'GIT_ASKPASS', 'SSH_ASKPASS',
  'GIT_LITERAL_PATHSPECS', 'GIT_GLOB_PATHSPECS', 'GIT_NOGLOB_PATHSPECS', 'GIT_ICASE_PATHSPECS',
];
const READ_ENV = {
  ...Object.fromEntries(SELECTORS.map(key => [key, undefined])),
  GIT_CONFIG_COUNT: '0', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0',
  GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_PAGER: 'cat', LC_ALL: 'C',
};
class OutputLimitError extends Error {}
class PathReadError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}
const message = error => (error instanceof Error ? error.message : String(error)).slice(0, 1000);
const blankRepository = () => ({ kind: 'unknown', root: '', branch: '', commit: '', unborn: false });
const publicRepository = repo => Object.fromEntries(Object.keys(blankRepository()).map(key => [key, repo[key]]));
const result = (kind, path, reason = '', patch = '') => ({ kind, path, patch, reason });
const validScope = scope => {
  if (!['all', 'unstaged', 'staged'].includes(scope)) throw new TypeError('Invalid Git change scope.');
};
function validPath(path) {
  // Git's paths use / in every execution world. Do not normalize an alias into
  // a different listed path (in particular a directory or a descendant match).
  return typeof path === 'string' && path.length > 0 && path.length <= 4096
    && !path.includes('\0') && !path.startsWith('/') && !path.startsWith('\\')
    && !/^[a-z]:[\\/]/i.test(path)
    && path.split('/').every(part => part && part !== '.' && part !== '..');
}
function listedPath(path) {
  if (!validPath(path) || path.includes('\ufffd')) throw new Error('Git returned an unsupported or non-UTF-8 repository path.');
  return path;
}
function nulFields(text) {
  if (!text) return [];
  if (!text.endsWith('\0')) throw new Error('Git returned incomplete NUL-delimited change metadata.');
  return text.slice(0, -1).split('\0');
}
function parseChanges(text) {
  const fields = nulFields(text), files = new Map();
  let i = 0;
  while (fields[i]?.startsWith(':')) {
    const header = /^:([0-7]{6}) ([0-7]{6}) ([a-f0-9]+) ([a-f0-9]+) ([A-Z])\d*$/.exec(fields[i++]);
    if (!header) throw new Error('Git returned invalid raw change metadata.');
    const [, beforeMode, afterMode, , , status] = header;
    const first = listedPath(fields[i++]);
    const path = status === 'R' || status === 'C' ? listedPath(fields[i++]) : first;
    const oldPath = status === 'R' ? first : '';
    const prior = files.get(path);
    files.set(path, {
      path, oldPath, status: prior?.status === 'U' ? 'U' : status,
      added: null, deleted: null, binary: false, beforeMode, afterMode,
    });
  }
  for (; i < fields.length; i += 1) {
    const stat = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(fields[i]);
    if (!stat) throw new Error('Git returned invalid line-count metadata.');
    let path = stat[3];
    if (!path) { listedPath(fields[++i]); path = fields[++i]; }
    const file = files.get(listedPath(path));
    if (!file) throw new Error('Git returned inconsistent change metadata.');
    file.binary ||= stat[1] === '-' || stat[2] === '-';
    if (file.status !== 'U' && !file.binary) {
      file.added = Number(stat[1]); file.deleted = Number(stat[2]);
      if (!Number.isSafeInteger(file.added) || !Number.isSafeInteger(file.deleted)) throw new Error('Git returned invalid line counts.');
    }
  }
  return files;
}
function diffArgs(repo, scope) {
  return [
    'diff', '--no-ext-diff', '--no-textconv', '--no-color',
    '--no-relative', '--ignore-submodules=dirty', '--find-renames=50%', '-l1000',
    '--diff-algorithm=myers', '--no-indent-heuristic', '--ita-invisible-in-index',
    ...(scope === 'staged' ? ['--cached', ...(repo.commit ? [repo.commit] : [])]
      : scope === 'all' ? [repo.commit || repo.emptyTree] : []),
  ];
}
function publicFile(file) {
  const { path, oldPath, status, added, deleted, binary } = file;
  return { path, oldPath, status, added, deleted, binary };
}
function patchFits(patch) {
  return new TextEncoder().encode(patch).byteLength <= PATCH_BYTE_LIMIT
    && patch.split('\n').length - (patch.endsWith('\n') ? 1 : 0) <= PATCH_LINE_LIMIT;
}
function additionPatch(path, text) {
  // C-style quoted headers keep tabs/newlines unambiguous. No path is evaluated
  // as an option or a Git pathspec, including names beginning with :( or -.
  const quote = value => /[\s"\\]/u.test(value) ? JSON.stringify(value) : value;
  const lines = text ? text.split('\n') : [];
  if (text.endsWith('\n')) lines.pop();
  const header = `diff --git ${quote(`a/${path}`)} ${quote(`b/${path}`)}\n--- /dev/null\n+++ ${quote(`b/${path}`)}\n`;
  if (!lines.length) return header;
  return `${header}@@ -0,0 +1,${lines.length} @@\n${lines.map(line => `+${line}\n`).join('')}${text.endsWith('\n') ? '' : '\\ No newline at end of file\n'}`;
}

/** Read-only Git changes in the calling Session's mounted execution world. */
export function createChangesReader(provider) {
  async function run(agent, cwd, args, signal, maxBytes = CHANGE_OUTPUT_LIMIT, allowed = [0]) {
    signal.throwIfAborted();
    const subprocess = provider(agent, 'subprocess');
    const policy = provider(agent, 'sandboxPolicy').resolve({ session: agent.session });
    const executable = await subprocess.resolveExecutable('git', undefined, signal);
    let argv = [
      executable, '--no-pager', '--no-optional-locks', '--literal-pathspecs',
      '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
      '-c', 'protocol.allow=never', '-c', 'diff.submodule=short', ...args,
    ];
    if (args[0] === 'diff') {
      // --no-textconv/--no-ext-diff do NOT disable attribute clean/process
      // filters. Discover their names without reading values into argv, then
      // neutralize every configured driver. Fail closed on an unbounded or
      // unrepresentable configuration rather than running a helper.
      const config = await run(agent, cwd, ['config', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process|required)$'], signal, CHANGE_OUTPUT_LIMIT, [0, 1]);
      const drivers = new Set();
      for (const key of nulFields(config.text)) {
        const match = /^filter\.([a-zA-Z0-9._/-]+)\.(?:clean|smudge|process|required)$/.exec(key);
        if (!match) throw new Error('Unsafe or unsupported Git filter configuration; change inspection is disabled.');
        drivers.add(match[1]);
      }
      if (drivers.size > 128) throw new Error('Git filter configuration exceeded its 128-driver safety limit.');
      const overrides = [...drivers].flatMap(driver => [
        '-c', `filter.${driver}.clean=`, '-c', `filter.${driver}.smudge=`,
        '-c', `filter.${driver}.process=`, '-c', `filter.${driver}.required=false`,
      ]);
      argv = [...argv.slice(0, argv.length - args.length), ...overrides, ...args];
    }
    if (policy.mode !== 'danger-full-access') argv = (await provider(agent, 'sandbox').confine(argv, policy, signal)).argv;
    signal.throwIfAborted();
    const child = subprocess.spawn({
      argv, cwd, env: { ...READ_ENV }, signal, graceMs: 1000,
      stdio: { stdin: 'ignore', stdout: { maxBytes }, stderr: { maxBytes: 8192 } },
    });
    try {
      const outcome = await child.done;
      signal.throwIfAborted();
      const stdout = child.collected.stdout.readFrom(0), stderr = child.collected.stderr.readFrom(0);
      if (stdout.lossy) throw new OutputLimitError(`Git change inspection exceeded its ${maxBytes}-byte output limit.`);
      if (stderr.lossy) throw new OutputLimitError('Git change diagnostics exceeded their output limit.');
      if (!allowed.includes(outcome.exitCode)) {
        throw new GitReadError(`Git change inspection failed (${outcome.signal ?? outcome.exitCode}): ${stderr.text.trim().slice(0, 1000)}`, outcome.exitCode, stderr.text);
      }
      // Successful metadata commands can still warn about unreadable paths or
      // configuration. Never turn those diagnostics into a clean summary.
      if (args[0] !== 'diff' && stderr.text.trim()) throw new Error(`Git change inspection reported diagnostics: ${stderr.text.trim().slice(0, 1000)}`);
      return { text: stdout.text, stderr: stderr.text, exitCode: outcome.exitCode };
    } catch (error) {
      signal.throwIfAborted();
      throw error;
    } finally {
      child.terminate();
      await child.waitForExit();
    }
  }
  const bounded = signal => signal ? AbortSignal.any([signal, AbortSignal.timeout(READ_TIMEOUT_MS)]) : AbortSignal.timeout(READ_TIMEOUT_MS);
  async function repository(agent, cwd, signal, repo) {
    const rootOutput = await run(agent, cwd, ['rev-parse', '--show-toplevel'], signal);
    const fs = provider(agent, 'fs');
    repo.rootTarget = await fs.resolve(rootOutput.text.replace(/\n$/, ''), { cwd, signal });
    repo.root = fs.processPath(repo.rootTarget);
    repo.kind = 'git';
    const ref = (await run(agent, repo.root, ['symbolic-ref', '--quiet', 'HEAD'], signal, CHANGE_OUTPUT_LIMIT, [0, 1])).text.trim();
    repo.branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
    const commit = await run(agent, repo.root, ['rev-parse', '--verify', '--quiet', '--end-of-options', 'HEAD^{commit}'], signal, CHANGE_OUTPUT_LIMIT, [0, 1]);
    if (commit.exitCode === 0) {
      repo.commit = commit.text.trim();
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(repo.commit)) throw new Error('Git returned an invalid HEAD commit.');
    } else {
      // A broken/detached HEAD is an error, not an empty history. Confirm that
      // the symbolic branch really has no ref before choosing the empty tree.
      if (!ref.startsWith('refs/heads/')) throw new Error('This repository has no readable HEAD commit.');
      const present = await run(agent, repo.root, ['show-ref', '--verify', '--quiet', ref], signal, CHANGE_OUTPUT_LIMIT, [0, 1]);
      if (present.exitCode !== 1) throw new Error('The HEAD branch exists but its commit cannot be read.');
      const format = (await run(agent, repo.root, ['rev-parse', '--show-object-format'], signal)).text.trim();
      repo.emptyTree = EMPTY_TREES[format];
      if (!repo.emptyTree) throw new Error('Unsupported Git object format.');
      repo.unborn = true;
    }
    return repo;
  }
  async function probe(agent, repo, scope, signal) {
    const output = await run(agent, repo.root, [...diffArgs(repo, scope), '--raw', '--numstat', '--no-abbrev', '-z', '--'], signal);
    const files = parseChanges(output.text);
    const conflicts = await run(agent, repo.root, ['ls-files', '--unmerged', '-z', '--'], signal);
    for (const entry of nulFields(conflicts.text)) {
      const match = /^([0-7]{6}) [a-f0-9]+ [123]\t([\s\S]+)$/.exec(entry);
      if (!match) throw new Error('Git returned invalid conflict metadata.');
      const path = listedPath(match[2]);
      files.set(path, { ...files.get(path), path, oldPath: '', status: 'U', added: null, deleted: null, binary: false, beforeMode: match[1], afterMode: match[1] });
    }
    let untracked = 0;
    if (scope !== 'staged') {
      const others = await run(agent, repo.root, ['ls-files', '--others', '--exclude-standard', '-z', '--'], signal);
      for (const entry of nulFields(others.text)) {
        const directory = entry.endsWith('/'), path = listedPath(directory ? entry.slice(0, -1) : entry);
        untracked += 1;
        if (files.has(path)) {
          // A staged deletion can coexist with an untracked replacement at the
          // same path. Do not overwrite the deletion or pretend its patch also
          // represents the replacement; inspecting unstaged shows the latter.
          files.get(path).untrackedOverlap = true;
        } else files.set(path, { path, oldPath: '', status: '?', added: null, deleted: null, binary: false, directory });
      }
    }
    return { files, untracked, warning: output.stderr.trim() };
  }
  function failure(error, callerSignal, signal) {
    callerSignal?.throwIfAborted();
    return signal.aborted ? 'Git change inspection exceeded its 10-second deadline.' : message(error);
  }
  async function summary(agent, cwd, scope, callerSignal) {
    validScope(scope);
    const signal = bounded(callerSignal), repo = blankRepository();
    signal.throwIfAborted();
    try {
      await repository(agent, cwd, signal, repo);
      const { files, untracked, warning } = await probe(agent, repo, scope, signal);
      const values = [...files.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
      const reasons = [];
      if (values.length > CHANGE_FILE_LIMIT) reasons.push(`Only the first ${CHANGE_FILE_LIMIT} changed paths are displayed.`);
      if (untracked) reasons.push('Line totals exclude unread untracked files.');
      if (values.some(file => file.status === 'U')) reasons.push('Line totals exclude unresolved conflicts.');
      if (values.some(file => file.untrackedOverlap)) reasons.push('A staged deletion overlaps an untracked replacement; inspect unstaged for its contents.');
      if (values.some(file => file.added === null && file.status !== '?' && file.status !== 'U')) reasons.push('Line totals exclude binary or unavailable line counts.');
      if (warning) reasons.push(warning.slice(0, 1000));
      return {
        repository: publicRepository(repo), scope, files: values.slice(0, CHANGE_FILE_LIMIT).map(publicFile),
        added: values.reduce((n, file) => n + (file.added ?? 0), 0),
        deleted: values.reduce((n, file) => n + (file.deleted ?? 0), 0),
        untracked, limited: reasons.length > 0, reason: reasons.join(' '),
      };
    } catch (error) {
      const reason = failure(error, callerSignal, signal);
      const none = repo.kind === 'unknown' && error instanceof GitReadError && error.exitCode === 128
        && /^fatal: not a git repository \(or any of the parent directories\): \.git\r?\n?$/.test(error.stderr);
      return { repository: { ...publicRepository(repo), ...(none ? { kind: 'none' } : {}) }, scope, files: [], added: 0, deleted: 0, untracked: 0, limited: !none, reason: none ? '' : reason };
    }
  }
  async function safeTarget(fs, repo, path, signal) {
    const parts = path.split('/');
    if (parts.length > 256) throw new PathReadError('unavailable', 'This path has too many ancestors to inspect safely.');
    const root = await fs.resolve(repo.root, { signal });
    if (fs.processPath(root) !== repo.root || !fs.contains(repo.rootTarget, root)) throw new PathReadError('unavailable', 'The repository root changed while reading.');
    let target, info;
    for (let i = 0; i < parts.length; i += 1) {
      const prefix = parts.slice(0, i + 1).join('/');
      info = await fs.lstat(prefix, { cwd: repo.root }, signal);
      if (!info) throw new PathReadError('missing', 'The changed path no longer exists.');
      if (info.type === 'symlink') throw new PathReadError('unavailable', 'Symbolic links and symlink ancestors are not followed.');
      if (i < parts.length - 1 ? info.type !== 'directory' : info.type !== 'file') throw new PathReadError('unavailable', 'The changed path is not a regular file; directories are not traversed.');
      target = await fs.resolve(prefix, { cwd: repo.root, signal });
      if (!fs.contains(repo.rootTarget, target)) throw new PathReadError('unavailable', 'The changed path resolves outside the repository.');
    }
    const stat = await fs.stat(target, signal);
    if (!stat || stat.type !== 'file' || stat.version !== info.version) throw new PathReadError('unavailable', 'The changed file moved during inspection.');
    if (stat.size > PATCH_BYTE_LIMIT) throw new PathReadError('oversized', `The untracked file exceeds ${PATCH_BYTE_LIMIT} bytes.`);
    return { target, version: stat.version, processPath: fs.processPath(target) };
  }
  async function untrackedDiff(agent, repo, file, signal) {
    if (file.directory) return result('submodule', file.path, 'Untracked nested repositories are not traversed.');
    const fs = provider(agent, 'fs');
    // The fs seam has no descriptor/no-follow read. Reject every visible symlink
    // ancestor and freshly canonicalize before bounded reading; validate again
    // afterwards and never return bytes from an observed path/version swap.
    const first = await safeTarget(fs, repo, file.path, signal);
    const fresh = await safeTarget(fs, repo, file.path, signal);
    if (fresh.version !== first.version || fresh.processPath !== first.processPath) return result('unavailable', file.path, 'The changed file moved during inspection.');
    const bytes = await fs.readBytes(fresh.target, signal, PATCH_BYTE_LIMIT);
    const after = await safeTarget(fs, repo, file.path, signal);
    if (fresh.version !== after.version || fresh.processPath !== after.processPath) return result('unavailable', file.path, 'The changed file moved while reading.');
    let text;
    try {
      if (bytes.includes(0)) return result('binary', file.path, 'The untracked file contains binary data.');
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch { return result('binary', file.path, 'The untracked file is not UTF-8 text.'); }
    const patch = additionPatch(file.path, text);
    return patchFits(patch) ? result('text', file.path, '', patch)
      : result('oversized', file.path, `The patch exceeds ${PATCH_BYTE_LIMIT} bytes or ${PATCH_LINE_LIMIT} lines.`);
  }
  async function diff(agent, cwd, scope, path, callerSignal) {
    validScope(scope);
    if (!validPath(path)) return result('unavailable', typeof path === 'string' ? path : '', 'A changed path must be a nonempty, repository-relative literal path without . or .. components.');
    const signal = bounded(callerSignal), repo = blankRepository();
    signal.throwIfAborted();
    try {
      await repository(agent, cwd, signal, repo);
      // Always probe Git again, independent of the display limit and without a
      // prefix/directory match. A browser-provided path grants no read authority.
      const { files } = await probe(agent, repo, scope, signal);
      const file = files.get(path);
      if (!file) return result('missing', path, 'This path is not currently changed in the requested scope.');
      if (file.status === 'U') return result('conflict', path, 'Resolve this unmerged path before viewing a unified diff.');
      if ([file.beforeMode, file.afterMode].includes('160000')) return result('submodule', path, 'Submodule commit changes are not expanded or traversed.');
      if ([file.beforeMode, file.afterMode].includes('120000')) return result('unavailable', path, 'Symbolic link changes are not followed or expanded.');
      if (file.untrackedOverlap) return result('unavailable', path, 'A staged deletion overlaps an untracked replacement; inspect staged or unstaged separately.');
      if (file.status === '?') return await untrackedDiff(agent, repo, file, signal);
      if (file.binary) return result('binary', path, 'Git reports a binary change; blob contents are not included.');
      const output = await run(agent, repo.root, [
        ...diffArgs(repo, scope), '--patch', '--unified=3', '--inter-hunk-context=0',
        '--no-function-context', '--word-diff=none', '--src-prefix=a/', '--dst-prefix=b/', '--line-prefix=',
        '--', ...(file.oldPath ? [file.oldPath] : []), file.path,
      ], signal, PATCH_BYTE_LIMIT);
      if (output.text.includes('\0') || /^Binary files .* differ$/m.test(output.text)) return result('binary', path, 'Git reports a binary change; blob contents are not included.');
      if (!patchFits(output.text)) return result('oversized', path, `The patch exceeds ${PATCH_BYTE_LIMIT} bytes or ${PATCH_LINE_LIMIT} lines.`);
      if (!output.text) return result('missing', path, 'This path no longer has a diff in the requested scope.');
      if (!output.text.startsWith('diff --git ') || (output.text.match(/^diff --git /gm) ?? []).length !== 1) {
        return result('unavailable', path, 'Git path selection overlaps other changed paths; no unrelated patches are returned.');
      }
      return result('text', path, output.stderr.trim().slice(0, 1000), output.text);
    } catch (error) {
      const reason = failure(error, callerSignal, signal);
      return result(error instanceof OutputLimitError ? 'oversized' : error instanceof PathReadError ? error.kind : error?.code === 'FS_TOO_LARGE' ? 'oversized' : 'unavailable', path, reason);
    }
  }
  return { summary, diff };
}
