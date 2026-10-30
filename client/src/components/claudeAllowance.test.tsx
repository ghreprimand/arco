import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, createElement, Fragment } from 'react';
import { createRoot } from 'react-dom/client';
import type { ArcoSettings, AuthStatusByProvider, UsageInfo } from '@arco/shared';
import { useAppStore } from '../stores/appStore';
import { UsageBar } from './UsageBar';
import { HeaderAuthChip } from './HeaderAuthChip';

test('allowance fallback, refresh and stale metadata preserve execution authentication and saved work', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const globals = Object.getOwnPropertyDescriptors(globalThis), before = useAppStore.getState();
  const storage = useAppStore.persist.getOptions().storage;
  const native = { source: 'claude-native', storeId: 'claude.native', revision: 'native-fixture' } as const;
  const cli = { source: 'claude-cli', storeId: 'claude-cli-default', revision: 'cli-fixture' } as const;
  const auth = Object.fromEntries(['claude', 'codex', 'cursor', 'ollama', 'github', 'llamacpp', 'lmstudio', 'strata', 'deepseek'].map(id => [id, id === 'claude' ? {
    loggedIn: true, native: { state: 'present', credentialsPresent: true, execution: 'unverified', checkedAt: 1, binding: native }, cli: { loggedIn: true, checkedAt: 1, binding: cli },
  } : { loggedIn: false }])) as unknown as AuthStatusByProvider;
  let result: UsageInfo = { session: { utilization: 55, resetsAt: null }, weekly: null, fetchedAt: Date.now(), checkedAt: Date.now(), subscriptionType: null,
    source: 'claude-cli', binding: cli, identity: { state: 'unknown' }, available: true, freshness: 'fresh', fallback: true };
  const requests: string[] = [];
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: dom.window }, document: { configurable: true, value: dom.window.document }, localStorage: { configurable: true, value: dom.window.localStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true }, fetch: { configurable: true, value: async (url: string) => { requests.push(url); assert.equal(url, '/api/usage?force=1'); return new Response(JSON.stringify(result)); } },
  });
  useAppStore.persist.setOptions({ storage: { getItem: () => null, setItem() {}, removeItem() {} } });
  useAppStore.setState({ authStatus: auth, settings: { claude: { transport: 'native' }, enabledProviders: { claude: true, codex: false, cursor: false, ollama: false } } as ArcoSettings, jobs: {}, activeJobId: null, usage: null });
  useAppStore.getState().createJob('fixture', { name: 'Saved fixture', workingDirectory: '/projects/fixture', primaryProvider: 'claude', primaryModel: 'fixture', primaryEffort: 'low', claudeTransport: 'native', skipPermissions: false });
  const savedJob = JSON.stringify(useAppStore.getState().jobs.fixture), savedAuth = JSON.stringify(auth);
  function Surface() { const value = useAppStore(s => s.usage); return createElement(Fragment, null, createElement(HeaderAuthChip), createElement(UsageBar, { usage: value })); }
  const root = createRoot(dom.window.document.getElementById('root')!);
  const text = () => dom.window.document.body.textContent!;
  const clickCheck = async () => {
    const button = [...dom.window.document.querySelectorAll('button')].find(b => b.textContent === 'CHECK ALLOWANCE NOW')!;
    assert.ok(button); await act(async () => { button.focus(); button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
  };
  try {
    await act(async () => root.render(createElement(Surface)));
    const dot = dom.window.document.querySelector<HTMLAnchorElement>('a[aria-label="C usage page"]')!;
    await act(async () => dot.focus());
    await clickCheck();
    assert.match(text(), /Allowance source: CLI OAuth credentials/);
    assert.match(text(), /Allowance account: unknown/);
    assert.match(text(), /does not establish Native account identity/);
    result = { ...result, available: false, stale: true, freshness: 'stale', error: 'fixture allowance network failure' };
    await clickCheck();
    assert.match(text(), /Showing an older allowance snapshot/); assert.match(text(), /55%/);
    assert.match(text(), /Allowance meter: unavailable/); assert.doesNotMatch(text(), /AUTH:/);
    result = { session: null, weekly: null, subscriptionType: null, available: false, stale: true, freshness: 'stale', source: 'unavailable', fetchedAt: Date.now(), checkedAt: Date.now(), error: 'Credentials changed while checking allowance. Check again.' };
    await clickCheck();
    assert.doesNotMatch(text(), /Showing an older allowance snapshot/);
    assert.equal(JSON.stringify(useAppStore.getState().authStatus), savedAuth);
    assert.equal(JSON.stringify(useAppStore.getState().jobs.fixture), savedJob);
    assert.deepEqual(requests, ['/api/usage?force=1', '/api/usage?force=1', '/api/usage?force=1']);
  } finally {
    await act(async () => root.unmount()); useAppStore.setState(before, true); useAppStore.persist.setOptions({ storage });
    for (const name of ['window', 'document', 'localStorage', 'IS_REACT_ACT_ENVIRONMENT', 'fetch']) { if (globals[name]) Object.defineProperty(globalThis, name, globals[name]); else Reflect.deleteProperty(globalThis, name); }
    dom.window.close();
  }
});
