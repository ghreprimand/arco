import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AuthStatusByProvider, ProviderName } from '@arco/shared';
import { availableMemberProviders, availablePrimaryProviders, firstAvailablePrimaryProvider, memberProviderAvailable, primaryProviderOptions, primaryProviderProblem } from './memberProviders.js';

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

test('primary provider starts on the first enabled and connected provider', () => {
  const all = () => true;
  assert.equal(firstAvailablePrimaryProvider(auth({ claude: false, codex: true }), all), 'codex', 'Codex-only home');
  assert.equal(firstAvailablePrimaryProvider(auth({ claude: true, codex: true }), all), 'claude');
  assert.equal(firstAvailablePrimaryProvider(auth({ claude: true, codex: true }), (p) => p !== 'claude'), 'codex', 'disabled provider skipped');
  assert.equal(firstAvailablePrimaryProvider(auth({ claude: false, codex: false }), all), null, 'nothing connected');
  assert.equal(firstAvailablePrimaryProvider(null, all), null, 'no status yet');
  assert.deepEqual(availablePrimaryProviders(auth({ deepseek: true, ollama: true, lmstudio: true }), all), ['ollama', 'lmstudio', 'deepseek']);
});

test('an unavailable current provider stays listed and blocks launch with a plain reason', () => {
  const all = () => true;
  const codexOnly = auth({ claude: false, codex: true });
  assert.deepEqual(primaryProviderOptions('claude', codexOnly, all), ['claude', 'codex'], 'saved Claude kept, Codex offered');
  assert.deepEqual(primaryProviderOptions('codex', codexOnly, all), ['codex'], 'no disconnected extras');
  assert.match(primaryProviderProblem('claude', codexOnly, all, 'Claude')!, /Claude is not connected/);
  assert.equal(primaryProviderProblem('codex', codexOnly, all, 'Codex'), null);
  assert.match(primaryProviderProblem('claude', auth({ claude: false }), all, 'Claude')!, /No provider is connected/);
  assert.match(primaryProviderProblem('claude', auth({ claude: true }), (p) => p !== 'claude', 'Claude')!, /turned off in Settings/);
  assert.match(primaryProviderProblem('claude', null, all, 'Claude')!, /Checking/);
});
