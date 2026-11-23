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
const storage = useAppStore.persist.getOptions().storage;
useAppStore.persist.setOptions({ storage: { getItem: () => null, setItem() {}, removeItem() {} } });
after(async () => {
  useAppStore.setState(initial, true);
  useAppStore.persist.setOptions({ storage });
  dom.window.close();
  for (const [name, descriptor] of before) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
});

let researchSignIn: 'missing' | 'ready' = 'missing';
async function mounted(pin: boolean, check: (container: HTMLElement, requests: Array<{ url: string; patch?: any }>) => Promise<void>, research = false) {
  const requests: Array<{ url: string; patch?: any }> = [];
  useAppStore.setState({
    setSettings: (settings) => useAppStore.setState({ settings }),
    settings: { enabledProviders: research ? { 'antigravity-cli': true } : {}, autoHandoffDefaults: { enabled: true, mode: 'fresh-summarizer', afterCompactions: 5 }, ...(pin ? { handoffSummarizer: { provider: 'claude', model: 'sonnet', effort: 'medium' } } : {}) } as never,
    activeJobId: null, activeClusterId: 'settings-fixture', jobs: {},
    clusters: { 'settings-fixture': { clusterId: 'settings-fixture', cwd: '/fixture/project', members: [] } } as never,
    authStatus: { claude: { loggedIn: true } } as never,
  });
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const patch = init?.method === 'POST' ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url: String(url), patch });
    if (research && String(url) === '/api/diagnostics/research-sandbox') return { ok: true, json: async () => ({ gemini: true, geminiSignIn: researchSignIn }) };
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

test('Cursor LOG IN in Settings runs the in-app sign-in at its row, not a bare command', async () => {
  const saved = useAppStore.getState().authStatus;
  useAppStore.setState({ authStatus: { claude: { loggedIn: true }, cursor: { loggedIn: false, error: "Cursor's saved sign-in has no session token." } } as never });
  const session = { provider: 'cursor', status: 'pending', needsCode: false, startedAt: Date.now(), url: 'https://cursor.example/login?id=fixture' };
  const realFetch = globalThis.fetch;
  try {
    await mounted(false, async (container, requests) => {
      const page = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Providers and models');
      assert.ok(page);
      await act(async () => page.click());
      const inner = globalThis.fetch;
      globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
        if (String(url).startsWith('/api/auth-login')) {
          requests.push({ url: String(url) });
          return { ok: true, json: async () => ({ started: true, command: 'env NO_OPEN_BROWSER=1 cursor-agent login', session }) };
        }
        return inner(url as string, init);
      }) as typeof fetch;
      const row = [...container.querySelectorAll('span')].find((s) => s.textContent === 'CURSOR (ACP)')?.closest('div')?.parentElement;
      const login = [...(row?.querySelectorAll('button') ?? [])].find((b) => b.textContent === 'LOG IN');
      assert.ok(login, 'the Cursor row offers LOG IN');
      await act(async () => login.click());
      assert.ok(requests.some((r) => r.url === '/api/auth-login?provider=cursor&inApp=1'), requests.map((r) => r.url).join(', '));
      const flow = container.querySelector('[data-testid="settings-cursor-login"]');
      assert.ok(flow, 'the sign-in shows at the Cursor row');
      assert.equal(flow.querySelector('a')?.getAttribute('href'), session.url);
      assert.match(flow.textContent ?? '', /PREFER A TERMINAL\?/);
      assert.doesNotMatch(login.textContent ?? '', /WAITING/);
    });
  } finally {
    globalThis.fetch = realFetch;
    useAppStore.setState({ authStatus: saved });
  }
});

test('a finished Cursor sign-in in Settings publishes the explicit check to the shared status', async () => {
  const saved = useAppStore.getState().authStatus;
  useAppStore.setState({ authStatus: { claude: { loggedIn: true }, cursor: { loggedIn: false } } as never });
  const realFetch = globalThis.fetch;
  try {
    await mounted(false, async (container, requests) => {
      const page = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Providers and models');
      assert.ok(page);
      await act(async () => page.click());
      const inner = globalThis.fetch;
      globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
        const u = String(url);
        if (u.startsWith('/api/auth-login')) {
          requests.push({ url: u });
          return { ok: true, json: async () => ({ started: true, command: 'cursor-agent login', session: { provider: 'cursor', status: 'completed', needsCode: false, startedAt: Date.now() } }) };
        }
        if (u === '/api/connections/check?provider=cursor') {
          requests.push({ url: u });
          return { ok: true, json: async () => ({ provider: 'cursor', status: { loggedIn: true, apiProvider: 'cursor-session' } }) };
        }
        if (u === '/api/cursor/catalog?force=1') {
          requests.push({ url: u });
          return { ok: true, json: async () => ({ models: [{ id: 'fixture-model', label: 'Fixture model' }] }) };
        }
        return inner(url as string, init);
      }) as typeof fetch;
      const row = [...container.querySelectorAll('span')].find((s) => s.textContent === 'CURSOR (ACP)')?.closest('div')?.parentElement;
      const login = [...(row?.querySelectorAll('button') ?? [])].find((b) => b.textContent === 'LOG IN');
      assert.ok(login);
      await act(async () => { login.click(); await new Promise((resolve) => setTimeout(resolve, 20)); });
      assert.ok(requests.some((r) => r.url === '/api/connections/check?provider=cursor'), requests.map((r) => r.url).join(', '));
      assert.equal(useAppStore.getState().authStatus?.cursor?.loggedIn, true, 'the top bar and pickers read the shared status');
      assert.ok(requests.some((r) => r.url === '/api/cursor/catalog?force=1'));
      assert.equal(useAppStore.getState().cursorCatalog?.models[0]?.id, 'fixture-model');
      assert.equal(container.querySelector('[data-testid="settings-cursor-login-note"]'), null);
    });
  } finally {
    globalThis.fetch = realFetch;
    useAppStore.setState({ authStatus: saved });
  }
});

test('Antigravity LOG IN in Settings relays the browser link and code prompt at its row', async () => {
  const saved = useAppStore.getState().authStatus;
  useAppStore.setState({ authStatus: { claude: { loggedIn: true }, 'antigravity-cli': { loggedIn: false, probeFailed: true } } as never });
  const realFetch = globalThis.fetch;
  try {
    await mounted(false, async (container, requests) => {
      const page = [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Providers and models');
      assert.ok(page); await act(async () => page.click());
      const inner = globalThis.fetch;
      globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
        if (String(url).startsWith('/api/auth-login')) {
          requests.push({ url: String(url) });
          return { ok: true, json: async () => ({ started: true, command: 'agy acp --login', session: { provider: 'antigravity-cli', status: 'pending', needsCode: true, awaitingCode: true, startedAt: Date.now(), url: 'https://example.invalid/authorize' } }) };
        }
        return inner(url as string, init);
      }) as typeof fetch;
      const row = [...container.querySelectorAll('[data-help="settings.authentication"] span')].find(s => s.textContent === 'ANTIGRAVITY CLI')?.closest('div')?.parentElement;
      const login = [...(row?.querySelectorAll('button') ?? [])].find(b => b.textContent === 'LOG IN');
      assert.ok(login); await act(async () => login.click());
      assert.ok(requests.some(r => r.url === '/api/auth-login?provider=antigravity-cli&inApp=1'));
      const flow = container.querySelector('[data-testid="settings-antigravity-login"]');
      assert.ok(flow); assert.equal(flow.querySelector('a')?.getAttribute('href'), 'https://example.invalid/authorize');
      assert.ok(flow.querySelector('input')); assert.match(flow.textContent ?? '', /PREFER A TERMINAL\?/);
    });
  } finally { globalThis.fetch = realFetch; useAppStore.setState({ authStatus: saved }); }
});


test('a completed Antigravity login closes its Settings flow and publishes signed-in status', async () => {
  const realFetch = globalThis.fetch;
  try {
    await mounted(false, async (container) => {
      const page = [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Providers and models');
      assert.ok(page); await act(async () => page.click());
      const inner = globalThis.fetch;
      globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
        const u = String(url);
        if (u.startsWith('/api/auth-login?provider=antigravity-cli')) return { ok: true, json: async () => ({ started: true, session: { provider: 'antigravity-cli', status: 'completed', needsCode: true, startedAt: Date.now() } }) };
        if (u === '/api/connections/check?provider=antigravity-cli') return { ok: true, json: async () => ({ provider: 'antigravity-cli', status: { loggedIn: true } }) };
        return inner(url as string, init);
      }) as typeof fetch;
      const row = [...container.querySelectorAll('[data-help="settings.authentication"] span')].find(s => s.textContent === 'ANTIGRAVITY CLI')?.closest('div')?.parentElement;
      const login = [...(row?.querySelectorAll('button') ?? [])].find(b => b.textContent === 'LOG IN');
      assert.ok(login); await act(async () => { login.click(); await new Promise(resolve => setTimeout(resolve, 20)); });
      assert.equal(useAppStore.getState().authStatus?.['antigravity-cli']?.loggedIn, true);
      assert.equal(container.querySelector('[data-testid="settings-antigravity-login"]'), null);
    });
  } finally { globalThis.fetch = realFetch; }
});


test('a completed Gemini research login closes its Settings flow and shows the ready row', async () => {
  const realFetch = globalThis.fetch;
  try {
    await mounted(false, async (container) => {
      const page = [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Providers and models');
      assert.ok(page); await act(async () => page.click());
      const inner = globalThis.fetch;
      globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
        if (String(url).startsWith('/api/auth-login?provider=gemini-research')) { researchSignIn = 'ready'; return { ok: true, json: async () => ({ started: true, session: { provider: 'gemini-research', status: 'completed', needsCode: true, startedAt: Date.now() } }) }; }
        return inner(url as string, init);
      }) as typeof fetch;
      const row = container.querySelector('[data-testid="settings-gemini-research"]')!;
      const login = [...row.querySelectorAll('button')].find(b => b.textContent?.includes('LOG IN'));
      assert.ok(login); await act(async () => { login.click(); await new Promise(resolve => setTimeout(resolve, 20)); });
      assert.equal(container.querySelector('[data-testid="settings-gemini-research-login"]'), null);
      assert.match(row.textContent ?? '', /authenticated|LIVE/i);
    }, true);
  } finally { globalThis.fetch = realFetch; }
});
