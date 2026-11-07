import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { usePlanRefs } from './planRefs.js';

test('a late reference list from a previous plan does not replace the current list', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost' });
  const previous = Object.getOwnPropertyDescriptors(globalThis);
  const pending = new Map<string, (response: Response) => void>();
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: (url: string) => new Promise<Response>(resolve => pending.set(new URL(url, 'http://localhost').searchParams.get('planId')!, resolve)),
  };
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const View = ({ id }: { id: string }) => React.createElement('div', null, JSON.stringify(usePlanRefs('/fixture', id).refs));
  const root = createRoot(dom.window.document.getElementById('root')!);
  try {
    await act(async () => root.render(React.createElement(View, { id: 'a' })));
    await act(async () => root.render(React.createElement(View, { id: 'b' })));
    await act(async () => pending.get('b')!(Response.json({ refs: [{ slug: 'current' }] })));
    await act(async () => pending.get('a')!(Response.json({ refs: [{ slug: 'old' }] })));
    assert.match(dom.window.document.body.textContent ?? '', /current/);
    assert.doesNotMatch(dom.window.document.body.textContent ?? '', /old/);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const key of Object.keys(globals)) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key]); else delete (globalThis as any)[key];
    }
  }
});
