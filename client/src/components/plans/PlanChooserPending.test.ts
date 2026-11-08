import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { transform } from 'esbuild';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';

for (const scenario of ['edit', 'reopen', 'unchanged'] as const) test(`LA01: plan create preserves the ${scenario} form instance`, async () => {
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
    if (name.endsWith('/format')) return {};
    if (name.endsWith('/PublicProjectBox')) return { PublicProjectBox: () => null };
    if (name.endsWith('/publicProject')) return { usePublicProject: () => ({ checked: false }), rememberPublicChoice: async () => false };
    throw new Error(name);
  }, module, module.exports);
  let resolveSave!: (r: Response) => void;
  let sent: any;
  const saved = new Promise<Response>(resolve => { resolveSave = resolve; });
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    if (init?.method === 'POST') { sent = JSON.parse(String(init.body)); return saved; }
    return Response.json({ plans: [] });
  };
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(dom.window.document.getElementById('root')!);
  const attached: any[] = [];
  const click = async (label: string) => act(async () => {
    const button = [...dom.window.document.querySelectorAll('button')].find(b => b.textContent === label);
    assert.ok(button, label); button.click();
  });
  const edit = async (selector: 'input' | 'textarea', value: string) => act(async () => {
    const input = dom.window.document.querySelector(selector)!;
    const proto = selector === 'input' ? dom.window.HTMLInputElement.prototype : dom.window.HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value);
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  try {
    await act(async () => root.render(React.createElement(module.exports.PlanChooser, { cwd: '/projects/fixture', onAttach: (p: any) => attached.push(p), onAllPlans() {} })));
    await click('+ NEW PLAN'); await edit('input', 'Original'); await edit('textarea', 'OLD draft');
    await click('CREATE AND ATTACH');
    assert.equal(sent.body, 'OLD draft');
    if (scenario === 'reopen') { await click('CANCEL'); await click('+ NEW PLAN'); }
    if (scenario !== 'unchanged') { await edit('input', 'Later title'); await edit('textarea', 'NEW unsaved words'); }
    await act(async () => { resolveSave(Response.json({ plan: { id: 'saved-plan', title: 'Original' } })); });
    if (scenario === 'unchanged') { assert.equal(attached.length, 1); assert.equal(dom.window.document.querySelector('textarea'), null); }
    else {
      assert.equal(dom.window.document.querySelector('textarea')?.value, 'NEW unsaved words');
      assert.equal(dom.window.document.querySelector('input')?.value, 'Later title');
      assert.equal(attached.length, 0);
    }
  } finally {
    await act(async () => root.unmount()); dom.window.close(); globalThis.fetch = oldFetch;
    for (const key of Object.keys(globals)) { if (previous[key]) Object.defineProperty(globalThis, key, previous[key]); else delete (globalThis as any)[key]; }
  }
});
