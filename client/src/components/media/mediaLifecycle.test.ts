import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { transform } from 'esbuild';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';

for (const [file, name, control] of [
  ['AudioEditor/AudioOpsPanel.tsx', 'AudioOpsPanel', 'media.op-normalize'],
  ['VideoEditor/VideoOpsPanel.tsx', 'VideoOpsPanel', 'media.video-op-convert'],
  ['MediaStemsControls.tsx', 'MediaStemsControls', 'media.op-stems'],
]) for (const replace of [false, true]) test(`B185: ${name} cancels on ${replace ? 'source replacement' : 'unmount'}`, async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  const previous = Object.getOwnPropertyDescriptors(globalThis);
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  let signal: AbortSignal | undefined;
  let finish!: (value: unknown) => void;
  const request = (opts: { signal: AbortSignal }) => { signal = opts.signal; return new Promise(resolve => { finish = resolve; }); };
  const require = createRequire(import.meta.url);
  const mockedRequire = (id: string) => {
    if (id === 'react' || id === 'react/jsx-runtime' || id === '@arco/shared') return require(id);
    if (id.endsWith('postMediaOp')) return { postMediaOp: request, postMediaStems: request, postMediaInspect: request };
    if (id.endsWith('DirectoryPicker')) return { useDirectoryPicker: () => ({ pick: async () => null, pickerElement: null }) };
    return new Proxy({}, { get: () => () => null });
  };
  const source = await readFile(new URL(file, import.meta.url), 'utf8');
  const output = await transform(source, { loader: 'tsx', format: 'cjs', jsx: 'automatic' });
  const module = { exports: {} as Record<string, React.ComponentType<any>> };
  new Function('require', 'module', 'exports', output.code)(mockedRequire, module, module.exports);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(dom.window.document.getElementById('root')!);
  const props = (diskPath: string) => ({ diskPath, source: { diskPath, fileContext: { cwd: '/fixture', workflowId: 'fixture' } }, fileContext: { cwd: '/fixture', workflowId: 'fixture' }, getRegion: () => null, enabled: true, saveDir: '', setSaveDir() {}, pick: async () => null });
  try {
    await act(async () => root.render(React.createElement(module.exports[name], props('source.wav'))));
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>(`[data-help="${control}"]`)!.click());
    assert.ok(signal);
    await act(async () => root.render(replace ? React.createElement(module.exports[name], props('replacement.wav')) : null));
    assert.equal(signal.aborted, true);
  } finally {
    if (finish) await act(async () => finish({ ok: false, error: 'fixture ended' }));
    await act(async () => root.unmount()); dom.window.close();
    for (const key of Object.keys(globals)) { if (previous[key]) Object.defineProperty(globalThis, key, previous[key]); else Reflect.deleteProperty(globalThis, key); }
  }
});
