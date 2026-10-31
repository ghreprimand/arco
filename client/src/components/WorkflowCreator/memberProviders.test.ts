import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AuthStatusByProvider, ProviderName } from '@arco/shared';
import { availableMemberProviders, memberProviderAvailable } from './memberProviders.js';

const auth = (loggedIn: Partial<Record<ProviderName, boolean>>) =>
  Object.fromEntries(Object.entries(loggedIn).map(([p, v]) => [p, { loggedIn: v }])) as unknown as AuthStatusByProvider;

test('member providers are offered only when enabled and connected, in display order', () => {
  const enabled = (p: ProviderName) => p !== 'cursor';
  const status = auth({ claude: true, codex: false, ollama: true, cursor: true, llamacpp: false, strata: true });
  assert.deepEqual(availableMemberProviders(status, enabled), ['claude', 'ollama']);
  assert.equal(memberProviderAvailable('cursor', status, enabled), false, 'disabled in Settings');
  assert.equal(memberProviderAvailable('codex', status, enabled), false, 'not connected');
  assert.deepEqual(availableMemberProviders(null, () => true), [], 'no status yet means nothing is offered');
});
