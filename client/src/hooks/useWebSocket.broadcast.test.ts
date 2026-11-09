import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { transform } from 'esbuild';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';

test('B148: disconnected cluster broadcasts report failure without sending', async () => {
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: 'http://localhost' });
  const previous = Object.getOwnPropertyDescriptors(globalThis);
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    static OPEN = 1; static CONNECTING = 0; static CLOSED = 3;
    readyState = FakeSocket.CLOSED;
    sent: string[] = [];
    constructor() { sockets.push(this); }
    send(value: string) { this.sent.push(value); }
    close() { this.readyState = FakeSocket.CLOSED; }
  }
  const globals = { window: dom.window, document: dom.window.document, WebSocket: FakeSocket, IS_REACT_ACT_ENVIRONMENT: true };
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const noop = () => {};
  const stubs = new Proxy({}, { get: () => noop });
  const require = createRequire(import.meta.url);
  const mockedRequire = (name: string) => {
    if (name === 'react') return require(name);
    if (name.endsWith('/appStore')) return { useAppStore: { getState: () => stubs } };
    if (name.endsWith('/wsSession')) return { ensureWsSession: async () => {} };
    return stubs;
  };
  const source = await readFile(new URL('./useWebSocket.ts', import.meta.url), 'utf8');
  const result = await transform(source, { loader: 'ts', format: 'cjs', target: 'es2022' });
  const module = { exports: {} as { useWebSocket: () => { broadcastToCluster: (...args: any[]) => unknown; createClusterFromScratch: (...args: any[]) => unknown } } };
  new Function('require', 'module', 'exports', result.code)(mockedRequire, module, module.exports);
  let api!: ReturnType<typeof module.exports.useWebSocket>;
  function Harness() { api = module.exports.useWebSocket(); return null; }
  const root = createRoot(dom.window.document.getElementById('root')!);
  try {
    await act(async () => root.render(React.createElement(Harness)));
    assert.equal(sockets.length, 1);
    assert.equal(api.broadcastToCluster('cluster', 'draft', ['attachment'], 'message', ['member']), false);
    assert.deepEqual(sockets[0].sent, []);
    assert.equal(api.createClusterFromScratch({ cwd: '/fixture', members: [] }), false);
    sockets[0].readyState = FakeSocket.OPEN;
    assert.equal(api.broadcastToCluster('cluster', 'draft', ['attachment'], 'message', ['member']), true);
    assert.deepEqual(JSON.parse(sockets[0].sent[0]), { type: 'cluster_broadcast', clusterId: 'cluster', content: 'draft', attachments: ['attachment'], clientMessageId: 'message', recipientWorkflowIds: ['member'] });
    sockets[0].send = () => { throw new Error('closed during send'); };
    assert.equal(api.createClusterFromScratch({ cwd: '/fixture', members: [] }), false);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const key of Object.keys(globals)) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key]);
      else delete (globalThis as any)[key];
    }
  }
});
