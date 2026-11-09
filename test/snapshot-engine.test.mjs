import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, lstat, symlink, rm, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { snapshot, verify, restore, SNAPSHOT_PROGRAM } from '../snapshot-engine.mjs';
const ROOT = await realpath(new URL('../', import.meta.url));
async function fixture(t) {
  const dir = await mkdtemp(path.join(ROOT, '.snapshot-test-')); const token = randomUUID(); await writeFile(path.join(dir, '.owner'), token);
  t.after(async () => { assert.equal(path.dirname(dir), ROOT); assert.ok(path.basename(dir).startsWith('.snapshot-test-')); assert.equal(await realpath(dir), dir); assert.equal(await readFile(path.join(dir,'.owner'),'utf8'),token); await rm(dir,{recursive:true,maxRetries:3}); });
  const repo=path.join(dir,'repo'),home=path.join(dir,'home');await mkdir(repo);await mkdir(home);
  const env={...process.env,HOME:home,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'x@example.invalid',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'x@example.invalid'};
  const git=(args,cwd=repo)=>execFileSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd,env,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git(['init','-q']);await writeFile(path.join(repo,'tracked'),'base\n');await writeFile(path.join(repo,'.gitignore'),'ignored\n');git(['add','.']);git(['commit','-qm','first']);git(['branch','-M','dsh/calm-bird']);
  return {dir,repo,home,git, options:{source:repo,repositoryRoot:repo,branch:'dsh/calm-bird',sessionId:'session-fixture',home}};
}
test('full snapshot restores binary staged/unstaged/untracked/ignored/symlink/mode and preserves staged objects',async t=>{
 const f=await fixture(t);await writeFile(path.join(f.repo,'tracked'),'staged\n');f.git(['add','tracked']);await writeFile(path.join(f.repo,'tracked'),'unstaged\n');await writeFile(path.join(f.repo,'binary'),Buffer.from([0,255,22]));await writeFile(path.join(f.repo,'ignored'),'secret');await chmod(path.join(f.repo,'binary'),0o755);await symlink('../outside-never-read',path.join(f.repo,'link'));
 const before=f.git(['diff','--cached']);const shot=await snapshot(f.options);assert.ok(shot.manifestHash);assert.equal((await lstat(shot.snapshotPath)).mode&0o777,0o700);assert.equal((await lstat(path.join(shot.snapshotPath,'manifest.json'))).mode&0o777,0o600);await verify(shot.snapshotPath,f.repo);
 const dest=path.join(f.dir,'restored');await restore(shot.snapshotPath,dest);assert.equal(await readFile(path.join(dest,'tracked'),'utf8'),'unstaged\n');assert.equal(await readFile(path.join(dest,'ignored'),'utf8'),'secret');assert.deepEqual(await readFile(path.join(dest,'binary')),Buffer.from([0,255,22]));assert.equal((await lstat(path.join(dest,'binary'))).mode&0o777,0o755);assert.ok((await lstat(path.join(dest,'link'))).isSymbolicLink());assert.equal(f.git(['diff','--cached'],dest),before);assert.throws(()=>f.git(['symbolic-ref','--quiet','HEAD'],dest));
});
test('nested initialized submodule local commit and raw index survive original deletion',async t=>{
 const f=await fixture(t);const child=path.join(f.dir,'child');await mkdir(child);f.git(['init','-q'],child);await writeFile(path.join(child,'a'),'original');f.git(['add','.'],child);f.git(['commit','-qm','child'],child);f.git(['-c','protocol.file.allow=always','submodule','add',child,'nested']);f.git(['commit','-qam','submodule']);const nested=path.join(f.repo,'nested');await writeFile(path.join(nested,'a'),'private local commit');f.git(['add','.'],nested);f.git(['-c','user.name=Fixture','-c','user.email=x@example.invalid','commit','-qm','private'],nested);const head=f.git(['rev-parse','HEAD'],nested);await writeFile(path.join(nested,'a'),'staged local');f.git(['add','a'],nested);await writeFile(path.join(nested,'a'),'dirty local');const shot=await snapshot(f.options);const dest=path.join(f.dir,'restored');await restore(shot.snapshotPath,dest);assert.equal(f.git(['rev-parse','HEAD'],path.join(dest,'nested')),head);assert.equal(await readFile(path.join(dest,'nested','a'),'utf8'),'dirty local');assert.match(f.git(['show',':a'],path.join(dest,'nested')),/staged local/);
});
test('dangling staged submodule commit is refused instead of issuing an unrecoverable receipt', async t => {
 const f=await fixture(t); const child=path.join(f.dir,'child'); await mkdir(child); f.git(['init','-q'],child); await writeFile(path.join(child,'a'),'base'); f.git(['add','.'],child); f.git(['commit','-qm','base'],child);
 f.git(['-c','protocol.file.allow=always','submodule','add',child,'nested']); f.git(['commit','-qam','add child']); const nested=path.join(f.repo,'nested'), base=f.git(['rev-parse','HEAD'],nested);
 await writeFile(path.join(nested,'a'),'dangling'); f.git(['add','.'],nested); f.git(['-c','user.name=Fixture','-c','user.email=x@example.invalid','commit','-qm','dangling'],nested); const dangling=f.git(['rev-parse','HEAD'],nested);
 f.git(['add','nested']); f.git(['reset','--hard',base],nested);
 assert.equal(f.git(['ls-files','--stage','nested']).split(' ')[1],dangling);
 await assert.rejects(snapshot(f.options), /Staged gitlink commit is not bundled/);
 assert.equal(f.git(['rev-parse','HEAD'],nested),base);
});
test('in-progress merge metadata is refused even when raw conflict stages could be copied', async t => {
 const f=await fixture(t); f.git(['branch','side']); await writeFile(path.join(f.repo,'tracked'),'main change'); f.git(['commit','-am','main']); f.git(['checkout','side']); await writeFile(path.join(f.repo,'tracked'),'side change'); f.git(['commit','-am','side']); f.git(['checkout','dsh/calm-bird']); assert.throws(()=>f.git(['merge','side']));
 await assert.rejects(snapshot(f.options), /Active Git operation.*MERGE_HEAD/);
 assert.ok(await lstat(path.join(f.repo,'.git','MERGE_HEAD')));
});

test('source mutation, backup tampering, occupied destination and limits fail closed',async t=>{
 const f=await fixture(t);const shot=await snapshot(f.options);await writeFile(path.join(f.repo,'tracked'),'changed');await assert.rejects(verify(shot.snapshotPath,f.repo),/Source changed/);await assert.rejects(restore(shot.snapshotPath,f.repo),/already exists/);await writeFile(path.join(shot.snapshotPath,'files','tracked'),'tampered');await assert.rejects(verify(shot.snapshotPath),/integrity failure/);await assert.rejects(snapshot({...f.options,limits:{maxBytes:1}}),/limit/);
});
test('static execution-world program accepts JSON action without importing plugin source',async t=>{
 const f=await fixture(t);const result=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',SNAPSHOT_PROGRAM,'snapshot',JSON.stringify(f.options)],{encoding:'utf8'}));assert.ok(result.snapshotPath);assert.throws(()=>execFileSync(process.execPath,['--input-type=module','-e',SNAPSHOT_PROGRAM,'verify',JSON.stringify({snapshotPath:result.snapshotPath,manifestHash:'bad'})],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
});
