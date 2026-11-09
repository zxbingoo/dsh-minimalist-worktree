import { z } from 'zod';

export const cleanupResultSchema = z.strictObject({ status: z.enum(['snapshotted', 'removed', 'skipped', 'failed', 'restored']), reason: z.string(), path: z.string(), branch: z.string(), at: z.number(), snapshotPath: z.string().optional(), manifestHash: z.string().optional(), restoredPath: z.string().optional() });

/** Observe future durable archive additions only. Never replay deletions at startup. */
export function createArchiveCleanup({ initialArchived, selections, results, getAgent, listAgents, archivedNow, activity, provider, clean, signal }) {
  let previous = new Set(initialArchived);
  const pending = new Map(), leases = new Map();
  async function run(id) {
    const selection = selections.get(id);
    if (!selection || selection.mode !== 'worktree' || selection.status !== 'created' || !selection.result) return;
    const agent = getAgent(id);
    const skip = reason => ({ status: 'skipped', reason, path: selection.result.path, branch: selection.result.branch, at: Date.now() });
    let unsafeReason = '';
    const refuse = reason => { unsafeReason = reason; return false; };
    const safe = async () => {
      signal.throwIfAborted();
      if (!archivedNow().includes(id)) return refuse('Session is no longer archived.');
      if (!agent || getAgent(id) !== agent) return refuse('Original Session execution context is unavailable.');
      const current = selections.get(id);
      if (!current || current.status !== 'created' || current.result?.path !== selection.result.path || current.result?.branch !== selection.result.branch || current.initialization?.status === 'running') return false;
      const running = await activity(id);
      if (running.length) return refuse(`Session still has activity: ${running.map(item => item.kind).join(', ')}.`);
      const fs = provider(agent, 'fs');
      const root = await fs.resolve(selection.result.path, { signal });
      for (const other of listAgents()) {
        if (other.id === id) continue;
        const otherFs = provider(other, 'fs');
        const cwd = provider(other, 'workingDirectory').get(other.session);
        if (!cwd) return refuse(`Cannot determine directory of Session ${other.id}.`);
        // Cordis creates caller-scoped proxies: object inequality is NOT a different filesystem.
        // Cross-provider mapping must explicitly prove the same file; never compare raw remote paths.
        let otherRoot = root;
        if (otherFs !== fs) {
          const mapped = otherFs.processPathFromHostPath?.(fs.processPath(root));
          if (!mapped) return refuse(`Cannot establish shared filesystem identity for Session ${other.id}.`);
          otherRoot = await otherFs.resolve(mapped, { signal });
        }
        const target = await otherFs.resolve(cwd, { signal });
        if (otherFs.contains(otherRoot, target)) return refuse(`Worktree is still used by Session ${other.id}.`);
      }
      return archivedNow().includes(id) && getAgent(id) === agent;
    };
    let result, snapshotReceipt;
    const leased = [...leases.values()].includes(selection.result.path);
    if (!leased) leases.set(id, selection.result.path);
    try {
      if (leased) { await results.put(id, skip('Another cleanup owns this worktree.')); return; }
      result = !agent ? skip('Archived Session has no live mounted execution context; retained safely.')
        : !(await safe()) ? skip(unsafeReason || 'Selection changed or initialization is still running.')
          : await clean(agent, selection, { isStillSafe: safe, onSnapshot: async receipt => {
              snapshotReceipt = receipt;
              await results.put(id, cleanupResultSchema.parse({ ...skip('Verified recovery snapshot saved before cleanup.'), status: 'snapshotted', snapshotPath: receipt.snapshotPath, manifestHash: receipt.manifestHash }));
            } }, signal);
    } catch (error) {
      result = { ...skip(error instanceof Error ? error.message : String(error)), status: 'failed' };
    }
    try { await results.put(id, cleanupResultSchema.parse({ ...(snapshotReceipt ? { snapshotPath: snapshotReceipt.snapshotPath, manifestHash: snapshotReceipt.manifestHash } : {}), ...result })); }
    finally { if (!leased) leases.delete(id); }
  }
  return {
    async assertNotCleaning(agent) {
      if (!leases.size) return;
      const fs = provider(agent, 'fs');
      const cwd = await fs.resolve(provider(agent, 'workingDirectory').get(agent.session));
      for (const path of leases.values()) if (fs.contains(await fs.resolve(path), cwd)) throw new Error('This worktree is being safely removed after archival; model execution is blocked.');
    },
    changed(change) {
      if (change.domain !== 'workspace' || change.table !== '' || change.key !== '' || change.operation !== 'put' || !Array.isArray(change.value?.archivedSessionIds) || !change.value.archivedSessionIds.every(id => typeof id === 'string')) return;
      const next = new Set(change.value.archivedSessionIds), added = [...next].filter(id => !previous.has(id)); previous = next;
      for (const id of added) {
        if (pending.has(id)) continue;
        const task = Promise.resolve().then(() => run(id)).catch(() => {});
        pending.set(id, task); task.finally(() => { if (pending.get(id) === task) pending.delete(id); });
      }
    },
    async drain() { await Promise.all([...pending.values()]); },
  };
}
