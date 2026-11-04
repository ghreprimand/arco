import { installIsolatedTestHome } from '../../testSupport/isolatedHome.js';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const home = mkdtempSync(join(tmpdir(), 'arco-native-status-'));
installIsolatedTestHome(home);
const { getClaudeNativeAuthStatus } = await import('./authStatus.js');
const { saveTokens, clearTokens, nativeCredentialBinding } = await import('./auth.js');
const { markClaudeAuthProblem, clearClaudeAuthProblem, REFRESH_LEAD_MS_EXPORT } = await import('./oauth.js');
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { assert.fail('a status read must not call a provider'); };
after(() => { globalThis.fetch = originalFetch; rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
const token = () => ({ accessToken: 'fixture-access', refreshToken: 'fixture-refresh', expiresAt: Date.now() + 3_600_000, obtainedAt: Date.now(), tokenType: 'Bearer', scope: 'fixture' });

test('missing credentials are distinct from an unverified local grant', async () => {
  assert.equal((await getClaudeNativeAuthStatus()).state, 'missing');
  await saveTokens(token());
  const status = await getClaudeNativeAuthStatus();
  assert.equal(status.state, 'present');
  assert.equal(status.credentialsPresent, true);
  assert.equal(status.execution, 'unverified');
  assert.equal(status.binding.storeId, 'claude.native');
  assert.ok(status.binding.revision);
  assert.ok(!JSON.stringify(status).includes('fixture-access'));
  assert.ok(!JSON.stringify(status).includes('fixture-refresh'));
});

test('expiration reports refresh needed without starting a refresh or claiming logout', async () => {
  await saveTokens({ ...token(), expiresAt: Date.now() + REFRESH_LEAD_MS_EXPORT + 5_000 });
  assert.equal((await getClaudeNativeAuthStatus()).state, 'present');
  await saveTokens({ ...token(), expiresAt: 1 });
  const status = await getClaudeNativeAuthStatus();
  assert.equal(status.state, 'refresh-needed');
  assert.equal(status.credentialsPresent, true);
  assert.equal(status.execution, 'unverified');
});

test('a reported Native problem remains independent of CLI and meter state', async () => {
  await saveTokens(token());
  markClaudeAuthProblem('fixture rejection detail');
  try {
    const status = await getClaudeNativeAuthStatus();
    assert.equal(status.state, 'needs-attention');
    assert.ok(status.problemSince);
    assert.equal(status.credentialsPresent, true);
    assert.ok(!JSON.stringify(status).includes('fixture rejection detail'));
  } finally { clearClaudeAuthProblem(); }
  assert.equal((await getClaudeNativeAuthStatus()).state, 'present');
});

test('an unreadable grant retains an explicitly stale answer and clears on recovery', async () => {
  const old = await getClaudeNativeAuthStatus();
  const file = join(process.env.ARCO_HOME!, 'auth.json');
  writeFileSync(file, '{');
  const status = await getClaudeNativeAuthStatus();
  assert.equal(status.state, 'unknown');
  assert.equal(status.probeFailed, true);
  assert.equal(status.stale, true);
  assert.equal(status.binding.revision, old.binding.revision);
  writeFileSync(file, '{}');
  await clearTokens();
  const missing = await getClaudeNativeAuthStatus();
  assert.equal(missing.state, 'missing');
  assert.equal(missing.stale, undefined);
  assert.equal(missing.binding.revision, undefined);
});

test('binding identifies one store and changes with credential revisions without profile identity', () => {
  const grant = token();
  const binding = nativeCredentialBinding(grant);
  assert.deepEqual(nativeCredentialBinding({ ...grant }), binding);
  assert.equal(nativeCredentialBinding({ ...grant, accessToken: 'fixture-rotated' }).storeId, binding.storeId);
  assert.notEqual(nativeCredentialBinding({ ...grant, accessToken: 'fixture-rotated' }).revision, binding.revision);
  assert.notEqual(nativeCredentialBinding({ ...grant, refreshToken: 'fixture-rotated-refresh' }).revision, binding.revision);
  assert.equal('account' in binding, false);
  assert.equal('profile' in binding, false);
});
