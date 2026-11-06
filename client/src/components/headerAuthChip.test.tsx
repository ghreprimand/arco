import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useAppStore } from '../stores/appStore';

// The auth chip panel closes on an outside press or Escape, stays open for a
// press inside, and keeps a sign-in poll running after it closes.

test('the auth chip panel closes on an outside click or Escape and keeps polling', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
  const names = ['window', 'document', 'localStorage', 'HTMLElement', 'Element', 'Node', 'navigator', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'] as const;
  const previous = Object.fromEntries(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: dom.window },
    document: { configurable: true, value: dom.window.document },
    localStorage: { configurable: true, value: dom.window.localStorage },
    HTMLElement: { configurable: true, value: dom.window.HTMLElement },
    Element: { configurable: true, value: dom.window.Element },
    Node: { configurable: true, value: dom.window.Node },
    navigator: { configurable: true, value: dom.window.navigator },
    getComputedStyle: { configurable: true, value: dom.window.getComputedStyle.bind(dom.window) },
    requestAnimationFrame: { configurable: true, value: (fn: FrameRequestCallback) => { fn(0); return 1; } },
    cancelAnimationFrame: { configurable: true, value: () => {} },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(String(url));
    if (String(url).includes('auth-login')) return { json: async () => ({ command: 'claude auth login --claudeai' }) };
    return { json: async () => ({ claude: { loggedIn: false, cli: { loggedIn: false, checkedAt: Date.now() } } }) };
  }) as typeof fetch;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  const { HeaderAuthChip } = await import('./HeaderAuthChip.js');
  const host = dom.window.document.createElement('div');
  dom.window.document.body.append(host);
  const root: Root = createRoot(host);
  const now = Date.now();
  useAppStore.setState({
    activeJobId: null,
    jobs: {},
    showSettings: false,
    settings: { claude: { transport: 'cli' }, enabledProviders: { claude: true } } as never,
    authStatus: { claude: { loggedIn: false, cli: { loggedIn: false, checkedAt: now } } } as never,
  });
  try {
    await act(async () => { root.render(createElement(HeaderAuthChip)); });
    const button = () => host.querySelector('button') as HTMLButtonElement;
    const panel = () => host.querySelector('[data-testid="header-auth-popover"]');
    await act(async () => { button().click(); });
    assert.ok(panel(), 'the panel opens from the chip');
    await act(async () => { panel()!.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true })); });
    assert.ok(panel(), 'a press inside the panel leaves it open');
    await act(async () => { dom.window.document.body.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true })); });
    assert.equal(panel(), null, 'a press outside closes the panel');
    await act(async () => { button().click(); });
    const signIn = [...host.querySelectorAll('button')].find((item) => item.textContent === 'SIGN IN TO CLAUDE CLI')!;
    await act(async () => { signIn.click(); });
    assert.equal(calls[0], '/api/auth-login?provider=claude');
    assert.match(host.textContent ?? '', /claude auth login --claudeai/);
    await act(async () => { dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    assert.equal(panel(), null);
    assert.equal(dom.window.document.activeElement, button(), 'Escape returns focus to the chip');
    await act(async () => { await new Promise((done) => setTimeout(done, 1600)); });
    assert.ok(calls.includes('/api/auth-status'), 'closing the panel does not stop the sign-in poll');
  } finally {
    await act(async () => { root.unmount(); });
    globalThis.fetch = previousFetch;
    for (const name of names) {
      const descriptor = previous[name];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  }
});
