import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { transform } from 'esbuild';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';

test('B157: Home and guide controls work when browser storage throws', async () => {
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: 'http://localhost' });
  const previous = Object.getOwnPropertyDescriptors(globalThis);
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true,
    localStorage: { getItem() { throw new Error('Storage unavailable'); }, setItem() { throw new Error('Storage unavailable'); } },
    fetch: async (url: string) => Response.json(url === '/api/projects' ? { projects: [], roots: [] } : url === '/api/chats' ? { chats: [] } : { clusters: [] }),
  };
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const require = createRequire(import.meta.url);
  const state = { settings: {}, authStatus: {}, jobs: {}, clusters: {} };
  const store = Object.assign((selector: any) => selector(state), { getState: () => state });
  const nullComponents = new Set(['./ProjectCard', './LocationDialog', './AddProject', './HomeStatus']);
  const mockedRequire = (name: string) => {
    if (name.endsWith('/appStore')) return { useAppStore: store };
    if (name.endsWith('/TabStatusChip')) return { TabStatusChip: () => null, useTabStatus: () => 'idle' };
    if (name.endsWith('/startupStore')) return { useStartupStore: { getState: () => ({}) } };
    if (name.endsWith('/waitingQuestion')) return { hasWaitingQuestion: () => false };
    if (name.endsWith('/modelCatalog')) return { useModelCatalogs: () => ({ claude: [], codex: [] }) };
    if (name.endsWith('/keepInWindow')) return { useKeepInWindow: () => ({ current: null }) };
    if (nullComponents.has(name)) return new Proxy({}, { get: () => () => null });
    return require(name);
  };
  const result = await transform(await readFile(new URL('./HomeView.tsx', import.meta.url), 'utf8'), { loader: 'tsx', format: 'cjs', jsx: 'automatic' });
  const module = { exports: {} as { HomeView: React.ComponentType<any> } };
  new Function('require', 'module', 'exports', result.code)(mockedRequire, module, module.exports);
  const root = createRoot(dom.window.document.getElementById('root')!);
  try {
    await act(async () => root.render(React.createElement(module.exports.HomeView)));
    assert.ok(dom.window.document.body.textContent?.includes('Welcome back'));
    const hide = dom.window.document.querySelector<HTMLButtonElement>('[aria-label="Hide the getting started guide"]');
    assert.ok(hide);
    await act(async () => { hide.click(); });
    assert.equal(dom.window.document.querySelector('[aria-label="Getting started"]'), null);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const key of Object.keys(globals)) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key]);
      else delete (globalThis as any)[key];
    }
  }
});
