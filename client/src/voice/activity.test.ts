import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { WorkflowConfig } from '@archon/shared';
import { VoiceControl } from '../components/VoiceControl';
import { ComputerActivityPanel } from '../components/ComputerActivityPanel';
import { useAppStore } from '../stores/appStore';
import { useComputerStore } from '../stores/computerStore';
import { useVoiceStore } from './store';
import { useComputerActivity } from './activity';
import { restoreSavedComputer } from './conversation';

Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem() {}, removeItem() {} } });

const selection = { provider: 'codex' as const, model: 'gpt-6-luna', effort: 'low' as const, history: 'saved' as const };
const config: WorkflowConfig = { kind: 'chat', name: 'Computer', workingDirectory: '', skipPermissions: false,
  primaryProvider: 'codex', primaryModel: selection.model, primaryEffort: 'low', voiceOperator: true };

for (const scenario of ['before', 'after', 'retry']) test(`saved Computer activity loads without an utterance (${scenario})`, async () => {
  const hydrateAfterMount = scenario === 'after';
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const globals = Object.getOwnPropertyDescriptors(globalThis);
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: dom.window }, document: { configurable: true, value: dom.window.document },
    localStorage: { configurable: true, value: dom.window.localStorage }, IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  useAppStore.setState({ jobs: {}, connected: true, activeJobId: 'project-worker', activeClusterId: null });
  useComputerStore.setState({ activeId: null, selection, pending: null, contextEpoch: 0 });
  useComputerActivity.setState({ snapshot: null, error: null, ownerId: null, revision: 0 });
  useVoiceStore.setState({ enabled: false, open: false, error: null });
  const requests: { url: string; body?: Record<string, unknown> }[] = [];
  let agentUpdates = 'off';
  let failActivity = scenario === 'retry';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input), body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url, body });
    if (url.includes('/activity?') && failActivity) {
      failActivity = false;
      return Response.json({ error: 'Activity temporarily unavailable.' }, { status: 503 });
    }
    if (body?.agent_updates) agentUpdates = body.agent_updates;
    const payload = url.includes('/activity?') ? { policy: { enabled: true, agentUpdates }, ledger: [], deliveries: [], pending: 0, updatesPerHour: 12, updatesThisHour: 0 }
      : url.includes('/watches?') ? { watches: [] } : { rules: [] };
    return Response.json(payload);
  };
  const root = createRoot(dom.window.document.getElementById('root')!);
  const failIfCalled = () => { throw Error('Restoring activity must not create a chat or send a prompt.'); };
  try {
    if (!hydrateAfterMount) useAppStore.getState().createJob('saved-computer', config);
    await act(async () => root.render(createElement('div', null,
      createElement(VoiceControl, { sendMessage: failIfCalled, cancel: failIfCalled, createWorkflow: failIfCalled }),
      createElement(ComputerActivityPanel, { ownerId: 'saved-computer' }))));
    if (hydrateAfterMount) {
      assert.match(dom.window.document.body.textContent!, /Loading activity settings/);
      await act(async () => { useAppStore.getState().createJob('saved-computer', config); });
    }
    assert.equal(useComputerStore.getState().activeId, 'saved-computer');
    assert(requests.some((r) => r.url === '/api/voice/activity?owner=saved-computer'));
    assert(requests.some((r) => r.url.includes('/watches?')));
    assert(requests.some((r) => r.url.includes('/mail-rules?')));
    const select = dom.window.document.querySelector<HTMLSelectElement>('select[aria-label="Computer agent activity updates"]')!;
    if (scenario === 'retry') {
      assert.equal(select.disabled, true);
      assert.match(dom.window.document.querySelector('[role="alert"]')!.textContent!, /temporarily unavailable/);
      const retry = Array.from(dom.window.document.querySelectorAll('button')).find((b) => b.textContent === 'RETRY ACTIVITY')!;
      await act(async () => retry.click());
      assert.equal(dom.window.document.querySelector('[role="alert"]'), null);
    }
    assert.equal(select.disabled, false);
    await act(async () => { select.value = 'workers'; select.dispatchEvent(new dom.window.Event('change', { bubbles: true })); });
    assert(requests.some((r) => r.body?.action === 'configure' && r.body.agent_updates === 'workers'));
    assert.equal(select.value, 'workers');
    assert.equal(useVoiceStore.getState().enabled, false);
    assert.equal(useAppStore.getState().activeJobId, 'project-worker');
    assert.equal(useComputerStore.getState().contextEpoch, 0);
    await act(async () => { useAppStore.setState({ connected: false }); });
    assert.equal(select.disabled, true);
    assert.match(dom.window.document.body.textContent!, /Disconnected/);
    const count = requests.length;
    await act(async () => { useAppStore.setState({ connected: true }); });
    assert(requests.length > count, 'reconnect refreshes without polling');
    assert.equal(select.disabled, false);
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    for (const name of ['window', 'document', 'localStorage', 'IS_REACT_ACT_ENVIRONMENT']) {
      if (globals[name]) Object.defineProperty(globalThis, name, globals[name]);
      else Reflect.deleteProperty(globalThis, name);
    }
    dom.window.close();
  }
});

test('restoration never adopts a private chat, another selection or a pending switch', () => {
  useAppStore.setState({ jobs: {} });
  useComputerStore.setState({ activeId: null, selection, pending: null });
  useAppStore.getState().createJob('private-computer', { ...config, incognito: true });
  useAppStore.getState().createJob('other-computer', { ...config, primaryModel: 'different-model' });
  restoreSavedComputer();
  assert.equal(useComputerStore.getState().activeId, null);
  useAppStore.getState().createJob('saved-computer', config);
  useComputerStore.setState({ selection: { ...selection, history: 'none' } });
  restoreSavedComputer();
  assert.equal(useComputerStore.getState().activeId, null);
  useComputerStore.setState({ selection, pending: { ...selection, history: 'none' } });
  restoreSavedComputer();
  assert.equal(useComputerStore.getState().activeId, null);
  useComputerStore.setState({ pending: null });
  restoreSavedComputer();
  assert.equal(useComputerStore.getState().activeId, 'saved-computer');
});
