import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';

test('Codex refresh waits for active isolated passes before renewing a selected account', async () => {
  const { CodexAccessLeaseBroker } = await import('./codexAccessLease.js');
  let expiry = 2000, renewals = 0;
  const credentials = () => ({ auth_mode: 'chatgpt', tokens: { access_token: `fixture.${Buffer.from(JSON.stringify({ exp: expiry })).toString('base64url')}.fixture`, refresh_token: 'renewal', account_id: 'fixture-account' }, last_refresh: '2026-01-01T00:00:00Z' });
  const broker = new CodexAccessLeaseBroker(async () => credentials(), async () => { renewals++; expiry = 2000; }, () => 1_000_000);
  const first = await broker.acquire();
  expiry = 1200;
  const pending = broker.acquire();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(renewals, 0);
  first.release(); first.release();
  const second = await pending;
  assert.equal(renewals, 1);
  expiry = 1200;
  const abort = new AbortController();
  const cancelled = broker.acquire(abort.signal);
  await new Promise<void>(resolve => setImmediate(resolve));
  abort.abort();
  await assert.rejects(cancelled, /cancelled/);
  second.release();
  assert.equal(renewals, 1);
});

test('a researcher waits for a changed usable Codex sign-in and stops waiting on cancellation', async () => {
  const { waitForCodexSignIn } = await import('./codexAccessLease.js');
  let marker = 'old', pauses = 0, waiting = false;
  const read = async () => ({ auth_mode: 'chatgpt', tokens: { access_token: `fixture.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, marker })).toString('base64url')}.fixture`, account_id: 'fixture-account' }, last_refresh: new Date().toISOString() });
  await waitForCodexSignIn('fixture', new AbortController().signal, { read, onWaiting: async () => { waiting = true; }, pause: async () => { pauses++; marker = 'new'; } });
  assert.equal(waiting, true);
  assert.equal(pauses, 1);
  const abort = new AbortController();
  await assert.rejects(waitForCodexSignIn('fixture', abort.signal, { read, pause: async () => { abort.abort(); } }), /cancelled/);
});


