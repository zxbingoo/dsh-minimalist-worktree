import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldShowWorktreePickers } from '../src/client.js';

// Test the pure visibility policy, not a simulated React tree or visual preview.
test('hide both pickers until repository inspection completes', () => {
  for (const snapshot of [null, undefined, {}, { repository: {} }]) {
    assert.equal(shouldShowWorktreePickers(snapshot), false);
  }
});

test('confirmed non-Git workspace hides both pickers, including a stale saved choice', () => {
  for (const selection of [null, { mode: 'local' }, { mode: 'worktree', status: 'staged' }]) {
    assert.equal(shouldShowWorktreePickers({ selection, repository: { kind: 'none', available: false } }), false);
  }
});

test('Git workspaces retain both pickers, including unborn repositories', () => {
  for (const available of [true, false]) {
    assert.equal(shouldShowWorktreePickers({ repository: { kind: 'git', available } }), true);
  }
});

test('repository inspection errors are not mistaken for confirmed absence', () => {
  assert.equal(shouldShowWorktreePickers({ repository: { kind: 'unknown', available: false, reason: 'policy denied' } }), true);
});
