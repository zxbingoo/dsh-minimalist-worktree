import { filePreviewType } from './file-preview.js';

const BROWSER_ENDPOINT = 'minimalistWorktree/browser';
const FILES_PANEL_KEY = '@deepseek-ai/dsh-client-ui-sidebar-files';
const NATIVE_TREE_OPTIONS = Object.freeze({ fallback: null });

export function browserChangeEntries(files, list = false) {
  const root = { dirs: new Map(), files: [] }, entries = [], mapping = new Map(), expanded = [];
  if (list) {
    for (const file of files) { const key = `file:${encodeURIComponent(file.path)}`; entries.push({ path: key, name: file.path, meta: { kind: 'file' } }); mapping.set(key, file); }
    return { entries, mapping, expanded };
  }
  for (const file of files) {
    const parts = file.path.split('/'); parts.pop(); let node = root;
    for (const part of parts) { if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] }); node = node.dirs.get(part); }
    node.files.push(file);
  }
  function visit(node, prefix) {
    for (const [part, initial] of node.dirs) {
      let name = part, child = initial;
      while (!child.files.length && child.dirs.size === 1) { const [next, nested] = [...child.dirs][0]; name += '/' + next; child = nested; }
      const key = prefix + 'dir:' + encodeURIComponent(name);
      entries.push({ path: key, name, meta: { kind: 'directory' } }); expanded.push(key); visit(child, key + '/');
    }
    for (const file of node.files) { const name = file.path.split('/').at(-1), key = prefix + 'file:' + encodeURIComponent(name); entries.push({ path: key, name, meta: { kind: 'file' } }); mapping.set(key, file); }
  }
  visit(root, ''); return { entries, mapping, expanded };
}

export function browserGitMode(discovery) {
  return discovery?.kind === 'none' ? 'none' : discovery?.kind === 'git' ? 'git' : 'unknown';
}

export function browserVisibleReason(reason) {
  return String(reason ?? '').split(/\r?\n/).filter(line => !/^Line totals exclude unread untracked files\.?$/.test(line.trim())).join('\n').trim();
}

export function browserRepositoryIsClean(repository, summary) {
  const data = summary?.value;
  return repository.initialized !== false && summary?.phase === 'ready' && data?.repositoryInfo?.kind === 'git'
    && Array.isArray(data.files) && data.files.length === 0 && !data.limited && !data.reason;
}

export function pairBrowserDiffRows(rows) {
  const pairs = [];
  for (let i = 0; i < rows.length;) {
    const row = rows[i];
    if (row.kind === 'delete' || row.kind === 'add') {
      const old = [], next = [];
      while (i < rows.length && ['delete', 'add'].includes(rows[i].kind)) { (rows[i].kind === 'delete' ? old : next).push(rows[i++]); }
      for (let n = 0; n < Math.max(old.length, next.length); n++) pairs.push({ old: old[n] ?? null, next: next[n] ?? null });
    } else { pairs.push({ old: row, next: row }); i++; }
  }
  return pairs;
}

const BROWSER_CSS = `
.dsh-mwb{height:100%;max-height:100%;min-height:0;min-width:0;flex:1 1 0;overflow:hidden;contain:size;display:flex;flex-direction:column;color:var(--dsw-alias-label-primary);background:transparent;font:inherit;font-size:14px}
.dsh-mwb *{box-sizing:border-box}.dsh-mwb-header,.dsh-mwb-root,.dsh-mwb-branch,.dsh-mwb-tabs,.dsh-mwb-tools,.dsh-mwb-filehead,.dsh-mwb-footer,.dsh-mwb-nav>footer{flex-shrink:0}.dsh-mwb button,.dsh-mwb select,.dsh-mwb input{font:inherit;color:inherit}.dsh-mwb button{background:transparent;border:1px solid transparent;border-radius:6px;padding:4px 7px;cursor:pointer}.dsh-mwb button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.dsh-mwb button:disabled{opacity:.5;cursor:default}.dsh-mwb button:focus-visible,.dsh-mwb select:focus-visible,.dsh-mwb input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dsh-mwb-header{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 14px;min-height:45px;border-bottom:1px solid var(--dsw-alias-border-l1)}.dsh-mwb-header strong{font-weight:500;font-size:14px}.dsh-mwb-body{display:grid;grid-template-columns:minmax(180px,27%) minmax(0,1fr);grid-template-rows:minmax(0,1fr);flex:1 1 0;min-height:0;overflow:hidden}.dsh-mwb-nav{display:flex;flex-direction:column;min-height:0;overflow:hidden;min-width:0;border-inline-end:1px solid var(--dsw-alias-border-l1);background:transparent}
.dsh-mwb-root{padding:12px 12px 5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:500}.dsh-mwb-branch{color:var(--dsw-alias-label-secondary);font-size:12px;padding:0 12px 5px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.dsh-mwb-tabs{display:flex;gap:16px;border-bottom:1px solid var(--dsw-alias-border-l1);margin:0 10px}.dsh-mwb-tabs button{border-radius:0;padding:7px 0;border-bottom:2px solid transparent;color:var(--dsw-alias-label-secondary)}.dsh-mwb-tabs button[aria-selected=true]{border-bottom-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}
.dsh-mwb-tools{padding:8px;display:flex;gap:5px;align-items:center;flex-wrap:wrap}.dsh-mwb select,.dsh-mwb input{max-width:100%;min-width:0;border:1px solid var(--dsw-alias-border-l1);border-radius:5px;background:transparent;font-size:12px;padding:5px}.dsh-mwb-tools select{width:100%}.dsh-mwb-tools input{width:100%}.dsh-mwb-list{overflow:auto;overscroll-behavior:contain;flex:1 1 0;min-height:0;padding:0 5px 10px}.dsh-mwb-list ul{margin:0;padding:0;list-style:none}.dsh-mwb-row{display:flex!important;align-items:center;gap:5px;text-align:left;width:100%;min-height:29px;padding-block:3px!important;line-height:22px;gap:7px;border-radius:4px;font-size:13px!important}.dsh-mwb-row[aria-current=true]{background:var(--dsw-alias-interactive-bg-active)}.dsh-mwb-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsh-mwb-status{font-size:12px;color:var(--dsw-alias-state-success-primary)}.dsh-mwb-count{font-size:11px;white-space:nowrap;color:var(--dsw-alias-label-secondary)}.dsh-mwb-group{font-size:12px;color:var(--dsw-alias-label-secondary);padding:9px 6px 4px;font-weight:500}.dsh-mwb-note{font-size:12px;color:var(--dsw-alias-label-secondary);padding:8px 10px;overflow-wrap:anywhere}.dsh-mwb-error{color:var(--dsw-alias-state-error-primary);white-space:pre-wrap}.dsh-mwb-main{display:flex;flex-direction:column;min-height:0;min-width:0}.dsh-mwb-filehead{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;min-height:42px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}.dsh-mwb-filehead code{font:13px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}.dsh-mwb-filetools{display:flex;gap:3px;font-size:12px}.dsh-mwb-filetools button[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-active)}.dsh-mwb-content{flex:1 1 0;min-height:0;overflow:auto;overscroll-behavior:contain;background:transparent}
.dsh-mwb-table{border-collapse:collapse;min-width:100%;font:13px/26px ui-monospace,SFMono-Regular,Consolas,monospace;tab-size:4}.dsh-mwb-table td{padding:0;vertical-align:top;border:0}.dsh-mwb-ln{min-width:30px;width:30px;padding:0 8px!important;text-align:right;color:var(--dsw-alias-label-caption);user-select:none;border-inline-end:1px solid var(--dsw-alias-border-l1)!important}.dsh-mwb-code{white-space:pre;padding-inline:8px 16px!important;min-width:160px}.dsh-mwb-table td[data-kind=add]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent)}.dsh-mwb-table td[data-kind=delete]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent)}.dsh-mwb-table td[data-kind=hunk],.dsh-mwb-table td[data-kind=meta]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}.dsh-mwb-sign{display:inline-block;min-width:16px;user-select:none}.dsh-mwb-empty{padding:35px 20px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:14px;overflow-wrap:anywhere}.dsh-mwb-footer{padding:7px 12px;font-size:12px;color:var(--dsw-alias-label-secondary);border-top:1px solid var(--dsw-alias-border-l1)}
.dsh-mwb-chevron{width:16px;height:16px;flex:none;fill:none;stroke:var(--dsw-alias-label-tertiary);stroke-width:1.3;stroke-linecap:round;stroke-linejoin:round}.dsh-mwb-chevron[data-open=true]{transform:rotate(90deg)}
.dsh-mwb[data-tree=false] .dsh-mwb-body{grid-template-columns:minmax(0,1fr)}.dsh-mwb[data-tree=false] .dsh-mwb-nav{display:none}.dsh-mwb[data-wrap=true] .dsh-mwb-table{width:100%;table-layout:fixed}.dsh-mwb[data-wrap=true] .dsh-mwb-code{white-space:pre-wrap;overflow-wrap:anywhere;min-width:0}
.dsh-mwb-change-stats{display:inline-flex;align-items:center;gap:5px;padding-inline:5px;font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap}.dsh-mwb-change-type{font-size:10px;color:var(--dsw-alias-label-secondary)}.dsh-mwb-added{color:var(--dsw-alias-state-success-primary)}.dsh-mwb-deleted{color:var(--dsw-alias-state-error-primary)}
.dsh-mwb-view-switch{display:inline-flex;gap:1px;margin-inline-start:auto;padding:2px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-layer-2)}.dsh-mwb-view-switch button{display:grid;place-items:center;width:27px;height:25px;padding:4px;border-radius:5px;color:var(--dsw-alias-label-secondary)}.dsh-mwb-view-switch button[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}.dsh-mwb-view-switch svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:1.4;stroke-linecap:round;stroke-linejoin:round}
@media(max-width:640px){.dsh-mwb-body{grid-template-columns:165px minmax(0,1fr)}.dsh-mwb-count{display:none}.dsh-mwb-code{min-width:100px}}@media(prefers-reduced-motion:reduce){.dsh-mwb *{transition:none}}
`;

export function createBrowserUI(React, ctx, t, parsePatch, previewFactory) {
  const { Preview } = previewFactory(React);
  const h = React.createElement, { useState, useEffect, useMemo, useRef, useSyncExternalStore } = React;
  function ChangeTree({ slot, repository, files, selected, view, onOpen, list }) {
    const fileMap = useRef(new Map());
    const model = browserChangeEntries(files, list);
    fileMap.current = model.mapping;
    const [collapsedFolders, setCollapsedFolders] = useState(new Set());
    const options = useMemo(() => ({ fallback: null, slots: { accessory: function ChangeStats({ entry }) {
      const file = fileMap.current.get(entry.path);
      if (!file) return null;
      return h('span', { className: 'dsh-mwb-change-stats', title: t(`changes.status.${file.status}`) },
        h('span', { className: 'dsh-mwb-change-type', 'aria-label': t(`changes.status.${file.status}`) }, file.status === '?' ? 'A' : file.status),
        file.added !== null && h('span', { className: 'dsh-mwb-added' }, `+${file.added}`),
        file.deleted !== null && h('span', { className: 'dsh-mwb-deleted' }, `−${file.deleted}`),
        file.added === null && file.deleted === null && h('span', { className: 'dsh-mwb-change-type' }, t(file.binary ? 'browser.binaryCount' : 'browser.unknownCount')));
    } } }), []);
    const current = [...fileMap.current].find(([,file]) => selected?.repository === repository.id && selected.diffPath === file.path && view === 'diff')?.[0];
    return slot.renderFactorySlot('sidebar.files.tree', { root: '', entries: model.entries, expanded: model.expanded.filter(path => !collapsedFolders.has(path)), current,
      onToggle: entry => setCollapsedFolders(current => { const next = new Set(current); next.has(entry.path) ? next.delete(entry.path) : next.add(entry.path); return next; }),
      onOpen: entry => { const file = fileMap.current.get(entry.path); if (file) onOpen(repository, file); },
    }, options);
  }
  function Panel(slot) {
    useSyncExternalStore(fn => ctx.locale.subscribe(fn), () => ctx.locale.getSnapshot());
    const generation = useSyncExternalStore(fn => ctx.connection.generation.subscribe(fn), () => ctx.connection.generation.getSnapshot());
    const access = slot.useAccess(BROWSER_ENDPOINT);
    const projected = slot.useProjection('workingDirectory');
    const stored = slot.useSessions(s => s.byId[slot.sessionId]?.cwd);
    const cwd = typeof projected === 'string' ? projected : stored ?? '';
    const turn = slot.useProjection('dsh-minimalist-worktree.refresh');
    return h(Contents, { key: JSON.stringify([slot.sessionId, cwd, generation?.id, access]), slot, cwd, generation, access, turn });
  }
  function Contents({ slot, cwd, generation, access, turn }) {
    const [mode, setMode] = useState('files'), [scope, setScope] = useState('all'), [wrapLines, setWrapLines] = useState(true), [showTree, setShowTree] = useState(true);
    const [sourceOnly, setSourceOnly] = useState(false), [changeList, setChangeList] = useState(false), [changeFilter, setChangeFilter] = useState('');
    const [collapsedChanges, setCollapsedChanges] = useState(new Set());
    const [refresh, setRefresh] = useState(0), [selected, setSelected] = useState(null), [view, setView] = useState('file');
    const [repositories, setRepositories] = useState({ phase: 'loading', value: null, error: '' });
    const [summaries, setSummaries] = useState({}), [levels, setLevels] = useState({}), [expanded, setExpanded] = useState(new Set([''])), [filter, setFilter] = useState('');
    const [content, setContent] = useState({ phase: 'idle', value: null, error: '', key: '' });
    const levelsRef = useRef({}), requests = useRef(new Map()), revisionRef = useRef(`${refresh}:${turn}`), listRef = useRef(null);
    const contentRef = useRef(null), scrolls = useRef(new Map());
    const enabled = !!(access && generation && cwd);
    const gitMode = browserGitMode(repositories.value);
    const lastFile = useRef(null), lastChange = useRef(null);
    function selectMode(next) {
      setMode(next);
      setSelected(next === 'files' ? lastFile.current : lastChange.current);
      setView(next === 'files' ? 'file' : 'diff');
    }
    useEffect(() => { if (gitMode === 'none') selectMode('files'); }, [gitMode]);
    function call(request, signal) {
      return ctx.connection.rpc.call('/api', BROWSER_ENDPOINT, { args: { agentId: slot.sessionId, request } }, signal).then(response => {
        if (!response.ok) throw new Error(response.error?.message || t('browser.failed'));
        if (response.value.sessionId !== slot.sessionId || response.value.cwd !== cwd) throw new Error(t('browser.stale'));
        return response.value;
      });
    }
    useEffect(() => { const focus = () => setRefresh(x => x + 1); window.addEventListener('focus', focus); return () => window.removeEventListener('focus', focus); }, []);
    useEffect(() => {
      if (!enabled) return;
      const c = new AbortController(); setRepositories(current => ({ ...current, phase: current.value ? 'ready' : 'loading', error: '' }));
      call({ action: 'repositories' }, c.signal).then(value => { if (!c.signal.aborted) setRepositories({ phase: 'ready', value, error: '' }); })
        .catch(error => { if (!c.signal.aborted) setRepositories({ phase: 'error', value: null, error: error.message }); });
      return () => c.abort();
    }, [enabled, refresh, turn]);
    useEffect(() => {
      if (!enabled || !repositories.value) return;
      const c = new AbortController();
      for (const repository of repositories.value.repositories ?? []) {
        if (repository.initialized === false) continue;
        setSummaries(current => ({ ...current, [repository.id]: { ...current[repository.id], phase: current[repository.id]?.value ? 'ready' : 'loading' } }));
        call({ action: 'summary', repository: repository.id, scope }, c.signal)
          .then(value => { if (!c.signal.aborted) setSummaries(current => ({ ...current, [repository.id]: { phase: 'ready', value } })); })
          .catch(error => { if (!c.signal.aborted) setSummaries(current => ({ ...current, [repository.id]: { phase: 'error', error: error.message } })); });
      }
      return () => c.abort();
    }, [enabled, scope, repositories.value]);
    useEffect(() => () => { for (const request of requests.current.values()) request.controller.abort(); requests.current.clear(); }, []);
    useEffect(() => {
      if (!enabled || mode !== 'files') return;
      const revision = `${refresh}:${turn}`;
      const force = revisionRef.current !== revision;
      revisionRef.current = revision;
      for (const path of expanded) {
        const previous = requests.current.get(path);
        if (previous && !force) continue;
        if (!force && levelsRef.current[path]?.value) continue;
        previous?.controller.abort();
        const controller = new AbortController(), request = { controller };
        requests.current.set(path, request);
        const publish = value => { levelsRef.current = { ...levelsRef.current, [path]: value }; setLevels(levelsRef.current); };
        const retained = levelsRef.current[path]?.value;
        if (!retained) publish({ phase: 'loading', value: null });
        call({ action: 'list', path }, controller.signal).then(value => {
          if (!controller.signal.aborted && requests.current.get(path) === request) publish({ phase: 'ready', value });
        }).catch(error => {
          if (!controller.signal.aborted) publish({ phase: 'error', value: retained ?? null, error: error.message });
        }).finally(() => { if (requests.current.get(path) === request) requests.current.delete(path); });
      }
    }, [enabled, mode, expanded, refresh, turn]);
    useEffect(() => {
      if (!enabled || !selected) { setContent({ phase: 'idle', value: null, error: '' }); return; }
      const c = new AbortController();
      const key = JSON.stringify([selected, view, scope]);
      setContent(current => current.key === key && current.value ? { ...current, error: '' } : { phase: 'loading', value: null, error: '', key });
      const request = view === 'diff' ? { action: 'diff', repository: selected.repository ?? '', path: selected.diffPath ?? selected.path, scope } : { action: 'read', path: selected.path };
      call(request, c.signal).then(value => { if (!c.signal.aborted) setContent({ phase: 'ready', value, error: '', key }); })
        .catch(error => { if (!c.signal.aborted) setContent(current => ({ ...current, phase: 'error', error: error.message, key })); });
      return () => c.abort();
    }, [enabled, selected, view, scope, refresh, turn]);
    useEffect(() => {
      if (!selected || content.phase !== 'ready') return;
      const saved = scrolls.current.get(JSON.stringify([selected, view, scope, sourceOnly]));
      if (contentRef.current) { contentRef.current.scrollTop = saved?.top ?? 0; contentRef.current.scrollLeft = saved?.left ?? 0; }
    }, [selected, view, scope, sourceOnly, content.phase]);
    const choose = (file, nextView) => { if (nextView === 'file') lastFile.current = file; else lastChange.current = file; setSelected(file); setView(nextView); };
    function changeFor(path) {
      for (const repository of repositories.value?.repositories ?? []) {
        const file = summaries[repository.id]?.value?.files?.find(file => file.workspacePath === path);
        if (file) return { ...file, repository: repository.id, diffPath: file.path };
      }
      return null;
    }
    const rows = useMemo(() => parsePatch(content.value?.patch ?? '').rows, [content.value]);
    function nativeFiles() {
      const entries = [], directories = {};
      const base = cwd.replace(/[\\/]+$/, '').replace(/\\/g, '/');
      const absolute = relative => relative ? `${base}/${relative}` : base;
      for (const [path, level] of Object.entries(levels)) {
        const state = {};
        if (!level.value) { if (level.phase === 'loading') state.loading = true; else if (level.error) state.failure = level.error; }
        if (level.value?.limited) state.truncated = true;
        directories[absolute(path)] = state;
        for (const entry of level.value?.entries ?? []) {
          if (entry.type !== 'directory' && filter && !entry.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase())) continue;
          entries.push({ path: absolute(entry.path), name: entry.name, meta: { kind: entry.type, hidden: entry.name.startsWith('.'), size: entry.size ?? undefined } });
        }
      }
      return slot.renderFactorySlot('sidebar.files.tree', {
        root: base, entries, directories, expanded: [...expanded].map(absolute),
        current: selected?.path && view === 'file' ? absolute(selected.path) : undefined,
        onToggle: entry => { const path = entry.path.slice(base.length + 1); setExpanded(current => { const next = new Set(current); next.has(path) ? next.delete(path) : next.add(path); return next; }); },
        canOpen: entry => entry.meta?.kind === 'file',
        onOpen: entry => { const path = entry.path.slice(base.length + 1), change = changeFor(path); choose({ path, ...(change ? { diffPath: change.diffPath, repository: change.repository } : {}) }, 'file'); },
      }, NATIVE_TREE_OPTIONS);
    }
    function openChange(repository, file) {
      choose({ path: file.workspacePath, diffPath: file.path, repository: repository.id }, 'diff');
    }
    const changedCount = Object.values(summaries).reduce((total, item) => total + (item.value?.files?.length ?? 0), 0);
    function changedFiles() {
      if (repositories.error) return h('p', { className: 'dsh-mwb-note dsh-mwb-error' }, repositories.error);
      if (!repositories.value) return h('p', { className: 'dsh-mwb-note' }, t('browser.loading'));
      const all = repositories.value.repositories ?? [];
      const visible = all.filter(repository => {
        const summary = summaries[repository.id], data = summary?.value;
        if (browserRepositoryIsClean(repository, summary)) return false;
        if (repository.initialized === false || summary?.phase !== 'ready' || !data || browserVisibleReason(data.reason) || (data.limited && !data.reason)) return true;
        return data.files.some(file => !all.some(child => child.kind === 'submodule' && child.id === (repository.id ? `${repository.id}/${file.path}` : file.path)));
      });
      if (!visible.length) return h('p', { className: 'dsh-mwb-note' }, t('browser.clean'));
      return visible.map(repository => {
        const summary = summaries[repository.id], data = summary?.value;
        // Gitlink entries are version markers, not files. Child repository files
        // are already read independently and rendered directly in their own tree.
        const links = (data?.files ?? []).filter(file => all.some(child => child.kind === 'submodule' && child.id === (repository.id ? `${repository.id}/${file.path}` : file.path)));
        const files = (data?.files ?? []).filter(file => !links.includes(file) && (!changeFilter || file.path.toLocaleLowerCase().includes(changeFilter.toLocaleLowerCase())));
        if (summary?.phase === 'ready' && !files.length && !browserVisibleReason(data?.reason) && !data?.limited && repository.initialized !== false) return null;
        const open = !collapsedChanges.has(`repo:${repository.id}`);
        return h('div', { key: repository.id },
          h('button', { type: 'button', className: 'dsh-mwb-row dsh-mwb-group', 'aria-expanded': open,
            onClick: () => setCollapsedChanges(current => { const next = new Set(current), key = `repo:${repository.id}`; next.has(key) ? next.delete(key) : next.add(key); return next; }) },
            h('svg', { className: 'dsh-mwb-chevron', viewBox: '0 0 16 16', 'data-open': open, 'aria-hidden': true }, h('path', { d: 'M6 4l4 4-4 4' })), h('span', { className: 'dsh-mwb-name' }, repository.kind === 'root' ? t('browser.root') : repository.id)),
          open && (repository.initialized === false ? h('p', { className: 'dsh-mwb-note' }, repository.reason || t('browser.uninitialized'))
            : summary?.phase === 'error' ? h('p', { className: 'dsh-mwb-note dsh-mwb-error' }, summary.error)
              : !data ? h('p', { className: 'dsh-mwb-note' }, t('browser.loading'))
                : h(React.Fragment, null,
                  !files.length && !links.length && h('p', { className: 'dsh-mwb-note' }, data.reason || (data.repositoryInfo?.kind === 'git' ? t('browser.clean') : t('browser.previewUnavailable'))),
                  files.length > 0 && h(ChangeTree, { key: `${repository.id}:${scope}`, slot, repository, files, selected, view, onOpen: openChange, list: changeList }),
                  data.limited && (!data.reason || browserVisibleReason(data.reason)) && h('p', { className: 'dsh-mwb-note' }, browserVisibleReason(data.reason) || t('browser.limited')))));
      });
    }
    function cells(row, key) {
      return [h('td', { key: `${key}-old`, className: 'dsh-mwb-ln' }, row?.oldLine ?? ''), h('td', { key: `${key}-new`, className: 'dsh-mwb-ln' }, row?.newLine ?? ''),
        h('td', { key, className: 'dsh-mwb-code', 'data-kind': row?.kind }, h('span', { className: 'dsh-mwb-sign' }, row?.sign ?? ''), row?.text ?? '')];
    }
    let body;
    if (!enabled) body = h('div', { className: 'dsh-mwb-empty' }, t('browser.noAccess'));
    else if (!selected) body = h('div', { className: 'dsh-mwb-empty' }, t('browser.chooseFile'));
    else if (content.phase === 'loading') body = h('div', { className: 'dsh-mwb-empty' }, t('browser.loading'));
    else if (content.error) body = h('div', { className: 'dsh-mwb-empty dsh-mwb-error', role: 'alert' }, content.error);
    else if (view === 'diff' && content.value?.kind === 'text') body = h('table', { className: 'dsh-mwb-table', 'aria-label': t('browser.diff') },
      h('tbody', null, rows.map((row, i) => h('tr', { key: i }, cells(row, i)))));
    else if (view === 'file' && ['text', 'image'].includes(content.value?.kind)) body = h(Preview, { path: selected.path, text: content.value.text ?? '', kind: content.value.kind, imageData: content.value.imageData, sourceOnly });
    else body = h('div', { className: 'dsh-mwb-empty' }, content.value?.reason || t('browser.previewUnavailable'));
    const selectedStats = selected && summaries[selected.repository ?? '']?.value?.files?.find(file => file.path === selected.diffPath);
    const rootName = cwd.split(/[\\/]/).filter(Boolean).at(-1) || cwd;
    return h('section', { className: 'dsh-mwb', 'data-tree': showTree, 'data-wrap': wrapLines, 'aria-label': t('browser.title') }, h('style', null, BROWSER_CSS),
      h('header', { className: 'dsh-mwb-header' }, h('strong', null, t('browser.title')), h('div', null, h('button', { type: 'button', 'aria-expanded': showTree, onClick: () => setShowTree(value => !value) }, t(showTree ? 'browser.hideTree' : 'browser.showTree')), h('button', { type: 'button', onClick: () => setRefresh(x => x + 1), title: t('browser.refresh') }, '↻'))),
      h('div', { className: 'dsh-mwb-body' },
        h('nav', { className: 'dsh-mwb-nav', 'aria-label': t('browser.navigation') }, h('div', { className: 'dsh-mwb-root', title: cwd }, rootName),
          gitMode === 'git' && h('div', { className: 'dsh-mwb-branch' }, repositories.value?.repositories?.[0]?.branch || ''),
          h('div', { className: 'dsh-mwb-tabs', role: 'tablist', 'aria-label': t('browser.navigation') }, (gitMode === 'none' ? ['files'] : ['files', 'changes']).map(tab => h('button', { key: tab, type: 'button', role: 'tab', 'aria-selected': mode === tab, onClick: () => selectMode(tab) }, t(`browser.${tab}`)))),
          h('div', { className: 'dsh-mwb-tools' }, mode === 'changes' ? h('select', { value: scope, 'aria-label': t('browser.scope'), onChange: e => setScope(e.target.value) }, ['all', 'unstaged', 'staged'].map(s => h('option', { key: s, value: s }, t(`changes.scope.${s}`))))
            : h('input', { value: filter, 'aria-label': t('browser.search'), placeholder: t('browser.search'), onChange: e => setFilter(e.target.value) })),
          mode === 'changes' && h('div', { className: 'dsh-mwb-tools' }, h('span', null, `${t('browser.files')} ${changedCount}`),
            h('div', { className: 'dsh-mwb-view-switch', role: 'group', 'aria-label': t('browser.navigation') },
              h('button', { type: 'button', title: t('browser.listView'), 'aria-label': t('browser.listView'), 'aria-pressed': changeList, onClick: () => setChangeList(true) }, h('svg', { viewBox: '0 0 16 16', 'aria-hidden': true }, h('path', { d: 'M5 4h8M5 8h8M5 12h8M2 4h.01M2 8h.01M2 12h.01' }))),
              h('button', { type: 'button', title: t('browser.treeView'), 'aria-label': t('browser.treeView'), 'aria-pressed': !changeList, onClick: () => setChangeList(false) }, h('svg', { viewBox: '0 0 16 16', 'aria-hidden': true }, h('path', { d: 'M3 2v10h3M3 6h3M7 4h6v4H7zM7 10h6v4H7z' })))),
            h('input', { value: changeFilter, placeholder: t('browser.changeSearch'), 'aria-label': t('browser.changeSearch'), onChange: event => setChangeFilter(event.target.value) })),
          h('div', { className: 'dsh-mwb-list', ref: listRef }, mode === 'files' ? nativeFiles() : changedFiles()),
          gitMode !== 'none' && h('footer', { className: 'dsh-mwb-note' }, t('browser.allEdits'))),
        h('div', { className: 'dsh-mwb-main' }, h('header', { className: 'dsh-mwb-filehead' }, h('code', null, selected?.path ?? selected?.diffPath ?? ''),
          h('div', { className: 'dsh-mwb-filetools' },
            view === 'diff' && selectedStats && h('span', { className: 'dsh-mwb-change-stats' }, selectedStats.added !== null && h('span', { className: 'dsh-mwb-added' }, `+${selectedStats.added}`), selectedStats.deleted !== null && h('span', { className: 'dsh-mwb-deleted' }, `−${selectedStats.deleted}`)),
            view === 'file' && content.value?.kind === 'text' && ['markdown', 'json', 'csv'].includes(filePreviewType(selected?.path)) && ['preview', 'source'].map(option => h('button', { key: option, type: 'button', 'aria-pressed': sourceOnly === (option === 'source'), onClick: () => setSourceOnly(option === 'source') }, t(`browser.${option}`))),
            view === 'diff' && h('button', { type: 'button', 'aria-pressed': wrapLines, onClick: () => setWrapLines(value => !value) }, t('browser.wrap')))),
          h('div', { className: 'dsh-mwb-content', ref: contentRef, onScroll: event => { if (selected) scrolls.current.set(JSON.stringify([selected, view, scope, sourceOnly]), { top: event.currentTarget.scrollTop, left: event.currentTarget.scrollLeft }); } }, body), h('footer', { className: 'dsh-mwb-footer' }, t(gitMode === 'none' ? 'browser.readOnlyFile' : 'browser.readOnly')))));
  }
  return { install() {
    ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: FILES_PANEL_KEY, priority: -10 }, Panel));
  } };
}
