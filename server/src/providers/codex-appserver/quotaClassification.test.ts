import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCodexQuotaInfo } from './worker.js';

test('usage-limit signals mark Codex quota as throttled', () => {
  assert.equal(isCodexQuotaInfo('usageLimitExceeded', 'Usage limit reached.'), true);
  assert.equal(isCodexQuotaInfo({ httpConnectionFailed: { httpStatusCode: 429 } }, 'request failed'), true);
  assert.equal(isCodexQuotaInfo('other', '429 Too Many Requests'), true);
});

test('model capacity does not become a provider-wide quota throttle', () => {
  assert.equal(
    isCodexQuotaInfo('serverOverloaded', 'Selected model is at capacity. Please try a different model.'),
    false,
  );
});
