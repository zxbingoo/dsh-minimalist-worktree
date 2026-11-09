import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRecoveryUI } from '../src/recovery-client.js';
test('recommendation badge has visible shape and uses only inherited live theme colors', async () => {
 const source = await readFile(new URL('../src/recovery-client.js', import.meta.url), 'utf8');
 const css = source.match(/\.dsh-mwr-recommended\{([^}]+)\}/)[1];
 assert.ok(css.includes('border:1px solid var(--dsw-alias-border-l2,currentColor)'));
 assert.ok(css.includes('background:var(--dsw-alias-bg-layer-2,transparent)'));
 assert.ok(css.includes('color:var(--dsw-alias-label-primary,inherit)'));
 assert.ok(css.includes('font-weight:600'));
 assert.ok(!/#[0-9a-f]{3,8}|rgba?\(/i.test(css));
 assert.ok(!source.includes("require('@deepseek-ai/dsh-client-ui-primitives')"));
});
test('recovery notice is additive, no original header or chat replacement', () => {
 const calls = []; const ctx = { slots: { inject: (name, fn) => { calls.push(name); return fn(); }, register: options => calls.push(options) } };
 createRecoveryUI({}, ctx, key => key).install(); assert.equal(calls[0], 'conversation.input.dock'); assert.equal(calls[1].id, 'dsh-minimalist-worktree.recovery');
});
test('source confirmation and fallback commit are explicit, no auto-resubmit or default mutation', async () => {
 const s = await readFile(new URL('../src/recovery-client.js', import.meta.url), 'utf8');
 assert.ok(s.includes("confirm === 'source'")); assert.ok(s.includes('confirmSource: true')); assert.ok(s.includes('confirmCommit: state.candidateCommit'));
 assert.ok(s.includes("setConfirm('source')")); assert.ok(s.includes("setConfirm('commit')"));
 for (const forbidden of ['inputActions.submit', 'session/prompt', 'document.querySelector', 'window.confirm']) assert.ok(!s.includes(forbidden));
});
