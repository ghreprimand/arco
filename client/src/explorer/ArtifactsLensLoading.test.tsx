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
