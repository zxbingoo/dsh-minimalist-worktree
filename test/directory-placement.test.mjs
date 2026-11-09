import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/changes-client.js', import.meta.url), 'utf8');
test('native hover shell theme bridge is restricted to this plugin card and uses live theme tokens', () => {
  const bridge = source.slice(source.indexOf('div[class*="_card"]'), source.indexOf('.dsh-mwc-hover-row'));
  assert.ok(bridge.includes(':has(.dsh-mwc-session-hover)'));
  assert.ok(bridge.includes('--dsw-hovercard-bg:var(--dsw-alias-bg-overlay)'));
  for (const token of ['bg-overlay', 'label-primary', 'label-secondary', 'border-l1']) assert.ok(bridge.includes(`--dsw-alias-${token}`));
  assert.ok(!/#[0-9a-f]{3,8}\b|rgba?\(/i.test(bridge));
});
test('directory lives in the native Session row hover card, never header, hero or composer', () => {
  assert.ok(source.includes("ctx.slots.inject('sidebar.session.row.hover'"));
  for (const slot of ['conversation.session.header.actions', 'conversation.hero.options', 'conversation.input.dock']) {
    assert.ok(!source.includes(`ctx.slots.inject('${slot}'`));
  }
  assert.ok(source.includes("ctx.slots.inject('conversation.view'"));
});
test('hover content is read-only, addressed to the hovered Session, and shows branch plus actual directory', () => {
  const hover = source.slice(source.indexOf('  function SessionHover('), source.indexOf('  function Patch('));
  assert.ok(hover.includes('state.byId[slot.sessionId]?.cwd'));
  assert.ok(hover.includes('useSessionAccess(slot.sessionId, CHANGES_ENDPOINT)'));
  assert.ok(hover.includes('sessionId: slot.sessionId'));
  assert.ok(hover.includes('data.repository.branch'));
  assert.ok(hover.includes('data?.cwd || cwd'));
  assert.ok(hover.includes("t('changes.unavailable')"));
  for (const forbidden of ['clipboard', 'onClick', "h('button'", "h('dialog'", 'useProjection(']) assert.ok(!hover.includes(forbidden));
  assert.ok(!source.includes('clipboard.writeText'));
});
