import test from 'node:test';
import assert from 'node:assert/strict';
import type { ProviderName } from '@arco/shared';
import { hasEnabledUsageProvider, USAGE_PROVIDERS } from './usageVisibility';

test('an enabled remote provider keeps the top bar whether or not it is signed in; local programs keep theirs', () => {
  assert.equal(hasEnabledUsageProvider(() => false), false);
  for (const provider of USAGE_PROVIDERS) assert.equal(hasEnabledUsageProvider((p: ProviderName) => p === provider), true);
  assert.equal(hasEnabledUsageProvider(() => true), true);
  for (const provider of ['ollama', 'llamacpp', 'strata', 'deepseek']) assert.equal(hasEnabledUsageProvider(p => p === provider), true);
  assert.equal(hasEnabledUsageProvider(p => p === 'lmstudio'), false);
});
