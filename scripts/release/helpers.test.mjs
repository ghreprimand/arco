import assert from 'node:assert/strict';
import test from 'node:test';
import { bumpVersion, initialChangelog, parseVersion, rollChangelog, extractSection, rewriteManifest, rewriteLockfile } from './helpers.mjs';
const changelog = '# Changelog\n\n## Unreleased\n\n### Fixed\n\n- Retain saved conversations.\n\n## v0.1.0 - 2026-10-27\n\n### Added\n\n- Initial workbench.\n';

test('semantic bumps reset lower components and explicit versions must advance', () => {
  for (const [request, expected] of [['patch', '0.1.1'], ['minor', '0.2.0'], ['major', '1.0.0'], ['2.3.4', '2.3.4']]) assert.equal(bumpVersion('0.1.0', request), expected);
  for (const request of ['0.1.0', '0.0.9', 'v1.0.0', '1.2.3-beta', '01.2.3', '1.2', '9007199254740992.0.0']) assert.throws(() => bumpVersion('0.1.0', request));
  assert.throws(() => parseVersion('1.2.3\n'));
});

test('rolling preserves prior releases and starts a fresh empty Unreleased section', () => {
  const rolled = rollChangelog(changelog, '0.1.1', '2026-10-28');
  assert.ok(rolled.startsWith('# Changelog\n\n## Unreleased\n\n## v0.1.1 - 2026-10-28\n'));
  assert.equal(extractSection(rolled, 'v0.1.1'), '## v0.1.1 - 2026-10-28\n\n### Fixed\n\n- Retain saved conversations.\n');
  assert.equal(extractSection(rolled, 'v0.1.0'), extractSection(changelog, 'v0.1.0'));
  assert.throws(() => rollChangelog(rolled, '0.1.2', '2026-10-29'), /empty/);
});

test('empty or malformed changelogs and duplicate releases fail before edits', () => {
  for (const text of ['# Changes\n', '## Unreleased\n\n### Fixed\n', '## v0.0.1 - 2026-01-01\n\n## Unreleased\n- Later\n', '## Unreleased\n- First\n## Unreleased\n- Second\n']) assert.throws(() => rollChangelog(text, '0.1.1', '2026-10-28'));
  assert.throws(() => rollChangelog(changelog, '0.1.0', '2026-10-28'), /already/);
  assert.throws(() => extractSection(changelog, 'v0.2.0'), /Missing/);
});

test('rewrites change only package versions and preserve locked dependency versions', () => {
  const manifest = { name: '@arco/server', version: '0.1.0', dependencies: { example: '1.2.3' } };
  assert.deepEqual(JSON.parse(rewriteManifest(JSON.stringify(manifest), '0.2.0')), { ...manifest, version: '0.2.0' });
  const lock = { version: '0.1.0', packages: Object.fromEntries(['', 'shared', 'server', 'client', 'node_modules/example'].map(key => [key, { version: key.includes('node_modules') ? '1.2.3' : '0.1.0' }])) };
  const next = JSON.parse(rewriteLockfile(JSON.stringify(lock), '0.2.0'));
  for (const key of ['', 'shared', 'server', 'client']) assert.equal(next.packages[key].version, '0.2.0');
  assert.equal(next.version, '0.2.0');
  assert.equal(next.packages['node_modules/example'].version, '1.2.3');
  assert.throws(() => rewriteLockfile('{}', '0.2.0'), /Missing/);
});


test('the seeded inaugural release is the only empty-Unreleased exception', () => {
  const seeded = changelog.replace('### Fixed\n\n- Retain saved conversations.\n\n', '');
  assert.equal(initialChangelog(seeded, '0.1.0', '0.1.0'), seeded);
  assert.throws(() => initialChangelog(changelog, '0.1.0', '0.1.0'), /empty Unreleased/);
  assert.throws(() => initialChangelog(seeded, '0.1.1', '0.1.1'), /Only/);
  assert.throws(() => rollChangelog(seeded, '0.1.1', '2026-10-28'), /empty/);
});
