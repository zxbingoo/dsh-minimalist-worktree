import test from 'node:test';
import assert from 'node:assert/strict';
import { ADJECTIVES, NOUNS, NAME_ATTEMPTS, generateWorktreeName, createWorktreeNamer } from '../names.js';

const agent = { id: 'name-session' };
const cwd = '/source/repo';
const signal = new AbortController().signal;
const check = (name, run) => test(name, { timeout: 5000 }, run);

function sequence(values) {
  let index = 0;
  return bound => {
    assert.ok(index < values.length, 'unexpected random draw');
    const value = values[index++];
    assert.ok(Number.isInteger(value) && value >= 0 && value < bound);
    return value;
  };
}

check('original word lists are immutable, unique lowercase English words', () => {
  for (const words of [ADJECTIVES, NOUNS]) {
    assert.equal(Object.isFrozen(words), true);
    assert.ok(words.length >= 64);
    assert.equal(new Set(words).size, words.length);
    assert.ok(words.every(word => /^[a-z]+$/.test(word)));
  }
  assert.equal(ADJECTIVES[0], 'ripe');
  assert.equal(NOUNS[0], 'bird');
});

check('all word pairs have exactly the dsh/adjective-noun shape without UUIDs or suffixes', () => {
  const names = new Set();
  for (let adjective = 0; adjective < ADJECTIVES.length; adjective += 1) {
    for (let noun = 0; noun < NOUNS.length; noun += 1) {
      const name = generateWorktreeName(sequence([adjective, noun]));
      assert.equal(name, `dsh/${ADJECTIVES[adjective]}-${NOUNS[noun]}`);
      assert.match(name, /^dsh\/[a-z]+-[a-z]+$/);
      names.add(name);
    }
  }
  assert.equal(names.size, ADJECTIVES.length * NOUNS.length);
  for (let i = 0; i < 50; i += 1) assert.ok(names.has(generateWorktreeName()));
});

check('name generation probes availability and resamples collisions before allocation', async () => {
  const probes = [];
  const makeName = createWorktreeNamer({
    random: sequence([0, 0, 1, 1]),
    async isAvailable(target, directory, name, callerSignal) {
      assert.equal(target, agent);
      assert.equal(directory, cwd);
      assert.equal(callerSignal, signal);
      probes.push(name);
      return name !== 'dsh/ripe-bird';
    },
  });
  assert.equal(await makeName(agent, cwd, signal), 'dsh/calm-badger');
  assert.deepEqual(probes, ['dsh/ripe-bird', 'dsh/calm-badger']);
});

check('concurrent Sessions reserve names before awaiting the Git probe', async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const probes = [];
  const makeName = createWorktreeNamer({
    random: sequence([0, 0, 0, 0, 1, 1]),
    async isAvailable(_target, _cwd, name) {
      probes.push(name);
      if (name === 'dsh/ripe-bird') await blocked;
      return true;
    },
  });
  const first = makeName(agent, cwd, signal);
  const second = makeName({ id: 'other-session' }, cwd, signal);
  try {
    assert.equal(await second, 'dsh/calm-badger');
  } finally { release(); }
  assert.equal(await first, 'dsh/ripe-bird');
  assert.deepEqual(probes, ['dsh/ripe-bird', 'dsh/calm-badger']);
});

check('collision retries are bounded and never append numbers or UUIDs', async () => {
  let probes = 0;
  const makeName = createWorktreeNamer({
    random: () => 0,
    async isAvailable(_target, _cwd, name) { assert.equal(name, 'dsh/ripe-bird'); probes += 1; return false; },
  });
  await assert.rejects(makeName(agent, cwd, signal), /Could not choose an unused dsh\/.*name/);
  assert.equal(probes, NAME_ATTEMPTS);
});

check('Git errors propagate immediately, releasing only the unsuccessful reservation', async () => {
  const reason = new Error('policy denied name probe');
  let deny = true, probes = 0;
  const makeName = createWorktreeNamer({
    random: () => 0,
    async isAvailable() { probes += 1; if (deny) throw reason; return true; },
  });
  await assert.rejects(makeName(agent, cwd, signal), error => error === reason);
  assert.equal(probes, 1);
  deny = false;
  assert.equal(await makeName(agent, cwd, signal), 'dsh/ripe-bird');
  assert.equal(probes, 2);
});

check('pre-cancelled name generation has no random or Git activity', async () => {
  const controller = new AbortController();
  const reason = new Error('cancelled before naming');
  controller.abort(reason);
  const fail = () => { throw new Error('must not run'); };
  const makeName = createWorktreeNamer({ random: fail, isAvailable: fail });
  await assert.rejects(makeName(agent, cwd, controller.signal), error => error === reason);
});

check('cancellation during a probe cannot retain or return a successful name', async () => {
  const controller = new AbortController();
  const reason = new Error('cancelled during naming');
  let cancel = true;
  const makeName = createWorktreeNamer({
    random: () => 0,
    async isAvailable() { if (cancel) controller.abort(reason); return true; },
  });
  await assert.rejects(makeName(agent, cwd, controller.signal), error => error === reason);
  cancel = false;
  assert.equal(await makeName(agent, cwd, signal), 'dsh/ripe-bird');
});
