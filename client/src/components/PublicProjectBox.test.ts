import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { transform } from 'esbuild';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';

async function fixture(fetcher: typeof fetch) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  const previous = Object.getOwnPropertyDescriptors(globalThis);
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, localStorage: dom.window.localStorage, fetch: fetcher, IS_REACT_ACT_ENVIRONMENT: true };
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const require = createRequire(import.meta.url);
  const load = async (url: URL, mockedRequire: Function) => {
    const source = await readFile(url, 'utf8');
    const result = await transform(source, { loader: url.pathname.endsWith('.tsx') ? 'tsx' : 'ts', format: 'cjs', jsx: 'automatic' });
    const module = { exports: {} as any };
    new Function('require', 'module', 'exports', result.code)(mockedRequire, module, module.exports);
    return module.exports;
  };
  const choice = await load(new URL('../utils/publicProject.ts', import.meta.url), require);
  const box = await load(new URL('./PublicProjectBox.tsx', import.meta.url), (name: string) => name.endsWith('/publicProject') ? choice : require(name));
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(dom.window.document.getElementById('root')!);
  await act(async () => root.render(React.createElement(box.PublicProjectBox, { cwd: '/projects/fixture' })));
  return { dom, choice, cleanup: async () => {
    await act(async () => root.unmount()); dom.window.close();
    for (const key of Object.keys(globals)) { if (previous[key]) Object.defineProperty(globalThis, key, previous[key]); else delete (globalThis as any)[key]; }
  } };
}

test('LA12: RETRY SAVE resends the failed displayed choice and unblocks plan startup', async () => {
  let saved = false;
  const posts: boolean[] = [];
  const f = await fixture(async (url, init) => {
    if (init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)).value);
      if (posts.length === 1) return new Response('', { status: 503 });
      saved = posts.at(-1)!;
    }
    return Response.json(String(url).includes('/remote?') ? { state: 'none' } : { choice: saved });
  });
  try {
    const input = f.dom.window.document.querySelector('input')!;
    await act(async () => { input.click(); });
    assert.equal(input.checked, true);
    await assert.rejects(f.choice.rememberPublicChoice('/projects/fixture'), /Could not save/);
    const retry = [...f.dom.window.document.querySelectorAll('button')].find(b => b.textContent === 'RETRY SAVE');
    assert.ok(retry, 'a failed save offers a direct retry');
    await act(async () => { retry.click(); });
    assert.deepEqual(posts, [true, true]);
    await act(async () => { assert.equal(await f.choice.rememberPublicChoice('/projects/fixture'), true); });
    assert.equal(f.dom.window.document.querySelector('[role="alert"]'), null);
  } finally { await f.cleanup(); }
});
