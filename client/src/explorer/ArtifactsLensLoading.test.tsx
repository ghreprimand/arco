import { test } from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';

test('artifacts render while project documents are still loading', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, React, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map([...Object.keys(globals), 'fetch'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  let finishDocs!: (response: Response) => void;
  const pendingDocs = new Promise<Response>(resolve => { finishDocs = resolve; });
  globalThis.fetch = async input => String(input).includes('/docs') ? pendingDocs : Response.json({ entries: [{ path: '/projects/fixture/.arco/workflows/fixture/artifacts/review.md', name: 'review.md', size: 1, mtime: Date.now(), workflowId: 'fixture', tabTitle: 'Fixture', provider: 'fixture', project: 'fixture', cwd: '/projects/fixture' }] });
  const { createRoot } = await import('react-dom/client');
  const { ArtifactsLens } = await import('./ArtifactsLens');
  const root = createRoot(document.getElementById('root')!);
  try {
    await act(async () => root.render(<ArtifactsLens focusTick={0} onOpen={() => {}} onRevealInTree={() => {}} />));
    assert.match(document.body.textContent!, /review.md/);
    assert.match(document.body.textContent!, /Loading project documents/);
    await act(async () => finishDocs(Response.json({ entries: [], partial: true })));
    assert.match(document.body.textContent!, /Showing the newest 0; open a project for more/);
    assert.doesNotMatch(document.body.textContent!, /Loading project documents/);
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});

for (const endpoint of ['docs', 'artifacts'] as const) for (const failure of ['http', 'network', 'shape'] as const) {
  test(`${endpoint} ${failure} failure keeps the other artifact list usable`, async () => {
    const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
    const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, React, IS_REACT_ACT_ENVIRONMENT: true };
    const previous = new Map([...Object.keys(globals), 'fetch'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    globalThis.fetch = async input => {
      if (String(input).endsWith('/' + endpoint)) {
        if (failure === 'network') throw new Error('Synthetic request failed');
        return failure === 'http' ? Response.json({ error: 'Unavailable' }, { status: 503 }) : Response.json({});
      }
      const path = endpoint === 'docs' ? '/projects/fixture/.arco/workflows/fixture/artifacts/review.md' : '/projects/fixture/docs/guide.md';
      return Response.json({ entries: [{ path, name: endpoint === 'docs' ? 'review.md' : 'guide.md', rel: 'docs/guide.md', size: 1, mtime: Date.now(), workflowId: 'fixture', tabTitle: 'Fixture', provider: 'fixture', project: 'fixture', cwd: '/projects/fixture' }] });
    };
    const { createRoot } = await import('react-dom/client');
    const { ArtifactsLens } = await import('./ArtifactsLens');
    const root = createRoot(document.getElementById('root')!);
    try {
      await act(async () => root.render(<ArtifactsLens focusTick={0} onOpen={() => {}} onRevealInTree={() => {}} />));
      assert.match(document.body.textContent!, endpoint === 'docs' ? /review.md/ : /guide.md/);
      assert.match(document.body.textContent!, endpoint === 'docs' ? /Project documents could not be loaded/ : /Workflow artifacts could not be loaded/);
      assert.doesNotMatch(document.body.textContent!, /Loading/);
      globalThis.fetch = async () => Response.json({ entries: [] });
      await act(async () => root.render(<ArtifactsLens focusTick={1} onOpen={() => {}} onRevealInTree={() => {}} />));
      assert.doesNotMatch(document.body.textContent!, /could not be loaded|Loading/);
      assert.match(document.body.textContent!, /No artifacts found/);
      assert.match(document.body.textContent!, /No project documents found/);
    } finally {
      await act(async () => root.unmount()); dom.window.close();
      for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
    }
  });
}
