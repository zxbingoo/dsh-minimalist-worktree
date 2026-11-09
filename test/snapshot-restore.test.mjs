import test from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshotRestorer } from '../snapshot-restore.js';
const receipt = { path: '/pool/tree', snapshotPath: '/home/.dsh/worktree-snapshots/repo/s/id', manifestHash: 'a'.repeat(64), branch: 'dsh/test', status: 'removed', at: 1, reason: '' };
function fixture({ occupied = false, mode = 'danger-full-access', exitCode = 0 } = {}) {
 const calls = []; const services = { fs: { lstat: async () => occupied ? {} : undefined, resolve: async x => x, processPath: x => x },
 workingDirectory: { get: () => '/removed' }, sandboxPolicy: { resolve: () => ({ mode }) }, sandbox: { confine: async argv => { calls.push('sandbox'); return { argv }; } },
 subprocess: { resolveExecutable: async () => '/bin/node', spawn: spec => { calls.push(spec); return { done: Promise.resolve({ exitCode }), collected: { stdout: { readFrom: () => ({ text: JSON.stringify({ path: receipt.path }), lossy: false }) }, stderr: { readFrom: () => ({ text: 'error', lossy: false }) } }, terminate: () => calls.push('terminate'), waitForExit: async () => calls.push('reap') }; } } };
 return { calls, run: value => createSnapshotRestorer((_a, k) => services[k])({ id: 's', session: {} }, value ?? receipt) };
}
test('restoration uses recorded receipt, mounted execution and existing snapshot cwd, then reaps', async () => {
 const f = fixture({ mode: 'workspace-write' }); const result = await f.run(); assert.equal(result.status, 'restored'); assert.equal(f.calls[0], 'sandbox'); assert.equal(f.calls[1].cwd, receipt.snapshotPath); assert.ok(f.calls[1].argv.includes('restore')); assert.deepEqual(f.calls.slice(-2), ['terminate', 'reap']);
});
test('restoration never overwrites occupied directory or runs without verified receipt', async () => {
 const f = fixture({ occupied: true }); await assert.rejects(f.run(), /never overwritten/); assert.equal(f.calls.length, 0);
 await assert.rejects(fixture().run({}), /No verified/);
});
test('failed restoration does not report success and still reaps child', async () => {
 const f = fixture({ exitCode: 1 }); await assert.rejects(f.run(), /restore failed/); assert.equal(f.calls.at(-1), 'reap');
});
