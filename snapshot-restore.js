import { SNAPSHOT_PROGRAM } from './snapshot-engine.mjs';

/** Restore only the exact durably recorded snapshot to an absent owned destination. */
export function createSnapshotRestorer(provider) {
  const pending = new Map();
  return async (agent, receipt, signal) => {
    const timeout = AbortSignal.timeout(10 * 60 * 1000);
    signal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    if (!receipt?.snapshotPath || !/^[a-f0-9]{64}$/.test(receipt.manifestHash ?? '')) throw new Error('No verified recovery snapshot is recorded for this Session.');
    if (pending.has(agent.id)) throw new Error('Snapshot restoration is already running for this Session.');
    const operation = (async () => {
      const fs = provider(agent, 'fs'), subprocess = provider(agent, 'subprocess');
      const destination = receipt.path;
      if (!destination || await fs.lstat(destination, undefined, signal)) throw new Error('Restore requires the original worktree directory to be absent; existing files are never overwritten.');
      // Execution cwd must exist: the Session may still name the removed worktree.
      const snapshot = await fs.resolve(receipt.snapshotPath, { signal });
      const policy = provider(agent, 'sandboxPolicy').resolve({ session: agent.session });
      let argv = [await subprocess.resolveExecutable('node', undefined, signal), '--input-type=module', '-e', SNAPSHOT_PROGRAM, 'restore', JSON.stringify({ snapshotPath: fs.processPath(snapshot), manifestHash: receipt.manifestHash, destination })];
      if (policy.mode !== 'danger-full-access') argv = (await provider(agent, 'sandbox').confine(argv, policy, signal)).argv;
      signal?.throwIfAborted();
      const child = subprocess.spawn({ argv, cwd: fs.processPath(snapshot), signal, graceMs: 3000,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 64 * 1024 }, stderr: { maxBytes: 64 * 1024 } } });
      try {
        const outcome = await child.done; signal?.throwIfAborted();
        const out = child.collected.stdout.readFrom(0), err = child.collected.stderr.readFrom(0);
        if (out.lossy || err.lossy || outcome.exitCode !== 0) throw new Error(`Snapshot restore failed: ${err.text.slice(-2000)}`);
        const result = JSON.parse(out.text);
        if (result.path !== destination) throw new Error('Snapshot restored to an unexpected location.');
        return { ...receipt, status: 'restored', reason: 'Recovery snapshot restored offline in detached HEAD; files and staged state retained.', restoredPath: result.path, at: Date.now() };
      } finally { child.terminate(); await child.waitForExit(); }
    })();
    pending.set(agent.id, operation);
    try { return await operation; } finally { pending.delete(agent.id); }
  };
}
