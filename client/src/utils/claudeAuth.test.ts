import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AuthStatus } from '@arco/shared';
import { claudeConnection } from './claudeAuth';
import { anyPrimaryProviderConnected } from './startupGate';
import { connectionState } from '../components/Connections/model';

const NOW = Date.now();
const native = (state: 'missing' | 'present' | 'needs-attention' | 'unknown', extra: object = {}) => ({
  state, credentialsPresent: state === 'present', execution: 'unverified' as const, checkedAt: NOW,
  binding: { source: 'claude-native' as const, storeId: 'claude.native' as const }, ...extra,
});
const status = (nativeState: Parameters<typeof native>[0], cliIn: boolean): AuthStatus => ({
  installed: true, cliInstalled: true, loggedIn: cliIn,
  native: native(nativeState),
  cli: { loggedIn: cliIn, checkedAt: NOW, binding: { source: 'claude-cli' as const, storeId: 'claude-cli-default' as const } },
} as unknown as AuthStatus);

test('Native selected: connected only with Native credentials, whatever the CLI says', () => {
  assert.deepEqual(
    [claudeConnection(status('present', false), 'native', NOW).connected, claudeConnection(status('present', true), 'native', NOW).connected],
    [true, true]);
  const missingCli = claudeConnection(status('missing', true), 'native', NOW);
  assert.equal(missingCli.connected, false);
  assert.equal(missingCli.needsNativeSignIn, true);
  assert.equal(missingCli.cliSignedIn, true);
  assert.equal(missingCli.text, 'Native: sign-in needed');
  const neither = claudeConnection(status('missing', false), 'native', NOW);
  assert.deepEqual([neither.connected, neither.needsNativeSignIn, neither.cliSignedIn], [false, true, false]);
  assert.equal(claudeConnection(status('needs-attention', true), 'native', NOW).text, 'Native needs attention');
});

test('CLI selected: connected only when the CLI is signed in', () => {
  assert.deepEqual(
    [claudeConnection(status('missing', true), 'cli', NOW).connected, claudeConnection(status('present', false), 'cli', NOW).connected],
    [true, false]);
  assert.equal(claudeConnection(status('present', false), 'cli', NOW).text, 'CLI: sign-in needed');
  assert.equal(claudeConnection(status('missing', true), 'cli', NOW).text, 'CLI connected');
  assert.equal(claudeConnection(status('missing', true), 'cli', NOW).needsNativeSignIn, false);
});

test('unknown Native evidence and legacy statuses keep the CLI-only answer', () => {
  assert.equal(claudeConnection(status('unknown', true), 'native', NOW).connected, true);
  assert.equal(claudeConnection(status('unknown', false), 'native', NOW).connected, false);
  const legacy = { installed: true, cliInstalled: true, loggedIn: true } as AuthStatus;
  assert.equal(claudeConnection(legacy, 'native', NOW).connected, true);
  assert.equal(claudeConnection(undefined, 'native', NOW).connected, false);
});

test('Welcome continues only when the selected Claude transport is usable', () => {
  const on = () => true;
  const auth = (s: AuthStatus) => ({ claude: s }) as never;
  assert.equal(anyPrimaryProviderConnected(auth(status('missing', true)), on), false);
  assert.equal(anyPrimaryProviderConnected(auth(status('missing', true)), on, 'native'), false);
  assert.equal(anyPrimaryProviderConnected(auth(status('missing', true)), on, 'cli'), true);
  assert.equal(anyPrimaryProviderConnected(auth(status('present', false)), on), true);
  assert.equal(anyPrimaryProviderConnected({ claude: status('missing', true), codex: { loggedIn: true } } as never, on), true);
});

test('Connections names the selected transport state', () => {
  const claude = { id: 'claude', kind: 'plan' } as never;
  assert.equal(connectionState(claude, status('missing', true), true, false, 'native'), 'Native: sign-in needed');
  assert.equal(connectionState(claude, status('missing', true), true, false, 'cli'), 'CLI connected');
  assert.equal(connectionState(claude, status('present', false), true, false, 'native'), 'Native credentials detected');
  assert.equal(connectionState(claude, status('present', false), true, false, 'cli'), 'CLI: sign-in needed');
});
