import test from 'node:test';
import assert from 'node:assert/strict';
import type { AuthStatusByProvider, ProviderName } from '@arco/shared';
import { hasEnabledUsageProvider, USAGE_PROVIDERS } from './usageVisibility';

test('remote dots require sign-in while enabled local programs retain their indicator', () => {
  const auth = Object.fromEntries(USAGE_PROVIDERS.map((provider) => [provider, { loggedIn: true }])) as unknown as AuthStatusByProvider;
  assert.equal(hasEnabledUsageProvider(auth, () => false), false);
  for (const provider of USAGE_PROVIDERS) {
    assert.equal(hasEnabledUsageProvider(auth, (p: ProviderName) => p === provider), true);
    const signedOut = { ...auth, [provider]: { loggedIn: false } };
    assert.equal(hasEnabledUsageProvider(signedOut, (p: ProviderName) => p === provider), false);
  }
  assert.equal(hasEnabledUsageProvider(null, () => true), true);
  for (const provider of ['ollama', 'llamacpp', 'strata', 'deepseek']) assert.equal(hasEnabledUsageProvider(null, p => p === provider), true);
  assert.equal(hasEnabledUsageProvider(null, p => p === 'lmstudio'), false);
});
