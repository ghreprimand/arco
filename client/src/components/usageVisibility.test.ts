import test from 'node:test';
import assert from 'node:assert/strict';
import type { AuthStatusByProvider, ProviderName } from '@arco/shared';
import { hasEnabledUsageProvider, USAGE_PROVIDERS } from './usageVisibility';

test('usage group requires an enabled signed-in provider', () => {
  const auth = Object.fromEntries(USAGE_PROVIDERS.map((provider) => [provider, { loggedIn: true }])) as unknown as AuthStatusByProvider;
  assert.equal(hasEnabledUsageProvider(auth, () => false), false);
  for (const provider of USAGE_PROVIDERS) {
    assert.equal(hasEnabledUsageProvider(auth, (p: ProviderName) => p === provider), true);
    const signedOut = { ...auth, [provider]: { loggedIn: false } };
    assert.equal(hasEnabledUsageProvider(signedOut, (p: ProviderName) => p === provider), false);
  }
  assert.equal(hasEnabledUsageProvider(null, () => true), false);
});
