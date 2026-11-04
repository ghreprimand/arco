// Regression guard for the platform-build pre-flight (docs/GOTCHAS.md §
// "Provider CLI updates"). `findPlatformDep` is the load-bearing half: it reads
// a third-party manifest shape that drifts, and getting it wrong silently
// disables the check that keeps `npm install -g …@latest` from installing a
// wrapper with no binary behind it.
//
// Run: node --conditions development --import tsx --test src/npmPlatformResolve.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPlatformDep, platformKey } from './npmPlatformResolve.js';

// The exact shape @openai/codex publishes: every entry is an npm alias, and the
// platform is encoded in both the dependency name and the alias version.
const CODEX_OPTIONAL = {
  '@openai/codex-linux-x64': 'npm:@openai/codex@0.153.3-linux-x64',
  '@openai/codex-linux-arm64': 'npm:@openai/codex@0.153.3-linux-arm64',
  '@openai/codex-darwin-x64': 'npm:@openai/codex@0.153.3-darwin-x64',
  '@openai/codex-darwin-arm64': 'npm:@openai/codex@0.153.3-darwin-arm64',
  '@openai/codex-win32-x64': 'npm:@openai/codex@0.153.3-win32-x64',
  '@openai/codex-win32-arm64': 'npm:@openai/codex@0.153.3-win32-arm64',
};

test('platformKey matches the npm platform-package naming convention', () => {
  assert.equal(platformKey('linux', 'x64'), 'linux-x64');
  assert.equal(platformKey('darwin', 'arm64'), 'darwin-arm64');
  assert.equal(platformKey('win32', 'x64'), 'win32-x64');
});

test('finds the aliased platform dep and unwraps it to a fetchable spec', () => {
  const dep = findPlatformDep(CODEX_OPTIONAL, 'linux-x64', '@openai/codex');
  assert.ok(dep);
  // The name is what the wrapper's require.resolve looks for; the real
  // name/version are what we ask the registry about. Conflating them is how the
  // check would pass against a package that was never published.
  assert.equal(dep.name, '@openai/codex-linux-x64');
  assert.equal(dep.realName, '@openai/codex');
  assert.equal(dep.realVersion, '0.153.3-linux-x64');
});

test('picks the entry for the requested platform, not merely the first', () => {
  assert.equal(findPlatformDep(CODEX_OPTIONAL, 'darwin-arm64', '@openai/codex')?.realVersion, '0.153.3-darwin-arm64');
  assert.equal(findPlatformDep(CODEX_OPTIONAL, 'win32-arm64', '@openai/codex')?.realVersion, '0.153.3-win32-arm64');
});

test('handles plain (non-aliased) platform deps', () => {
  const dep = findPlatformDep({ '@vendor/tool-linux-x64': '1.2.3' }, 'linux-x64', '@vendor/tool');
  assert.equal(dep?.realName, '@vendor/tool-linux-x64');
  assert.equal(dep?.realVersion, '1.2.3');
});

test('returns null for pure-JS packages so they skip the check entirely', () => {
  assert.equal(findPlatformDep({ 'some-lib': '^1.0.0' }, 'linux-x64', '@vendor/tool'), null);
  assert.equal(findPlatformDep(undefined, 'linux-x64', '@vendor/tool'), null);
});

test("ignores a third party's platform build", () => {
  // A pure-JS package optionally depends on node-pty's linux-x64
  // build. The app runs without it, so gating (and downgrading) the CLI on that
  // package would be a false positive — only a self-published binary counts.
  const unrelatedPackage = { '@lydell/node-pty-linux-x64': '1.1.0' };
  assert.equal(findPlatformDep(unrelatedPackage, 'linux-x64', '@vendor/app'), null);
  // Same manifest, no ownPackage filter: still found, so the narrowing is what
  // rejects it rather than the suffix match silently not firing.
  assert.ok(findPlatformDep(unrelatedPackage, 'linux-x64'));
});

test('accepts a self-published build named after the package', () => {
  const own = { '@vendor/tool-linux-x64': 'npm:@vendor/tool@2.0.0-linux-x64' };
  assert.equal(findPlatformDep(own, 'linux-x64', '@vendor/tool')?.realVersion, '2.0.0-linux-x64');
});

test('does not confuse a different platform for this one', () => {
  const onlyDarwin = { '@openai/codex-darwin-arm64': 'npm:@openai/codex@0.153.3-darwin-arm64' };
  assert.equal(findPlatformDep(onlyDarwin, 'linux-x64', '@openai/codex'), null);
});

test('arm64 is not matched by the x64 key', () => {
  // 'linux-arm64'.endsWith('-x64') is false, but a sloppier match on 'x64'
  // alone would be true — pin the boundary.
  assert.equal(findPlatformDep({ 'p-linux-arm64': 'npm:p@1.0.0-linux-arm64' }, 'linux-x64', 'p'), null);
});
