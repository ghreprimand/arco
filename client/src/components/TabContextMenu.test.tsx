import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { CLUSTER_MEMBER_PROVIDERS } from '@arco/shared';
import { useAppStore } from '../stores/appStore.js';
import { CLUSTER_PROVIDER_REFUSAL, CURSOR_TAB_REFUSAL, TabContextMenu } from './TabContextMenu.js';

async function render(jobs: Record<string, { provider: string }>, anchor: string): Promise<string> {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
  const previous = new Map(['window', 'document', 'localStorage', 'navigator', 'React', 'IS_REACT_ACT_ENVIRONMENT'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of ['window', 'document', 'localStorage', 'navigator'] as const) Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? dom.window : dom.window[name] });
  Object.defineProperty(globalThis, 'React', { configurable: true, value: React });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
  const root = createRoot(dom.window.document.getElementById('root')!);
  const before = useAppStore.getState();
  const storage = useAppStore.persist.getOptions().storage;
  useAppStore.persist.setOptions({ storage: { getItem: () => null, setItem() {}, removeItem() {} } });
  try {
    useAppStore.setState({ clusters: {}, jobs: {} });
    for (const [id, { provider }] of Object.entries(jobs)) {
      useAppStore.getState().createJob(id, { name: `tab ${id}`, workingDirectory: '/fixture/project', skipPermissions: false, primaryProvider: provider as never, primaryModel: 'fixture-model', primaryEffort: 'low' });
    }
    await act(async () => root.render(createElement(TabContextMenu, { anchorJobId: anchor, onClose() {}, onCreateCluster() {}, onAddClusterMember() {}, onCreateClusterWithFreshWorkers() {} })));
    return dom.window.document.body.textContent ?? '';
  } finally {
    await act(async () => root.unmount());
    useAppStore.setState({ jobs: before.jobs, clusters: before.clusters });
    useAppStore.persist.setOptions({ storage });
    for (const [name, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
    dom.window.close();
  }
}

test('every provider whose open tab gets the peer tools can seed a cluster from the tab menu', async () => {
  for (const provider of CLUSTER_MEMBER_PROVIDERS.filter((p) => p !== 'cursor')) {
    const text = await render({ a: { provider }, b: { provider } }, 'a');
    assert.ok(!text.includes(CLUSTER_PROVIDER_REFUSAL) && !text.includes(CURSOR_TAB_REFUSAL), `${provider} anchor is not refused`);
    assert.ok(text.includes('TAB B'), `${provider} same-folder tab is offered as a candidate`);
  }
});

test('an open Cursor tab is neither an anchor nor a candidate: its session has no peer tools', async () => {
  const anchor = await render({ a: { provider: 'cursor' }, b: { provider: 'claude' } }, 'a');
  assert.ok(anchor.includes(CURSOR_TAB_REFUSAL));
  assert.match(CURSOR_TAB_REFUSAL, /\+ ADD FRESH/);
  const candidate = await render({ a: { provider: 'claude' }, b: { provider: 'cursor' } }, 'a');
  assert.ok(!candidate.includes('TAB B'), 'the Cursor tab is not offered');
});

test('a provider without peer tools is refused with the accurate provider list', async () => {
  const text = await render({ a: { provider: 'lmstudio' }, b: { provider: 'claude' } }, 'a');
  assert.ok(text.includes(CLUSTER_PROVIDER_REFUSAL));
  for (const name of ['Claude', 'Codex', 'Ollama', 'llama.cpp']) assert.ok(CLUSTER_PROVIDER_REFUSAL.includes(name), name);
  assert.ok(!CLUSTER_PROVIDER_REFUSAL.includes('Cursor'));
  assert.doesNotMatch(text, /only Claude or Codex|no MCP wiring/);
});
