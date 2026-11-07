import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { transform } from 'esbuild';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';

test('B167: leaving Genesis and scaffolding immediately both flush the edited seed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: 'http://localhost' });
  const previous = Object.getOwnPropertyDescriptors(globalThis);
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  dom.window.confirm = () => true;
  let resolveChoice!: (value: boolean) => void;
  const choice = new Promise<boolean>(resolve => { resolveChoice = resolve; });
  const require = createRequire(import.meta.url);
  const mockedRequire = (name: string) => {
    if (name === 'react' || name === 'react/jsx-runtime') return require(name);
    if (name.endsWith('/appStore')) return { useAppStore: (selector: any) => selector({ clearGenesisAssist() {} }) };
    if (name.endsWith('/publicProject')) return { rememberPublicChoice: () => choice };
    if (name.endsWith('/PublicProjectBox')) return { PublicProjectBox: () => null };
    throw new Error(`Unexpected dependency ${name}`);
  };
  const source = await readFile(new URL('./GenesisTab.tsx', import.meta.url), 'utf8');
  const result = await transform(source, { loader: 'tsx', format: 'cjs', jsx: 'automatic' });
  const module = { exports: {} as { GenesisTab: React.ComponentType<any> } };
  new Function('require', 'module', 'exports', result.code)(mockedRequire, module, module.exports);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(dom.window.document.getElementById('root')!);
  let saved: any;
  let scaffolded: any;
  const props = { job: { id: 'seed-fixture', config: { workingDirectory: '/projects/fixture' }, genesisSeed: { title: 'Initial', creative: true } },
    onSeedUpdate: (_id: string, seed: any) => { saved = seed; }, onScaffold: () => { scaffolded = saved; } };
  const editTitle = async (value: string) => act(async () => {
    const input = dom.window.document.querySelector('input[placeholder="Project name"]')!;
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    assert.equal((input as HTMLInputElement).value, value);
  });
  try {
    await act(async () => root.render(React.createElement(module.exports.GenesisTab, props)));
    await editTitle('Latest before leaving');
    await act(async () => root.render(null));
    assert.equal(saved?.title, 'Latest before leaving');
    await act(async () => root.render(React.createElement(module.exports.GenesisTab, props)));
    await editTitle('Latest before scaffold');
    const button = [...dom.window.document.querySelectorAll('button')].find(b => b.textContent?.includes('CREATE ALTERNATIVE'))!;
    assert.ok(button);
    await act(async () => { button.click(); });
    assert.equal(Boolean(scaffolded), false);
    assert.equal(dom.window.document.querySelector<HTMLInputElement>('input[placeholder="Project name"]')?.matches(':disabled'), true);
    await act(async () => { resolveChoice(false); });
    assert.equal(scaffolded?.title, 'Latest before scaffold');
    await act(async () => root.render(null));
    assert.equal(saved?.title, 'Latest before scaffold');
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const key of Object.keys(globals)) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key]);
      else delete (globalThis as any)[key];
    }
  }
});
