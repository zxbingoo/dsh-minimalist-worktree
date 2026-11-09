import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { filePreviewType, filePreviewLink, parsePreviewInline, parsePreviewMarkdown, parsePreviewCsv, previewRasterImage } from '../src/file-preview.js';

test('preview types classify Markdown raster SVG structured code and plain text by extension', () => {
  for (const [path,type] of [['docs/README.MD','markdown'],['image.PNG','image'],['photo.jpeg','image'],['chart.svg','svg'],['a.tsx','code'],['config.JSON','json'],['report.csv','csv'],['a.tsv','csv'],['notes.txt','text']]) assert.equal(filePreviewType(path),type,path);
});
test('Markdown parses headings paragraphs lists fenced code tables and blockquotes into declarative AST', () => {
  const value = parsePreviewMarkdown('# Heading\n\nA **bold** paragraph with `code`.\n\n- item one\n- item two\n\n1. first\n2. second\n\n> quoted text\n\n```js\nconst a = "<script>";\n```\n\n| Name | Value |\n| --- | --- |\n| item | 42 |\n\n---');
  assert.deepEqual(value.blocks.map(block=>block.type),['heading','paragraph','list','list','quote','code','table','rule']);
  assert.equal(value.blocks[0].level,1);assert.equal(value.blocks[2].ordered,false);assert.equal(value.blocks[3].ordered,true);
  assert.equal(value.blocks[5].text,'const a = "<script>";'); assert.equal(value.blocks[6].rows.length,1);assert.equal(value.limited,false);
});
test('raw HTML and SVG remain literal text; Markdown image never retains a remote source', () => {
  const parsed = parsePreviewMarkdown('<img src=x onerror=alert(1)>\n\n<svg onload=alert(1)>');
  assert.equal(parsed.blocks[0].inline[0].type,'text');assert.match(parsed.blocks[0].inline[0].text,/<img/);
  const images = parsePreviewInline('![secret](https://example.invalid/tracker.png) ![evil](data:image/svg+xml,payload)');
  assert.equal(images.filter(x=>x.type==='image-label').length,2);assert.ok(!JSON.stringify(images).includes('https:'));assert.ok(!JSON.stringify(images).includes('data:'));
});
test('only explicit valid HTTP(S) links become anchors, credentials and control characters rejected', () => {
  assert.equal(filePreviewLink('https://example.com/a?q=b'),'https://example.com/a?q=b');
  for(const href of ['javascript:alert(1)','data:text/html,x','file:///etc/passwd','//example.com','/relative','https://user:secret@example.com','https://example.com/\nattack']) assert.equal(filePreviewLink(href),null,href);
  const nodes=parsePreviewInline('[safe](https://example.com) [bad](javascript:alert) [local](file:///secret)');
  assert.equal(nodes.filter(x=>x.type==='link').length,1);assert.ok(nodes.some(x=>x.type==='text'&&x.text==='bad'));
});
test('Markdown parser is bounded and does not recursively parse deeply nested control syntax', () => {
  const parsed=parsePreviewMarkdown('line\n'.repeat(10002));assert.equal(parsed.limited,true);assert.equal(parsed.blocks.length,1);
  assert.equal(parsePreviewMarkdown('x'.repeat(1024*1024+1)).limited,true);
  const table='| A | B |\n| --- | --- |\n'+'| x | y |\n'.repeat(300);assert.equal(parsePreviewMarkdown(table).blocks[0].rows.length,200);
});
test('CSV preserves quoted delimiters newlines and double quotes, bounds rows and columns', () => {
  const result=parsePreviewCsv('name,value\n"a,b","line\nsecond"\n"a""quote",42\n');
  assert.deepEqual(result.rows,[['name','value'],['a,b','line\nsecond'],['a"quote','42']]);assert.equal(result.malformed,false);
  assert.equal(parsePreviewCsv('x\n'.repeat(300)).rows.length,200);assert.equal(parsePreviewCsv('x\n'.repeat(300)).limited,true);
  assert.equal(parsePreviewCsv(Array.from({length:70},(_,i)=>i).join(',')).rows[0].length,50);
  assert.equal(parsePreviewCsv('a\tb','\t').rows[0][1],'b');assert.equal(parsePreviewCsv('"unclosed').malformed,true);
});
test('raster image source requires allowed MIME, valid signature and never supports SVG HTML or remote URLs', () => {
  const png='data:image/png;base64,'+Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]).toString('base64');assert.equal(previewRasterImage(png),png);
  const gif='data:image/gif;base64,'+Buffer.from('GIF89aheader').toString('base64');assert.equal(previewRasterImage(gif),gif);
  for(const value of ['https://example.com/x.png','data:image/svg+xml;base64,PHN2Zz4=','data:text/html;base64,PHN2Zz4=','data:image/png;base64,PHN2Zz4=','data:image/png,<svg>']) assert.equal(previewRasterImage(value),null);
});
test('rendering source has no raw HTML execution, external imports, palette literals or dynamic script tags', async () => {
  const source=await readFile(new URL('../src/file-preview.js',import.meta.url),'utf8');
  for(const forbidden of ['dangerouslySetInnerHTML','innerHTML','eval(','createElement(\'script\'','import ']) assert.ok(!source.includes(forbidden));
  const css=source.slice(source.indexOf('const MWPREVIEW_CSS'),source.indexOf('export function createFilePreview'));
  assert.ok(!/#[a-f0-9]{3,8}\b|rgba?\(/i.test(css));assert.ok(css.includes('--dsw-alias-label-primary'));assert.ok(css.includes('--dsw-alias-bg-layer-1'));
});
