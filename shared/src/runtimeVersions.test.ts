import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareLlamacppBuild } from './runtimeVersions.js';
test('llama.cpp update comparison uses builds across old and new version formats', () => {
  assert.equal(compareLlamacppBuild('0.9.0, build 12110', '1.0.0, build 11000'), 1);
  assert.equal(compareLlamacppBuild('9037 (bbeb89d76)', '0.1.2-dev (build 10549, commit b2e5e9b28)'), -1);
  assert.equal(compareLlamacppBuild('0.9.0, build 12110', 'b12110'), 0);
  assert.equal(compareLlamacppBuild('0.9.0, build 12110', 'b12111'), -1);
  assert.equal(compareLlamacppBuild('0.9.0', 'b12111'), undefined);
});
