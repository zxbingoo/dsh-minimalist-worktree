const MWPREVIEW_MAX_LINES = 10000;
const MWPREVIEW_MAX_TEXT = 1024 * 1024;

export function filePreviewType(path) {
  const ext = String(path ?? '').split(/[\\/]/).at(-1).split('.').at(-1).toLowerCase();
  if (['md', 'markdown', 'mdown', 'mdx'].includes(ext)) return 'markdown';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext)) return 'image';
  if (ext === 'svg') return 'svg';
  if (['json', 'jsonc', 'jsonl'].includes(ext)) return 'json';
  if (['csv', 'tsv'].includes(ext)) return 'csv';
  if (['js','jsx','mjs','cjs','ts','tsx','py','java','kt','kts','rs','go','c','h','cpp','hpp','cs','swift','rb','php','sh','bash','zsh','ps1','sql','html','htm','xml','css','scss','less','vue','svelte','yaml','yml','toml','ini','conf','properties','gradle','dockerfile'].includes(ext)) return 'code';
  return 'text';
}

export function filePreviewLink(value) {
  const href = String(value ?? '').trim();
  if (!/^https?:\/\//i.test(href) || /[\u0000-\u0020\u007f]/.test(href)) return null;
  try { const url = new URL(href); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
}

/** Bounded nonrecursive inline AST. Raw HTML always remains a text node. */
export function parsePreviewInline(text) {
  const source = String(text ?? '').slice(0, MWPREVIEW_MAX_TEXT), nodes = [];
  const pattern = /!\[([^\]\n]*)\]\(([^)\n]*)\)|\[([^\]\n]+)\]\(([^)\n]*)\)|`([^`\n]+)`|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|~~([^~\n]+)~~/g;
  let last = 0, match;
  while ((match = pattern.exec(source))) {
    if (match.index > last) nodes.push({ type: 'text', text: source.slice(last, match.index) });
    if (match[1] !== undefined) nodes.push({ type: 'image-label', text: match[1] || 'Image' });
    else if (match[3] !== undefined) {
      const href = filePreviewLink(match[4]);
      nodes.push(href ? { type: 'link', text: match[3], href } : { type: 'text', text: match[3] });
    } else if (match[5] !== undefined) nodes.push({ type: 'code', text: match[5] });
    else if (match[6] !== undefined || match[7] !== undefined) nodes.push({ type: 'strong', text: match[6] ?? match[7] });
    else if (match[8] !== undefined) nodes.push({ type: 'em', text: match[8] });
    else nodes.push({ type: 'del', text: match[9] });
    last = pattern.lastIndex;
  }
  if (last < source.length) nodes.push({ type: 'text', text: source.slice(last) });
  return nodes;
}

function previewTableCells(line) {
  const value = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return value.split(/(?<!\\)\|/).slice(0, 50).map(cell => cell.trim().replace(/\\\|/g, '|'));
}

export function parsePreviewMarkdown(text) {
  const raw = String(text ?? ''), bounded = raw.slice(0, MWPREVIEW_MAX_TEXT);
  const all = bounded.replace(/\r\n?/g, '\n').split('\n'), lines = all.slice(0, MWPREVIEW_MAX_LINES);
  const blocks = []; let tableLimited = false;
  const tableSeparator = line => /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
  const begins = (line, index) => !line.trim() || /^\s*(`{3,}|~{3,})|^#{1,6}\s|^\s*>|^\s*[-*+]\s|^\s*\d+[.)]\s|^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line) || (line.includes('|') && tableSeparator(lines[index + 1] || ''));
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      const content = [], marker = fence[1][0], length = fence[1].length; i++;
      while (i < lines.length && !new RegExp(`^\\s*${marker}{${length},}\\s*$`).test(lines[i])) content.push(lines[i++]);
      if (i < lines.length) i++;
      blocks.push({ type: 'code', language: fence[2].trim().slice(0, 40), text: content.join('\n') }); continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) { blocks.push({ type: 'heading', level: heading[1].length, inline: parsePreviewInline(heading[2].replace(/\s+#+\s*$/, '')) }); i++; continue; }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { blocks.push({ type: 'rule' }); i++; continue; }
    if (line.includes('|') && tableSeparator(lines[i + 1] || '')) {
      const headers = previewTableCells(line).map(parsePreviewInline), rows = []; i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        if (rows.length < 200) rows.push(previewTableCells(lines[i]).slice(0, headers.length).map(parsePreviewInline));
        else tableLimited = true;
        i++;
      }
      blocks.push({ type: 'table', headers, rows }); continue;
    }
    if (/^\s*>/.test(line)) {
      const content = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) content.push(lines[i++].replace(/^\s*>\s?/, ''));
      blocks.push({ type: 'quote', inline: parsePreviewInline(content.join('\n')) }); continue;
    }
    const list = /^\s*(?:([-*+])|(\d+)[.)])\s+(.+)$/.exec(line);
    if (list) {
      const ordered = !!list[2], items = [];
      while (i < lines.length) {
        const item = /^\s*(?:([-*+])|(\d+)[.)])\s+(.+)$/.exec(lines[i]);
        if (!item || !!item[2] !== ordered) break;
        items.push(parsePreviewInline(item[3])); i++;
      }
      blocks.push({ type: 'list', ordered, items }); continue;
    }
    const paragraph = [line]; i++;
    while (i < lines.length && !begins(lines[i], i)) paragraph.push(lines[i++]);
    blocks.push({ type: 'paragraph', inline: parsePreviewInline(paragraph.join('\n')) });
  }
  return { blocks, limited: tableLimited || raw.length > MWPREVIEW_MAX_TEXT || all.length > MWPREVIEW_MAX_LINES };
}

export function parsePreviewCsv(text, separator = ',') {
  const raw = String(text ?? ''), source = raw.slice(0, MWPREVIEW_MAX_TEXT), rows = [];
  let row = [], cell = '', quoted = false, limited = raw.length > MWPREVIEW_MAX_TEXT;
  function finishCell() { if (row.length < 50) row.push(cell); else limited = true; cell = ''; }
  function finishRow() { finishCell(); if (rows.length < 200) rows.push(row); else limited = true; row = []; }
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '"') {
      if (quoted && source[i + 1] === '"') { cell += '"'; i++; }
      else if (quoted || !cell) quoted = !quoted;
      else cell += char;
    } else if (char === separator && !quoted) finishCell();
    else if ((char === '\n' || char === '\r') && !quoted) { if (char === '\r' && source[i + 1] === '\n') i++; finishRow(); }
    else cell += char;
    if (rows.length >= 200 && i < source.length - 1) { limited = true; break; }
  }
  if (cell || row.length || !rows.length) finishRow();
  return { rows, limited, malformed: quoted };
}

export function previewRasterImage(value) {
  if (typeof value !== 'string' || value.length > 12 * 1024 * 1024) return null;
  const match = /^data:image\/(png|jpeg|gif|webp|bmp);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(value);
  if (!match) return null;
  let bytes;
  try { bytes = atob(match[2].slice(0, 64)); } catch { return null; }
  const mime = match[1].toLowerCase(), byte = index => bytes.charCodeAt(index);
  const valid = mime === 'png' ? [137,80,78,71,13,10,26,10].every((x,i) => byte(i) === x)
    : mime === 'jpeg' ? byte(0) === 255 && byte(1) === 216 && byte(2) === 255
      : mime === 'gif' ? /^GIF8[79]a/.test(bytes)
        : mime === 'webp' ? bytes.slice(0,4) === 'RIFF' && bytes.slice(8,12) === 'WEBP'
          : bytes.startsWith('BM');
  return valid ? value : null;
}

const MWPREVIEW_CSS = `
.dsh-mwpreview{color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:1.8;min-width:0}
.dsh-mwpreview-document{padding:22px 28px;max-width:1000px;margin:0 auto;overflow-wrap:anywhere}
.dsh-mwpreview h1,.dsh-mwpreview h2,.dsh-mwpreview h3,.dsh-mwpreview h4,.dsh-mwpreview h5,.dsh-mwpreview h6{font-weight:600;line-height:1.4;margin:1.25em 0 .6em}.dsh-mwpreview h1{font-size:1.8em}.dsh-mwpreview h2{font-size:1.5em;border-bottom:1px solid var(--dsw-alias-border-l1);padding-bottom:.3em}.dsh-mwpreview h3{font-size:1.2em}
.dsh-mwpreview p{margin:.7em 0;white-space:pre-wrap}.dsh-mwpreview ul,.dsh-mwpreview ol{padding-inline-start:24px;margin:.7em 0}.dsh-mwpreview li{margin:.25em 0}.dsh-mwpreview a{color:var(--dsw-alias-brand-primary);text-decoration:underline;text-underline-offset:2px}
.dsh-mwpreview blockquote{border-inline-start:3px solid var(--dsw-alias-border-l2);margin:1em 0;padding:2px 16px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap}.dsh-mwpreview hr{border:0;border-top:1px solid var(--dsw-alias-border-l1);margin:20px 0}
.dsh-mwpreview code,.dsh-mwpreview pre{font:13px/1.8 ui-monospace,SFMono-Regular,Consolas,monospace;tab-size:4}.dsh-mwpreview :not(pre)>code{padding:2px 5px;border-radius:4px;background:var(--dsw-alias-bg-layer-2)}.dsh-mwpreview pre{margin:0;white-space:pre;overflow:auto;padding:16px;background:var(--dsw-alias-bg-layer-1)}.dsh-mwpreview-document pre{border:1px solid var(--dsw-alias-border-l1);border-radius:7px;margin:12px 0}
.dsh-mwpreview-tablewrap{max-width:100%;overflow:auto}.dsh-mwpreview table{border-collapse:collapse;min-width:50%;font-size:13px;margin:12px 0}.dsh-mwpreview th,.dsh-mwpreview td{padding:7px 12px;border:1px solid var(--dsw-alias-border-l1);text-align:start;vertical-align:top;white-space:pre-wrap}.dsh-mwpreview th{background:var(--dsw-alias-bg-layer-2);font-weight:500}
.dsh-mwpreview-note{padding:8px 16px;color:var(--dsw-alias-label-secondary);font-size:11px}.dsh-mwpreview-image{display:flex;align-items:center;justify-content:center;padding:20px;min-height:150px}.dsh-mwpreview-image img{display:block;max-width:100%;height:auto;object-fit:contain}.dsh-mwpreview-image-label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsh-mwpreview-icon{display:inline-flex;position:relative;align-items:center;justify-content:center;flex:none;width:21px;height:22px;color:var(--dsw-alias-label-secondary)}.dsh-mwpreview-icon svg{width:17px;height:20px;fill:none;stroke:currentColor;stroke-width:1.4;stroke-linecap:round;stroke-linejoin:round}.dsh-mwpreview-icon-label{position:absolute;bottom:0;inset-inline-end:-2px;border-radius:2px;padding:0 2px;background:var(--dsw-alias-bg-layer-1);font:600 7px/10px ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--dsw-alias-brand-primary)}
`;

export function createFilePreview(React) {
  const h = React.createElement;
  function FileIcon({ path, size = 16 }) {
    const type = filePreviewType(path);
    const color = ['markdown', 'code'].includes(type) ? 'var(--dsw-alias-brand-primary)' : ['json', 'csv'].includes(type) ? 'var(--dsw-alias-state-warn-primary,var(--dsw-alias-label-secondary))' : 'var(--dsw-alias-label-secondary)';
    const paths = type === 'markdown' ? ['M2 12V5h3l2 4 2-4h3v7', 'M14 8v5m-2-2 2 2 2-2']
      : type === 'json' || type === 'csv' ? ['M6 2H4v5l-2 1 2 1v5h2', 'M10 2h2v5l2 1-2 1v5h-2']
        : type === 'image' || type === 'svg' ? ['M2 2h12v12H2z', 'M2 11l4-4 3 3 2-2 3 3', 'M10 5h.01']
          : type === 'code' ? ['M5 4L1 8l4 4', 'M11 4l4 4-4 4', 'M9 2L7 14']
            : ['M3 1h6l4 4v10H3z', 'M9 1v5h4'];
    return h('span', { className: 'dsh-mwpreview-icon', style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: 'none', width: size, height: size, color }, 'aria-hidden': true },
      h('svg', { viewBox: '0 0 16 16', style: { width: size, height: size, fill: 'none', stroke: 'currentColor', strokeWidth: 1.25, strokeLinecap: 'round', strokeLinejoin: 'round' } }, paths.map((d, i) => h('path', { key: i, d }))));
  }
  function inline(nodes) {
    return nodes.map((node, i) => node.type === 'text' ? node.text : node.type === 'link'
      ? h('a', { key: i, href: node.href, target: '_blank', rel: 'noopener noreferrer', referrerPolicy: 'no-referrer' }, node.text)
      : node.type === 'image-label' ? h('span', { key: i, className: 'dsh-mwpreview-image-label' }, `[${node.text}]`)
        : h(node.type, { key: i }, node.text));
  }
  function table(rows, headers) {
    return h('div', { className: 'dsh-mwpreview-tablewrap' }, h('table', null,
      headers && h('thead', null, h('tr', null, headers.map((cells,i) => h('th', { key:i }, inline(cells))))),
      h('tbody', null, rows.map((row,i) => h('tr', { key:i }, row.map((cell,j) => h('td', { key:j }, Array.isArray(cell) ? inline(cell) : cell)))))));
  }
  function Preview({ path = '', text = '', kind, imageData, sourceOnly = false }) {
    const type = filePreviewType(path), source = String(text ?? '').slice(0, MWPREVIEW_MAX_TEXT);
    let body;
    if (sourceOnly && kind === 'text') body = h('pre', { tabIndex: 0 }, h('code', null, source));
    else if (type === 'image') {
      const data = previewRasterImage(imageData);
      body = data ? h('div', { className: 'dsh-mwpreview-image' }, h('img', { src: data, alt: String(path).split(/[\\/]/).at(-1), loading: 'lazy', referrerPolicy: 'no-referrer' }))
        : h('p', { className: 'dsh-mwpreview-note' }, 'Image preview unavailable.');
    } else if (kind && kind !== 'text') body = h('p', { className: 'dsh-mwpreview-note' }, 'File preview unavailable.');
    else if (type === 'markdown') {
      const parsed = parsePreviewMarkdown(source);
      body = h('article', { className: 'dsh-mwpreview-document' }, parsed.blocks.map((block,i) => {
        const props = { key: i };
        if (block.type === 'heading') return h(`h${block.level}`, props, inline(block.inline));
        if (block.type === 'paragraph') return h('p', props, inline(block.inline));
        if (block.type === 'quote') return h('blockquote', props, inline(block.inline));
        if (block.type === 'rule') return h('hr', props);
        if (block.type === 'code') return h('pre', props, h('code', null, block.text));
        if (block.type === 'list') return h(block.ordered ? 'ol' : 'ul', props, block.items.map((item,j) => h('li', { key: j }, inline(item))));
        return h('div', props, table(block.rows, block.headers));
      }), parsed.limited && h('p', { className: 'dsh-mwpreview-note' }, 'Preview limit reached.'));
    } else if (type === 'csv') {
      const parsed = parsePreviewCsv(source, String(path).toLowerCase().endsWith('.tsv') ? '\t' : ',');
      body = h('div', { className: 'dsh-mwpreview-document' }, table(parsed.rows), (parsed.limited || parsed.malformed) && h('p', { className: 'dsh-mwpreview-note' }, parsed.malformed ? 'Unclosed quoted field; showing a bounded preview.' : 'Preview limited to 200 rows and 50 columns.'));
    } else {
      let formatted = source;
      if (type === 'json') { try { formatted = JSON.stringify(JSON.parse(source), null, 2).slice(0, MWPREVIEW_MAX_TEXT); } catch {} }
      const lines = formatted.split('\n');
      body = h(React.Fragment, null, h('pre', { tabIndex: 0 }, h('code', null, lines.slice(0, MWPREVIEW_MAX_LINES).join('\n'))),
        (type === 'svg') && h('p', { className: 'dsh-mwpreview-note' }, 'SVG source only; active content is not executed.'),
        lines.length > MWPREVIEW_MAX_LINES && h('p', { className: 'dsh-mwpreview-note' }, 'Preview limit reached.'));
    }
    return h('div', { className: 'dsh-mwpreview' }, h('style', null, MWPREVIEW_CSS), body);
  }
  return { FileIcon, Preview };
}
