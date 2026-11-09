const RECOVERY_ENDPOINT = 'minimalistWorktree/recovery';
// Adapted from DSH QuestionComposer option geometry; no private component imports.
const RECOVERY_CSS = `
.dsh-mwr{box-sizing:border-box;width:calc(100% - 32px);max-width:var(--dsh-chat-content-width,800px);min-width:0;margin:6px auto;padding:14px 12px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}
.dsh-mwr h3{font:inherit;font-size:13px;font-weight:500;margin:0;padding:0 10px 8px}.dsh-mwr p{margin:6px 0;overflow-wrap:anywhere}.dsh-mwr code{font:11px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;user-select:text}
.dsh-mwr-actions{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}.dsh-mwr button{font:inherit;color:inherit;cursor:pointer;padding:6px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:transparent}
.dsh-mwr .dsh-mwr-options{flex-direction:column;gap:1px;margin:0;padding:4px 0}
.dsh-mwr .dsh-mwr-option{display:flex;align-items:center;gap:8px;width:100%;min-height:40px;flex-shrink:0;padding:8px 12px 8px 8px;text-align:left;border:1px solid transparent;border-radius:8px;background:transparent;transition:background-color .12s,border-color .12s}
.dsh-mwr .dsh-mwr-option:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);border-color:transparent}
.dsh-mwr-number{display:grid;place-items:center;flex:0 0 20px;width:20px;height:20px;border-radius:4px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;line-height:18px}
.dsh-mwr-option-label{flex:1;min-width:0}.dsh-mwr-recommended{display:inline-flex;align-items:center;vertical-align:middle;white-space:nowrap;margin-inline-start:8px;padding:1px 6px;border:1px solid var(--dsw-alias-border-l2,currentColor);border-radius:5px;background:var(--dsw-alias-bg-layer-2,transparent);color:var(--dsw-alias-label-primary,inherit);font-size:11px;font-weight:600;line-height:16px}.dsh-mwr-arrow{color:var(--dsw-alias-label-tertiary);font-size:16px;opacity:0}.dsh-mwr-option:hover .dsh-mwr-arrow,.dsh-mwr-option:focus-visible .dsh-mwr-arrow{opacity:1}
.dsh-mwr button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.dsh-mwr button:disabled{opacity:.5;cursor:default}.dsh-mwr button:focus-visible,.dsh-mwr summary:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dsh-mwr details{padding:0 10px;margin-top:4px;color:var(--dsw-alias-label-secondary);font-size:11px}.dsh-mwr summary{cursor:pointer;width:fit-content;font-size:10px}.dsh-mwr-confirm{padding:8px 10px 0;border-top:1px solid var(--dsw-alias-border-l1);margin-top:8px}.dsh-mwr-warning{color:var(--dsw-alias-state-warn-primary)}.dsh-mwr-error{color:var(--dsw-alias-state-error-primary)}
@media(prefers-reduced-motion:reduce){.dsh-mwr .dsh-mwr-option{transition:none}}
`;

export function createRecoveryUI(React, ctx, t) {
  const h = React.createElement;
  const { useEffect, useState, useSyncExternalStore } = React;
  function Recovery(slot) {
    useSyncExternalStore(fn => ctx.locale.subscribe(fn), () => ctx.locale.getSnapshot());
    const generation = useSyncExternalStore(fn => ctx.connection.generation.subscribe(fn), () => ctx.connection.generation.getSnapshot());
    const allowed = slot.useAccess(RECOVERY_ENDPOINT);
    const cwd = slot.useProjection('workingDirectory');
    const refresh = slot.useProjection('dsh-minimalist-worktree.refresh');
    const [state, setState] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [confirm, setConfirm] = useState(''), [done, setDone] = useState(false);
    useEffect(() => {
      setState(null); setDone(false); setConfirm(''); setError('');
      if (!allowed || !generation) return;
      const controller = new AbortController();
      const load = () => ctx.connection.rpc.call('/api', RECOVERY_ENDPOINT, { args: { agentId: slot.sessionId, request: { action: 'inspect' } } }, controller.signal)
        .then(response => { if (controller.signal.aborted) return; if (!response.ok) throw new Error(response.error?.message || 'Recovery check failed'); setState(response.value); })
        .catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : String(error)); });
      load(); window.addEventListener('focus', load);
      return () => { controller.abort(); window.removeEventListener('focus', load); };
    }, [slot.sessionId, allowed, generation, cwd, refresh]);
    async function choose(action) {
      setBusy(true); setError('');
      try {
        const request = { action, token: state.token, ...(action === 'source' ? { confirmSource: true } : !state.branchExists ? { confirmCommit: state.candidateCommit } : {}) };
        const response = await ctx.connection.rpc.call('/api', RECOVERY_ENDPOINT, { args: { agentId: slot.sessionId, request } });
        if (!response.ok) throw new Error(response.error?.message || 'Recovery operation failed');
        setState(response.value); setDone(true); setConfirm('');
      } catch (error) { setError(error instanceof Error ? error.message : String(error)); setConfirm(''); }
      finally { setBusy(false); }
    }
    if (done) return h('div', { className: 'dsh-mwr', role: 'status' }, h('style', null, RECOVERY_CSS), t('recovery.done'));
    if (!state?.blocked) return error ? h('div', { className: 'dsh-mwr dsh-mwr-error', role: 'alert' }, h('style', null, RECOVERY_CSS), t('recovery.checkFailed'), ' ', error) : null;
    return h('section', { className: 'dsh-mwr', 'aria-label': t('recovery.title') }, h('style', null, RECOVERY_CSS),
      h('div', { className: 'dsh-mwr-head' },
        h('h3', null, t(state.expectedExists ? 'recovery.changedShort' : 'recovery.missingShort')),
        !confirm && h('div', { className: 'dsh-mwr-actions dsh-mwr-options' },
          h('button', { type: 'button', className: 'dsh-mwr-option', disabled: busy || !state.canRebuild, onClick: () => state.branchExists ? choose('rebuild') : setConfirm('commit') }, h('span', { className: 'dsh-mwr-number', 'aria-hidden': true }, '1'), h('span', { className: 'dsh-mwr-option-label' }, t(busy ? 'recovery.working' : 'recovery.rebuildShort'), h('span', { className: 'dsh-mwr-recommended' }, t('recovery.recommended'))), h('span', { className: 'dsh-mwr-arrow', 'aria-hidden': true }, '›')),
          h('button', { type: 'button', className: 'dsh-mwr-option', disabled: busy || !state.canUseSource, onClick: () => setConfirm('source') }, h('span', { className: 'dsh-mwr-number', 'aria-hidden': true }, '2'), h('span', { className: 'dsh-mwr-option-label' }, t('recovery.sourceShort')), h('span', { className: 'dsh-mwr-arrow', 'aria-hidden': true }, '›')))),
      h('details', null, h('summary', null, t('recovery.details')),
        h('p', null, h('code', null, state.expectedBranch)),
        h('p', null, t('recovery.current'), ' ', h('code', null, state.actualCwd)),
        h('p', null, t('recovery.lostShort'))),
      confirm === 'source' ? h('div', { className: 'dsh-mwr-confirm' },
        h('p', { className: 'dsh-mwr-warning' }, t('recovery.sourceWarning')),
        h('p', null, h('code', null, state.sourceCwd), ' · ', state.sourceBranch),
        h('div', { className: 'dsh-mwr-actions' }, h('button', { type: 'button', disabled: busy, onClick: () => choose('source') }, t('recovery.confirmSource')), h('button', { type: 'button', disabled: busy, onClick: () => setConfirm('') }, t('recovery.cancel'))))
        : confirm === 'commit' ? h('div', { className: 'dsh-mwr-confirm' },
          h('p', { className: 'dsh-mwr-warning' }, t('recovery.branchMissing')),
          h('p', null, h('code', null, state.candidateCommit)),
          h('div', { className: 'dsh-mwr-actions' }, h('button', { type: 'button', disabled: busy || !state.candidateCommit, onClick: () => choose('rebuild') }, t('recovery.confirmCommit')), h('button', { type: 'button', disabled: busy, onClick: () => setConfirm('') }, t('recovery.cancel'))))
          : null,
      error && h('p', { className: 'dsh-mwr-error', role: 'alert' }, error));
  }
  return { install() {
    ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'dsh-minimalist-worktree.recovery', order: -10 }, Recovery));
  } };
}
