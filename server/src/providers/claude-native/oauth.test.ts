// A1 (REMOTE_CLUSTER_CONTROL_PLAN.md §10.2) — forced-refresh contract.
//
// The prod incident this pins: Anthropic revokes access tokens ahead of local
// expiresAt, ensureLiveTokens' expiry check never fires, the API 401s, and the
// worker used to fail fatal without ever trying the refresh chain. These tests
// pin the forceRefreshTokens semantics: refresh DESPITE a future expiresAt,
// skip the refresh when another worker already rotated the chain, surface the
// endpoint's rejection status, and leave the normal refreshTokens short-circuit
// untouched.
//
// HOME is redirected to a tmpdir BEFORE the dynamic import so auth.ts computes
// its ~/.arco/auth.json path inside the sandbox.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sandbox = mkdtempSync(join(tmpdir(), 'arco-oauth-test-'));
process.env.HOME = sandbox;

const { forceRefreshTokens, refreshTokens } = await import('./oauth.js');
const { loadTokens } = await import('./auth.js');

interface TokenSeed {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  tokenType: string;
  scope: string;
  obtainedAt: number;
}

function seedAuthFile(tokens: TokenSeed): void {
  mkdirSync(join(sandbox, '.arco'), { recursive: true });
  writeFileSync(
    join(sandbox, '.arco', 'auth.json'),
    JSON.stringify({ claude: { native: tokens } }),
    { mode: 0o600 },
  );
}

function makeSeed(overrides: Partial<TokenSeed> = {}): TokenSeed {
  const now = Date.now();
  return {
    accessToken: 'stale-access',
    refreshToken: 'refresh-1',
    expiresAt: now + 60 * 60 * 1000, // one hour out — locally "valid"
    tokenType: 'Bearer',
    scope: 'user:inference',
    obtainedAt: now - 10 * 60 * 1000,
    ...overrides,
  };
}

// Install a fetch mock; returns the calls it saw.
function mockFetch(
  handler: () => { status: number; body: unknown },
): { calls: Array<{ url: string; body: Record<string, unknown> }>; restore: () => void } {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
    const { status, body } = handler();
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('forceRefreshTokens refreshes despite a far-future expiresAt', async () => {
  const seed = makeSeed();
  seedAuthFile(seed);
  const fetchMock = mockFetch(() => ({
    status: 200,
    body: { access_token: 'fresh-access', refresh_token: 'refresh-2', expires_in: 3600 },
  }));
  try {
    const next = await forceRefreshTokens(seed.obtainedAt);
    assert.equal(fetchMock.calls.length, 1, 'must hit the token endpoint');
    assert.equal(fetchMock.calls[0].body.grant_type, 'refresh_token');
    assert.equal(fetchMock.calls[0].body.refresh_token, 'refresh-1');
    assert.equal(next.accessToken, 'fresh-access');
    assert.equal(next.refreshToken, 'refresh-2');
    // Rotation persisted — a second worker reading disk sees the new chain.
    const onDisk = await loadTokens();
    assert.equal(onDisk?.accessToken, 'fresh-access');
    assert.ok(onDisk!.obtainedAt > seed.obtainedAt);
  } finally {
    fetchMock.restore();
  }
});

test('forceRefreshTokens skips the refresh when the chain already rotated', async () => {
  const rotated = makeSeed({ accessToken: 'already-rotated', obtainedAt: Date.now() });
  seedAuthFile(rotated);
  const fetchMock = mockFetch(() => ({ status: 200, body: {} }));
  try {
    // Caller's client was built from an OLDER obtainedAt — another worker beat
    // us to the refresh; must return disk tokens without burning the chain.
    const next = await forceRefreshTokens(rotated.obtainedAt - 5_000);
    assert.equal(fetchMock.calls.length, 0, 'must not hit the token endpoint');
    assert.equal(next.accessToken, 'already-rotated');
  } finally {
    fetchMock.restore();
  }
});

test('forceRefreshTokens surfaces the endpoint rejection status', async () => {
  const seed = makeSeed();
  seedAuthFile(seed);
  const fetchMock = mockFetch(() => ({ status: 400, body: { error: 'invalid_grant' } }));
  try {
    await assert.rejects(
      () => forceRefreshTokens(seed.obtainedAt),
      (err: Error & { httpStatus?: number }) => {
        assert.match(err.message, /refresh failed \(400\)/);
        assert.equal(err.httpStatus, 400);
        return true;
      },
    );
    // A failed refresh must NOT clobber the stored tokens.
    const onDisk = await loadTokens();
    assert.equal(onDisk?.accessToken, 'stale-access');
  } finally {
    fetchMock.restore();
  }
});

test('forceRefreshTokens throws NO_AUTH when the auth file is empty', async () => {
  mkdirSync(join(sandbox, '.arco'), { recursive: true });
  writeFileSync(join(sandbox, '.arco', 'auth.json'), '{}\n', { mode: 0o600 });
  const fetchMock = mockFetch(() => ({ status: 200, body: {} }));
  try {
    await assert.rejects(
      () => forceRefreshTokens(0),
      (err: Error & { code?: string }) => err.code === 'NO_AUTH',
    );
    assert.equal(fetchMock.calls.length, 0);
  } finally {
    fetchMock.restore();
  }
});

test('refreshTokens still short-circuits on a not-near-expiry token (regression)', async () => {
  const seed = makeSeed();
  seedAuthFile(seed);
  const fetchMock = mockFetch(() => ({ status: 200, body: {} }));
  try {
    const next = await refreshTokens(seed);
    assert.equal(fetchMock.calls.length, 0, 'normal path must not refresh early');
    assert.equal(next.accessToken, 'stale-access');
  } finally {
    fetchMock.restore();
  }
});

test('lockfile artifacts do not leak into the auth dir', () => {
  // proper-lockfile creates auth.json.lock during the critical section; after
  // the calls above it must be gone (a leaked lock deadlocks the next refresh).
  const entries = readFileSync(join(sandbox, '.arco', 'auth.json'), 'utf8');
  assert.ok(entries.length > 0);
  assert.throws(() => readFileSync(join(sandbox, '.arco', 'auth.json.lock')));
});
