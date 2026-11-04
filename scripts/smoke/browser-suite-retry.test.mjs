import assert from 'node:assert/strict';
import test from 'node:test';

import { outputTail, runWithCiRetry } from './browser-suite-retry.mjs';

test('local browser runs never retry a failed suite', async () => {
  let attempts = 0;
  const result = await runWithCiRetry(async () => { attempts += 1; return { status: 1 }; }, { ci: false });
  assert.equal(result.status, 'fail');
  assert.equal(attempts, 1);
});

test('CI reports a suite that passes once on retry as flaky', async () => {
  let attempts = 0;
  const result = await runWithCiRetry(async () => ({ status: ++attempts === 1 ? 1 : 0 }), { ci: true });
  assert.equal(result.status, 'flaky');
  assert.equal(attempts, 2);
});

test('a suite that fails twice on CI remains a failure', async () => {
  let attempts = 0;
  const result = await runWithCiRetry(async () => { attempts += 1; return { status: 1 }; }, { ci: true });
  assert.equal(result.status, 'fail');
  assert.equal(attempts, 2);
});

test('failure tail is bounded and includes both output streams', () => {
  assert.equal(outputTail({ stdout: '123456', stderr: 'error' }, 8), '456error');
});
