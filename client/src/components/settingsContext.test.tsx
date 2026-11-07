import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import React, { act } from 'react';

import { JSDOM } from 'jsdom';
import { registerHooks } from 'node:module';
const css = registerHooks({ load(url, context, next) {
  return url.endsWith('.css') ? { format: 'module', source: 'export default {};', shortCircuit: true } : next(url, context);
} });
import { useAppStore } from '../stores/appStore';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
const names = ['window', 'document', 'navigator', 'localStorage', 'React', 'IS_REACT_ACT_ENVIRONMENT', 'fetch', 'requestAnimationFrame', 'cancelAnimationFrame'];
const before = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, localStorage: dom.window.localStorage, React, IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout })) Object.defineProperty(globalThis, key, { configurable: true, value, writable: true });
dom.window.HTMLElement.prototype.scrollTo = () => {};
dom.window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as never;
const { createRoot } = await import('react-dom/client');
const { SettingsPanel } = await import('./SettingsPanel');
css.deregister();
const initial = useAppStore.getState();
after(async () => {
  useAppStore.setState(initial, true);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  dom.window.close();
  for (const [name, descriptor] of before) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
});

async function mounted(pin: boolean, check: (container: HTMLElement, requests: Array<{ url: string; patch?: any }>) => Promise<void>) {
  const requests: Array<{ url: string; patch?: any }> = [];
  useAppStore.setState({
    setSettings: (settings) => useAppStore.setState({ settings }),
    settings: { enabledProviders: {}, autoHandoffDefaults: { enabled: true, mode: 'fresh-summarizer', afterCompactions: 5 }, ...(pin ? { handoffSummarizer: { provider: 'claude', model: 'sonnet', effort: 'medium' } } : {}) } as never,
    activeJobId: null, activeClusterId: 'settings-fixture', jobs: {},
    clusters: { 'settings-fixture': { clusterId: 'settings-fixture', cwd: '/fixture/project', members: [] } } as never,
    authStatus: { claude: { loggedIn: true } } as never,
  });
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const patch = init?.method === 'POST' ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url: String(url), patch });
    if (String(url) === '/api/auth-status') return { ok: true, json: async () => useAppStore.getState().authStatus };
    if (!patch && String(url) === '/api/settings') return { ok: true, json: async () => useAppStore.getState().settings };
    if (patch) {
      const current = { ...useAppStore.getState().settings, ...patch };
      if (patch.handoffSummarizer === null) delete current.handoffSummarizer;
      return { ok: true, json: async () => current };
    }
    return { ok: false, statusText: 'Fixture unavailable', json: async () => ({ error: 'Fixture unavailable' }) };
  }) as typeof fetch;
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(React.createElement(SettingsPanel, { onClose() {} })));
    const tab = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Agents and clusters');
    assert.ok(tab);
    await act(async () => tab.click());
    await check(container, requests);
  } finally { await act(async () => root.unmount()); container.remove(); }
}

test('B174: mounting an unpinned summarizer does not persist a pin', async () => {
  await mounted(false, async (_container, requests) => {
    assert.equal(requests.filter((r) => r.patch?.handoffSummarizer).length, 0);
    assert.equal(useAppStore.getState().settings?.handoffSummarizer, undefined);
  });
});

test('B174: CLEAR keeps the summarizer unpinned after normalization', async () => {
  await mounted(true, async (container, requests) => {
    const clear = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim().endsWith('CLEAR'));
    assert.ok(clear);
    await act(async () => clear.click());
    assert.equal(useAppStore.getState().settings?.handoffSummarizer, undefined);
    assert.deepEqual(requests.filter((r) => r.patch && 'handoffSummarizer' in r.patch).map((r) => r.patch.handoffSummarizer), [null]);
  });
});

test('B175: a selected cluster supplies the project folder to handoff prompt settings', async () => {
  await mounted(false, async (_container, requests) => {
    assert.ok(requests.some((r) => r.url === '/api/handoff-prompts?cwd=%2Ffixture%2Fproject'), requests.map((r) => r.url).join(', '));
  });
});
