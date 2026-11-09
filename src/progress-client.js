const PREPARATION_ENDPOINT = 'minimalistWorktree/progress';
const PREPARATION_ACTIVE = ['creating', 'initializing'];

export function decodePreparationResponse(envelope, sessionId) {
  if (envelope?.ok !== true) throw new Error(envelope?.error?.message || 'Preparation progress unavailable');
  const value = envelope.value;
  if (value === null) return null;
  if (!value || value.sessionId !== sessionId || !Number.isSafeInteger(value.revision)
    || !['creating', 'initializing', 'succeeded', 'skipped', 'failed'].includes(value.phase)
    || !['logs', 'cwd', 'branch', 'command', 'error'].every(key => typeof value[key] === 'string')
    || value.logs.length > 32768 || !(value.anchorSeq === null || Number.isSafeInteger(value.anchorSeq) && value.anchorSeq >= 0) || !Number.isFinite(value.startedAt) || !Number.isFinite(value.updatedAt)
    || !(value.endedAt === null || Number.isFinite(value.endedAt))) throw new Error('Invalid preparation progress response');
  return value;
}

/** One cancellable server-held read per visible Session; no repeated Git or source scans. */
export function createPreparationFeed(read, publish, signal, sessionId) {
  return (async () => {
    let after;
    while (!signal.aborted) {
      const value = decodePreparationResponse(await read(after, signal), sessionId);
      if (signal.aborted) return;
      publish({ value, error: '' });
      if (value && !PREPARATION_ACTIVE.includes(value.phase)) return;
      after = value?.revision ?? 0;
    }
  })().catch(error => { if (!signal.aborted) publish({ value: null, error: error instanceof Error ? error.message : String(error) }); });
}

const PREPARATION_CSS = `
.dsh-mwp{font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary);margin:12px 0 20px;min-width:0}
.dsh-mwp summary{display:flex;align-items:center;gap:8px;list-style:none;cursor:pointer;width:fit-content;max-width:100%;min-height:28px}
.dsh-mwp summary::-webkit-details-marker{display:none}
.dsh-mwp summary:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px;border-radius:4px}
.dsh-mwp-indicator{width:12px;height:12px;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;flex:none}
.dsh-mwp-indicator[data-active=true]{border:1.5px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-label-secondary);border-radius:50%;animation:dsh-mwp-spin 1s linear infinite}
.dsh-mwp-indicator[data-phase=succeeded],.dsh-mwp-indicator[data-phase=skipped]{color:var(--dsw-alias-state-success-primary)}
.dsh-mwp-indicator[data-phase=failed]{color:var(--dsw-alias-state-error-primary)}
.dsh-mwp-time{font-size:10px;color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums}
.dsh-mwp-chevron{display:inline-block;transition:transform .15s}.dsh-mwp details[open] .dsh-mwp-chevron{transform:rotate(90deg)}
.dsh-mwp-terminal{margin:8px 0 0 20px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;overflow:hidden;background:var(--dsw-alias-bg-layer-1);max-width:100%}
.dsh-mwp-terminal header{display:flex;justify-content:space-between;gap:12px;padding:8px 12px;background:var(--dsw-alias-bg-layer-2);font-size:10px}
.dsh-mwp-terminal code{font:11px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--dsw-alias-label-primary);white-space:pre-wrap;overflow-wrap:anywhere}
.dsh-mwp-terminal pre{margin:0;max-height:240px;overflow:auto;padding:12px;font:11px/1.8 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary)}
.dsh-mwp-terminal footer{font-size:10px;padding:8px 12px;border-top:1px solid var(--dsw-alias-border-l1);overflow-wrap:anywhere}
.dsh-mwp-note{font-size:11px;margin:4px 0 0 20px}.dsh-mwp-error{color:var(--dsw-alias-state-error-primary);white-space:pre-wrap;overflow-wrap:anywhere}
@keyframes dsh-mwp-spin{to{transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce){.dsh-mwp-indicator[data-active=true]{animation:none}.dsh-mwp-chevron{transition:none}}
`;

export function createPreparationUI(React, ctx, t) {
  const h = React.createElement;
  const { useState, useEffect, useSyncExternalStore } = React;
  const feeds = new Map();
  function subscribeFeed(sessionId, generation, listener) {
    const key = JSON.stringify([sessionId, generation.id]);
    let entry = feeds.get(key);
    if (!entry) {
      entry = { listeners: new Set(), state: { value: null, error: '' }, controller: new AbortController() };
      feeds.set(key, entry);
      createPreparationFeed((after, signal) => ctx.connection.rpc.call('/api', PREPARATION_ENDPOINT,
        { args: { agentId: sessionId, request: after === undefined ? {} : { after } } }, signal), state => {
          entry.state = state; for (const fn of entry.listeners) fn(state);
        }, entry.controller.signal, sessionId);
    }
    entry.listeners.add(listener); listener(entry.state);
    return () => { entry.listeners.delete(listener); if (!entry.listeners.size) { entry.controller.abort(); feeds.delete(key); } };
  }
  ctx.effect(() => () => { for (const entry of feeds.values()) entry.controller.abort(); feeds.clear(); });
  function Preparation(slot) {
    useSyncExternalStore(listener => ctx.locale.subscribe(listener), () => ctx.locale.getSnapshot());
    const generation = useSyncExternalStore(listener => ctx.connection.generation.subscribe(listener), () => ctx.connection.generation.getSnapshot());
    const access = slot.useAccess(PREPARATION_ENDPOINT);
    const inputSeq = slot.node?.data?.seq;
    const [state, setState] = useState({ value: null, error: '' });
    const [open, setOpen] = useState(true), [clock, setClock] = useState(Date.now());
    useEffect(() => {
      setState({ value: null, error: '' });
      if (!access || !generation) return;
      return subscribeFeed(slot.sessionId, generation, setState);
    }, [slot.sessionId, generation, access]);
    const value = state.value;
    const active = !!value && PREPARATION_ACTIVE.includes(value.phase);
    useEffect(() => {
      if (!value) return;
      setOpen(active || value.phase === 'failed');
    }, [value?.phase]);
    useEffect(() => {
      if (!active) return;
      setClock(Date.now()); const timer = setInterval(() => setClock(Date.now()), 1000);
      return () => clearInterval(timer);
    }, [active]);
    if (!value || value.anchorSeq !== inputSeq) return null;
    const seconds = Math.max(0, Math.floor(((active ? clock : value.endedAt ?? value.updatedAt) - value.startedAt) / 1000));
    return h('section', { className: 'dsh-mwp', 'aria-label': t('progress.label') }, h('style', null, PREPARATION_CSS),
      h('details', { open, onToggle: event => setOpen(event.currentTarget.open) },
        h('summary', null,
          h('span', { className: 'dsh-mwp-indicator', 'data-active': active, 'data-phase': value.phase, 'aria-hidden': true }, active ? '' : value.phase === 'failed' ? '!' : '✓'),
          h('span', { role: 'status', 'aria-live': 'polite' }, t(`progress.${value.phase}`)),
          h('span', { className: 'dsh-mwp-time' }, `${seconds} ${t('progress.seconds')}`),
          h('span', { className: 'dsh-mwp-chevron', 'aria-hidden': true }, '›')),
        h('div', { className: 'dsh-mwp-terminal' },
          h('header', null, h('code', null, value.command || value.branch || t('progress.creating')), h('span', null, active ? t('progress.live') : t('progress.ended'))),
          h('pre', { tabIndex: 0, 'aria-label': t('progress.logs') }, value.logs || t('progress.noLogs')),
          h('footer', null, value.cwd,
            value.limited && h('div', null, t('progress.limited'))))),
      value.phase === 'failed' && h('div', { className: 'dsh-mwp-note dsh-mwp-error', role: 'alert' }, value.error, h('div', null, t('progress.failedHint'))),
      value.phase === 'succeeded' && h('div', { className: 'dsh-mwp-note' }, t('progress.successHint')),
      value.phase === 'skipped' && h('div', { className: 'dsh-mwp-note' }, t('progress.skippedHint')));
  }
  return { Preparation, install() {
    const kind = 'dsh-minimalist-worktree.preparation';
    ctx.effect(() => ctx.uiConversation.events.register({
      kind, target: 'chat',
      match: { 'agent/inbox/spliced': event => event.data?.target === 'next-turn'
        && event.data.inserted?.some(message => message.role === 'user' && message.source?.kind === 'user')
        ? { id: 'preparation', role: 'start' } : null },
      start: (_context, match) => ({ seq: match.event.seq }),
      update: context => context.state,
      buildViewNode: context => !context.state ? null : ({
        key: context.key, id: context.id, kind, target: 'chat', anchorSeq: context.state.seq + 0.1,
        location: context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' },
        visibility: 'visible', groupTree: 'turn', data: context.state,
      }),
    }));
    ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ name: 'conversation.chat.node', key: kind }, Preparation));
  } };
}
