import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';

test('Claude refresh waits for active isolated passes and renews before starting a new turn', async () => {
  const { ClaudeAccessLeaseBroker } = await import('./claudeAccessLease.js');
  let expiresAt = 2_000_000, renewals = 0;
  const credentials = () => ({ claudeAiOauth: { accessToken: 'access', refreshToken: 'renewal', expiresAt,
    scopes: ['inference'], subscriptionType: 'plan', subscriptionTypeSource: 'source', rateLimitTier: 'tier' } });
  const broker = new ClaudeAccessLeaseBroker(async () => credentials(), async () => { renewals++; expiresAt = 2_000_000; }, () => 1_000_000);
  const first = await broker.acquire();
  expiresAt = 1_200_000;
  const pending = broker.acquire();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(renewals, 0);
  first.release(); first.release();
  const second = await pending;
  assert.equal(renewals, 1);
  expiresAt = 1_200_000;
  const abort = new AbortController();
  const cancelled = broker.acquire(abort.signal);
  await new Promise<void>(resolve => setImmediate(resolve));
  abort.abort();
  await assert.rejects(cancelled, /cancelled/);
  second.release();
  assert.equal(renewals, 1);
});

test('a researcher waits for a changed usable Claude sign-in and stops waiting on cancellation', async () => {
  const { waitForClaudeSignIn } = await import('./claudeAccessLease.js');
  let accessToken = 'old', pauses = 0, waiting = false;
  const read = async () => ({ claudeAiOauth: { accessToken, expiresAt: Date.now() + 3_600_000,
    scopes: ['inference'], subscriptionType: 'plan', subscriptionTypeSource: 'source', rateLimitTier: 'tier' } });
  await waitForClaudeSignIn(new AbortController().signal, { read, onWaiting: async () => { waiting = true; },
    pause: async () => { pauses++; accessToken = 'new'; } });
  assert.equal(waiting, true);
  assert.equal(pauses, 1);
  const abort = new AbortController();
  await assert.rejects(waitForClaudeSignIn(abort.signal, { read, pause: async () => { abort.abort(); } }), /cancelled/);
});


