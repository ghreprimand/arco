import { installIsolatedTestHome } from './testSupport/isolatedHome.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'arco-allowance-'));
installIsolatedTestHome(root);
const { saveTokens, clearTokens, loadTokens } = await import('./providers/claude-native/auth.js');
const { getUsage, getCliUsageBinding } = await import('./usage.js');
const { getClaudeNativeAuthStatus } = await import('./providers/claude-native/authStatus.js');
const { getClaudeAuthProblem } = await import('./providers/claude-native/oauth.js');
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
const grant = (suffix: string) => ({ accessToken: `fixture-access-${suffix}`, refreshToken: `fixture-refresh-${suffix}`, expiresAt: Date.now() + 3_600_000, obtainedAt: Date.now(), tokenType: 'Bearer', scope: 'fixture' });
const cliFile = join(process.env.CLAUDE_CONFIG_DIR!, '.credentials.json');
function cli(suffix?: string, expiresAt = Date.now() + 3_600_000) {
  mkdirSync(process.env.CLAUDE_CONFIG_DIR!, { recursive: true });
  writeFileSync(cliFile, JSON.stringify(suffix ? { claudeAiOauth: { accessToken: `fixture-cli-${suffix}`, refreshToken: `fixture-cli-refresh-${suffix}`, expiresAt } } : {}));
}
const quota = (value: number) => new Response(JSON.stringify({ five_hour: { utilization: value, resets_at: null }, seven_day: { utilization: value / 2 } }), { status: 200 });
const authHeader = (init?: RequestInit) => new Headers(init?.headers).get('authorization');
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

test('a credential revision change invalidates a fresh allowance cache', async () => {
  globalThis.fetch = async (_url, init) => new Response(JSON.stringify({ five_hour: { utilization: new Headers(init?.headers).get('authorization') === 'Bearer fixture-access-alpha' ? 10 : 80 } }), { status: 200 });
  await saveTokens(grant('alpha'));
  assert.equal((await getUsage()).session?.utilization, 10);
  await saveTokens(grant('beta'));
  assert.equal((await getUsage()).session?.utilization, 80, 'a new credential binding must not receive the previous account allowance');
});

test('Native-first reads leave an unrelated bad CLI grant untouched and account identity unknown', async () => {
  cli('bad'); await saveTokens(grant('native-first'));
  const before = readFileSync(cliFile, 'utf8'); const calls: string[] = [];
  globalThis.fetch = async (url, init) => {
    calls.push(String(url)); assert.equal(authHeader(init), 'Bearer fixture-access-native-first');
    return quota(22);
  };
  const result = await getUsage(true);
  assert.equal(result.source, 'claude-native'); assert.equal(result.available, true);
  assert.equal(result.binding?.source, 'claude-native'); assert.deepEqual(result.identity, { state: 'unknown' });
  assert.equal(result.fallback, false); assert.equal(calls.length, 1);
  assert.equal(readFileSync(cliFile, 'utf8'), before);
});

test('Native meter rejection with a different CLI grant is an explicitly attributed fallback', async () => {
  cli('different'); await saveTokens(grant('native-rejected'));
  const before = await getClaudeNativeAuthStatus();
  const calls: string[] = [];
  globalThis.fetch = async (url, init) => {
    assert.ok(String(url).endsWith('/api/oauth/usage'));
    const auth = authHeader(init)!; calls.push(auth);
    return auth.includes('native-rejected') ? new Response('{}', { status: 401 }) : quota(77);
  };
  const result = await getUsage(true);
  assert.deepEqual(calls, ['Bearer fixture-access-native-rejected', 'Bearer fixture-cli-different']);
  assert.equal(result.source, 'claude-cli'); assert.equal(result.binding?.source, 'claude-cli');
  assert.equal(result.fallback, true); assert.equal(result.session?.utilization, 77);
  assert.deepEqual(result.identity, { state: 'unknown' });
  assert.equal((await getClaudeNativeAuthStatus()).state, before.state);
  assert.equal((await getClaudeNativeAuthStatus()).binding.revision, before.binding.revision);
  assert.equal(getClaudeAuthProblem(), null);
});

test('CLI expiry and rejection never rotate or write the external owner credential chain', async () => {
  await clearTokens(); cli('expired', 1); const before = readFileSync(cliFile, 'utf8');
  const calls: string[] = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url)); assert.ok(String(url).endsWith('/api/oauth/usage'), 'meter must not POST to a token endpoint');
    return new Response('{}', { status: 401 });
  };
  const result = await getUsage(true);
  assert.equal(result.available, false); assert.equal(result.source, 'unavailable');
  assert.match(result.error!, /through Claude CLI/); assert.equal(calls.length, 1);
  assert.equal(readFileSync(cliFile, 'utf8'), before); assert.equal(getClaudeAuthProblem(), null);
});

test('CLI replacement invalidates both its binding and cached quota, without sticky in-memory tokens', async () => {
  await clearTokens(); cli('alpha');
  const firstBinding = await getCliUsageBinding(); let calls = 0;
  globalThis.fetch = async (_url, init) => { calls++; return quota(authHeader(init)?.endsWith('alpha') ? 11 : 88); };
  assert.equal((await getUsage(true)).session?.utilization, 11);
  cli('beta');
  assert.notEqual((await getCliUsageBinding()).revision, firstBinding.revision);
  const result = await getUsage();
  assert.equal(result.session?.utilization, 88); assert.equal(result.source, 'claude-cli'); assert.equal(calls, 2);
  assert.equal((await getUsage()).freshness, 'cached'); assert.equal(calls, 2);
});

for (const delayedBody of [false, true]) {
  test(`a late old-binding ${delayedBody ? 'body' : 'response'} cannot publish or poison the replacement cache`, async () => {
    cli(); await saveTokens(grant(`old-${delayedBody}`));
    const started = deferred(), release = deferred(); let calls = 0;
    globalThis.fetch = async (_url, init) => {
      calls++;
      if (authHeader(init)?.includes(`old-${delayedBody}`)) {
        started.resolve();
        if (!delayedBody) { await release.promise; return quota(12); }
        const response = quota(12);
        response.json = async () => { await release.promise; return { five_hour: { utilization: 12 } }; };
        return response;
      }
      return quota(82);
    };
    const old = getUsage(true);
    try {
      await started.promise; await saveTokens(grant(`new-${delayedBody}`));
      const current = await getUsage(true); assert.equal(current.session?.utilization, 82);
      release.resolve(); const obsolete = await old;
      assert.equal(obsolete.session, null); assert.equal(obsolete.available, false);
      assert.match(obsolete.error!, /Credentials changed/);
      assert.equal((await getUsage()).session?.utilization, 82); assert.equal(calls, 2);
    } finally { release.resolve(); await old; }
  });
}

test('simultaneous poll and forced consumers share one request for the same credential context', async () => {
  cli(); await saveTokens(grant('concurrent')); const started = deferred(), release = deferred(); let calls = 0;
  globalThis.fetch = async () => { calls++; started.resolve(); await release.promise; return quota(35); };
  const requests = Array.from({ length: 8 }, (_, index) => getUsage(index % 2 === 0));
  try {
    await started.promise; await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(calls, 1); release.resolve();
    const results = await Promise.all(requests);
    assert.ok(results.every(result => result.session?.utilization === 35)); assert.equal(calls, 1);
  } finally { release.resolve(); await Promise.all(requests); }
});

test('Native expiry refresh stays with its owner and caches the resulting actual revision', async () => {
  cli(); await saveTokens({ ...grant('expired-native'), expiresAt: 1 });
  let refreshes = 0, reads = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/v1/oauth/token')) {
      refreshes++; assert.equal(init?.method, 'POST');
      return new Response(JSON.stringify({ access_token: 'fixture-owned-native', refresh_token: 'fixture-owned-refresh', expires_in: 3600 }), { status: 200 });
    }
    reads++; assert.equal(authHeader(init), 'Bearer fixture-owned-native'); return quota(39);
  };
  const result = await getUsage(true);
  assert.equal(result.source, 'claude-native'); assert.equal((await loadTokens())?.accessToken, 'fixture-owned-native');
  assert.equal((await getUsage()).binding?.revision, result.binding?.revision);
  assert.equal(refreshes, 1); assert.equal(reads, 1);
});

test('network failure retains only same-binding stale data and never changes execution auth', async () => {
  cli(); await saveTokens(grant('same-stale'));
  globalThis.fetch = async () => quota(44);
  const fresh = await getUsage(true); const auth = await getClaudeNativeAuthStatus();
  globalThis.fetch = async () => { throw new Error('fixture network unavailable'); };
  const stale = await getUsage(true);
  assert.equal(stale.available, false); assert.equal(stale.stale, true); assert.equal(stale.freshness, 'stale');
  assert.equal(stale.fetchedAt, fresh.fetchedAt); assert.equal(stale.session?.utilization, 44);
  assert.equal(stale.binding?.revision, fresh.binding?.revision);
  await saveTokens(grant('changed-stale'));
  const changed = await getUsage(); assert.equal(changed.session, null); assert.equal(changed.source, 'unavailable');
  assert.equal((await getClaudeNativeAuthStatus()).state, auth.state); assert.equal(getClaudeAuthProblem(), null);
});

test('no suitable meter and malformed quota remain explicit unavailable results', async () => {
  cli(); await clearTokens();
  globalThis.fetch = async () => { assert.fail('no credentials must not query a provider'); };
  const missing = await getUsage(true);
  assert.equal(missing.available, false); assert.equal(missing.source, 'unavailable'); assert.equal(missing.identity?.state, 'unknown');
  await saveTokens(grant('malformed-window'));
  globalThis.fetch = async () => new Response('{"five_hour":{"utilization":"unknown"}}', { status: 200 });
  const malformed = await getUsage(true); assert.equal(malformed.available, false); assert.equal(malformed.session, null);
});

test('a cached poll joins an in-flight explicit check instead of returning the older snapshot', async () => {
  cli(); await saveTokens(grant('forced-cache'));
  globalThis.fetch = async () => quota(10); await getUsage(true);
  const started = deferred(), release = deferred();
  globalThis.fetch = async () => { started.resolve(); await release.promise; return quota(80); };
  const forced = getUsage(true);
  try {
    await started.promise; const poll = getUsage(); await new Promise(resolve => setTimeout(resolve, 20)); release.resolve();
    assert.equal((await forced).session?.utilization, 80);
    assert.equal((await poll).session?.utilization, 80);
  } finally { release.resolve(); await forced; }
});
