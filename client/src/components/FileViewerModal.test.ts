import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';

// Keep the real viewer/save lifecycle; replace rendering-only integrations.
async function viewer() {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('./FileViewerModal.tsx', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic',
    loader: { '.css': 'empty' },
    plugins: [{ name: 'viewer-fixtures', setup(build) {
      build.onResolve({ filter: /\.css$/ }, args => ({ path: args.path, namespace: 'style' }));
      build.onLoad({ filter: /.*/, namespace: 'style' }, () => ({ contents: '' }));
      build.onResolve({ filter: /^react$/, namespace: 'fixture' }, args => ({ path: args.path, external: true }));
      build.onResolve({ filter: /(?:CodeEditor|AiEditAffordance|WorkSurfaceControls)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path.endsWith('CodeEditor')
        ? `const React = require('react'); exports.CodeEditor = React.forwardRef((p, ref) => React.createElement('textarea', {value:p.value, readOnly:p.readOnly, onInput:e=>p.onChange(e.target.value)}));`
        : args.path.endsWith('WorkSurfaceControls')
          ? `exports.contentSurfaceSize = {}; exports.WorkSurfaceControls = () => null;`
          : `exports.AiEditAffordance = () => null;` }));
    } }],
  });
  const module = { exports: {} as { FileViewerModal: React.ComponentType<any> } };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  return module.exports.FileViewerModal;
}

test('B150: edits made during a pending save stay visible and require another save', async () => {
  const Component = await viewer();
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: 'http://localhost' });
  const previous = Object.getOwnPropertyDescriptors(globalThis);
  const install = (name: string, value: unknown) => Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  for (const key of ['window', 'document', 'HTMLElement', 'Event', 'navigator']) install(key, (dom.window as any)[key]);
  install('IS_REACT_ACT_ENVIRONMENT', true);
  let resolveSave!: (value: Response) => void;
  const writes: string[] = [];
  install('fetch', async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      writes.push(JSON.parse(init.body as string).content);
      return new Promise<Response>(resolve => { resolveSave = resolve; });
    }
    return Response.json({ type: 'text', content: 'initial', size: 7 });
  });
  const root = createRoot(dom.window.document.getElementById('root')!);
  try {
    await act(async () => { root.render(React.createElement(Component, { path: 'fixture.txt', editContext: { cwd: '/projects/fixture' }, initialEditing: true, onClose() {} })); });
    const edit = async (text: string) => act(async () => {
      const input = dom.window.document.querySelector('textarea')!;
      input.value = text;
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    const save = () => [...dom.window.document.querySelectorAll('button')].find(b => b.textContent?.trim() === 'SAVE')!;
    await edit('submitted');
    await act(async () => { save().click(); });
    assert.deepEqual(writes, ['submitted']);
    await edit('new unsaved text');
    await act(async () => { resolveSave(Response.json({ ok: true })); });
    assert.equal(dom.window.document.querySelector('textarea')?.value, 'new unsaved text');
    assert.equal(save().disabled, false);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const key of ['window', 'document', 'HTMLElement', 'Event', 'navigator', 'IS_REACT_ACT_ENVIRONMENT', 'fetch']) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key]);
      else delete (globalThis as any)[key];
    }
  }
});
