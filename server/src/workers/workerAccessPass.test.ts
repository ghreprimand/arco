import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';

test('access-only worker credentials exclude renewal tokens and unrelated account data', async () => {
  const { workerAccessPass } = await import('./workerAccessPass.js');
  const access = `fixture.${Buffer.from(JSON.stringify({ exp: 2000 })).toString('base64url')}.fixture`;
  const codex = JSON.parse(workerAccessPass('codex', { auth_mode: 'chatgpt', OPENAI_API_KEY: 'secret-key',
    tokens: { access_token: access, id_token: 'private-id', refresh_token: 'renewal', account_id: 'fixture-account' },
    last_refresh: '2026-01-01T00:00:00Z' }, 1000));
  assert.deepEqual(codex.tokens, { access_token: access, id_token: access, refresh_token: '', account_id: 'fixture-account' });
  assert.equal(codex.OPENAI_API_KEY, null);
  assert.throws(() => workerAccessPass('codex', { auth_mode: 'chatgpt', tokens: { access_token: access }, last_refresh: '2026-01-01T00:00:00Z' }, 1700000), /needs renewing/);
  const source = { claudeAiOauth: { accessToken: 'access', refreshToken: 'renewal', expiresAt: 1000000,
    scopes: ['inference'], subscriptionType: 'plan', subscriptionTypeSource: 'source', rateLimitTier: 'tier', accountUuid: 'private-account' } };
  const claude = JSON.parse(workerAccessPass('claude', source, 1000));
  assert.deepEqual(Object.keys(claude.claudeAiOauth).sort(), ['accessToken', 'expiresAt', 'rateLimitTier', 'refreshToken', 'scopes', 'subscriptionType', 'subscriptionTypeSource'].sort());
  assert.equal(claude.claudeAiOauth.refreshToken, '');
  assert.equal(claude.claudeAiOauth.accessToken, 'access');
  assert.throws(() => workerAccessPass('claude', source, 700000), /needs renewing/);
  assert.throws(() => workerAccessPass('codex', { auth_mode: 'apikey' }), /needs renewing/);
});


