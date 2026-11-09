import test from 'node:test';
import assert from 'node:assert/strict';
import { createChangesResource, decodeChangesResponse, parseUnifiedPatch, formatChangesDirectory, isPendingWorktree, changesSummaryState } from '../src/changes-client.js';

const generation = { id: 1, host: { home: '/home/user' } };
const owner = (extra = {}) => ({ sessionId: 'session', cwd: '/repo', access: true, generation, scope: 'all', ...extra });
const file = (path = 'file.txt') => ({ path, oldPath: '', status: 'M', added: 2, deleted: 1, binary: false });
function summary(target = owner(), extra = {}) {
  return { sessionId: target.sessionId, cwd: target.cwd, scope: target.scope,
    repository: { kind: 'git', root: target.cwd, branch: 'main', commit: 'a'.repeat(40), unborn: false }, selection: null,
    files: [file()], added: 2, deleted: 1, untracked: 0, limited: false, reason: '', ...extra };
}
const patch = (target, path, extra = {}) => ({ sessionId: target.sessionId, cwd: target.cwd, scope: target.scope, path, kind: 'text', patch: 'diff --git a/file.txt b/file.txt\n@@ -1 +1,2 @@\n-before\n+after\n+added\n', reason: '', ...extra });
const envelope = value => ({ ok: true, value });
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function settle() { for (let i = 0; i < 5; i++) await Promise.resolve(); }
function fixture() {
  const calls = [], current = { generation };
  const resource = createChangesResource({
    isCurrent: target => target.generation === current.generation,
    read(target, request, signal) { const pending = deferred(); calls.push({ target, request, signal, ...pending }); return pending.promise; },
  });
  return { resource, calls, current, async answer(index, value) { calls[index].resolve(envelope(value)); await settle(); } };
}

test('hover summaries resolve effective worktree cwd without weakening panel or patch identity checks', async () => {
  const f = fixture();
  const hover = owner({ resolveDirectory: true });
  const normal = f.resource.forSession(owner());
  const handle = f.resource.forSession(hover);
  assert.notEqual(normal.key, handle.key);
  const release = handle.subscribe(() => {});
  const actual = summary(owner({ cwd: '/repo/.agents/worktrees/dsh/cool-sun' }));
  actual.repository.branch = 'dsh/cool-sun';
  await f.answer(0, actual);
  assert.equal(handle.getSnapshot().phase, 'ready');
  assert.equal(handle.getSnapshot().value.cwd, actual.cwd);
  assert.equal(handle.getSnapshot().value.repository.branch, 'dsh/cool-sun');
  assert.throws(() => decodeChangesResponse(envelope(actual), owner(), { action: 'summary' }));
  assert.throws(() => decodeChangesResponse(envelope({ ...actual, sessionId: 'other' }), hover, { action: 'summary' }));
  assert.throws(() => decodeChangesResponse(envelope(patch(owner({ cwd: actual.cwd }), 'file.txt')), hover, { action: 'diff', path: 'file.txt' }));
  release(); f.resource.dispose();
});

test('directory abbreviations and pending labels always preserve the actual checkout identity', () => {
  assert.equal(formatChangesDirectory('/home/user', '/home/user/'), '~');
  assert.equal(formatChangesDirectory('/home/user/repo', '/home/user'), '~/repo');
  assert.equal(formatChangesDirectory('/home/user-other/repo', '/home/user'), '/home/user-other/repo');
  assert.equal(formatChangesDirectory('C:\\Users\\me\\repo', 'C:\\Users\\me'), '~\\repo');
  for (const status of ['staged', 'creating']) assert.equal(isPendingWorktree({ mode: 'worktree', status, sourceCwd: '/repo' }, '/repo'), true);
  for (const status of ['created', 'failed']) assert.equal(isPendingWorktree({ mode: 'worktree', status, sourceCwd: '/repo' }, '/repo'), false);
  assert.equal(isPendingWorktree({ mode: 'worktree', status: 'creating', sourceCwd: '/repo' }, '/isolated'), false);
  assert.equal(isPendingWorktree({ mode: 'local', status: 'staged', sourceCwd: '/repo' }, '/repo'), false);
});

test('query failures, partial empty lists and unknown repositories never appear clean', () => {
  assert.equal(changesSummaryState(null), 'unavailable');
  assert.equal(changesSummaryState(summary(owner(), { files: [] })), 'clean');
  assert.equal(changesSummaryState(summary(owner(), { files: [], limited: true, reason: 'Git denied' })), 'unavailable');
  assert.equal(changesSummaryState(summary(owner(), { files: [], reason: 'warning' })), 'unavailable');
  assert.equal(changesSummaryState(summary(owner(), { repository: { kind: 'unknown' }, files: [] })), 'unavailable');
  assert.equal(changesSummaryState(summary(owner(), { repository: { kind: 'none' }, files: [] })), 'none');
  assert.equal(changesSummaryState(summary()), 'changed');
  assert.equal(changesSummaryState(summary(owner(), { limited: true })), 'partial');
});

test('unified parser numbers source lines without numbering metadata or no-newline notes', () => {
  const value = parseUnifiedPatch('diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -4,2 +8,3 @@ title\n keep\n-old\n+new\n+++code\n\\ No newline at end of file\n');
  assert.equal(value.hasHunks, true); assert.equal(value.limited, false);
  assert.deepEqual(value.rows.slice(0, 3).map(row => [row.kind, row.oldLine, row.newLine]), Array.from({ length: 3 }, () => ['meta', null, null]));
  assert.deepEqual(value.rows.slice(4).map(row => [row.kind, row.oldLine, row.newLine, row.text]), [
    ['context', 4, 8, 'keep'], ['delete', 5, null, 'old'], ['add', null, 9, 'new'], ['add', null, 10, '++code'], ['note', null, null, '\\ No newline at end of file'],
  ]);
  const additions = parseUnifiedPatch('@@ -0,0 +1,2 @@\n+one\n+two\n');
  assert.deepEqual(additions.rows.slice(1).map(row => [row.oldLine, row.newLine]), [[null, 1], [null, 2]]);
  assert.equal(parseUnifiedPatch('new file mode 100644\n').hasHunks, false);
  assert.equal(parseUnifiedPatch('x\n'.repeat(10001)).limited, true);
  assert.equal(parseUnifiedPatch('x\n'.repeat(10001)).rows.length, 10000);
});

test('responses validate Session, directory, comparison scope, selected path and bounded shapes', () => {
  const target = owner(), request = { action: 'summary', scope: 'all' }, good = summary(target);
  assert.equal(decodeChangesResponse(envelope(good), target, request), good);
  for (const extra of [{ sessionId: 'other' }, { cwd: '/old' }, { scope: 'staged' }, { added: -1 }, { files: [file(), file()] }, { files: Array.from({ length: 501 }, (_, i) => file(String(i))) }]) {
    assert.throws(() => decodeChangesResponse(envelope({ ...good, ...extra }), target, request));
  }
  assert.throws(() => decodeChangesResponse({ ok: false, error: { message: 'access denied' } }, target, request), /access denied/);
  for (const kind of ['binary', 'oversized', 'conflict', 'submodule', 'missing', 'unavailable', 'text']) {
    const value = patch(target, 'file.txt', { kind, patch: '' });
    assert.equal(decodeChangesResponse(envelope(value), target, { action: 'diff', path: 'file.txt' }), value);
  }
  assert.throws(() => decodeChangesResponse(envelope(patch(target, 'other.txt')), target, { action: 'diff', path: 'file.txt' }));
  assert.throws(() => decodeChangesResponse(envelope(patch(target, 'file.txt', { patch: 'x'.repeat(1024 * 1024 + 1) })), target, { action: 'diff', path: 'file.txt' }));
});

test('concurrent summary consumers share one request and the last unmount cancels and releases it', async () => {
  const f = fixture(), first = f.resource.forSession(owner()), second = f.resource.forSession(owner());
  const release1 = first.subscribe(() => {}), release2 = second.subscribe(() => {});
  assert.equal(f.calls.length, 1); assert.equal(f.resource.size, 1);
  release1(); assert.equal(f.calls[0].signal.aborted, false);
  await f.answer(0, summary()); assert.equal(second.getSnapshot().phase, 'ready');
  release2(); assert.equal(f.resource.size, 0);
  const third = f.resource.forSession(owner()), release3 = third.subscribe(() => {});
  assert.equal(f.calls.length, 2); release3(); assert.equal(f.calls[1].signal.aborted, true);
  await f.answer(1, summary()); assert.equal(f.resource.size, 0); assert.equal(third.getSnapshot().value, null);
});

test('manual refresh drops stale responses even when transport ignores cancellation', async () => {
  const f = fixture(), handle = f.resource.forSession(owner()), release = handle.subscribe(() => {});
  const refresh = handle.refresh(); assert.equal(f.calls.length, 2); assert.equal(f.calls[0].signal.aborted, true);
  await f.answer(1, summary(owner(), { files: [file('fresh')] })); await refresh;
  await f.answer(0, summary(owner(), { files: [file('stale')] }));
  assert.equal(handle.getSnapshot().value.files[0].path, 'fresh'); release();
});

test('Session, cwd, generation, scope and access are distinct resource identities', async () => {
  const f = fixture(), handles = [owner(), owner({ sessionId: 'other' }), owner({ cwd: '/isolated' }), owner({ scope: 'staged' })].map(target => f.resource.forSession(target));
  const releases = handles.map(handle => handle.subscribe(() => {})); assert.equal(f.calls.length, 4); assert.equal(f.resource.size, 4);
  const blocked = f.resource.forSession(owner({ access: false })); const releaseBlocked = blocked.subscribe(() => {});
  assert.equal(blocked.getSnapshot().phase, 'blocked'); assert.equal(f.calls.length, 4);
  f.current.generation = { id: 2, host: { home: '/new' } };
  await f.answer(0, summary()); assert.equal(handles[0].getSnapshot().phase, 'loading');
  for (const release of releases) release(); releaseBlocked(); assert.equal(f.resource.size, 0);
  const fresh = f.resource.forSession(owner({ generation: f.current.generation })), done = fresh.subscribe(() => {});
  await f.answer(4, summary(owner({ generation: f.current.generation }))); assert.equal(fresh.getSnapshot().phase, 'ready'); done();
});

test('patches are read only for subscribed selected files and share in-flight requests', async () => {
  const f = fixture(), handle = f.resource.forSession(owner()), release = handle.subscribe(() => {});
  await f.answer(0, summary(owner(), { files: [file(), file('next.txt')] })); assert.equal(f.calls.length, 1);
  const selected = handle.diff('file.txt'); assert.equal(f.calls.length, 1);
  const close1 = selected.subscribe(() => {}), close2 = handle.diff('file.txt').subscribe(() => {});
  assert.equal(f.calls.length, 2); assert.deepEqual(f.calls[1].request, { action: 'diff', scope: 'all', path: 'file.txt' });
  close1(); assert.equal(f.calls[1].signal.aborted, false); close2(); assert.equal(f.calls[1].signal.aborted, true);
  const next = handle.diff('next.txt'), closeNext = next.subscribe(() => {});
  assert.equal(f.calls.length, 3);
  await f.answer(2, patch(owner(), 'next.txt')); assert.equal(next.getSnapshot().phase, 'ready');
  await f.answer(1, patch(owner(), 'file.txt')); assert.equal(selected.getSnapshot().value, null);
  closeNext(); release(); assert.equal(f.resource.size, 0);
});

test('nonlisted paths and non-Git responses never start a file read', async () => {
  const f = fixture(), handle = f.resource.forSession(owner()), release = handle.subscribe(() => {});
  await f.answer(0, summary());
  const selected = handle.diff('../outside'), close = selected.subscribe(() => {});
  assert.equal(selected.getSnapshot().phase, 'error'); assert.equal(f.calls.length, 1);
  close(); release();
  const other = f.resource.forSession(owner()), done = other.subscribe(() => {});
  await f.answer(1, summary(owner(), { repository: { kind: 'none', root: '', branch: '', commit: '', unborn: false }, files: [] }));
  const diff = other.diff('file.txt'), closeDiff = diff.subscribe(() => {});
  assert.equal(diff.getSnapshot().phase, 'error'); assert.equal(f.calls.length, 2); closeDiff(); done();
});

test('summary refresh cancels an obsolete patch and reloads only an active selected file', async () => {
  const f = fixture(), handle = f.resource.forSession(owner()), release = handle.subscribe(() => {});
  await f.answer(0, summary());
  const selected = handle.diff('file.txt'), close = selected.subscribe(() => {});
  const refreshing = handle.refresh(); assert.equal(f.calls[1].signal.aborted, true); assert.equal(selected.getSnapshot().phase, 'loading');
  await f.answer(2, summary()); await refreshing; assert.equal(f.calls.length, 4); assert.equal(f.calls[3].request.action, 'diff');
  await f.answer(3, patch(owner(), 'file.txt', { kind: 'binary', patch: '', reason: 'binary contents excluded' }));
  await f.answer(1, patch(owner(), 'file.txt')); assert.equal(selected.getSnapshot().value.kind, 'binary');
  close(); release();
});

test('committed-turn refresh revisions coalesce across consumers without reacting to identical values', async () => {
  const f = fixture(), one = f.resource.forSession(owner()), two = f.resource.forSession(owner());
  const a = one.subscribe(() => {}), b = two.subscribe(() => {});
  one.observeRefresh(10); two.observeRefresh(10); assert.equal(f.calls.length, 1);
  await f.answer(0, summary());
  one.observeRefresh(11); two.observeRefresh(11); assert.equal(f.calls.length, 2);
  one.observeRefresh(11); assert.equal(f.calls.length, 2);
  f.resource.refreshAll(); assert.equal(f.calls.length, 2, 'focus coalesces with an in-flight refresh');
  a(); b(); assert.equal(f.calls[1].signal.aborted, true);
});

test('transport and identity failures publish explicit error state and never retain a clean snapshot', async () => {
  const f = fixture(), handle = f.resource.forSession(owner()), release = handle.subscribe(() => {});
  await f.answer(0, summary(owner(), { files: [] })); assert.equal(changesSummaryState(handle.getSnapshot().value), 'clean');
  const pending = handle.refresh(); f.calls[1].reject(new Error('sandbox denied')); await pending;
  assert.equal(handle.getSnapshot().phase, 'error'); assert.equal(handle.getSnapshot().value, null); assert.match(handle.getSnapshot().error.detail, /sandbox denied/);
  const again = handle.refresh(); await f.answer(2, summary(owner(), { cwd: '/obsolete' })); await again;
  assert.equal(handle.getSnapshot().phase, 'error'); assert.equal(handle.getSnapshot().error.key, 'changes.invalidResponse'); release();
});

test('plugin disposal cancels every retained read and late callbacks cannot repopulate the cache', async () => {
  const f = fixture(), handle = f.resource.forSession(owner()), release = handle.subscribe(() => {});
  await f.answer(0, summary()); const selected = handle.diff('file.txt'), close = selected.subscribe(() => {});
  f.resource.dispose(); assert.equal(f.calls[1].signal.aborted, true); assert.equal(f.resource.size, 0);
  await f.answer(1, patch(owner(), 'file.txt')); assert.equal(f.resource.size, 0);
  close(); release(); const after = f.resource.forSession(owner()).subscribe(() => {}); after(); assert.equal(f.calls.length, 2);
});
