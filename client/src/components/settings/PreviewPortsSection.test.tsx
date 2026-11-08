import assert from 'node:assert/strict';
import { test } from 'node:test';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { useAppStore } from '../../stores/appStore';

test('LA16: PREVIEW PORTS locks its draft until a pending save succeeds or fails', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, React, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map([...Object.keys(globals), 'fetch'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const initial = useAppStore.getState();
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { PreviewPortsSection } = await import('./PreviewPortsSection');
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  let finish!: (response: unknown) => void;
  const requests: string[] = [];
  globalThis.fetch = ((_url: unknown, options?: RequestInit) => { requests.push(String(options?.body)); return new Promise<unknown>(resolve => { finish = resolve; }); }) as unknown as typeof fetch;
  useAppStore.setState({ settings: { previewPorts: '4400-4402' } as never, setSettings: settings => useAppStore.setState({ settings }) });
  try {
    await act(async () => root.render(<PreviewPortsSection />));
    const input = container.querySelector('input')!, save = container.querySelector('button')!;
    assert.equal(input.disabled, false);
    await act(async () => save.click());
    assert.deepEqual(requests.map(body => JSON.parse(body)), [{ previewPorts: '4400-4402' }]);
    assert.equal(input.disabled, true, 'typing a new range while SAVE is pending must be prevented');
    assert.equal(save.disabled, true);
    await act(async () => finish({ ok: true, json: async () => ({ previewPorts: '4400-4402' }) }));
    assert.equal(input.disabled, false); assert.match(container.textContent!, /Saved for new previews/);
    await act(async () => save.click());
    assert.equal(input.disabled, true);
    await act(async () => finish({ ok: false, json: async () => ({ error: 'Fixture refused' }) }));
    assert.equal(input.disabled, false); assert.equal(save.disabled, false);
    assert.equal(input.value, '4400-4402'); assert.match(container.textContent!, /Fixture refused/);
  } finally {
    await act(async () => root.unmount()); useAppStore.setState(initial, true); dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
