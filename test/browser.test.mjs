import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, lstat, readdir, symlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { browserRequestSchema, browserResultSchema, createBrowserOperations } from '../browser.js';
const ROOT = await realpath(new URL('../', import.meta.url));
async function fixture(t) {
  const root = await mkdtemp(path.join(ROOT, '.mwt-browser-fixture-')), marker = randomUUID(); await writeFile(path.join(root, '.owner'), marker);
  const running = new Set();
  t.after(async () => { for (const child of running) child.kill('SIGKILL'); await Promise.all([...running].map(child => new Promise(resolve => child.once('close', resolve)))); assert.equal(path.dirname(root), ROOT); assert.ok(path.basename(root).startsWith('.mwt-browser-fixture-')); assert.equal(await realpath(root), root); assert.equal(await readFile(path.join(root, '.owner'), 'utf8'), marker); await rm(root, { recursive: true, maxRetries: 3 }); });
  const repo = path.join(root, 'repo'), home = path.join(root, 'home'); await mkdir(repo); await mkdir(home);
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'x@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'x@example.invalid' };
  const git = (args, cwd = repo) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '-q']); git(['symbolic-ref', 'HEAD', 'refs/heads/main']); await writeFile(path.join(repo, 'tracked.txt'), 'before\n'); git(['add', '.']); git(['commit', '-qm', 'first']);
  let cwd = repo, denied = false, beforeRead;
  const info = stat => ({ type: stat.isSymbolicLink() ? 'symlink' : stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other', size: stat.size, version: `${stat.ino}-${stat.size}-${stat.mtimeMs}` });
  async function resolve(value, opts = {}) { const absolute = path.resolve(opts.cwd ?? repo, value); async function canonical(p) { try { return await realpath(p); } catch (error) { if (error.code !== 'ENOENT') throw error; const parent = path.dirname(p); if (parent === p) throw error; return path.join(await canonical(parent), path.basename(p)); } } const valuePath = await canonical(absolute); return { targetKey: valuePath, path: valuePath }; }
  const fs = { resolve, processPath: target => target.path, contains: (a, b) => b.path === a.path || b.path.startsWith(a.path + path.sep),
    async stat(target) { try { return info(await lstat(target.path)); } catch (error) { if (error.code !== 'ENOENT') throw error; } },
    async lstat(value, opts) { try { return info(await lstat(path.resolve(opts?.cwd ?? repo, value))); } catch (error) { if (error.code !== 'ENOENT') throw error; } },
    async listDir(target) { return Promise.all((await readdir(target.path)).sort().map(async name => ({ name, target: await resolve(name, { cwd: target.path }) }))); },
    async readBytes(target, _signal, maxBytes) { if (denied) throw new Error('read denied'); await beforeRead?.(); const bytes = await readFile(target.path); if (bytes.length > maxBytes) throw Object.assign(new Error('too large'), { code: 'FS_TOO_LARGE' }); return bytes; } };
  const calls = [];
  const services = { fs, workingDirectory: { get: () => cwd }, sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) }, sandbox: { confine() { throw new Error('Unexpected confinement'); } }, subprocess: {
    resolveExecutable: async () => 'git', spawn(spec) { calls.push(spec); const childEnv = { ...env }; for (const [key, value] of Object.entries(spec.env)) value === undefined ? delete childEnv[key] : childEnv[key] = value;
      const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], signal: spec.signal }); running.add(child);
      const collect = (stream, cap) => { let data = Buffer.alloc(0), lossy = false; stream.on('data', bytes => { if (data.length + bytes.length > cap) lossy = true; data = Buffer.concat([data, bytes]).subarray(0, cap); }); return { readFrom: () => ({ text: data.toString(), lossy }) }; };
      const stdout = collect(child.stdout, spec.stdio.stdout.maxBytes), stderr = collect(child.stderr, spec.stdio.stderr.maxBytes);
      const done = new Promise((yes, no) => { child.once('error', no); child.once('close', (exitCode, signal) => { running.delete(child); yes({ exitCode, signal }); }); });
      return { done, collected: { stdout, stderr }, terminate() { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); }, async waitForExit() { await done.catch(() => {}); } };
    } } };
  const operations = createBrowserOperations((_agent, key) => services[key]); const agent = { id: 'session', session: { header: { cwd: '/wrong-header' } } };
  return { root, repo, git, calls, operations, fs, setCwd: value => { cwd = value; }, denyRead: () => { denied = true; }, onRead: callback => { beforeRead = callback; }, run: (request, signal) => operations.operate(agent, request, signal) };
}
test('browser summaries count new text files and preserve deleted file counts', async t => {
 const f = await fixture(t); await writeFile(path.join(f.repo,'new.ts'),'one\ntwo\n'); await writeFile(path.join(f.repo,'empty.ts'),'');
 f.git(['rm','tracked.txt']);
 const data=await f.run({action:'summary'});
 assert.equal(data.files.find(file=>file.path==='new.ts').added,2);assert.equal(data.files.find(file=>file.path==='new.ts').deleted,0);
 assert.equal(data.files.find(file=>file.path==='empty.ts').added,0);assert.equal(data.files.find(file=>file.path==='tracked.txt').deleted,1);
});
test('strict requests reject traversal, absolute aliases, .git, unknown fields and missing file path', () => {
  for (const request of [{ action: 'list', path: '../x' }, { action: 'read', path: '/etc/passwd' }, { action: 'read', path: '.git/config' }, { action: 'list', path: 'x\\y' }, { action: 'diff', repository: '../other', path: 'x' }, { action: 'read' }, { action: 'repositories', cwd: '/other' }]) assert.throws(() => browserRequestSchema.parse(request));
});
test('list/read follow actual Session cwd and reject symlinks without Host fallback', async t => {
  const f = await fixture(t); await mkdir(path.join(f.repo, 'child')); await writeFile(path.join(f.repo, 'child', '.env'), 'TOKEN=local'); await symlink(f.repo, path.join(f.repo, 'child', 'escape'));
  f.setCwd(path.join(f.repo, 'child')); const list = await f.run({ action: 'list' }); assert.equal(list.cwd, path.join(f.repo, 'child')); assert.equal(list.entries.find(x => x.name === 'escape').type, 'other');
  const read = await f.run({ action: 'read', path: '.env' }); assert.equal(read.text, 'TOKEN=local'); assert.equal(read.kind, 'text');
  assert.equal((await f.run({ action: 'read', path: 'escape/tracked.txt' })).kind, 'unavailable');
  f.denyRead(); assert.match((await f.run({ action: 'read', path: '.env' })).reason, /read denied/);
});
test('internal linked directories and files are browsable but Git administration aliases remain blocked', async t => {
 const f = await fixture(t); await mkdir(path.join(f.repo, '.harness')); await writeFile(path.join(f.repo, '.harness', 'rule.md'), 'internal rule');
 await symlink('.harness', path.join(f.repo, 'rules')); await symlink('.harness/rule.md', path.join(f.repo, 'rule.md')); await symlink('.git', path.join(f.repo, 'admin'));
 const list = await f.run({ action: 'list' }); assert.equal(list.entries.find(x => x.name === 'rules').type, 'directory'); assert.equal(list.entries.find(x => x.name === 'rule.md').type, 'file'); assert.equal(list.entries.find(x => x.name === 'admin').type, 'other');
 assert.equal((await f.run({ action: 'list', path: 'rules' })).entries[0].name, 'rule.md');
 assert.equal((await f.run({ action: 'read', path: 'rules/rule.md' })).text, 'internal rule');
 assert.equal((await f.run({ action: 'read', path: 'rule.md' })).text, 'internal rule');
 assert.equal((await f.run({ action: 'read', path: 'admin/config' })).kind, 'unavailable');
});

test('bounded text preview has binary, oversized, changed-file and cwd-race fallbacks', async t => {
  const f = await fixture(t); await writeFile(path.join(f.repo, 'binary'), Buffer.from([0, 255])); await writeFile(path.join(f.repo, 'big'), 'a'.repeat(512 * 1024 + 1)); await writeFile(path.join(f.repo, 'lines'), '\n'.repeat(10001));
  assert.equal((await f.run({ action: 'read', path: 'binary' })).kind, 'binary'); assert.equal((await f.run({ action: 'read', path: 'big' })).kind, 'oversized'); assert.equal((await f.run({ action: 'read', path: 'lines' })).kind, 'oversized');
  f.onRead(async () => { f.setCwd(f.root); }); await assert.rejects(f.run({ action: 'read', path: 'tracked.txt' }), /directory changed/);
});
test('raster image preview uses signatures instead of filename and never returns SVG or HTML image data', async t => {
  const f = await fixture(t);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6VhEAAAAASUVORK5CYII=', 'base64');
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  const jpeg = Buffer.from([255,216,255,224,0,16,74,70,73,70,0,255,217]);
  const webp = Buffer.alloc(20); webp.write('RIFF'); webp.writeUInt32LE(12,4); webp.write('WEBPVP8L',8);
  const bmp = Buffer.alloc(26); bmp.write('BM'); bmp.writeUInt32LE(26,2); bmp.writeUInt32LE(26,10); bmp.writeUInt32LE(12,14);
  for (const [name, bytes, mime] of [['image.data',png,'image/png'], ['wrong.jpg',gif,'image/gif'], ['jpeg.bin',jpeg,'image/jpeg'], ['webp.bin',webp,'image/webp'], ['bmp.bin',bmp,'image/bmp']]) {
    await writeFile(path.join(f.repo,name),bytes); const image = await f.run({action:'read',path:name});
    assert.equal(image.kind,'image'); assert.equal(image.mime,mime); assert.equal(image.text,''); assert.equal(image.imageData,`data:${mime};base64,${bytes.toString('base64')}`);
  }
  for (const [name, text] of [['spoof.png','<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],['spoof.jpg','<html>active page</html>']]) {
    await writeFile(path.join(f.repo,name),text); const result = await f.run({action:'read',path:name}); assert.equal(result.kind,'unavailable'); assert.equal(result.imageData,undefined); assert.equal(result.mime,undefined);
  }
  await writeFile(path.join(f.repo,'safe.svg'),'<svg><script>alert(1)</script></svg>'); const svg = await f.run({action:'read',path:'safe.svg'}); assert.equal(svg.kind,'text'); assert.equal(svg.imageData,undefined);
});
test('image preview keeps size, containment, version and cancellation checks', async t => {
  const f = await fixture(t); const bytes=Buffer.alloc(512*1024+8); Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB','base64').copy(bytes);
  await writeFile(path.join(f.repo,'large.png'),bytes); assert.equal((await f.run({action:'read',path:'large.png'})).kind,'image');
  await writeFile(path.join(f.repo,'too-big.png'),Buffer.alloc(5*1024*1024+1)); assert.equal((await f.run({action:'read',path:'too-big.png'})).kind,'oversized');
  await symlink(path.join(f.repo,'large.png'),path.join(f.repo,'linked.png')); assert.equal((await f.run({action:'read',path:'linked.png'})).kind,'image');
  const c=new AbortController(); f.onRead(()=>c.abort(new Error('cancel image'))); await assert.rejects(f.run({action:'read',path:'large.png'},c.signal),/cancel image/);
  f.onRead(async()=>writeFile(path.join(f.repo,'large.png'),'changed')); const changed=await f.run({action:'read',path:'large.png'}); assert.equal(changed.kind,'unavailable'); assert.match(changed.reason,/changed while reading/);
});
test('strict read schema permits raster payloads only on image results', () => {
 const base={sessionId:'s',cwd:'/repo',action:'read',path:'a',kind:'image',text:'',reason:'',mime:'image/png',imageData:'data:image/png;base64,AQID'};
 browserResultSchema.parse(base);
 for(const patch of [{kind:'text'},{mime:'image/svg+xml'},{imageData:'data:text/html;base64,AQID'},{imageData:'data:image/png;base64,not base64'},{text:'unexpected'}]) assert.throws(()=>browserResultSchema.parse({...base,...patch}));
});
test('Git root and initialized tracked submodules are verified; arbitrary nested repos rejected', async t => {
  const f = await fixture(t), child = path.join(f.root, 'child'); await mkdir(child); f.git(['init', '-q'], child); await writeFile(path.join(child, 'child.txt'), 'base\n'); f.git(['add', '.'], child); f.git(['commit', '-qm', 'child'], child);
  f.git(['-c', 'protocol.file.allow=always', 'submodule', 'add', child, 'module']); f.git(['commit', '-qam', 'module']); await writeFile(path.join(f.repo, 'module', 'child.txt'), 'after\n');
  const repos = await f.run({ action: 'repositories' }); assert.deepEqual(repos.repositories.map(x => [x.id, x.initialized]), [['', true], ['module', true]]);
  const summary = await f.run({ action: 'summary', repository: 'module' }); assert.equal(summary.repository, 'module'); assert.equal(summary.files[0].workspacePath, 'module/child.txt');
  assert.match((await f.run({ action: 'diff', repository: 'module', path: 'child.txt' })).patch, /\+after/);
  await assert.rejects(f.run({ action: 'summary', repository: 'unknown' }), /not a verified/);
  await mkdir(path.join(f.repo, 'nested')); f.setCwd(path.join(f.repo, 'nested')); const rootSummary = await f.run({ action: 'summary' }); assert.equal(rootSummary.repositoryInfo.root, f.repo); assert.ok(rootSummary.files.every(x => x.workspacePath === null));
});
test('tracked but uninitialized submodules are listed without borrowing parent Git identity', async t => {
  const f = await fixture(t); const commit = f.git(['rev-parse', 'HEAD']); f.git(['update-index', '--add', '--cacheinfo', `160000,${commit},not-initialized`]);
  const repos = await f.run({ action: 'repositories' }); const child = repos.repositories.find(repo => repo.id === 'not-initialized'); assert.equal(child.initialized, false); assert.ok(child.reason);
  await assert.rejects(f.run({ action: 'summary', repository: 'not-initialized' }), /Missing path|not initialized/);
});
test('listing truncation is explicit and .git entries are never exposed', async t => {
  const f = await fixture(t); await Promise.all(Array.from({ length: 505 }, (_, i) => writeFile(path.join(f.repo, `file-${i}`), ''))); const result = await f.run({ action: 'list' }); assert.equal(result.entries.length, 500); assert.equal(result.limited, true); assert.ok(!result.entries.some(x => x.name === '.git'));
});
test('pre-cancelled requests never spawn and drain settles after active reads', async t => {
  const f = await fixture(t), c = new AbortController(); c.abort(new Error('stop')); await assert.rejects(f.run({ action: 'repositories' }, c.signal), /stop/); assert.equal(f.calls.length, 0); await f.operations.drain();
});
