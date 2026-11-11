import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLlamacppVersion } from './llamacppVersion.js';
test('llama.cpp preserves old build and new semantic-version identities', () => {
  assert.equal(parseLlamacppVersion('version: 9037 (bbeb89d76)\nbuild info'), '9037 (bbeb89d76)');
  assert.equal(parseLlamacppVersion('warning\nversion: 0.1.2-dev (build 10549, commit b2e5e9b28)\n'), '0.1.2-dev (build 10549, commit b2e5e9b28)');
  assert.equal(parseLlamacppVersion('version: 0.9.0, build 12110'), '0.9.0, build 12110');
  assert.equal(parseLlamacppVersion('version: 0.9.0-dev (build 12110, commit cd959bae9)'), '0.9.0-dev (build 12110, commit cd959bae9)');
  assert.equal(parseLlamacppVersion('no version available'), undefined);
});
