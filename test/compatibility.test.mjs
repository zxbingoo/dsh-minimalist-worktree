import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import semver from 'semver';

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('DSH compatibility admits the supported 0.2 line, including prereleases, but stops at 0.3', () => {
  const range = manifest.engines.dsh;
  assert.ok(semver.validRange(range));
  // DSH app-boot includes prereleases in admission matching.
  for (const version of ['0.2.1-rc.5', '0.2.1', '0.2.2-rc.1', '0.2.2', '0.2.3-rc.1', '0.2.9']) {
    assert.equal(semver.satisfies(version, range, { includePrerelease: true }), true, version);
  }
  for (const version of ['0.2.1-rc.4', '0.2.0', '0.3.0-alpha.1', '0.3.0', '1.0.0']) {
    assert.equal(semver.satisfies(version, range, { includePrerelease: true }), false, version);
  }
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-typert-protocol'], range);
});

test('development regression suite uses the explicitly tested current protocol', () => {
  assert.equal(manifest.devDependencies['@deepseek-ai/dsh-typert-protocol'], '0.2.2-rc.1');
});
