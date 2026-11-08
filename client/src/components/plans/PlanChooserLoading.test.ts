import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { transform } from 'esbuild';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';

test('100 plans load in one request, stay bounded, and fetch only the selected preview', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  const previous = Object.getOwnPropertyDescriptors(globalThis);
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const require = createRequire(import.meta.url);
  const source = await readFile(new URL('./PlanChooser.tsx', import.meta.url), 'utf8');
  const result = await transform(source, { loader: 'tsx', format: 'cjs', jsx: 'automatic' });
  const module = { exports: {} as { PlanChooser: React.ComponentType<any> } };
  new Function('require', 'module', 'exports', result.code)((name: string) => {
    if (name === 'react' || name === 'react/jsx-runtime') return require(name);
    if (name === '@arco/shared') return { hasGuardrails: () => false, insertGuardrails: (s: string) => s };
    if (name.endsWith('/format')) return { planRowSubtitle: () => 'Saved', splitAttachments: () => ({ active: [], past: [] }) };
    if (name.endsWith('/PublicProjectBox')) return { PublicProjectBox: () => null };
    if (name.endsWith('/publicProject')) return { usePublicProject: () => ({ checked: false }), rememberPublicChoice: async () => false };
    throw new Error(name);
  }, module, module.exports);
  const oldFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return String(url).includes('/body?') ? Response.json({ plan: { body: 'Selected body' } })
      : Response.json({ plans: Array.from({ length: 100 }, (_, i) => ({ id: `plan-${i}`, title: `Plan ${i}`, taskCount: i, attachments: [] })) });
  };
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(dom.window.document.getElementById('root')!);
  try {
    await act(async () => root.render(React.createElement(module.exports.PlanChooser, { cwd: '/projects/fixture', onAttach() {}, onAllPlans() {} })));
    assert.equal(calls.length, 1, 'listing must not fetch one body per plan');
    assert.match(dom.window.document.body.textContent!, /99 tasks/);
    const list = dom.window.document.querySelector('[data-testid="plan-chooser-list"]') as HTMLElement;
    assert.ok(list?.style.maxHeight, 'the list must have a height limit');
    assert.equal(list.style.overflowY, 'auto');
    await act(async () => dom.window.dispatchEvent(new dom.window.Event('focus')));
    assert.equal(calls.length, 1, 'window focus must not reload the whole list');
    await act(async () => (dom.window.document.querySelector('[aria-label="Preview Plan 99"]') as HTMLButtonElement).click());
    assert.equal(calls.length, 2); assert.match(calls[1], /planId=plan-99/);
    assert.match(dom.window.document.body.textContent!, /Selected body/);
  } finally {
    await act(async () => root.unmount()); dom.window.close(); globalThis.fetch = oldFetch;
    for (const key of Object.keys(globals)) { if (previous[key]) Object.defineProperty(globalThis, key, previous[key]); else delete (globalThis as any)[key]; }
  }
});
