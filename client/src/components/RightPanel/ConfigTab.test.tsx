import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigTab } from './ConfigTab.js';
import { useAppStore, type JobState } from '../../stores/appStore.js';
import type { ProviderName } from '@arco/shared';

const senders = { list() {}, create() {}, update() {}, remove() {}, allow() {}, probe() {} };
async function visible(provider: ProviderName, kind = 'agent', accessMode?: 'standard' | 'blind' | 'isolated', transport?: string): Promise<boolean> {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  const previous = new Map(['window', 'document', 'localStorage', 'navigator', 'React', 'IS_REACT_ACT_ENVIRONMENT'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const clusters = useAppStore.getState().clusters;
  for (const name of ['window', 'document', 'localStorage', 'navigator'] as const) Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? dom.window : dom.window[name] });
  Object.defineProperty(globalThis, 'React', { configurable: true, value: React });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
  const root = createRoot(dom.window.document.body);
  try {
    useAppStore.setState({ clusters: accessMode ? { fixture: { members: [{ workflowId: 'fixture', accessMode }] } } as never : {} });
    const job = { id: 'fixture', config: { kind, primaryProvider: provider, workingDirectory: '/fixture', model: 'fixture', effort: 'medium', claudeTransport: transport, codexTransport: transport } } as unknown as JobState;
    await act(async () => root.render(createElement(ConfigTab, { job, mcp: senders })));
    return !!dom.window.document.querySelector('[data-help="rightpanel.config.mcp"]');
  } finally {
    await act(async () => root.unmount());
    useAppStore.setState({ clusters });
    useAppStore.persist.clearStorage();
    for (const [name, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
    dom.window.close();
  }
}

for (const provider of ['claude', 'codex', 'cursor', 'ollama', 'llamacpp', 'lmstudio', 'strata', 'deepseek'] as const) {
  test(`${provider} registry controls follow Agent attachment in standalone, standard and BLIND tabs`, async () => {
    for (const mode of [undefined, 'standard', 'blind'] as const) assert.equal(await visible(provider, 'agent', mode), true, String(mode));
    assert.equal(await visible(provider, 'chat'), false, 'Chat has no configured tools');
  });
}
test('both Claude and Codex transports retain registry controls', async () => {
  for (const transport of ['native', 'cli']) assert.equal(await visible('claude', 'agent', undefined, transport), true);
  for (const transport of ['exec', 'appserver']) assert.equal(await visible('codex', 'agent', undefined, transport), true);
});
test('isolated members have no configured tool-server controls', async () => {
  assert.equal(await visible('claude', 'agent', 'isolated', 'native'), false);
});
