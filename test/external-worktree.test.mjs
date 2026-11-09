import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, realpath, lstat, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createExternalWorktreeCreator } from '../external-worktree.js';

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
  return { root, home, repo, commit, git, calls, confined, published, services, agent, create: createExternalWorktreeCreator((a,key)=>services[key], options.probeHome ? {} : {home}) };
}

test('external checkout uses canonical repo hash and word-pair leaf, pins commit, and preserves source changes', async t => {
  const f = await fixture(t); await writeFile(path.join(f.repo,'tracked.txt'),'modified\n'); await writeFile(path.join(f.repo,'untracked.txt'),'private');
  const before = f.git(['status','--porcelain']);
  const result = await f.create(f.agent,{name:'dsh/calm-otter',from:f.commit});
  const hash = createHash('sha256').update(f.repo).digest('hex').slice(0,8);
  assert.equal(result.path,path.join(f.home,'.dsh','worktrees',`source-${hash}`,'calm-otter'));
  assert.equal(result.branch,'dsh/calm-otter'); assert.equal(result.baseCommit,f.commit); assert.equal(result.repositoryRoot,f.repo);
  assert.equal(f.git(['symbolic-ref','--short','HEAD']),'main'); assert.equal(f.git(['status','--porcelain']),before);
  assert.equal(await readFile(path.join(result.path,'tracked.txt'),'utf8'),'original\n');
  assert.equal(f.git(['symbolic-ref','--short','HEAD'],result.path),'dsh/calm-otter');
  assert.equal(f.published.length,1); assert.ok(f.calls.some(x=>x.argv.includes('--no-checkout')));
  assert.ok(f.calls.filter(x=>x.argv.includes('--hard')).every(x=>x.cwd===result.path));
});

test('home probe executes inside mounted subprocess world and honors mounted home', async t => {
  const f = await fixture(t,{probeHome:true}); const r = await f.create(f.agent,{name:'dsh/ripe-bird',from:f.commit});
  assert.ok(r.path.startsWith(path.join(f.home,'.dsh','worktrees')+path.sep)); assert.ok(f.calls.some(x=>x.argv.some(a=>a.includes('os.homedir()'))));
});

test('invalid/traversal names fail before launching or allocating', async t => {
  const f = await fixture(t); for(const name of ['dsh/../escape','dsh/a/b','-bad','dsh/a..b','dsh/foo.lock','dsh/a\\b']) await assert.rejects(f.create(f.agent,{name}));
  assert.equal(f.calls.length,0); assert.equal(f.published.length,0);
});

test('existing branch and destination are rejected without overwrite or retry', async t => {
  const f = await fixture(t); f.git(['branch','dsh/ripe-bird']); await assert.rejects(f.create(f.agent,{name:'dsh/ripe-bird'}),/branch already exists/);
  const hash=createHash('sha256').update(f.repo).digest('hex').slice(0,8);const dest=path.join(f.home,'.dsh','worktrees',`source-${hash}`,'calm-otter'); await mkdir(dest,{recursive:true});await writeFile(path.join(dest,'keep'),'keep');
  await assert.rejects(f.create(f.agent,{name:'dsh/calm-otter'}),/path already exists/);assert.equal(await readFile(path.join(dest,'keep'),'utf8'),'keep');assert.equal(f.published.length,0);
});

test('sandbox denial is not retried or bypassed for external writes', async t => {
  const f = await fixture(t,{mode:'workspace-write',deny:true}); await assert.rejects(f.create(f.agent,{name:'dsh/calm-otter'}),/sandbox denied/);assert.equal(f.calls.length,0);assert.equal(f.confined.length,1);
});

test('configured smudge/process filters and hooks do not run during new checkout', async t => {
  const f = await fixture(t); const marker=path.join(f.root,'helper-marker');
  await writeFile(path.join(f.repo,'.gitattributes'),'tracked.txt filter=evil\n');f.git(['add','.gitattributes']);f.git(['commit','-qm','attributes']);
  f.git(['config','filter.evil.smudge',`touch ${marker}`]); f.git(['config','filter.evil.process',`touch ${marker}`]);f.git(['config','filter.evil.required','true']);
  const result=await f.create(f.agent,{name:'dsh/calm-otter',from:f.git(['rev-parse','HEAD'])});
  assert.equal(await readFile(path.join(result.path,'tracked.txt'),'utf8'),'original\n');await assert.rejects(lstat(marker),{code:'ENOENT'});
});

test('publication failure retains allocated branch/checkout and does not clean or retry', async t => {
  const f=await fixture(t,{setError:new Error('publish denied')});await assert.rejects(f.create(f.agent,{name:'dsh/calm-otter'}),/retained.*publish denied/);
  assert.equal(f.git(['show-ref','--verify','refs/heads/dsh/calm-otter']).split(' ')[0],f.commit);assert.equal(f.calls.filter(x=>x.argv.includes('add')&&x.argv.includes('worktree')).length,1);
  assert.ok(!f.calls.some(x=>x.argv.includes('remove')||x.argv.includes('prune')));assert.equal(f.git(['symbolic-ref','--short','HEAD']),'main');
});

test('symlinked external pool that points into source is rejected', async t => {
  const f=await fixture(t);await mkdir(path.join(f.home,'.dsh'));await symlink(f.repo,path.join(f.home,'.dsh','worktrees'));
  await assert.rejects(f.create(f.agent,{name:'dsh/calm-otter'}),/escaped.*inside/);assert.equal(f.published.length,0);
});

test('restricted policy confines every command without adding writable roots', async t => {
  const f=await fixture(t,{mode:'workspace-write'});await f.create(f.agent,{name:'dsh/calm-otter'});
  assert.equal(f.calls.length,f.confined.length);assert.ok(f.confined.some(x=>x.argv.includes('--input-type=module')));
  for(const entry of f.confined) assert.deepEqual(entry.policy,{mode:'workspace-write',workspaceRoot:f.repo});
});

test('cwd changes prevent publication and retain newly allocated checkout', async t => {
  const f=await fixture(t,{cwdChanged:true});await assert.rejects(f.create(f.agent,{name:'dsh/calm-otter'}),/directory changed/);assert.equal(f.published.length,0);
  assert.equal(f.git(['show-ref','--verify','refs/heads/dsh/calm-otter']).split(' ')[0],f.commit);
});

test('safe legacy pinned UUID-style branch names retain exact branch and leaf', async t => {
  const f=await fixture(t);const branch='worktree-d2665003-7e66-4481-a9a3-6c49054929f1';const result=await f.create(f.agent,{name:branch});assert.equal(result.branch,branch);assert.equal(path.basename(result.path),branch);
});

test('pre-aborted caller never launches a subprocess', async t => {
  const f=await fixture(t);const controller=new AbortController();controller.abort(new Error('cancelled'));await assert.rejects(f.create(f.agent,{name:'dsh/calm-otter'},controller.signal),/cancelled/);assert.equal(f.calls.length,0);
});
