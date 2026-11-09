import { pathToFileURL } from 'node:url';

/** Self-contained execution-world engine; never imports Host filesystem providers. */
async function engine(action, args) {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const { createHash, randomUUID } = await import('node:crypto');
  const { spawnSync } = await import('node:child_process');
  const hash = data => createHash('sha256').update(data).digest('hex');
  const env = { ...process.env, GIT_CONFIG_COUNT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' };
  for (const key of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG_PARAMETERS|CONFIG_KEY_.*|CONFIG_VALUE_.*)$/.test(key)) delete env[key];
  function git(cwd, argv, input, allowed = [0]) {
    const result = spawnSync('git', ['--no-pager', '-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'), '-c', 'core.fsmonitor=false', ...argv], { cwd, env, input, timeout: 120000, maxBuffer: 256 * 1024 * 1024 });
    if (result.error || !allowed.includes(result.status)) throw new Error('Snapshot Git failed: ' + argv[0] + ': ' + (result.error?.message || result.stderr?.toString().slice(-2000)));
    return result.stdout;
  }
  function relative(value) {
    if (typeof value !== 'string' || value.includes('\0') || path.isAbsolute(value) || value.split(/[\\/]/).some(part => part === '..' || part === '.git')) throw new Error('Unsafe snapshot path');
    return value;
  }
  async function privateDir(dir) {
    const absolute = path.resolve(dir); let current = path.parse(absolute).root;
    for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      try { await fs.mkdir(current, { mode: 0o700 }); await syncDir(path.dirname(current)); } catch (e) { if (e.code !== 'EEXIST') throw e; }
      const info = await fs.lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe directory ancestor: ' + current);
    }
    return absolute;
  }
  async function assertDirectoryChain(dir) {
    const absolute = path.resolve(dir); let current = path.parse(absolute).root;
    for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part); const info = await fs.lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe snapshot directory ancestor: ' + current);
    }
  }
  async function regularBytes(file) {
    await assertDirectoryChain(path.dirname(file));
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe snapshot file: ' + file);
    return fs.readFile(file);
  }
  async function syncDir(dir) { const h = await fs.open(dir, 'r'); try { await h.sync(); } finally { await h.close(); } }
  async function writePrivate(file, data) { const handle = await fs.open(file, 'wx', 0o600); try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); } }
  async function exists(file) { try { return await fs.lstat(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
  async function tree(root, copyTo, limits) {
    const entries = [], repos = []; let bytes = 0;
    async function visit(dir, prefix) {
      const children = await fs.readdir(dir); children.sort();
      if (!children.includes('.git') && children.includes('HEAD') && children.includes('objects') && children.includes('refs')) {
        const bare = git(dir, ['rev-parse', '--is-bare-repository'], undefined, [0, 128]).toString().trim();
        if (bare === 'true') throw new Error('Nested bare repositories are not supported');
      }
      if (children.includes('.git')) {
        const admin = await fs.lstat(path.join(dir, '.git'));
        if ((!admin.isFile() && !admin.isDirectory()) || admin.isSymbolicLink()) throw new Error('Unsafe Git administration path');
        const top = git(dir, ['rev-parse', '--show-toplevel']).toString().trimEnd();
        if (await fs.realpath(top) !== await fs.realpath(dir)) throw new Error('Nested repository identity mismatch');
        repos.push(prefix);
      }
      for (const name of children) {
        if (name === '.git') continue;
        const rel = prefix ? prefix + '/' + name : name; relative(rel);
        const source = path.join(dir, name), info = await fs.lstat(source), mode = info.mode & 0o777;
        if (entries.length >= limits.maxFiles) throw new Error('Snapshot file count limit exceeded');
        if (info.isDirectory()) {
          entries.push({ path: rel, type: 'directory', mode });
          if (copyTo) await fs.mkdir(path.join(copyTo, rel), { mode: 0o700 });
          await visit(source, rel);
        } else if (info.isSymbolicLink()) {
          const target = await fs.readlink(source); entries.push({ path: rel, type: 'symlink', target, mode });
        } else if (info.isFile()) {
          bytes += info.size; if (bytes > limits.maxBytes) throw new Error('Snapshot byte limit exceeded');
          const data = await fs.readFile(source);
          const after = await fs.lstat(source);
          if (!after.isFile() || info.ino !== after.ino || info.size !== after.size || info.mtimeMs !== after.mtimeMs) throw new Error('Source mutated during snapshot');
          entries.push({ path: rel, type: 'file', mode, size: data.length, hash: hash(data) });
          if (copyTo) await writePrivate(path.join(copyTo, rel), data);
        } else throw new Error('Unsupported special file: ' + rel);
      }
    }
    await visit(root, '');
    return { entries, repos, bytes };
  }
  async function repoState(root, rel) {
    const cwd = path.join(root, relative(rel));
    // An index/file snapshot is not sufficient to resume sequencer/merge state.
    // Refuse instead of deleting per-worktree operation metadata we do not restore.
    for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'BISECT_START']) {
      const operationPath = git(cwd, ['rev-parse', '--path-format=absolute', '--git-path', name]).toString().trimEnd();
      if (await exists(operationPath)) throw new Error('Active Git operation is not supported; worktree retained: ' + name);
    }
    const head = git(cwd, ['rev-parse', '--verify', 'HEAD']).toString().trim();
    const branch = git(cwd, ['symbolic-ref', '--quiet', 'HEAD'], undefined, [0, 1]).toString().trim();
    const indexPath = git(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'index']).toString().trimEnd();
    const sharedIndex = git(cwd, ['rev-parse', '--shared-index-path']).toString().trim();
    if (sharedIndex) throw new Error('Split Git index is not supported; worktree retained');
    const index = await exists(indexPath) ? await fs.readFile(indexPath) : null;
    const refs = git(cwd, ['show-ref'], undefined, [0, 1]).toString();
    const stages = git(cwd, ['ls-files', '--stage', '-z']).toString();
    return { head, branch, refs, indexHash: index ? hash(index) : null, stages, index };
  }
  function comparable(state) { const { index, ...value } = state; return value; }
  async function snapshot(options) {
    const source = await fs.realpath(options.source), repositoryRoot = await fs.realpath(options.repositoryRoot);
    if (git(source, ['rev-parse', '--show-toplevel']).toString().trimEnd() !== source) throw new Error('Source must be a repository root');
    const sourceCommon = await fs.realpath(git(source, ['rev-parse', '--path-format=absolute', '--git-common-dir']).toString().trimEnd());
    const repoCommon = await fs.realpath(git(repositoryRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']).toString().trimEnd());
    if (sourceCommon !== repoCommon) throw new Error('Source and repositoryRoot are different repositories');
    const currentBranch = git(source, ['symbolic-ref', '--quiet', '--short', 'HEAD'], undefined, [0, 1]).toString().trim();
    if (options.branch && currentBranch !== options.branch) throw new Error('Source branch changed');
    if (!/^[A-Za-z0-9_-]+$/.test(options.sessionId)) throw new Error('Invalid Session id');
    const home = await fs.realpath(options.home);
    const bucket = path.basename(repositoryRoot).replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[-.]+/, '').slice(0, 80) + '-' + hash(repositoryRoot).slice(0, 8);
    const base = await privateDir(path.join(home, '.dsh', 'worktree-snapshots', bucket, options.sessionId));
    const snapshotPath = path.join(base, randomUUID());
    if (path.relative(source, snapshotPath) === '' || !path.relative(source, snapshotPath).startsWith('..' + path.sep) && !path.isAbsolute(path.relative(source, snapshotPath))) throw new Error('Snapshot destination cannot be inside source');
    await fs.mkdir(snapshotPath, { mode: 0o700 });
    const payload = path.join(snapshotPath, 'files'); await fs.mkdir(payload, { mode: 0o700 });
    const validation = path.join(snapshotPath, 'validation.git');
    git(snapshotPath, ['init', '--bare', '--quiet', validation]); await fs.chmod(validation, 0o700);
    const limits = { maxBytes: options.limits?.maxBytes ?? 1024 ** 3, maxFiles: options.limits?.maxFiles ?? 100000 };
    const before = await tree(source, null, limits);
    if (!before.repos.includes('')) throw new Error('Source has no Git administration');
    const states = await Promise.all(before.repos.map(async rel => comparable(await repoState(source, rel))));
    // A parent index can name a dangling child commit other than child HEAD.
    // --all HEAD bundles do not preserve it: prove every staged gitlink belongs
    // to a captured child's reachable bundle closure, otherwise retain source.
    for (let i = 0; i < before.repos.length; i++) {
      for (const entry of states[i].stages.split('\0').filter(Boolean)) {
        const link = /^160000 ([a-f0-9]+) [0-3]\t([\s\S]+)$/.exec(entry);
        if (!link) continue;
        const childRel = path.posix.join(before.repos[i], relative(link[2]));
        if (!before.repos.includes(childRel)) throw new Error('Gitlink repository is not captured; worktree retained: ' + childRel);
        const reachable = git(path.join(source, childRel), ['rev-list', '--all', 'HEAD']).toString().split('\n');
        if (!reachable.includes(link[1])) throw new Error('Staged gitlink commit is not bundled; worktree retained: ' + childRel);
      }
    }
    const copied = await tree(source, payload, limits);
    if (JSON.stringify(before) !== JSON.stringify(copied)) throw new Error('Source mutated during copy');
    const repositories = [];
    await fs.mkdir(path.join(snapshotPath, 'repositories'), { mode: 0o700 });
    let totalBytes = copied.bytes;
    for (let i = 0; i < before.repos.length; i++) {
      const rel = before.repos[i], cwd = path.join(source, rel), state = await repoState(source, rel);
      if (JSON.stringify(comparable(state)) !== JSON.stringify(states[i])) throw new Error('Repository changed during snapshot');
      const repoDir = path.join(snapshotPath, 'repositories', String(i)); await fs.mkdir(repoDir, { mode: 0o700 });
      const bundle = path.join(repoDir, 'repo.bundle');
      git(cwd, ['bundle', 'create', bundle, '--all', 'HEAD']); await fs.chmod(bundle, 0o600);
      const bundleData = await fs.readFile(bundle); totalBytes += bundleData.length;
      if (totalBytes > limits.maxBytes) throw new Error('Snapshot byte limit exceeded');
      git(cwd, ['bundle', 'verify', bundle]);
      const bundleHandle = await fs.open(bundle, 'r'); try { await bundleHandle.sync(); } finally { await bundleHandle.close(); }
      if (state.index) await writePrivate(path.join(repoDir, 'index'), state.index);
      await fs.mkdir(path.join(repoDir, 'objects'), { mode: 0o700 });
      const objects = [];
      for (const entry of state.stages.split('\0').filter(Boolean)) {
        const oid = /^\d+ ([a-f0-9]+) \d\t/.exec(entry)?.[1]; if (!oid || objects.some(o => o.oid === oid)) continue;
        const typeResult = spawnSync('git', ['-C', cwd, 'cat-file', '-t', oid], { env, maxBuffer: 1024 });
        // Gitlinks name commits in another repository; that repository is captured independently.
        if (typeResult.status !== 0 && entry.startsWith('160000 ')) continue;
        if (typeResult.status !== 0) throw new Error('Cannot preserve staged Git object');
        const type = typeResult.stdout.toString().trim(), data = git(cwd, ['cat-file', type, oid]);
        totalBytes += data.length; if (totalBytes > limits.maxBytes) throw new Error('Snapshot byte limit exceeded');
        await writePrivate(path.join(repoDir, 'objects', oid), data); objects.push({ oid, type, hash: hash(data) });
      }
      repositories.push({ path: rel, ...comparable(state), bundleHash: hash(bundleData), objects });
      await syncDir(path.join(repoDir, 'objects')); await syncDir(repoDir);
    }
    const finalTree = await tree(source, null, limits);
    if (JSON.stringify(before) !== JSON.stringify(finalTree)) throw new Error('Source mutated before snapshot completed');
    for (let i = 0; i < repositories.length; i++) if (JSON.stringify(comparable(await repoState(source, repositories[i].path))) !== JSON.stringify(states[i])) throw new Error('Source Git state mutated');
    const manifest = { version: 1, complete: true, source, repositoryRoot, branch: currentBranch, sessionId: options.sessionId, createdAt: Date.now(), limits, entries: copied.entries, repositories };
    const encoded = JSON.stringify(manifest);
    for (const entry of [...copied.entries].reverse()) if (entry.type === 'directory') await syncDir(path.join(payload, entry.path));
    await syncDir(payload); await syncDir(path.join(snapshotPath, 'repositories'));
    await writePrivate(path.join(snapshotPath, 'manifest.json'), encoded);
    await writePrivate(path.join(snapshotPath, 'manifest.sha256'), hash(encoded)); await syncDir(snapshotPath); await syncDir(base);
    return { snapshotPath, manifestHash: hash(encoded) };
  }
  async function verify(snapshotPath, source, expectedHash) {
    snapshotPath = path.resolve(snapshotPath);
    await assertDirectoryChain(snapshotPath);
    const encoded = await regularBytes(path.join(snapshotPath, 'manifest.json'));
    const manifestHash = hash(encoded);
    if (expectedHash !== undefined && expectedHash !== manifestHash) throw new Error('Snapshot receipt hash mismatch');
    if ((await regularBytes(path.join(snapshotPath, 'manifest.sha256'))).toString().trim() !== manifestHash) throw new Error('Snapshot manifest integrity failure');
    const manifest = JSON.parse(encoded);
    if (manifest.version !== 1 || manifest.complete !== true || !Array.isArray(manifest.entries) || !Array.isArray(manifest.repositories)) throw new Error('Incomplete snapshot');
    const payload = path.join(snapshotPath, 'files');
    for (const entry of manifest.entries) {
      relative(entry.path);
      if (entry.type === 'file') { const info = await fs.lstat(path.join(payload, entry.path)); if (!info.isFile() || info.isSymbolicLink() || hash(await regularBytes(path.join(payload, entry.path))) !== entry.hash) throw new Error('Snapshot file integrity failure: ' + entry.path); }
      else if (!['directory', 'symlink'].includes(entry.type)) throw new Error('Invalid snapshot entry');
    }
    for (let i = 0; i < manifest.repositories.length; i++) {
      const repo = manifest.repositories[i]; relative(repo.path);
      const dir = path.join(snapshotPath, 'repositories', String(i));
      if (hash(await regularBytes(path.join(dir, 'repo.bundle'))) !== repo.bundleHash) throw new Error('Snapshot bundle integrity failure');
      git(path.join(snapshotPath, 'validation.git'), ['bundle', 'verify', path.join(dir, 'repo.bundle')]);
      if (repo.indexHash && hash(await regularBytes(path.join(dir, 'index'))) !== repo.indexHash) throw new Error('Snapshot index integrity failure');
      for (const object of repo.objects) if (!/^[a-f0-9]+$/.test(object.oid) || hash(await regularBytes(path.join(dir, 'objects', object.oid))) !== object.hash) throw new Error('Snapshot object integrity failure');
    }
    if (source) {
      source = await fs.realpath(source);
      if (source !== manifest.source) throw new Error('Snapshot source identity mismatch');
      const current = await tree(source, null, manifest.limits);
      if (JSON.stringify(current.entries) !== JSON.stringify(manifest.entries) || JSON.stringify(current.repos) !== JSON.stringify(manifest.repositories.map(r => r.path))) throw new Error('Source changed since snapshot');
      for (const repo of manifest.repositories) {
        const state = comparable(await repoState(source, repo.path));
        const { path: ignored, bundleHash, objects, ...expected } = repo;
        if (JSON.stringify(state) !== JSON.stringify(expected)) throw new Error('Source Git state changed since snapshot');
      }
    }
    return { verified: true, manifestHash, manifest };
  }
  async function restore(snapshotPath, destination, expectedHash) {
    const { manifest } = await verify(snapshotPath, undefined, expectedHash);
    destination = path.resolve(destination);
    if (await exists(destination)) throw new Error('Restore destination already exists');
    await privateDir(path.dirname(destination)); await fs.mkdir(destination, { mode: 0o700 });
    for (let i = 0; i < manifest.repositories.length; i++) {
      const repo = manifest.repositories[i], target = path.join(destination, relative(repo.path));
      if (repo.path) { await privateDir(path.dirname(target)); if (await exists(target)) throw new Error('Nested restore target occupied'); }
      const bundle = path.join(path.resolve(snapshotPath), 'repositories', String(i), 'repo.bundle');
      git(destination, ['clone', '--no-checkout', '--no-hardlinks', '--', bundle, target]);
      git(target, ['update-ref', '--no-deref', 'HEAD', repo.head]);
      const config = git(target, ['symbolic-ref', '--quiet', 'HEAD'], undefined, [0, 1]);
      if (config.length) git(target, ['symbolic-ref', '--delete', 'HEAD']);
      // update-ref after deleting symbolic HEAD writes detached identity.
      git(target, ['update-ref', '--no-deref', 'HEAD', repo.head]);
      for (const object of repo.objects) {
        const data = await fs.readFile(path.join(path.resolve(snapshotPath), 'repositories', String(i), 'objects', object.oid));
        if (git(target, ['hash-object', '-w', '-t', object.type, '--stdin'], data).toString().trim() !== object.oid) throw new Error('Restored staged object identity mismatch');
      }
    }
    for (const entry of manifest.entries) {
      const target = path.join(destination, relative(entry.path));
      if (entry.type === 'directory') await fs.mkdir(target, { recursive: true, mode: 0o700 });
      else if (entry.type === 'symlink') await fs.symlink(entry.target, target);
      else { await writePrivate(target, await fs.readFile(path.join(path.resolve(snapshotPath), 'files', entry.path))); await fs.chmod(target, entry.mode); }
    }
    for (const entry of [...manifest.entries].reverse()) if (entry.type === 'directory') await fs.chmod(path.join(destination, entry.path), entry.mode);
    for (let i = 0; i < manifest.repositories.length; i++) {
      const repo = manifest.repositories[i]; if (!repo.indexHash) continue;
      const target = path.join(destination, repo.path), indexPath = git(target, ['rev-parse', '--path-format=absolute', '--git-path', 'index']).toString().trimEnd();
      await writePrivate(indexPath, await fs.readFile(path.join(path.resolve(snapshotPath), 'repositories', String(i), 'index')));
    }
    return { path: destination, restored: true, branch: manifest.branch, detached: true };
  }
  if (action === 'snapshot') return snapshot(args);
  if (action === 'verify') { const result = await verify(args.snapshotPath, args.source, args.manifestHash); return { verified: true, manifestHash: result.manifestHash }; }
  if (action === 'restore') return restore(args.snapshotPath, args.destination, args.manifestHash);
  throw new Error('Unknown snapshot action');
}

export const snapshot = options => engine('snapshot', options);
export const verify = (snapshotPath, source) => engine('verify', { snapshotPath, source });
export const restore = (snapshotPath, destination) => engine('restore', { snapshotPath, destination });
export const SNAPSHOT_PROGRAM = `(${engine.toString()})(process.argv[1], JSON.parse(process.argv[2])).then(value => console.log(JSON.stringify(value))).catch(error => { console.error(error.message); process.exitCode = 1; });`;
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  engine(process.argv[2], JSON.parse(process.argv[3] || '{}')).then(value => console.log(JSON.stringify(value))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
