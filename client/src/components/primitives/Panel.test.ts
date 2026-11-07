import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { transform } from 'esbuild';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';

test('B187: rough panels attach their border and replace it on active redraw', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  const before = Object.getOwnPropertyDescriptors(globalThis);
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), ResizeObserver: class { observe() {} disconnect() {} }, IS_REACT_ACT_ENVIRONMENT: true };
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetWidth', { get: () => 160 });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetHeight', { get: () => 80 });
  const require = createRequire(import.meta.url);
  const mockedRequire = (id: string) => {
    if (id === 'react' || id === 'react/jsx-runtime') return require(id);
    if (id.endsWith('/appStore')) return { useAppStore: (pick: (s: unknown) => unknown) => pick({ settings: { themeId: 'fixture' } }) };
    if (id.endsWith('/registry')) return { DEFAULT_THEME_ID: 'fixture', THEME_REGISTRY: { fixture: { borderRenderer: 'rough', density: { borderWidth: '2px' } } } };
    if (id === 'roughjs') return { default: { svg: () => ({ generator: { rectangle: () => ({}) }, draw: () => dom.window.document.createElementNS('http://www.w3.org/2000/svg', 'g') }) } };
    throw new Error(`Unexpected dependency ${id}`);
  };
  const source = (await readFile(new URL('./Panel.tsx', import.meta.url), 'utf8')).replace("import('roughjs')", "Promise.resolve(require('roughjs'))");
  const output = await transform(source, { loader: 'tsx', format: 'cjs', jsx: 'automatic' });
  const module = { exports: {} as { Panel: React.ComponentType<{ active: boolean }> } };
  new Function('require', 'module', 'exports', output.code)(mockedRequire, module, module.exports);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(dom.window.document.getElementById('root')!);
  try {
    await act(async () => root.render(React.createElement(module.exports.Panel, { active: false })));
    const first = dom.window.document.querySelector('svg > g');
    assert.ok(first);
    await act(async () => root.render(React.createElement(module.exports.Panel, { active: true })));
    assert.equal(dom.window.document.querySelectorAll('svg > g').length, 1);
    assert.notEqual(dom.window.document.querySelector('svg > g'), first);
  } finally { await act(async () => root.unmount()); dom.window.close(); for (const key of Object.keys(globals)) { if (before[key]) Object.defineProperty(globalThis, key, before[key]); else Reflect.deleteProperty(globalThis, key); } }
});
