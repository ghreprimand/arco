import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';

// Render the real review row and click handler, with synthetic store state.
test('B170: SEND TO AGENT preserves the composer draft', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let draft = 'Unsent operator instructions';
  const fixtures: Record<string, string> = {
    '../../stores/appStore': `exports.useAppStore = selector => selector(globalThis.__reviewFixtureStore);`,
    '../../stores/draftStore': `exports.readDraft = id => globalThis.__reviewFixtureStore.readDraft(id);`,
    '../SpawnDialog': 'exports.SpawnDialog = () => null;',
    '../FileViewerModal': 'exports.FileViewerModal = () => null;',
    './FilesTab': 'exports.EmptyState = () => null;',
  };
  const result = await build({
    entryPoints: [fileURLToPath(new URL('./ReviewTab.tsx', import.meta.url))], bundle: true, write: false,
    platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic',
    plugins: [{ name: 'review-fixtures', setup(build) {
      build.onResolve({ filter: /.*/ }, args => args.path in fixtures ? { path: args.path, namespace: 'fixture' } : undefined);
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: fixtures[args.path] }));
    } }],
  });
  const module = { exports: {} as { ReviewTab: React.ComponentType<any> } };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: 'http://localhost' });
  const previous = Object.getOwnPropertyDescriptors(globalThis);
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true,
    __reviewFixtureStore: { readDraft: () => draft, setDraft: (_id: string, text: string) => { draft = text; } },
    fetch: async () => Response.json({ contents: 'Review concerns' }),
  };
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const root = createRoot(dom.window.document.getElementById('root')!);
  try {
    await act(async () => root.render(React.createElement(module.exports.ReviewTab, { job: {
      id: 'review-fixture', config: { workingDirectory: '/projects/fixture' },
      reviews: [{ reviewId: 'saved-review', reviewer: { provider: 'claude', model: 'fixture', effort: 'low' }, startedAt: 1, completedAt: 2, verdict: 'PASS', artifactName: 'review.md' }],
    } })));
    await act(async () => { dom.window.document.querySelector('button')!.click(); });
    const send = [...dom.window.document.querySelectorAll('button')].find(b => b.textContent?.includes('SEND TO AGENT'))!;
    assert.ok(send);
    await act(async () => { send.click(); });
    assert.ok(draft.startsWith('Unsent operator instructions\n\n'), draft);
    assert.ok(draft.includes('Review concerns'));
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const key of Object.keys(globals)) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key]);
      else delete (globalThis as any)[key];
    }
  }
});
