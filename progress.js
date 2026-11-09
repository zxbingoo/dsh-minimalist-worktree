import { z } from 'zod';

export const PROGRESS_LOG_LIMIT = 32 * 1024;
export const progressSchema = z.strictObject({
  sessionId: z.string(), revision: z.number().int().nonnegative(), anchorSeq: z.number().int().nonnegative().nullable(),
  phase: z.enum(['creating', 'initializing', 'succeeded', 'skipped', 'failed']),
  startedAt: z.number().nonnegative(), updatedAt: z.number().nonnegative(), endedAt: z.number().nonnegative().nullable(),
  cwd: z.string().max(4096), branch: z.string().max(1024), command: z.string().max(4096),
  logs: z.string().refine(value => Buffer.byteLength(value) <= PROGRESS_LOG_LIMIT), limited: z.boolean(), error: z.string().max(4096),
});
export const progressRecordSchema = progressSchema;
const active = value => value && ['creating', 'initializing'].includes(value.phase);
export function preparationInput(event) {
  return event?.type === 'agent/inbox/spliced' && event.data?.target === 'next-turn'
    && event.data.inserted?.some(message => message.role === 'user' && message.source?.kind === 'user');
}
export function preparationError(error) {
  if (error instanceof Error) return error.message;
  if (error?.kind === 'user') return 'Preparation cancelled by the user; existing worktree files are retained.';
  if (error?.kind) return `Preparation cancelled (${error.kind}); existing worktree files are retained.`;
  return typeof error === 'string' ? error : JSON.stringify(error) || 'Preparation failed.';
}
// Output is text, not HTML. Remove OSC/CSI/control sequences before publication.
export function sanitizeProgressText(value) {
  return String(value).replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .replace(/\b(Bearer\s+)[^\s]+/gi, '$1[REDACTED]')
    .replace(/\b((?:api[_-]?key|access[_-]?token|token|password|secret)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{16,})\b/g, '[REDACTED]');
}
function bounded(value, bytes) {
  if (Buffer.byteLength(value) <= bytes) return value;
  let result = Buffer.from(value).subarray(-bytes).toString('utf8');
  while (Buffer.byteLength(result) > bytes) result = result.slice(1);
  return result.replace(/^\uFFFD/, '');
}

/** Persist before notifying. Failed storage writes reject callers; observers never run execution callbacks. */
export function createProgressTracker(table, { waitMs = 25000, now = Date.now } = {}) {
  const queues = new Map(), waiters = new Map(), live = new Set();
  const idOf = agent => typeof agent === 'string' ? agent : agent.id;
  const snapshot = id => { const value = table.get(id); return value ? structuredClone(progressSchema.parse(value)) : null; };
  function serial(id, operation) {
    const promise = (queues.get(id) ?? Promise.resolve()).catch(() => {}).then(operation);
    const settled = promise.then(() => {}, () => {}); queues.set(id, settled);
    settled.then(() => { if (queues.get(id) === settled) queues.delete(id); }); return promise;
  }
  function publish(id) { for (const wake of [...(waiters.get(id) ?? [])]) wake(); }
  async function save(id, value) { const record = progressSchema.parse(value); await table.put(id, record); publish(id); return structuredClone(record); }
  function start(agent) {
    const id = idOf(agent);
    live.add(id);
    return serial(id, () => { const previous = snapshot(id), time = now();
      let anchorSeq = null;
      if (typeof agent?.session?.eventAt === 'function' && Number.isSafeInteger(agent.session.seq)) {
        for (let seq = 0; seq < agent.session.seq; seq++) {
          const event = agent.session.eventAt(seq);
          if (preparationInput(event)) { anchorSeq = seq; break; }
        }
      }
      return save(id, { sessionId: id, revision: (previous?.revision ?? 0) + 1, anchorSeq, phase: 'creating', startedAt: time, updatedAt: time,
        endedAt: null, cwd: '', branch: '', command: '', logs: '', limited: false, error: '' }); });
  }
  function update(agent, patch) {
    const id = idOf(agent);
    return serial(id, () => {
      const current = snapshot(id); if (!current) throw new Error('Preparation progress has not started.');
      const allowed = ['phase', 'cwd', 'branch', 'command'];
      if (!patch || Object.keys(patch).some(key => !allowed.includes(key))) throw new Error('Invalid progress update.');
      if (!active(current)) throw new Error('Preparation progress is already terminal.');
      if (patch.phase && !['creating', 'initializing'].includes(patch.phase)) throw new Error('Use finish for terminal progress.');
      const safe = { ...patch }; for (const key of ['cwd', 'branch', 'command']) if (key in safe) safe[key] = sanitizeProgressText(safe[key]);
      return save(id, { ...current, ...safe, revision: current.revision + 1, updatedAt: now() });
    });
  }
  function append(agent, text) {
    const id = idOf(agent);
    return serial(id, () => {
      const current = snapshot(id); if (!current) throw new Error('Preparation progress has not started.');
      if (!active(current)) return current;
      const all = sanitizeProgressText(current.logs + String(text));
      const logs = bounded(all, PROGRESS_LOG_LIMIT);
      if (logs === current.logs) return current;
      return save(id, { ...current, logs, limited: current.limited || Buffer.byteLength(all) > PROGRESS_LOG_LIMIT,
        revision: current.revision + 1, updatedAt: now() });
    });
  }
  function finish(agent, phase, error = '') {
    const id = idOf(agent);
    return serial(id, () => {
      const current = snapshot(id); if (!current) throw new Error('Preparation progress has not started.');
      if (!['succeeded', 'skipped', 'failed'].includes(phase)) throw new Error('Invalid terminal progress phase.');
      if (!active(current)) return current;
      const time = now(); return save(id, { ...current, phase, error: bounded(sanitizeProgressText(error), 4096),
        endedAt: time, updatedAt: time, revision: current.revision + 1 }).then(value => { live.delete(id); return value; });
    });
  }
  async function read(agent, after, signal) {
    signal?.throwIfAborted(); const id = idOf(agent);
    let value = snapshot(id);
    if (value && value.anchorSeq === null && typeof agent?.session?.eventAt === 'function') {
      let anchorSeq = null;
      for (let seq = 0; seq < agent.session.seq; seq++) if (preparationInput(agent.session.eventAt(seq))) { anchorSeq = seq; break; }
      if (anchorSeq !== null) {
        await serial(id, () => { const current = snapshot(id); return save(id, { ...current, anchorSeq, revision: current.revision + 1 }); });
        value = snapshot(id);
      }
    }
    if (active(value) && !live.has(id)) {
      await finish(agent, 'failed', 'Preparation was interrupted by a runtime restart; no automatic retry was performed.');
      value = snapshot(id);
    }
    if (value ? (!active(value) || after !== value.revision) : after === undefined) return value;
    return new Promise((resolve, reject) => {
      let timer;
      const listeners = waiters.get(id) ?? new Set(); waiters.set(id, listeners);
      function cleanup() { clearTimeout(timer); listeners.delete(wake); if (!listeners.size) waiters.delete(id); signal?.removeEventListener('abort', abort); }
      function wake() { cleanup(); try { resolve(snapshot(id)); } catch (error) { reject(error); } }
      function abort() { cleanup(); reject(signal.reason ?? new Error('Progress read cancelled.')); }
      listeners.add(wake); signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(wake, Math.min(25000, Math.max(1, waitMs)));
      if (signal?.aborted) abort(); else { const latest = snapshot(id); if (latest && (!active(latest) || latest.revision !== after)) wake(); }
    });
  }
  return { start, update, append, finish, read, async drain() {
    await Promise.all([...queues.values()]); for (const id of [...waiters.keys()]) publish(id);
  } };
}
