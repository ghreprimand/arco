import assert from 'node:assert/strict';
import test from 'node:test';

import { hasDefaultBackendRefusal, suiteStatusWithVite, outputTail, runWithCiRetry } from './browser-suite-retry.mjs';

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

test('rejects a successful suite when the default backend connection was refused', () => {
  assert.equal(hasDefaultBackendRefusal('proxy error: /api/session\nError: connect ECONNREFUSED 127.0.0.1:3001'), true);
  assert.equal(hasDefaultBackendRefusal('Error: connect ECONNREFUSED ::1:3001'), true);
  assert.equal(hasDefaultBackendRefusal('Error: connect ECONNREFUSED 127.0.0.1:30010'), false);
  assert.equal(hasDefaultBackendRefusal('Error: connect ECONNREFUSED 127.0.0.1:4000'), false);
  assert.equal(hasDefaultBackendRefusal('all requests were handled'), false);
});

test('Vite refusal fails a successful suite and survives split writes', () => {
  const chunks = ['proxy error: connect ECONN', 'REFUSED 127.0.0.', '1:3001'];
  assert.equal(suiteStatusWithVite('pass', chunks.join('')), 'fail');
  assert.equal(suiteStatusWithVite('pass', 'Vite ready'), 'pass');
  assert.equal(suiteStatusWithVite('fail', 'Vite ready'), 'fail');
});
