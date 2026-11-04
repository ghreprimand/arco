import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AuthStatusByProvider, UsageInfo } from '@arco/shared';
import { refreshClaudeAllowance, allowanceBindingChanged, allowanceFreshness, allowanceSource } from './claudeAllowance';
import { useAppStore } from '../stores/appStore';

const usage = (revision: string, checkedAt: number, source = 'claude-native' as 'claude-native' | 'claude-cli'): UsageInfo => ({
  session: { utilization: 20, resetsAt: null }, weekly: null, fetchedAt: checkedAt, checkedAt, subscriptionType: null,
  available: true, source, binding: { source, storeId: source === 'claude-native' ? 'claude.native' : 'claude-cli-default', revision }, identity: { state: 'unknown' }, freshness: 'fresh',
});
const auth = (revision: string, checkedAt: number) => ({ claude: {
  loggedIn: true, native: { state: 'present', credentialsPresent: true, execution: 'unverified', checkedAt, binding: { source: 'claude-native', storeId: 'claude.native', revision } },
} }) as AuthStatusByProvider;

test('a late browser poll cannot overwrite a newer explicit refresh, including late failures', async () => {
  const original = globalThis.fetch;
  const pending: Array<{ resolve: (response: Response) => void; reject: (error: Error) => void }> = [];
  globalThis.fetch = async () => new Promise<Response>((resolve, reject) => pending.push({ resolve, reject }));
  try {
    const old = refreshClaudeAllowance(), next = refreshClaudeAllowance(true);
    pending[1].resolve(new Response(JSON.stringify(usage('beta', 20))));
    assert.equal((await next)?.binding?.revision, 'beta');
    pending[0].resolve(new Response(JSON.stringify(usage('alpha', 10))));
    assert.equal(await old, null);
    const failing = refreshClaudeAllowance(), current = refreshClaudeAllowance(true);
    pending[3].resolve(new Response(JSON.stringify(usage('gamma', 30))));
    assert.equal((await current)?.binding?.revision, 'gamma');
    pending[2].reject(new Error('fixture obsolete network failure'));
    assert.equal(await failing, null);
  } finally { globalThis.fetch = original; }
});

test('auth revision observation clears old quota and rejects a delayed earlier snapshot', () => {
  const before = useAppStore.getState();
  const storage = useAppStore.persist.getOptions().storage;
  useAppStore.persist.setOptions({ storage: { getItem: () => null, setItem() {}, removeItem() {} } });
  try {
    useAppStore.setState({ authStatus: auth('alpha', 5), usage: usage('alpha', 10) });
    useAppStore.getState().setAuthStatus(auth('beta', 20));
    assert.equal(useAppStore.getState().usage, null);
    useAppStore.getState().setUsage(usage('alpha', 10));
    assert.equal(useAppStore.getState().usage, null);
    useAppStore.getState().setUsage(usage('beta', 30));
    assert.equal(useAppStore.getState().usage?.binding?.revision, 'beta');
    useAppStore.getState().setAuthStatus(auth('alpha', 5));
    assert.equal(useAppStore.getState().usage?.binding?.revision, 'beta', 'an older auth observation cannot discard newer meter evidence');
    assert.equal(allowanceBindingChanged({ ...usage('beta', 10), fetchedAt: 30 }, auth('alpha', 20)), false);
  } finally { useAppStore.setState(before, true); useAppStore.persist.setOptions({ storage }); }
});

test('CLI binding freshness is independent of a stale login probe and source labels never infer identity', () => {
  const status = { claude: { loggedIn: true, cli: { loggedIn: true, probeFailed: true, checkedAt: 1, bindingCheckedAt: 30,
    binding: { source: 'claude-cli', storeId: 'claude-cli-default', revision: 'beta' } } } } as AuthStatusByProvider;
  assert.equal(allowanceBindingChanged(usage('alpha', 10, 'claude-cli'), status), true);
  assert.equal(allowanceBindingChanged(usage('beta', 40, 'claude-cli'), status), false);
  assert.equal(allowanceSource(usage('beta', 40, 'claude-cli')), 'CLI OAuth credentials');
  assert.equal(allowanceSource(null), 'Source not reported');
  assert.equal(allowanceFreshness({ ...usage('alpha', 1), stale: true }, 2), 'stale');
  assert.equal(allowanceFreshness(usage('alpha', 1), 180_000), 'stale');
});

test('a new Native grant invalidates an earlier CLI fallback context even when CLI credentials are unchanged', () => {
  const fallback = usage('cli-fixture', 10, 'claude-cli');
  fallback.credentialContext = { native: { source: 'claude-native', storeId: 'claude.native', revision: 'alpha' }, cli: fallback.binding! };
  assert.equal(allowanceBindingChanged(fallback, auth('beta', 20)), true);
  assert.equal(allowanceBindingChanged(fallback, auth('alpha', 20)), false);
});

test('a background poll shares an operator refresh already in progress', async () => {
  const original = globalThis.fetch;
  let calls = 0; let release!: (response: Response) => void;
  globalThis.fetch = async () => { calls++; return new Promise<Response>(resolve => { release = resolve; }); };
  try {
    const forced = refreshClaudeAllowance(true), poll = refreshClaudeAllowance();
    release(new Response(JSON.stringify(usage('current', 30))));
    assert.equal((await poll)?.binding?.revision, 'current');
    assert.equal((await forced)?.binding?.revision, 'current');
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});
