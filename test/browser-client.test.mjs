import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pairBrowserDiffRows, createBrowserUI, browserRepositoryIsClean, browserGitMode, browserChangeEntries } from '../src/browser-client.js';
test('compressed change paths preserve branching and native file identity, list stays flat', () => {
 const files=[{path:'apps/web/src/a.ts'},{path:'apps/web/test/b.ts'},{path:'docs/design/solution/c.md'},{path:'README.md'}];
 const tree=browserChangeEntries(files);
 assert.deepEqual(tree.entries.filter(entry=>entry.meta.kind==='directory').map(entry=>entry.name),['apps/web','src','test','docs/design/solution']);
 assert.equal(tree.mapping.size,4);assert.equal(tree.expanded.length,4);
 const list=browserChangeEntries(files,true);assert.equal(list.entries.length,4);assert.equal(list.expanded.length,0);assert.equal(list.entries[0].name,files[0].path);
});
test('only confirmed non-Git discovery hides Git UI; errors and loading remain unknown', () => {
 assert.equal(browserGitMode({kind:'none'}),'none'); assert.equal(browserGitMode({kind:'git'}),'git');
 for(const value of [null,{}, {kind:'unknown'}]) assert.equal(browserGitMode(value),'unknown');
});
test('only confirmed clean repositories are hidden; changes, failures and unknown state stay visible', () => {
 const repository = { initialized: true };
 const clean = { phase: 'ready', value: { repositoryInfo: { kind: 'git' }, files: [], limited: false, reason: '' } };
 assert.equal(browserRepositoryIsClean(repository, clean), true);
 for (const state of [undefined, { phase: 'error' }, { ...clean, value: { ...clean.value, files: [{ path: 'changed' }] } }, { ...clean, value: { ...clean.value, limited: true } }, { ...clean, value: { ...clean.value, reason: 'denied' } }]) assert.equal(browserRepositoryIsClean(repository, state), false);
 assert.equal(browserRepositoryIsClean({ initialized: false }, clean), false);
});
test('panel grid and flex children constrain overflow into independent scroll regions', async () => {
 const s=await readFile(new URL('../src/browser-client.js',import.meta.url),'utf8');
 assert.ok(s.includes('grid-template-rows:minmax(0,1fr)'));
 assert.ok(s.includes('.dsh-mwb-nav{display:flex;flex-direction:column;min-height:0;overflow:hidden;'));
 assert.ok(s.includes('.dsh-mwb-list{overflow:auto;overscroll-behavior:contain;flex:1 1 0;min-height:0;'));
 assert.ok(s.includes('.dsh-mwb-content{flex:1 1 0;min-height:0;overflow:auto;'));
});
test('side-by-side pairing aligns changed blocks and preserves source line numbers', () => {
 const del = {kind:'delete',oldLine:4,text:'old'}, add={kind:'add',newLine:4,text:'new'}, add2={kind:'add',newLine:5,text:'extra'}, context={kind:'context',oldLine:5,newLine:6,text:'keep'};
 assert.deepEqual(pairBrowserDiffRows([del,add,add2,context]),[{old:del,next:add},{old:null,next:add2},{old:context,next:context}]);
});
test('browser replaces only the existing workspace files body with higher priority, without new tab type', () => {
 const calls=[];const ctx={slots:{inject:(slot,fn)=>{calls.push(slot);fn();},register:options=>calls.push(options)}};
 createBrowserUI({},ctx,()=>'',()=>({rows:[]}),()=>({})).install();assert.equal(calls[0],'sidebar.right.pane.tab');assert.equal(calls[1].key,'@deepseek-ai/dsh-client-ui-sidebar-files');assert.equal(calls[1].priority,-10);
});
test('file and change listings reuse the native tree factory instead of hand-drawn icons', async () => {
 const s=await readFile(new URL('../src/browser-client.js',import.meta.url),'utf8');
 assert.equal(s.split("slot.renderFactorySlot('sidebar.files.tree'").length-1,2);
 assert.ok(s.includes('NATIVE_TREE_OPTIONS = Object.freeze'));
 assert.ok(!s.includes('h(FileIcon'));
});
test('panel stays single-file and session/cwd/generation-bound with cancellation, no Git write controls', async () => {
 const s=await readFile(new URL('../src/browser-client.js',import.meta.url),'utf8');
 assert.ok(s.includes('slot.sessionId, cwd, generation?.id, access')); assert.ok(s.includes('c.abort()'));assert.ok(s.includes('response.value.cwd !== cwd'));assert.ok(s.includes('file.workspacePath'));
 for(const prohibited of ['sidebarRight.openTab','createPortal','dangerouslySetInnerHTML','git commit','git reset','stageFile','require('])assert.ok(!s.includes(prohibited));
});
