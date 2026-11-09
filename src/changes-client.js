const CHANGES_ENDPOINT = 'minimalistWorktree/changes';
const CHANGES_REFRESH = 'dsh-minimalist-worktree.refresh';
const CHANGES_SCOPES = ['all', 'unstaged', 'staged'];
const CHANGES_KINDS = ['text', 'binary', 'oversized', 'conflict', 'submodule', 'missing', 'unavailable'];
const CHANGES_LOADING = Object.freeze({ phase: 'loading', value: null, error: null });
const CHANGES_IDLE = Object.freeze({ phase: 'idle', value: null, error: null });
const CHANGES_UNSET = Symbol('unobserved refresh');

const isChangesRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isChangesCount = value => Number.isSafeInteger(value) && value >= 0;
const isChangesNullableCount = value => value === null || isChangesCount(value);
const changesKey = owner => JSON.stringify([owner.sessionId, owner.cwd, owner.generation?.id ?? null, !!owner.access, owner.scope, !!owner.resolveDirectory]);
const canReadChanges = owner => !!(owner.sessionId && owner.cwd && owner.generation && owner.access);
const changesBlocked = owner => ({ phase: 'blocked', value: null, error: {
  key: !owner.access ? 'changes.accessDenied' : !owner.generation ? 'changes.connecting' : 'changes.directoryMissing', detail: '',
} });
const changesError = (key, detail = '') => Object.assign(new Error(detail), { changesKey: key });
const changesFailure = error => ({ phase: 'error', value: null, error: {
  key: error?.changesKey || 'changes.requestFailed', detail: error instanceof Error ? error.message : String(error),
} });

/** Validate both the response shape and the exact Session/directory/scope/path it belongs to. */
export function decodeChangesResponse(envelope, owner, request) {
  if (envelope?.ok !== true) throw changesError('changes.requestFailed', typeof envelope?.error?.message === 'string' ? envelope.error.message : '');
  const value = envelope.value;
  let valid = isChangesRecord(value) && value.sessionId === owner.sessionId
    && typeof value.cwd === 'string' && !!value.cwd
    && (owner.resolveDirectory && request.action === 'summary' || value.cwd === owner.cwd)
    && value.scope === owner.scope && typeof value.reason === 'string';
  if (request.action === 'summary') {
    const repo = value?.repository;
    valid &&= isChangesRecord(repo) && ['git', 'none', 'unknown'].includes(repo.kind)
      && ['root', 'branch', 'commit'].every(key => typeof repo[key] === 'string') && typeof repo.unborn === 'boolean'
      && (value.selection === null || (isChangesRecord(value.selection) && ['local', 'worktree'].includes(value.selection.mode)))
      && isChangesCount(value.added) && isChangesCount(value.deleted) && isChangesCount(value.untracked)
      && typeof value.limited === 'boolean' && Array.isArray(value.files) && value.files.length <= 500
      && value.files.every(file => isChangesRecord(file) && typeof file.path === 'string' && !!file.path
        && typeof file.oldPath === 'string' && typeof file.status === 'string'
        && isChangesNullableCount(file.added) && isChangesNullableCount(file.deleted) && typeof file.binary === 'boolean')
      && new Set(value.files.map(file => file.path)).size === value.files.length;
  } else {
    valid &&= CHANGES_KINDS.includes(value?.kind) && value.path === request.path
      && typeof value.patch === 'string' && value.patch.length <= 1024 * 1024;
  }
  if (!valid) throw changesError('changes.invalidResponse');
  return value;
}

/** A pending choice never substitutes its planned checkout for the actual working directory. */
export function isPendingWorktree(selection, cwd) {
  return selection?.mode === 'worktree' && ['staged', 'creating'].includes(selection.status) && selection.sourceCwd === cwd;
}

/** Abbreviate only the display label; copying and the selectable field always use the full path. */
export function formatChangesDirectory(cwd, home) {
  if (typeof cwd !== 'string') return '';
  const base = typeof home === 'string' ? home.replace(/[\\/]+$/, '') : '';
  if (base && (cwd === base || cwd.startsWith(`${base}/`) || cwd.startsWith(`${base}\\`))) return `~${cwd.slice(base.length)}`;
  return cwd;
}

/** Pure, bounded unified-diff parser. Headers are never mistaken for numbered source lines. */
export function parseUnifiedPatch(patch) {
  if (typeof patch !== 'string') return { rows: [], hasHunks: false, limited: false };
  const lines = patch.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const limited = lines.length > 10000;
  const rows = [];
  let oldLine = 0, newLine = 0, oldLeft = 0, newLeft = 0, hasHunks = false;
  for (const raw of lines.slice(0, 10000)) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(raw);
    if (match && match.slice(1).filter(value => value !== undefined).every(value => Number.isSafeInteger(Number(value)))) {
      oldLine = Number(match[1]); oldLeft = Number(match[2] ?? 1);
      newLine = Number(match[3]); newLeft = Number(match[4] ?? 1);
      hasHunks = true;
      rows.push({ kind: 'hunk', oldLine: null, newLine: null, sign: '', text: raw });
    } else if (raw.startsWith('\\')) {
      rows.push({ kind: 'note', oldLine: null, newLine: null, sign: '', text: raw });
    } else if (raw[0] === '+' && newLeft > 0) {
      rows.push({ kind: 'add', oldLine: null, newLine: newLine++, sign: '+', text: raw.slice(1) });
      newLeft--;
    } else if (raw[0] === '-' && oldLeft > 0) {
      rows.push({ kind: 'delete', oldLine: oldLine++, newLine: null, sign: '−', text: raw.slice(1) });
      oldLeft--;
    } else if (raw[0] === ' ' && oldLeft > 0 && newLeft > 0) {
      rows.push({ kind: 'context', oldLine: oldLine++, newLine: newLine++, sign: ' ', text: raw.slice(1) });
      oldLeft--; newLeft--;
    } else {
      oldLeft = 0; newLeft = 0;
      rows.push({ kind: 'meta', oldLine: null, newLine: null, sign: '', text: raw });
    }
  }
  return { rows, hasHunks, limited };
}

/**
 * Subscription-owned shared reads. Only mounted summary/selected-file consumers retain entries.
 * There is no timer, historical Session cache, or background all-file patch prefetch.
 */
export function createChangesResource({ read, isCurrent = () => true }) {
  const entries = new Map();
  let disposed = false;
  const current = (entry, ticket) => !disposed && entry.active && entries.get(entry.key) === entry
    && isCurrent(entry.owner) && !ticket.controller.signal.aborted;
  const notify = listeners => { for (const listener of [...listeners]) listener(); };

  function drop(entry) {
    entry.active = false;
    entry.pending?.controller.abort();
    for (const patch of entry.patches.values()) patch.pending?.controller.abort();
    entry.patches.clear();
    if (entries.get(entry.key) === entry) entries.delete(entry.key);
  }
  function release(entry) {
    entry.refs--;
    if (entry.refs === 0) drop(entry);
  }
  function ensure(owner, key) {
    let entry = entries.get(key);
    if (!entry) {
      entry = { owner, key, active: true, refs: 0, listeners: new Set(), patches: new Map(),
        summary: CHANGES_LOADING, pending: null, revision: CHANGES_UNSET };
      entries.set(key, entry);
    }
    return entry;
  }
  function resetPatches(entry) {
    for (const patch of entry.patches.values()) {
      patch.pending?.controller.abort();
      patch.pending = null;
      patch.snapshot = CHANGES_LOADING;
      notify(patch.listeners);
    }
  }
  function runPatch(entry, patch, force = false) {
    if (patch.pending && !force) return patch.pending.promise;
    patch.pending?.controller.abort();
    if (!entry.active || !isCurrent(entry.owner) || !patch.listeners.size) return;
    if (entry.summary.phase !== 'ready') return;
    const listed = entry.summary.value.repository.kind === 'git'
      && entry.summary.value.files.some(file => file.path === patch.path);
    if (!listed) {
      patch.snapshot = changesFailure(changesError('changes.fileMissing'));
      notify(patch.listeners);
      return;
    }
    const ticket = { controller: new AbortController(), promise: null };
    patch.pending = ticket;
    patch.snapshot = CHANGES_LOADING;
    notify(patch.listeners);
    const valid = () => current(entry, ticket) && patch.pending === ticket && entry.patches.get(patch.path) === patch;
    ticket.promise = (async () => {
      try {
        const request = { action: 'diff', scope: entry.owner.scope, path: patch.path };
        const result = await read(entry.owner, request, ticket.controller.signal);
        if (!valid()) return;
        patch.snapshot = { phase: 'ready', value: decodeChangesResponse(result, entry.owner, request), error: null };
        notify(patch.listeners);
      } catch (error) {
        if (valid()) { patch.snapshot = changesFailure(error); notify(patch.listeners); }
      } finally {
        if (patch.pending === ticket) patch.pending = null;
      }
    })();
    return ticket.promise;
  }
  function runSummary(entry, force = false) {
    if (entry.pending && !force) return entry.pending.promise;
    entry.pending?.controller.abort();
    if (!entry.active || !isCurrent(entry.owner)) return;
    const ticket = { controller: new AbortController(), promise: null };
    entry.pending = ticket;
    resetPatches(entry);
    entry.summary = CHANGES_LOADING;
    notify(entry.listeners);
    const valid = () => current(entry, ticket) && entry.pending === ticket;
    ticket.promise = (async () => {
      try {
        const request = { action: 'summary', scope: entry.owner.scope };
        const result = await read(entry.owner, request, ticket.controller.signal);
        if (!valid()) return;
        entry.summary = { phase: 'ready', value: decodeChangesResponse(result, entry.owner, request), error: null };
        notify(entry.listeners);
        for (const patch of entry.patches.values()) void runPatch(entry, patch);
      } catch (error) {
        if (valid()) { entry.summary = changesFailure(error); notify(entry.listeners); }
      } finally {
        if (entry.pending === ticket) entry.pending = null;
      }
    })();
    return ticket.promise;
  }

  function forSession(rawOwner) {
    const owner = { ...rawOwner, scope: CHANGES_SCOPES.includes(rawOwner.scope) ? rawOwner.scope : 'all', access: !!rawOwner.access };
    const key = changesKey(owner);
    const enabled = canReadChanges(owner);
    const initial = enabled ? CHANGES_LOADING : changesBlocked(owner);
    return {
      key,
      getSnapshot: () => entries.get(key)?.summary ?? initial,
      subscribe(listener) {
        if (!enabled || disposed) return () => {};
        const entry = ensure(owner, key), wrapped = () => listener();
        entry.refs++;
        entry.listeners.add(wrapped);
        // Every mount is fresh; concurrent mounts share the same pending operation.
        void runSummary(entry);
        let active = true;
        return () => {
          if (!active) return;
          active = false;
          entry.listeners.delete(wrapped);
          release(entry);
        };
      },
      refresh() { const entry = entries.get(key); return entry ? runSummary(entry, true) : undefined; },
      observeRefresh(revision) {
        const entry = entries.get(key);
        if (!entry || Object.is(entry.revision, revision)) return;
        const first = entry.revision === CHANGES_UNSET;
        entry.revision = revision;
        if (!first) return runSummary(entry, true);
      },
      diff(path) {
        const initialPatch = enabled && path ? CHANGES_LOADING : enabled ? CHANGES_IDLE : initial;
        return {
          getSnapshot: () => entries.get(key)?.patches.get(path)?.snapshot ?? initialPatch,
          subscribe(listener) {
            if (!enabled || !path || disposed) return () => {};
            const entry = ensure(owner, key), wrapped = () => listener();
            let patch = entry.patches.get(path);
            if (!patch) {
              patch = { path, listeners: new Set(), pending: null, snapshot: CHANGES_LOADING };
              entry.patches.set(path, patch);
            }
            entry.refs++;
            patch.listeners.add(wrapped);
            if (entry.summary.phase === 'ready') void runPatch(entry, patch);
            else if (!entry.pending) void runSummary(entry);
            let active = true;
            return () => {
              if (!active) return;
              active = false;
              patch.listeners.delete(wrapped);
              if (!patch.listeners.size) {
                patch.pending?.controller.abort();
                if (entry.patches.get(path) === patch) entry.patches.delete(path);
              }
              release(entry);
            };
          },
          refresh() {
            const entry = entries.get(key), patch = entry?.patches.get(path);
            return patch ? runPatch(entry, patch, true) : undefined;
          },
        };
      },
    };
  }
  return {
    forSession,
    invalidate(sessionId) { for (const entry of entries.values()) if (entry.owner.sessionId === sessionId) void runSummary(entry, true); },
    refreshAll() { for (const entry of entries.values()) void runSummary(entry); },
    dispose() { disposed = true; for (const entry of [...entries.values()]) drop(entry); },
    get size() { return entries.size; },
  };
}

/** Never present a failed or partial empty query as a clean checkout. */
export function changesSummaryState(value) {
  if (!value || value.repository?.kind === 'unknown') return 'unavailable';
  if (value.repository.kind === 'none') return 'none';
  if (!value.files.length) return value.limited || value.reason ? 'unavailable' : 'clean';
  return value.limited || value.reason ? 'partial' : 'changed';
}

const CHANGES_CSS = `
.dsh-mwc{box-sizing:border-box;min-width:0;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:1.5}
.dsh-mwc button,.dsh-mwc select,.dsh-mwc textarea{font:inherit;box-sizing:border-box}
.dsh-mwc button,.dsh-mwc select{color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:transparent}
.dsh-mwc button{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:28px;padding:4px 8px;cursor:pointer}
.dsh-mwc button:hover:not(:disabled),.dsh-mwc button[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-mwc button:disabled{cursor:default;opacity:.5}
.dsh-mwc button:focus-visible,.dsh-mwc select:focus-visible,.dsh-mwc textarea:focus-visible,.dsh-mwc [tabindex="0"]:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dsh-mwc svg{flex:none;display:block}
/* The native compact HoverCard uses a fixed inverse palette. Scope this
   bridge to a card containing OUR slot; never repaint unrelated tooltips.
   Match the CSS-module local suffix, not a build-specific hashed prefix. */
div[class*="_card"]:has(.dsh-mwc-session-hover){--dsw-hovercard-bg:var(--dsw-alias-bg-overlay);background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);color-scheme:inherit}
div[class*="_card"]:has(.dsh-mwc-session-hover) [class*="_hoverTitle"]{color:var(--dsw-alias-label-primary)}
div[class*="_card"]:has(.dsh-mwc-session-hover) :is([class*="_hoverPath"],[class*="_hoverTime"],[class*="_hoverStatus"]){color:var(--dsw-alias-label-secondary)}
.dsh-mwc-session-hover{display:flex;flex-direction:column;gap:5px;padding-block:5px;max-width:100%;background:transparent;color:var(--dsw-alias-label-primary)}
.dsh-mwc-hover-row{display:flex;align-items:baseline;gap:8px;min-width:0}
.dsh-mwc-hover-row>span:first-child{flex:none}
.dsh-mwc-hover-row>span:last-child{min-width:0;overflow-wrap:anywhere;white-space:pre-wrap}
.dsh-mwc-bar{display:flex;align-items:center;flex-wrap:wrap;gap:6px;padding:2px 6px;min-height:32px;color:var(--dsw-alias-label-secondary)}
.dsh-mwc-bar button{border-color:transparent;min-height:26px;padding:3px 6px}
.dsh-mwc-branch{display:inline-flex;align-items:center;gap:5px;min-width:0;max-width:32%;font-size:11px}
.dsh-mwc-ellipsis{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.dsh-mwc-path{position:relative;display:flex;align-items:center;flex:1;min-width:100px;max-width:100%}
.dsh-mwc-path-trigger{min-width:0;max-width:100%}
.dsh-mwc-path-trigger span{direction:ltr;text-align:start}
.dsh-mwc-path-pop{position:absolute;inset-block-end:calc(100% + 6px);inset-inline-start:0;z-index:45;width:420px;max-width:calc(100vw - 40px);padding:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary)}
.dsh-mwc-path-pop label{display:block;margin-bottom:6px;font-weight:500}
.dsh-mwc-path-pop textarea{width:100%;resize:vertical;min-height:62px;padding:7px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:inherit;font-family:monospace;direction:ltr;text-align:start;overflow-wrap:anywhere;user-select:text}
.dsh-mwc-muted{color:var(--dsw-alias-label-secondary)}
.dsh-mwc-caption{color:var(--dsw-alias-label-caption);font-size:11px}
.dsh-mwc-pending,.dsh-mwc-warn{color:var(--dsw-alias-state-warn-primary)}
.dsh-mwc-badge{flex:none;font-size:10px;line-height:18px;padding:0 6px;border-radius:5px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.dsh-mwc-counts{display:inline-flex;align-items:center;gap:6px;white-space:nowrap;font-variant-numeric:tabular-nums;font-size:11px}
.dsh-mwc-add{color:var(--dsw-alias-state-success-primary)}
.dsh-mwc-del{color:var(--dsw-alias-state-error-primary)}
.dsh-mwc-panel{display:flex;flex-direction:column;gap:10px;height:100%;min-height:300px;padding:16px;overflow:hidden;background:var(--dsw-alias-bg-base)}
.dsh-mwc-header{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.dsh-mwc-title{display:flex;align-items:center;gap:8px;min-width:0}
.dsh-mwc-title h2{font:inherit;font-size:14px;font-weight:600;margin:0}
.dsh-mwc-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dsh-mwc select{height:30px;max-width:100%;padding:3px 26px 3px 9px;background:var(--dsw-alias-bg-layer-1)}
.dsh-mwc-meta{display:flex;align-items:center;gap:10px;flex-wrap:wrap;color:var(--dsw-alias-label-secondary);font-size:11px}
.dsh-mwc-meta code{overflow-wrap:anywhere;user-select:text}
.dsh-mwc-notice{padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-layer-1);overflow-wrap:anywhere;font-size:11px}
.dsh-mwc-notice summary{cursor:pointer;font-weight:500}
.dsh-mwc-notice p{margin:5px 0 0;color:var(--dsw-alias-label-secondary);white-space:pre-wrap}
.dsh-mwc-workspace{display:grid;grid-template-columns:minmax(180px,28%) minmax(0,1fr);flex:1;min-height:250px;max-height:72dvh;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;overflow:hidden;background:var(--dsw-alias-bg-layer-1)}
.dsh-mwc-files{margin:0;padding:5px;list-style:none;overflow:auto;overscroll-behavior:contain;border-inline-end:1px solid var(--dsw-alias-border-l1)}
.dsh-mwc-files li{margin:0;padding:0}
.dsh-mwc-files button{display:flex;width:100%;text-align:start;justify-content:flex-start;border-color:transparent;padding:8px;gap:8px}
.dsh-mwc-files button[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-active);border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
.dsh-mwc-status{flex:none;width:16px;text-align:center;font-size:11px;font-weight:600}
.dsh-mwc-file-copy{flex:1;min-width:0;overflow-wrap:anywhere;white-space:pre-wrap}
.dsh-mwc-file-copy small{display:block;font-size:10px;color:var(--dsw-alias-label-caption)}
.dsh-mwc-file-copy .dsh-mwc-counts{display:flex;margin-top:2px}
.dsh-mwc-diff{display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden}
.dsh-mwc-diff-head{display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:38px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.dsh-mwc-diff-head code{overflow-wrap:anywhere;white-space:pre-wrap;min-width:0}
.dsh-mwc-patch{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;background:var(--dsw-alias-markdown-code-block)}
.dsh-mwc-patch table{border-collapse:collapse;min-width:100%;font:11px/20px ui-monospace,SFMono-Regular,Consolas,monospace;tab-size:4}
.dsh-mwc-patch td{padding:0;vertical-align:top;border:0}
.dsh-mwc-patch td.dsh-mwc-ln{min-width:36px;width:36px;padding:0 8px;text-align:end;color:var(--dsw-alias-label-caption);border-inline-end:1px solid var(--dsw-alias-border-l1);user-select:none;font-variant-numeric:tabular-nums}
.dsh-mwc-patch td.dsh-mwc-code{padding-inline-end:14px;white-space:pre}
.dsh-mwc-sign{display:inline-block;min-width:24px;text-align:center;user-select:none}
.dsh-mwc-patch tr[data-kind=add]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent)}
.dsh-mwc-patch tr[data-kind=delete]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)}
.dsh-mwc-patch tr[data-kind=add] .dsh-mwc-sign{color:var(--dsw-alias-state-success-primary)}
.dsh-mwc-patch tr[data-kind=delete] .dsh-mwc-sign{color:var(--dsw-alias-state-error-primary)}
.dsh-mwc-patch tr[data-kind=hunk]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,transparent);color:var(--dsw-alias-label-secondary)}
.dsh-mwc-patch tr[data-kind=meta],.dsh-mwc-patch tr[data-kind=note]{color:var(--dsw-alias-label-caption);background:var(--dsw-alias-bg-layer-1)}
.dsh-mwc-empty{display:flex;flex:1;min-height:140px;align-items:center;justify-content:center;flex-direction:column;gap:8px;padding:24px;text-align:center;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.dsh-mwc-empty p{margin:0;max-width:650px;white-space:pre-wrap}
.dsh-mwc-empty strong{font-size:13px;color:var(--dsw-alias-label-primary);font-weight:500}
.dsh-mwc-dialog{box-sizing:border-box;width:min(1100px,94vw);max-width:94vw;height:min(760px,88dvh);max-height:88dvh;padding:0;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary)}
.dsh-mwc-dialog::backdrop{background:color-mix(in srgb,var(--dsw-alias-label-primary) 24%,transparent)}
.dsh-mwc-dialog .dsh-mwc-panel{height:100%;min-height:0}
.dsh-mwc-dialog .dsh-mwc-workspace{max-height:none;min-height:0}
.dsh-mwc-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
@media(max-width:720px){.dsh-mwc-panel{padding:10px;gap:8px}.dsh-mwc-workspace{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(70px,26%) minmax(180px,1fr);min-height:350px;max-height:70dvh}.dsh-mwc-files{border-inline-end:0;border-bottom:1px solid var(--dsw-alias-border-l1)}.dsh-mwc-files button{padding:5px 7px}.dsh-mwc-file-copy .dsh-mwc-counts{display:inline-flex;margin:0 0 0 8px}.dsh-mwc-branch{max-width:42%}.dsh-mwc-dialog{width:96vw;max-width:96vw;height:92dvh;max-height:92dvh;border-radius:10px}.dsh-mwc-path-pop{max-width:calc(100vw - 28px);width:320px}}
`;

/** Installed UI only: no private stores, browser package imports, or out-of-slot DOM. */
export function createChangesUI(React, ctx, t) {
  const h = React.createElement;
  const { useState, useMemo, useRef, useEffect, useSyncExternalStore, useId } = React;
  const subscribeLocale = listener => ctx.locale.subscribe(listener);
  const getLocale = () => ctx.locale.getSnapshot();
  const subscribeGeneration = listener => ctx.connection.generation.subscribe(listener);
  const getGeneration = () => ctx.connection.generation.getSnapshot();
  const resource = createChangesResource({
    isCurrent: owner => getGeneration() === owner.generation,
    read: (owner, request, signal) => ctx.connection.rpc.call('/api', CHANGES_ENDPOINT,
      { args: { agentId: owner.sessionId, request } }, signal),
  });

  function Icon({ kind, size = 14 }) {
    const attrs = { width: size, height: size, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true };
    const shapes = kind === 'folder' ? [h('path', { key: 0, d: 'M2.5 6V4.5h5l2 2h8v9h-15z' })]
      : kind === 'copy' ? [h('rect', { key: 0, x: 7, y: 7, width: 10, height: 10, rx: 2 }), h('path', { key: 1, d: 'M13 7V3H3v10h4' })]
      : kind === 'refresh' ? [h('path', { key: 0, d: 'M16 8a6.2 6.2 0 1 0 0 5M16 3v5h-5' })]
      : kind === 'close' ? [h('path', { key: 0, d: 'm5 5 10 10M15 5 5 15' })]
      : kind === 'check' ? [h('path', { key: 0, d: 'm4 10 4 4 8-8' })]
      : kind === 'changes' ? [h('rect', { key: 0, x: 3, y: 2.5, width: 14, height: 15, rx: 2 }), h('path', { key: 1, d: 'M6 7h5m-2-2v4m-3 4h7' })]
      : [h('circle', { key: 0, cx: 5, cy: 4, r: 2 }), h('circle', { key: 1, cx: 5, cy: 16, r: 2 }), h('circle', { key: 2, cx: 15, cy: 5, r: 2 }), h('path', { key: 3, d: 'M5 6v8m0-3c0-4 10 0 10-4' })];
    return h('svg', attrs, ...shapes);
  }
  function useChanges(slot, scope) {
    useSyncExternalStore(subscribeLocale, getLocale, getLocale);
    const sessionCwd = slot.useSessions(state => state.byId[slot.sessionId]?.cwd);
    const projectedCwd = slot.useProjection('workingDirectory');
    const revision = slot.useProjection(CHANGES_REFRESH);
    const access = slot.useAccess(CHANGES_ENDPOINT);
    const generation = useSyncExternalStore(subscribeGeneration, getGeneration, getGeneration);
    const cwd = typeof projectedCwd === 'string' ? projectedCwd : sessionCwd ?? '';
    const handle = useMemo(() => resource.forSession({ sessionId: slot.sessionId, cwd, scope, access, generation }),
      [slot.sessionId, cwd, scope, access, generation]);
    const snapshot = useSyncExternalStore(handle.subscribe, handle.getSnapshot, handle.getSnapshot);
    useEffect(() => { handle.observeRefresh(revision); }, [handle, revision]);
    return { handle, snapshot, cwd, generation, enabled: !!(slot.sessionId && cwd && access && generation) };
  }
  function Counts({ added, deleted, limited }) {
    return h('span', { className: 'dsh-mwc-counts', title: limited ? t('changes.partial') : undefined },
      limited && h('span', { 'aria-label': t('changes.partial') }, '≈'),
      h('span', { className: 'dsh-mwc-add' }, `+${added}`), h('span', { className: 'dsh-mwc-del' }, `−${deleted}`));
  }
  function Empty({ title, detail, busy = false }) {
    return h('div', { className: 'dsh-mwc-empty', role: busy ? 'status' : undefined },
      h('strong', null, title), detail && h('p', { className: 'dsh-mwc-caption' }, detail));
  }
  function ErrorState({ error }) {
    return h(Empty, { title: t(error?.key || 'changes.requestFailed'), detail: error?.detail });
  }
  function SessionHover(slot) {
    useSyncExternalStore(subscribeLocale, getLocale, getLocale);
    const cwd = slot.useSessions(state => state.byId[slot.sessionId]?.cwd) ?? '';
    const access = slot.useSessionAccess(slot.sessionId, CHANGES_ENDPOINT);
    const generation = useSyncExternalStore(subscribeGeneration, getGeneration, getGeneration);
    const handle = useMemo(() => resource.forSession({ sessionId: slot.sessionId, cwd, scope: 'all', access, generation, resolveDirectory: true }),
      [slot.sessionId, cwd, access, generation]);
    const snapshot = useSyncExternalStore(handle.subscribe, handle.getSnapshot, handle.getSnapshot);
    const data = snapshot.phase === 'ready' ? snapshot.value : null;
    const directory = data?.cwd || cwd;
    const branch = data?.repository.kind === 'git'
      ? data.repository.branch || `${t('state.detached')} ${data.repository.commit.slice(0, 8)}`
      : data?.repository.kind === 'none' ? t('changes.notGit')
        : snapshot.phase === 'loading' ? t('changes.loading') : t('changes.unavailable');
    return h('div', { className: 'dsh-mwc dsh-mwc-session-hover', 'data-worktree-hover-session': slot.sessionId },
      h('style', null, CHANGES_CSS),
      h('div', { className: 'dsh-mwc-hover-row' }, h('span', { className: 'dsh-mwc-caption' }, t('branch.current')), h('span', { title: snapshot.error?.detail || data?.reason || undefined }, branch)),
      h('div', { className: 'dsh-mwc-hover-row' }, h('span', { className: 'dsh-mwc-caption' }, t('changes.directory')),
        h('span', { dir: 'ltr' }, directory || t('changes.directoryMissing'))));
  }

  function Patch({ handle, file }) {
    const patchHandle = useMemo(() => handle.diff(file?.path ?? ''), [handle, file?.path]);
    const snapshot = useSyncExternalStore(patchHandle.subscribe, patchHandle.getSnapshot, patchHandle.getSnapshot);
    const parsed = useMemo(() => parseUnifiedPatch(snapshot.value?.patch), [snapshot.value?.patch]);
    let body;
    if (!file) body = h(Empty, { title: t('changes.chooseFile') });
    else if (snapshot.phase === 'loading') body = h(Empty, { title: t('changes.patchLoading'), busy: true });
    else if (snapshot.error) body = h(ErrorState, { error: snapshot.error });
    else if (snapshot.value?.kind !== 'text') body = h(Empty, {
      title: t(`changes.kind.${snapshot.value?.kind || 'unavailable'}`), detail: snapshot.value?.reason,
    });
    else if (parsed.limited) body = h(Empty, { title: t('changes.kind.oversized') });
    else body = h(React.Fragment, null,
      snapshot.value.reason && h('div', { className: 'dsh-mwc-notice dsh-mwc-warn', role: 'status' }, snapshot.value.reason),
      !parsed.hasHunks && h('div', { className: 'dsh-mwc-notice' }, t('changes.metadataOnly')),
      h('div', { className: 'dsh-mwc-patch', tabIndex: 0, role: 'region', 'aria-label': t('changes.unifiedDiff') },
        h('table', null,
          h('caption', { className: 'dsh-mwc-sr' }, t('changes.lineNumbers')),
          h('tbody', null, parsed.rows.map((row, index) => h('tr', { key: index, 'data-kind': row.kind },
            h('td', { className: 'dsh-mwc-ln' }, row.oldLine ?? ''),
            h('td', { className: 'dsh-mwc-ln' }, row.newLine ?? ''),
            h('td', { className: 'dsh-mwc-code' }, h('span', { className: 'dsh-mwc-sign', 'aria-hidden': true }, row.sign), row.text)))))));
    return h('section', { className: 'dsh-mwc-diff', 'aria-label': t('changes.unifiedDiff'), 'aria-busy': snapshot.phase === 'loading' || undefined },
      h('div', { className: 'dsh-mwc-diff-head' },
        h('code', null, file?.path || t('changes.chooseFile')),
        file && h('span', { className: 'dsh-mwc-badge' }, t(`changes.status.${file.status}`) || file.status)), body);
  }

  function RestoreSnapshot({ slot, onRestored }) {
    const access = slot.useAccess('minimalistWorktree/operate');
    const canRestore = slot.useAccess('minimalistWorktree/restore');
    const [receipt, setReceipt] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
    useEffect(() => {
      if (!access) return;
      const controller = new AbortController();
      ctx.connection.rpc.call('/api', 'minimalistWorktree/operate', { args: { agentId: slot.sessionId, request: { action: 'inspect' } } }, controller.signal)
        .then(response => { if (!controller.signal.aborted && response.ok) setReceipt(response.value.cleanup ?? null); })
        .catch(() => {});
      return () => controller.abort();
    }, [slot.sessionId, access]);
    if (!receipt?.snapshotPath || receipt.status === 'restored') return null;
    async function restore() {
      setBusy(true); setError('');
      try {
        const response = await ctx.connection.rpc.call('/api', 'minimalistWorktree/restore', { args: { agentId: slot.sessionId, request: {} } });
        if (!response.ok) throw new Error(response.error?.message || t('snapshot.failed'));
        setReceipt(response.value); onRestored();
      } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
      finally { setBusy(false); }
    }
    return h('div', { className: 'dsh-mwc-notice' },
      h('strong', null, t('snapshot.available')), h('p', null, receipt.snapshotPath),
      h('p', null, t('snapshot.hint')),
      h('button', { type: 'button', disabled: !canRestore || busy, onClick: restore }, t(busy ? 'snapshot.restoring' : 'snapshot.restore')),
      error && h('p', { role: 'alert' }, error));
  }

  function Panel({ slot, onClose }) {
    const [scope, setScope] = useState('all'), [chosen, setChosen] = useState(null);
    const { handle, snapshot, cwd, enabled } = useChanges(slot, scope);
    const root = useRef(null), buttons = useRef(new Map());
    const titleId = `dsh-mwc-title-${useId().replace(/:/g, '')}`;
    useEffect(() => {
      if (slot.viewRequest) { root.current?.focus(); slot.completeViewRequest?.(); }
    }, [slot.viewRequest, slot.completeViewRequest]);
    const data = snapshot.phase === 'ready' ? snapshot.value : null;
    const state = changesSummaryState(data);
    const files = data?.repository.kind === 'git' ? data.files : [];
    const selected = (chosen?.key === handle.key && files.find(file => file.path === chosen.path)) || files[0];
    function choose(file, focus = false) {
      setChosen({ key: handle.key, path: file.path });
      if (focus) buttons.current.get(file.path)?.focus();
    }
    function navigate(event, index) {
      let next;
      if (event.key === 'ArrowDown') next = (index + 1) % files.length;
      else if (event.key === 'ArrowUp') next = (index - 1 + files.length) % files.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = files.length - 1;
      if (next === undefined) return;
      event.preventDefault(); choose(files[next], true);
    }
    let content;
    if (snapshot.phase === 'loading') content = h(Empty, { title: t('changes.loading'), busy: true });
    else if (snapshot.error) content = h(ErrorState, { error: snapshot.error });
    else if (state === 'none') content = h(Empty, { title: t('changes.notGit'), detail: cwd });
    else if (state === 'unavailable') content = h(Empty, { title: t('changes.unavailable'), detail: data?.reason || t('changes.retryHint') });
    else if (state === 'clean') content = h(Empty, { title: t('changes.clean'), detail: t(`changes.scopeHint.${scope}`) });
    else content = h('div', { className: 'dsh-mwc-workspace' },
      h('ul', { className: 'dsh-mwc-files', 'aria-label': t('changes.files') }, files.map((file, index) => h('li', { key: file.path },
        h('button', { type: 'button', 'aria-pressed': selected?.path === file.path, title: file.oldPath ? `${file.oldPath} → ${file.path}` : file.path,
          ref: element => { if (element) buttons.current.set(file.path, element); else buttons.current.delete(file.path); },
          onClick: () => choose(file), onKeyDown: event => navigate(event, index),
        }, h('span', { className: `dsh-mwc-status ${file.status === 'D' ? 'dsh-mwc-del' : ['A', '?'].includes(file.status) ? 'dsh-mwc-add' : ''}`, 'aria-label': t(`changes.status.${file.status}`) }, file.status),
        h('span', { className: 'dsh-mwc-file-copy' }, file.path,
          file.oldPath && h('small', null, `${t('changes.renamedFrom')} ${file.oldPath}`),
          file.binary ? h('small', null, t('changes.kind.binary'))
            : file.added === null || file.deleted === null ? h('small', null, t(file.status === '?' ? 'changes.untracked' : 'changes.countUnknown'))
              : h(Counts, { added: file.added, deleted: file.deleted })))))),
      h(Patch, { handle, file: selected }));
    return h('section', { ref: root, tabIndex: -1, className: 'dsh-mwc dsh-mwc-panel', 'aria-labelledby': titleId }, h('style', null, CHANGES_CSS),
      h('header', { className: 'dsh-mwc-header' },
        h('div', { className: 'dsh-mwc-title' }, h(Icon, { kind: 'changes', size: 17 }), h('h2', { id: titleId }, t('changes.title')), h('span', { className: 'dsh-mwc-badge' }, t('changes.readOnly'))),
        h('div', { className: 'dsh-mwc-actions' },
          h('select', { value: scope, 'aria-label': t('changes.scope'), onChange: event => setScope(event.target.value) },
            CHANGES_SCOPES.map(value => h('option', { key: value, value }, t(`changes.scope.${value}`)))),
          h('button', { type: 'button', disabled: !enabled || snapshot.phase === 'loading', onClick: () => handle.refresh(), title: t('changes.refresh') }, h(Icon, { kind: 'refresh' }), t('changes.refresh')),
          onClose && h('button', { type: 'button', onClick: onClose, 'aria-label': t('changes.close'), title: t('changes.close'), autoFocus: true }, h(Icon, { kind: 'close' })))),
      h('div', { className: 'dsh-mwc-meta' },
        data?.repository.kind === 'git' && h('span', null, data.repository.branch || `${t('state.detached')} ${data.repository.commit.slice(0, 8)}`),
        h('code', { title: cwd }, cwd),
        ['changed', 'partial', 'clean'].includes(state) && data && h(React.Fragment, null,
          h('span', null, `${data.files.length} ${t('changes.files')}`), h(Counts, { added: data.added, deleted: data.deleted, limited: state === 'partial' }))),
      ['changed', 'partial', 'clean'].includes(state) && h('div', { className: 'dsh-mwc-caption' }, t(`changes.scopeHint.${scope}`)),
      state === 'partial' && data && h('details', { className: 'dsh-mwc-notice dsh-mwc-warn' },
        h('summary', null, t('changes.partial')), h('p', null, data.reason || t('changes.countUnknown'))),
      h(RestoreSnapshot, { slot, onRestored: () => handle.refresh() }),
      content);
  }

  function View(slot) { return h(Panel, { key: slot.sessionId, slot }); }

  return {
    invalidate: sessionId => resource.invalidate(sessionId),
    install() {
      ctx.effect(() => {
        const focus = () => resource.refreshAll();
        window.addEventListener('focus', focus);
        return () => { window.removeEventListener('focus', focus); resource.dispose(); };
      });
      // The host owns row hover timing, placement and dismissal; no extra icon or click target.
      ctx.slots.inject('sidebar.session.row.hover', () => ctx.slots.register({ name: 'sidebar.session.row.hover', id: 'dsh-minimalist-worktree.directory', order: 0 }, SessionHover));
      ctx.slots.inject('conversation.view', () => ctx.slots.register({ name: 'conversation.view', id: 'dsh-minimalist-worktree.changes', order: 40, label: () => t('changes.title') }, View));
    },
  };
}
