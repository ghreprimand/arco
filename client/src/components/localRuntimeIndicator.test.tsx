import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { LocalRuntimeIndicator } from './LocalRuntimeStatus';
import { setProviderPanelOpen } from './providerPanelState';
import { useAppStore } from '../stores/appStore';
import type { ArcoSettings } from '@arco/shared';

test('one LOCAL card lists enabled programs, handles focus/tap/Escape and stays suppressed by versions', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const saved = Object.getOwnPropertyDescriptors(globalThis);
  const values = { window: dom.window, document: dom.window.document, Element: dom.window.Element, Node: dom.window.Node,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    ResizeObserver: class { observe() {} disconnect() {} }, IS_REACT_ACT_ENVIRONMENT: true };
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const before = useAppStore.getState(); const storage = useAppStore.persist.getOptions().storage;
  useAppStore.persist.setOptions({ storage: { getItem: () => null, setItem() {}, removeItem() {} } });
  const settings = { enabledProviders: { ollama: true, llamacpp: true, strata: true, deepseek: true, lmstudio: true } } as ArcoSettings;
  useAppStore.setState({ settings, localRuntimeStatus: { fetchedAt: 1, rows: [
    { provider: 'ollama', state: 'loaded', models: ['fixture-ollama'], modelExpiries: { 'fixture-ollama': new Date(Date.now() + 300_000).toISOString() } }, { provider: 'llamacpp', state: 'stopped', models: [] },
    { provider: 'strata', state: 'loaded', models: ['actual-model'] }, { provider: 'deepseek', state: 'down', models: [] },
  ] } });
  const root = createRoot(document.getElementById('root')!);
  const event = async (el: Element, type: string, detail = 0) => act(async () => el.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, detail })));
  try {
    await act(async () => root.render(createElement(LocalRuntimeIndicator)));
    const button = document.querySelector('button')!;
    assert.equal(button.textContent, 'LOCAL'); assert.equal(document.querySelectorAll('button').length, 1);
    assert.equal(button.dataset.localState, 'down', 'confirmed fault outranks loaded Strata');
    await act(async () => button.focus());
    assert.ok(document.querySelector('[role="tooltip"]'));
    await event(button, 'pointerout');
    assert.ok(document.querySelector('[role="tooltip"]'), 'pointer leave cannot dismiss a keyboard-focused card');
    assert.deepEqual([...document.querySelectorAll('[data-local-runtime]')].map(el => el.getAttribute('data-local-runtime')), ['ollama', 'llamacpp', 'strata', 'deepseek']);
    assert.match(document.body.textContent!, /fixture-ollama.*unloads in 5m/);
    assert.match(document.body.textContent!, /stopped - starts on demand/); assert.match(document.body.textContent!, /actual-model/); assert.doesNotMatch(document.body.textContent!, /LM Studio/);
    await act(async () => button.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    assert.equal(document.querySelector('[role="tooltip"]'), null); assert.equal(document.activeElement, button);
    await event(button, 'mouseover'); // Compatibility mouse event synthesized during a first touch.
    await event(button, 'pointerdown'); await event(button, 'click', 1);
    assert.ok(document.querySelector('[role="tooltip"]'), 'tap opens even if focus opened first');
    await event(document.body, 'mousedown'); assert.equal(document.querySelector('[role="tooltip"]'), null);
    await act(async () => useAppStore.setState({ localRuntimeStatus: { fetchedAt: 2, rows: [{ provider: 'ollama', state: 'down', models: [], detail: 'Daemon not reachable. Run ollama serve on this machine, or set OLLAMA_URL_BASE to point elsewhere.' }] } }));
    await event(button, 'pointerdown'); await event(button, 'click', 1);
    assert.match(document.body.textContent!, /Daemon not reachable.*ollama serve.*OLLAMA_URL_BASE/);
    await act(async () => setProviderPanelOpen(true)); await event(button, 'pointerover');
    assert.equal(document.querySelector('[role="tooltip"]'), null);
    await act(async () => setProviderPanelOpen(false));
    assert.equal(document.querySelector('[role="tooltip"]'), null, 'no stale card on versions close');
    await act(async () => useAppStore.setState({ settings: { enabledProviders: { ollama: false, llamacpp: false, strata: false, deepseek: false, lmstudio: true } } as ArcoSettings }));
    assert.equal(document.querySelector('button'), null, 'LM Studio alone never adds LOCAL');
  } finally {
    await act(async () => { setProviderPanelOpen(false); root.unmount(); });
    useAppStore.setState(before, true); useAppStore.persist.setOptions({ storage });
    for (const key of Object.keys(values)) { if (saved[key]) Object.defineProperty(globalThis, key, saved[key]); else Reflect.deleteProperty(globalThis, key); }
    dom.window.close();
  }
});
