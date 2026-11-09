import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, realpath, lstat, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createExternalWorktreeCreator } from '../external-worktree.js';
import { createWorktreeRebuilder } from '../rebuild-worktree.js';

const PROJECT = await realpath(new URL('../', import.meta.url));
async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(PROJECT, '.mwt-external-fixture-'));
  const marker = randomUUID(); await writeFile(path.join(root, '.owner'), marker);
  const running = new Set();
  t.after(async () => {
    for (const child of running) child.kill('SIGKILL');
    await Promise.all([...running].map(child => new Promise(resolve => child.once('close', resolve))));
    assert.equal(path.dirname(root), PROJECT); assert.ok(path.basename(root).startsWith('.mwt-external-fixture-'));
    assert.equal(await realpath(root), root); assert.equal(await readFile(path.join(root, '.owner'), 'utf8'), marker);
    await rm(root, { recursive: true, maxRetries: 3, retryDelay: 100 });
  });
  const home = path.join(root, 'home'), repo = path.join(root, 'source'); await mkdir(home); await mkdir(repo);
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_CONFIG_KEY_') || key.startsWith('GIT_CONFIG_VALUE_')) delete env[key];
  const git = (args, cwd = repo) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, env, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
  git(['init', '-q']); git(['symbolic-ref', 'HEAD', 'refs/heads/main']); await writeFile(path.join(repo, 'tracked.txt'), 'original\n'); git(['add', '.']); git(['commit', '-qm', 'first']);
  const commit = git(['rev-parse', 'HEAD']); let cwd = repo; const calls = [], confined = [], published = [];
  async function resolve(value, opts = {}) {
    const absolute = path.resolve(opts.cwd ?? repo, value);
    async function canonical(p) { try { return await realpath(p); } catch (e) { if (e.code !== 'ENOENT') throw e; const parent = path.dirname(p); if (p === parent) throw e; return path.join(await canonical(parent), path.basename(p)); } }
    const p = await canonical(absolute); return { targetKey: p, value: p };
  }
  const services = {
    fs: { resolve, processPath: target => target.value, contains: (a,b) => b.value === a.value || b.value.startsWith(a.value + path.sep), async lstat(p) { try { return await lstat(p); } catch(e) { if(e.code !== 'ENOENT') throw e; } } },
    workingDirectory: { ensure: async () => cwd, get: () => options.cwdChanged ? root : cwd, async set(agent, next) { options.setError && (()=>{throw options.setError})(); published.push(next); cwd = next; return next; } },
    sandboxPolicy: { resolve: () => ({ mode: options.mode ?? 'danger-full-access', workspaceRoot: repo }) },
    sandbox: { async confine(argv, policy) { confined.push({argv,policy}); if (options.deny) throw new Error('sandbox denied'); return {argv}; } },
    subprocess: {
      resolveExecutable: async name => name === 'node' ? process.execPath : 'git',
      spawn(spec) {
        calls.push(spec); options.beforeSpawn?.(spec);
        const childEnv = { ...env }; for (const [key,value] of Object.entries(spec.env)) value === undefined ? delete childEnv[key] : childEnv[key] = value;
        const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, env: childEnv, stdio:['ignore','pipe','pipe'], signal: spec.signal }); running.add(child);
        let out = '', err = ''; child.stdout.on('data', x => out += x); child.stderr.on('data', x => err += x);
        const done = new Promise((yes,no) => { child.on('error', no); child.on('close', (exitCode,signal) => {running.delete(child);yes({exitCode,signal});}); });
        return { done, collected: { stdout:{readFrom:()=>({text:out,lossy:out.length>spec.stdio.stdout.maxBytes})},stderr:{readFrom:()=>({text:err,lossy:err.length>spec.stdio.stderr.maxBytes})} }, terminate(){child.kill('SIGTERM');}, async waitForExit(){await done;} };
      },
    },
  };
  const agent = { session:{id:'external-test'},id:'external-test' };
  return { root, home, repo, commit, git, calls, confined, published, services, agent, options, rebuild: createWorktreeRebuilder((a,key)=>services[key]), create: createExternalWorktreeCreator((a,key)=>services[key], options.probeHome ? {} : {home}) };
}


async function deleted(f, stale = false) {
  const result = await f.create(f.agent, { name: 'dsh/calm-otter', from: f.commit });
  if (stale) {
    const checked = path.resolve(result.path);
    assert.ok(checked.startsWith(f.home + path.sep));
    assert.equal(await realpath(checked), checked);
    await rm(checked, { recursive: true, maxRetries: 3 });
  } else f.git(['worktree', 'remove', '--', result.path]);
  f.calls.length = 0; f.confined.length = 0; f.published.length = 0;
  return { path: result.path, branch: result.branch, repositoryRoot: f.repo, commit: f.commit, branchExists: true };
}
test('existing branch is rebuilt at original external path without changing source or ref', async t => {
  const f = await fixture(t); const request = await deleted(f);
  await writeFile(path.join(f.repo, 'tracked.txt'), 'source modification');
  const before = f.git(['status', '--porcelain']);
  const result = await f.rebuild(f.agent, request);
  assert.deepEqual(result, { path: request.path, branch: request.branch, repositoryRoot: f.repo, baseCommit: f.commit });
  assert.equal(await readFile(path.join(result.path, 'tracked.txt'), 'utf8'), 'original\n');
  assert.equal(f.git(['symbolic-ref', '--short', 'HEAD'], result.path), request.branch);
  assert.equal(f.git(['status', '--porcelain']), before);
  assert.equal(f.git(['rev-parse', 'refs/heads/' + request.branch]), f.commit);
  assert.equal(f.published.length, 1);
  assert.ok(!f.calls.some(x => x.argv.includes('--hard') || x.argv.includes('fetch') || x.argv.includes('prune')));
});
test('exact stale unlocked registration from manual directory deletion is removed, no broad prune', async t => {
  const f = await fixture(t); const request = await deleted(f, true);
  const result = await f.rebuild(f.agent, request);
  assert.equal(result.path, request.path);
  const remove = f.calls.filter(x => x.argv.includes('remove'));
  assert.equal(remove.length, 1); assert.deepEqual(remove[0].argv.slice(-3), ['remove', '--', request.path]);
  assert.ok(!f.calls.some(x => x.argv.includes('--force') || x.argv.includes('prune')));
});
test('missing branch is recreated only at caller-confirmed local commit', async t => {
  const f = await fixture(t); const request = await deleted(f); f.git(['branch', '-D', request.branch]);
  const result = await f.rebuild(f.agent, { ...request, branchExists: false });
  assert.equal(result.baseCommit, f.commit); assert.equal(f.git(['rev-parse', request.branch]), f.commit);
});
test('occupied target, branch in another checkout and legacy paths are refused', async t => {
  const f = await fixture(t); const request = await deleted(f); await mkdir(request.path); await writeFile(path.join(request.path,'keep'),'keep');
  await assert.rejects(f.rebuild(f.agent, request), /already exists/);
  assert.equal(await readFile(path.join(request.path,'keep'),'utf8'),'keep');
  const g = await fixture(t); const req = await deleted(g); const elsewhere = path.join(g.root,'other');g.git(['worktree','add',elsewhere,req.branch]);
  await assert.rejects(g.rebuild(g.agent, req), /already in use/);
  await assert.rejects(g.rebuild(g.agent,{...req,path:path.join(g.repo,'.agents','worktrees',req.branch)}),/exact owned external/);
  assert.equal(g.published.length,0);
});
test('branch ref moving before allocation is rejected without rewinding it', async t => {
  const f = await fixture(t); const request = await deleted(f);
  await writeFile(path.join(f.repo,'next'),'next');f.git(['add','next']);f.git(['commit','-qm','second']);const newer=f.git(['rev-parse','HEAD']);
  f.git(['branch','-f',request.branch,newer]);
  await assert.rejects(f.rebuild(f.agent,request),/Branch moved/);
  assert.equal(f.git(['rev-parse',request.branch]),newer);assert.equal(f.published.length,0);await assert.rejects(lstat(request.path),{code:'ENOENT'});
});
test('ref move between checkout and population never resets or rewinds existing branch', async t => {
  const f = await fixture(t);const request=await deleted(f);
  await writeFile(path.join(f.repo,'next'),'next');f.git(['add','next']);f.git(['commit','-qm','second']);const newer=f.git(['rev-parse','HEAD']);
  let moved=false;f.options.beforeSpawn=spec=>{if(!moved && spec.argv.includes('read-tree')){moved=true;f.git(['update-ref','refs/heads/'+request.branch,newer]);}};
  await assert.rejects(f.rebuild(f.agent,request),/Branch moved/);
  assert.equal(f.git(['rev-parse',request.branch]),newer);assert.equal(f.published.length,0);
});
test('locked stale registration and malformed branch/commit cannot mutate source', async t => {
  const f=await fixture(t);const result=await f.create(f.agent,{name:'dsh/calm-otter',from:f.commit});f.git(['worktree','lock',result.path]);
  assert.ok(path.resolve(result.path).startsWith(f.home+path.sep));await rm(result.path,{recursive:true,maxRetries:3});
  const request={path:result.path,branch:result.branch,repositoryRoot:f.repo,commit:f.commit,branchExists:true};
  await assert.rejects(f.rebuild(f.agent,request),/locked/);
  for(const patch of [{branch:'dsh/../escape'},{commit:'HEAD'},{branchExists:undefined}])await assert.rejects(f.rebuild(f.agent,{...request,...patch}));
  assert.equal(f.git(['symbolic-ref','--short','HEAD']),'main');
});
test('sandbox denial and pre-cancellation have no fallback, checkout or publication', async t => {
  const f=await fixture(t);const request=await deleted(f);f.options.mode='workspace-write';f.options.deny=true;
  await assert.rejects(f.rebuild(f.agent,request),/sandbox denied/);assert.equal(f.calls.length,0);assert.equal(f.published.length,0);
  f.options.deny=false;const controller=new AbortController();controller.abort(new Error('cancel'));
  await assert.rejects(f.rebuild(f.agent,request,controller.signal),/cancel/);assert.equal(f.calls.length,0);
});
test('filter drivers disabled and policy preserved for every mounted process', async t=>{
  const f=await fixture(t);const request=await deleted(f);const marker=path.join(f.root,'executed');
  // Commit attribute to the source and explicitly confirm that newer branch commit.
  await writeFile(path.join(f.repo,'.gitattributes'),'tracked.txt filter=evil\n');f.git(['add','.gitattributes']);f.git(['commit','-qm','attributes']);const tip=f.git(['rev-parse','HEAD']);f.git(['branch','-f',request.branch,tip]);
  f.git(['config','filter.evil.smudge','touch '+marker]);f.git(['config','filter.evil.required','true']);
  f.options.mode='workspace-write';await f.rebuild(f.agent,{...request,commit:tip});
  await assert.rejects(lstat(marker),{code:'ENOENT'});assert.equal(f.calls.length,f.confined.length);
});
