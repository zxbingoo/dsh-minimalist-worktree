import path from 'node:path';
import { z } from 'zod';
import { createChangesReader } from './git-changes.js';

const validRelative = value => typeof value === 'string' && value.length <= 4096 && !value.includes('\0') && !value.includes('\\') && !value.startsWith('/') && !/^[a-z]:/i.test(value) && (value === '' || value.split('/').every(part => part && !['.', '..', '.git'].includes(part.toLowerCase())));
const relative = z.string().max(4096).refine(validRelative, 'Expected a literal relative path without traversal or .git.');
const nonempty = relative.refine(value => !!value, 'A file path is required.');
const scope = z.enum(['all', 'unstaged', 'staged']).default('all');
export const browserRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('list'), path: relative.default('') }),
  z.strictObject({ action: z.literal('read'), path: nonempty }),
  z.strictObject({ action: z.literal('repositories') }),
  z.strictObject({ action: z.literal('summary'), repository: relative.default(''), scope }),
  z.strictObject({ action: z.literal('diff'), repository: relative.default(''), scope, path: nonempty }),
]);
const count = z.number().int().nonnegative(), identity = { sessionId: z.string(), cwd: z.string() };
const repoInfo = z.strictObject({ kind: z.enum(['git', 'none', 'unknown']), root: z.string(), branch: z.string(), commit: z.string(), unborn: z.boolean() });
const file = z.strictObject({ path: z.string(), oldPath: z.string(), status: z.string(), added: count.nullable(), deleted: count.nullable(), binary: z.boolean(), workspacePath: z.string().nullable() });
const IMAGE_LIMIT = 5 * 1024 * 1024;
const imageMimeSchema = z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp']);
const readResult = z.strictObject({ ...identity, action: z.literal('read'), path: z.string(), kind: z.enum(['text', 'image', 'binary', 'oversized', 'unavailable']), text: z.string().max(512 * 1024), reason: z.string(), mime: imageMimeSchema.optional(), imageData: z.string().max(4 * Math.ceil(IMAGE_LIMIT / 3) + 32).optional() }).superRefine((value, ctx) => {
  if (value.kind === 'image') {
    const prefix = `data:${value.mime};base64,`;
    if (!value.mime || !value.imageData?.startsWith(prefix) || value.text !== '') ctx.addIssue({ code: 'custom', message: 'Images require a validated raster MIME and matching data URL.' });
    else {
      const encoded = value.imageData.slice(prefix.length);
      if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || Buffer.from(encoded, 'base64').length > IMAGE_LIMIT) ctx.addIssue({ code: 'custom', message: 'Invalid or oversized image payload.' });
    }
  } else if (value.mime !== undefined || value.imageData !== undefined) ctx.addIssue({ code: 'custom', message: 'Only images may carry image data.' });
});

/** Inspect raster signatures, never trust an extension or return active SVG/HTML. */
function rasterMime(bytes) {
  const b = Buffer.from(bytes);
  if (b.length >= 24 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && b.readUInt32BE(8) === 13 && b.toString('ascii', 12, 16) === 'IHDR' && b.readUInt32BE(16) > 0 && b.readUInt32BE(20) > 0) return 'image/png';
  if (b.length >= 4 && b[0] === 255 && b[1] === 216 && b[2] === 255 && b[3] !== 0 && b[3] !== 255) return 'image/jpeg';
  if (b.length >= 10 && ['GIF87a', 'GIF89a'].includes(b.toString('ascii', 0, 6)) && b.readUInt16LE(6) > 0 && b.readUInt16LE(8) > 0) return 'image/gif';
  if (b.length >= 16 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(b.toString('ascii', 12, 16))) return 'image/webp';
  if (b.length >= 26 && b.toString('ascii', 0, 2) === 'BM' && b.readUInt32LE(14) >= 12 && b.readUInt32LE(10) >= 26) return 'image/bmp';
  return null;
}
export const browserResultSchema = z.discriminatedUnion('action', [
  z.strictObject({ ...identity, action: z.literal('list'), path: z.string(), entries: z.array(z.strictObject({ name: z.string(), path: z.string(), type: z.enum(['file', 'directory', 'other']), size: count.nullable() })).max(500), limited: z.boolean() }),
  readResult,
  z.strictObject({ ...identity, action: z.literal('repositories'), kind: z.enum(['git', 'none', 'unknown']), root: z.string(), repositories: z.array(z.strictObject({ id: z.string(), path: z.string(), name: z.string(), kind: z.enum(['root', 'submodule']), initialized: z.boolean(), branch: z.string(), commit: z.string(), reason: z.string() })).max(32), limited: z.boolean(), reason: z.string() }),
  z.strictObject({ ...identity, action: z.literal('summary'), repository: z.string(), scope: z.enum(['all', 'unstaged', 'staged']), repositoryInfo: repoInfo, files: z.array(file).max(500), added: count, deleted: count, untracked: count, limited: z.boolean(), reason: z.string() }),
  z.strictObject({ ...identity, action: z.literal('diff'), repository: z.string(), scope: z.enum(['all', 'unstaged', 'staged']), path: z.string(), kind: z.enum(['text', 'binary', 'oversized', 'conflict', 'submodule', 'missing', 'unavailable']), patch: z.string().max(1024 * 1024), reason: z.string() }),
]);
const LIMIT = 512 * 1024;
const GIT_ENV = { ...Object.fromEntries(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_PREFIX', 'GIT_CEILING_DIRECTORIES', 'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE', 'GIT_REPLACE_REF_BASE', 'GIT_ATTR_SOURCE', 'GIT_EXTERNAL_DIFF', 'GIT_DIFF_OPTS'].map(key => [key, undefined])), GIT_CONFIG_COUNT: '0', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_PAGER: 'cat', LC_ALL: 'C' };

/** Read-only actual-cwd file browsing and verified tracked-gitlink repository selection. */
export function createBrowserOperations(provider) {
  const reader = createChangesReader(provider), active = new Set();
  const cwdOf = agent => provider(agent, 'workingDirectory').get(agent.session);
  async function target(fs, rootPath, relativePath, type, signal) {
    if (!validRelative(relativePath)) throw new Error('Unsafe browser path.');
    const root = await fs.resolve(rootPath, { signal });
    const rootInfo = await fs.stat(root, signal);
    if (rootInfo?.type !== 'directory') throw new Error('The Session directory is unavailable.');
    let resolved = root, info = rootInfo;
    const parts = relativePath ? relativePath.split('/') : [];
    for (let i = 0; i < parts.length; i++) {
      const prefix = parts.slice(0, i + 1).join('/');
      info = await fs.lstat(prefix, { cwd: rootPath }, signal);
      if (!info) throw new Error('Missing path in file browser.');
      resolved = await fs.resolve(prefix, { cwd: rootPath, signal });
      if (!fs.contains(root, resolved)) throw new Error('Browser path resolves outside its root.');
      if (fs.processPath(resolved).split(/[\\/]/).some(part => part.toLowerCase() === '.git')) throw new Error('Git administration paths cannot be browsed.');
      if (info.type === 'symlink') info = await fs.stat(resolved, signal);
      if (!info || (i < parts.length - 1 && info.type !== 'directory')) throw new Error('Missing path or non-directory ancestor.');
    }
    if (type && info.type !== type) throw new Error(`The path is not a ${type}.`);
    return { target: resolved, info, absolute: fs.processPath(resolved) };
  }
  async function gitlinks(agent, cwd, signal) {
    const subprocess = provider(agent, 'subprocess');
    const policy = provider(agent, 'sandboxPolicy').resolve({ session: agent.session });
    let argv = [await subprocess.resolveExecutable('git', undefined, signal), '--no-pager', '--no-optional-locks', '--literal-pathspecs', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never', 'ls-files', '--stage', '-z', '--'];
    if (policy.mode !== 'danger-full-access') argv = (await provider(agent, 'sandbox').confine(argv, policy, signal)).argv;
    signal.throwIfAborted();
    const child = subprocess.spawn({ argv, cwd, signal, env: { ...GIT_ENV }, graceMs: 1000, stdio: { stdin: 'ignore', stdout: { maxBytes: 2 * 1024 * 1024 }, stderr: { maxBytes: 8192 } } });
    try {
      const outcome = await child.done; signal.throwIfAborted();
      const out = child.collected.stdout.readFrom(0), err = child.collected.stderr.readFrom(0);
      if (outcome.exitCode !== 0 || out.lossy || err.lossy || err.text.trim()) throw new Error(`Cannot discover submodules: ${err.text.slice(0, 1000)}`);
      if (out.text && !out.text.endsWith('\0')) throw new Error('Incomplete Git repository metadata.');
      const result = new Set();
      for (const entry of out.text.split('\0').filter(Boolean)) {
        const match = /^(\d{6}) [a-f0-9]+ ([0-3])\t([\s\S]+)$/.exec(entry);
        if (!match) throw new Error('Invalid Git index metadata.');
        if (match[1] === '160000' && match[2] === '0') {
          if (!validRelative(match[3]) || !match[3]) throw new Error('Unsupported submodule path.');
          result.add(match[3]);
        }
      }
      return [...result];
    } finally { child.terminate(); await child.waitForExit(); }
  }
  async function discover(agent, cwd, signal) {
    const fs = provider(agent, 'fs');
    const summary = await reader.summary(agent, cwd, 'all', signal);
    if (summary.repository.kind !== 'git') return { kind: summary.repository.kind, root: '', repositories: [], limited: summary.limited, reason: summary.reason || (summary.repository.kind === 'none' ? 'This directory is not a Git repository.' : 'Git repository unavailable.') };
    const root = fs.processPath(await fs.resolve(summary.repository.root, { cwd, signal }));
    const rootTarget = await fs.resolve(root, { signal });
    const repositories = [{ id: '', path: root, name: root.split(/[\\/]/).filter(Boolean).at(-1) || root, kind: 'root', initialized: true, branch: summary.repository.branch, commit: summary.repository.commit, reason: '' }];
    const queue = [{ path: root, id: '' }]; let limited = false;
    while (queue.length) {
      const parent = queue.shift();
      for (const child of await gitlinks(agent, parent.path, signal)) {
        if (repositories.length >= 32) { limited = true; break; }
        const id = parent.id ? `${parent.id}/${child}` : child;
        if (repositories.some(repo => repo.id === id)) continue;
        let childPath = `${parent.path.replace(/[\\/]$/, '')}/${child}`, initialized = false, branch = '', commit = '', reason = 'Submodule is not initialized.';
        try {
          const verified = await target(fs, root, id, 'directory', signal);
          childPath = verified.absolute;
          if (!fs.contains(rootTarget, verified.target)) throw new Error('Submodule resolves outside repository.');
          const marker = await fs.lstat('.git', { cwd: childPath }, signal);
          if (marker && ['file', 'directory'].includes(marker.type)) {
            const data = await reader.summary(agent, childPath, 'all', signal);
            if (data.repository.kind === 'git' && fs.processPath(await fs.resolve(data.repository.root, { signal })) === childPath) {
              initialized = true; branch = data.repository.branch; commit = data.repository.commit; reason = '';
            } else reason = data.reason || 'Submodule Git metadata is unavailable.';
          }
        } catch (error) { signal.throwIfAborted(); reason = error instanceof Error ? error.message : String(error); }
        repositories.push({ id, path: childPath, name: child.split('/').at(-1), kind: 'submodule', initialized, branch, commit, reason });
        if (initialized) queue.push({ id, path: childPath });
      }
      if (limited) break;
    }
    return { kind: 'git', root, repositories, limited, reason: limited ? 'Only the first 32 repositories are shown.' : '' };
  }
  function operate(agent, raw, callerSignal) {
    const operation = (async () => {
      const request = browserRequestSchema.parse(raw);
      const signal = callerSignal ? AbortSignal.any([callerSignal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000);
      signal.throwIfAborted();
      const cwd = cwdOf(agent), fs = provider(agent, 'fs');
      if (typeof cwd !== 'string' || !cwd) throw new Error('The Session working directory is unavailable.');
      let result;
      if (request.action === 'list') {
        const directory = await target(fs, cwd, request.path, 'directory', signal);
        const listed = await fs.listDir(directory.target, signal), entries = [];
        let limited = false;
        for (const entry of listed) {
          if (entry.name.toLowerCase() === '.git') continue;
          if (!validRelative(entry.name) || entry.name.includes('/')) throw new Error('Filesystem returned an unsafe entry name.');
          if (entries.length >= 500) { limited = true; break; }
          const path = request.path ? `${request.path}/${entry.name}` : entry.name;
          let info;
          try { info = (await target(fs, cwd, path, undefined, signal)).info; }
          catch { signal.throwIfAborted(); }
          entries.push({ name: entry.name, path, type: info && ['file', 'directory'].includes(info.type) ? info.type : 'other', size: Number.isSafeInteger(info?.size) && info.size >= 0 ? info.size : null });
        }
        result = { path: request.path, entries, limited };
      } else if (request.action === 'read') {
        result = { path: request.path, kind: 'unavailable', text: '', reason: '' };
        try {
          const before = await target(fs, cwd, request.path, 'file', signal);
          if (before.info.size > IMAGE_LIMIT) result = { ...result, kind: 'oversized', reason: 'File exceeds the 5 MiB image preview limit.' };
          else {
            // Images may be larger than text and may use an unrelated extension.
            // The provider enforces the byte cap even if stat races with a writer.
            const bytes = await fs.readBytes(before.target, signal, IMAGE_LIMIT);
            signal.throwIfAborted();
            if (bytes.length > IMAGE_LIMIT) throw Object.assign(new Error('File exceeds the 5 MiB image preview limit.'), { code: 'FS_TOO_LARGE' });
            const after = await target(fs, cwd, request.path, 'file', signal);
            if (before.info.version !== after.info.version || before.absolute !== after.absolute) throw new Error('File changed while reading.');
            const mime = rasterMime(bytes);
            if (mime) result = { ...result, kind: 'image', mime, imageData: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}` };
            else if (/\.(?:png|jpe?g|gif|webp|bmp)$/i.test(request.path)) result = { ...result, kind: 'unavailable', reason: 'The file does not have a supported raster image signature.' };
            else if (bytes.length > LIMIT) result = { ...result, kind: 'oversized', reason: 'Text file exceeds 512 KiB.' };
            else {
              let text;
              try { if (bytes.includes(0)) throw new Error('Binary'); text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
              catch { result = { ...result, kind: 'binary', reason: 'This file is not UTF-8 text.' }; }
              if (text !== undefined) result = text.split('\n').length - (text.endsWith('\n') ? 1 : 0) > 10000 ? { ...result, kind: 'oversized', reason: 'File exceeds 10,000 lines.' } : { ...result, kind: 'text', text };
            }
          }
        } catch (error) { signal.throwIfAborted(); result = { ...result, kind: error?.code === 'FS_TOO_LARGE' ? 'oversized' : 'unavailable', reason: error instanceof Error ? error.message : String(error) }; }
      } else {
        const discovery = await discover(agent, cwd, signal);
        if (request.action === 'repositories') result = discovery;
        else {
          const repository = discovery.repositories.find(repo => repo.id === request.repository);
          if (!repository?.initialized) throw new Error(repository?.reason || 'The selected repository is not a verified initialized repository.');
          if (request.action === 'summary') {
            const data = await reader.summary(agent, repository.path, request.scope, signal);
            const paths = /^[a-z]:[\\/]|^\\\\/i.test(cwd) ? path.win32 : path.posix;
            const workspace = await fs.resolve(cwd, { signal });
            const files = [];
            let countBudget = 4 * 1024 * 1024;
            for (const original of data.files) {
              let file = { ...original };
              if (file.status === '?' && file.added === null && countBudget > 0) {
                try {
                  const item = await target(fs, repository.path, file.path, 'file', signal);
                  if (Number.isSafeInteger(item.info.size) && item.info.size <= 512 * 1024 && item.info.size <= countBudget) {
                    countBudget -= item.info.size;
                    const bytes = await fs.readBytes(item.target, signal, Math.min(512 * 1024, countBudget + item.info.size));
                    const after = await target(fs, repository.path, file.path, 'file', signal);
                    if (after.info.version !== item.info.version || after.absolute !== item.absolute) throw new Error('File changed during line count.');
                    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
                    if (!text.includes('\0')) file = { ...file, added: text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0, deleted: 0 };
                    else file.binary = true;
                  }
                } catch { signal.throwIfAborted(); }
              }
              const absolute = await fs.resolve(file.path, { cwd: repository.path, signal });
              const relativePath = paths.relative(fs.processPath(workspace), fs.processPath(absolute)).split(paths.sep).join('/');
              files.push({ ...file, workspacePath: fs.contains(workspace, absolute) && validRelative(relativePath) ? relativePath : null });
            }
            result = { repository: request.repository, scope: request.scope, repositoryInfo: data.repository, files, added: files.reduce((n, file) => n + (file.added ?? 0), 0), deleted: files.reduce((n, file) => n + (file.deleted ?? 0), 0), untracked: data.untracked, limited: data.limited, reason: data.reason };
          } else result = { ...await reader.diff(agent, repository.path, request.scope, request.path, signal), repository: request.repository, scope: request.scope };
        }
      }
      signal.throwIfAborted();
      if (cwdOf(agent) !== cwd) throw new Error('The Session directory changed during browser inspection. Refresh and try again.');
      return browserResultSchema.parse({ ...result, action: request.action, sessionId: agent.id, cwd });
    })();
    active.add(operation); operation.then(() => active.delete(operation), () => active.delete(operation)); return operation;
  }
  return { operate, async drain() { await Promise.allSettled([...active]); } };
}
