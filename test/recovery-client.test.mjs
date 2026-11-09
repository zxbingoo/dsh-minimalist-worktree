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
test('overlapping focus inspections cannot restore an older recovery notice or error', async () => {
  const previousWindow = globalThis.window;
  const listeners = new Map(), pending = [], setters = [], effects = [];
  globalThis.window = { addEventListener: (key, fn) => listeners.set(key, fn), removeEventListener: key => listeners.delete(key) };
  const React = {
    createElement: () => null,
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
    useState: initial => { const cell = { value: initial }; setters.push(cell); return [initial, value => { cell.value = value; }]; },
    useEffect: fn => effects.push(fn),
  };
  let Component;
  const ctx = {
    locale: { getSnapshot: () => 'zh' }, connection: { generation: { getSnapshot: () => ({ id: 1 }) },
      rpc: { call: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) } },
    slots: { inject: (_name, fn) => fn(), register: (_options, component) => { Component = component; } },
  };
  let cleanup;
  try {
    createRecoveryUI(React, ctx, key => key).install();
    Component({ sessionId: 's', useAccess: () => true, useProjection: () => 0 });
    cleanup = effects[0]();
    const newer = listeners.get('focus')();
    pending[1].resolve({ ok: true, value: { blocked: false } }); await newer;
    pending[0].resolve({ ok: true, value: { blocked: true } });
    await Promise.resolve(); await Promise.resolve();
    assert.deepEqual(setters[0].value, { blocked: false });
    const oldFailure = listeners.get('focus')(), newest = listeners.get('focus')();
    pending[3].resolve({ ok: true, value: { blocked: false } }); await newest;
    pending[2].reject(new Error('stale error')); await oldFailure;
    assert.equal(setters[1].value, '');
    const afterUnmount = listeners.get('focus')(); cleanup(); cleanup = undefined;
    pending[4].resolve({ ok: true, value: { blocked: true } }); await afterUnmount;
    assert.deepEqual(setters[0].value, { blocked: false });
  } finally { cleanup?.(); globalThis.window = previousWindow; }
});
test('source confirmation and fallback commit are explicit, no auto-resubmit or default mutation', async () => {
 const s = await readFile(new URL('../src/recovery-client.js', import.meta.url), 'utf8');
 assert.ok(s.includes("confirm === 'source'")); assert.ok(s.includes('confirmSource: true')); assert.ok(s.includes('confirmCommit: state.candidateCommit'));
 assert.ok(s.includes("setConfirm('source')")); assert.ok(s.includes("setConfirm('commit')"));
 for (const forbidden of ['inputActions.submit', 'session/prompt', 'document.querySelector', 'window.confirm']) assert.ok(!s.includes(forbidden));
});
