import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { ArcoSettings, AuthStatusByProvider, CodexUsageInfo, CursorUsageInfo } from '@arco/shared';
import { useAppStore } from '../stores/appStore';
import { UsageBar } from './UsageBar';

test('Codex and Cursor dropdowns show a provider title and their usage only', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const globals = Object.getOwnPropertyDescriptors(globalThis), before = useAppStore.getState();
  const storage = useAppStore.persist.getOptions().storage;
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: dom.window }, document: { configurable: true, value: dom.window.document }, localStorage: { configurable: true, value: dom.window.localStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  useAppStore.persist.setOptions({ storage: { getItem: () => null, setItem() {}, removeItem() {} } });
  const auth = Object.fromEntries(['claude', 'codex', 'cursor', 'ollama', 'github', 'llamacpp', 'lmstudio', 'strata', 'deepseek'].map(id => [id, { loggedIn: id === 'codex' || id === 'cursor' }])) as unknown as AuthStatusByProvider;
  const codex = { available: true, source: 'appserver', fetchedAt: Date.now(), rows: [{ label: '5h limit', value: '40% used Resets 3pm' }] } as unknown as CodexUsageInfo;
  const cursor = { available: true, totalTokens: 1200, eventCount: 3, chargedCents: 0, hardCapped: true } as unknown as CursorUsageInfo;
  useAppStore.setState({ authStatus: auth, jobs: {}, activeJobId: null, codexUsage: codex, cursorUsage: cursor,
    settings: { enabledProviders: { claude: false, codex: true, cursor: true, ollama: false } } as ArcoSettings });
  const root = createRoot(dom.window.document.getElementById('root')!);
  const text = () => dom.window.document.body.textContent!;
  try {
    await act(async () => root.render(createElement(UsageBar, { usage: null })));
    await act(async () => dom.window.document.querySelector<HTMLAnchorElement>('a[aria-label="Codex usage page"]')!.focus());
    assert.match(text(), /Codex/); assert.match(text(), /5h limit/); assert.match(text(), /40%/);
    assert.doesNotMatch(text(), /checked|OPEN CODEX ANALYTICS|CHECK NOW|Account|Allowance/);
    assert.equal(dom.window.document.querySelectorAll('[role="tooltip"] button').length, 1);
    await act(async () => dom.window.document.querySelector<HTMLAnchorElement>('a[aria-label="Cursor usage page"]')!.focus());
    assert.match(text(), /Cursor/); assert.match(text(), /1\.2k tokens/);
    assert.doesNotMatch(text(), /OPEN CURSOR DASHBOARD|polled|MONTH TO DATE/);
  } finally {
    await act(async () => root.unmount()); useAppStore.setState(before, true); useAppStore.persist.setOptions({ storage });
    for (const name of ['window', 'document', 'localStorage', 'IS_REACT_ACT_ENVIRONMENT']) { if (globals[name]) Object.defineProperty(globalThis, name, globals[name]); else Reflect.deleteProperty(globalThis, name); }
    dom.window.close();
  }
});

test('Ollama status details open on keyboard focus', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const globals = Object.getOwnPropertyDescriptors(globalThis), before = useAppStore.getState();
  const storage = useAppStore.persist.getOptions().storage;
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: dom.window }, document: { configurable: true, value: dom.window.document }, localStorage: { configurable: true, value: dom.window.localStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  useAppStore.persist.setOptions({ storage: { getItem: () => null, setItem() {}, removeItem() {} } });
  const auth = Object.fromEntries(['claude', 'codex', 'cursor', 'ollama', 'github', 'llamacpp', 'lmstudio', 'strata', 'deepseek'].map(id => [id, { loggedIn: id === 'ollama' }])) as unknown as AuthStatusByProvider;
  useAppStore.setState({
    authStatus: auth, jobs: {}, activeJobId: null, ollamaLive: { up: true, version: '0.0.0', fetchedAt: Date.now(), loadedModels: [{ name: 'qwen3:4b', expiresAt: null, sizeVram: null }] },
    settings: { enabledProviders: { claude: false, codex: false, cursor: false, ollama: true } } as ArcoSettings,
  });
  const root = createRoot(dom.window.document.getElementById('root')!);
  const text = () => dom.window.document.body.textContent!;
  try {
    await act(async () => root.render(createElement(UsageBar, { usage: null })));
    const focusable = dom.window.document.querySelector<HTMLElement>('[aria-label="Ollama status details"]');
    assert.ok(focusable);
    assert.equal(focusable!.tabIndex, 0);
    await act(async () => { focusable!.focus(); });
    assert.match(text(), /LOADED IN VRAM|qwen3:4b/);
  } finally {
    await act(async () => root.unmount()); useAppStore.setState(before, true); useAppStore.persist.setOptions({ storage });
    for (const name of ['window', 'document', 'localStorage', 'IS_REACT_ACT_ENVIRONMENT']) { if (globals[name]) Object.defineProperty(globalThis, name, globals[name]); else Reflect.deleteProperty(globalThis, name); }
    dom.window.close();
  }
});
