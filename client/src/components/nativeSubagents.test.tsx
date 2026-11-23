import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useAppStore } from '../stores/appStore';
import { NativeSubagentControls } from './NativeSubagentControls';
import { TaskCard } from './TaskCard';
import { TasksPanel } from './TasksPanel';
import { isTaskChildView } from '../utils/homeModel';
import { RuntimeStateBanner } from './RuntimeStateBanner';
import type { NativeSubagentPolicy } from '@arco/shared';

test('per-tab model inheritance differs from explicit Agent choice and queued rows survive replay and cancel by parent identity', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const saved = Object.getOwnPropertyDescriptors(globalThis), before = useAppStore.getState(), storage = useAppStore.persist.getOptions().storage;
  const globals = { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, React, IS_REACT_ACT_ENVIRONMENT: true };
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  useAppStore.persist.setOptions({ storage: { getItem: () => null, setItem() {}, removeItem() {} } });
  const root = createRoot(document.getElementById('root')!);
  try {
    const changes: NativeSubagentPolicy[] = [];
    await act(async () => root.render(<NativeSubagentControls value={{ maxRunning: 1 }} defaults={{ model: 'haiku' }} inherit onChange={(v) => changes.push(v)} />));
    const select = document.querySelector('select')!;
    assert.equal(select.value, '__inherit__');
    await act(async () => { select.value = ''; select.dispatchEvent(new dom.window.Event('change', { bubbles: true })); });
    assert.deepEqual(changes[0], { maxRunning: 1, model: '' });
    await act(async () => { select.value = 'sonnet'; select.dispatchEvent(new dom.window.Event('change', { bubbles: true })); });
    assert.deepEqual(changes[1], { maxRunning: 1, model: 'sonnet' });
    const limits = [...document.querySelectorAll('input')];
    assert.deepEqual(limits.map((n) => [n.min, n.max]), [['1', '32'], ['1', '128']]);

    const sent: unknown[] = [];
    useAppStore.getState().createJob('p', { name: 'Fixture', primaryProvider: 'claude', primaryModel: 'haiku', primaryEffort: 'low', kind: 'agent' } as never);
    useAppStore.setState({ connectionState: 'online', wsSendRaw: (m: unknown) => sent.push(m) } as never);
    const start = { taskId: 'q', toolUseId: 'uq', description: 'Fixture queued', phase: 'queued' as const, model: 'haiku', startedAt: 1000 };
    useAppStore.getState().recordTaskStarted('p', start);
    useAppStore.setState((s) => ({ jobs: { ...s.jobs, p: { ...s.jobs.p, busy: true, lastPrimaryEventAt: 1000 } } }));
    const renderRows = () => <><TaskCard parentJobId="p" toolUseId="uq" /><TasksPanel job={useAppStore.getState().jobs.p} /><RuntimeStateBanner job={useAppStore.getState().jobs.p} onCancel={() => {}} /></>;
    await act(async () => root.render(renderRows()));
    assert.match(document.body.textContent!, /QUEUED/);
    assert.match(document.body.textContent!, /Model: haiku/);
    assert.match(document.body.textContent!, /Waiting for 1 sub-agent/);
    assert.doesNotMatch(document.body.textContent!, /may be stuck/);
    const cancel = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'CANCEL')!;
    await act(async () => cancel.click());
    assert.deepEqual(sent, [{ type: 'cancel', workflowId: 'p', taskId: 'q' }]);
    await act(async () => {
    useAppStore.getState().recordTaskStarted('p', { ...start, phase: 'running', childWorkflowId: 'child', startedAt: 2000, model: 'claude-haiku-fixture' });
    useAppStore.getState().recordTaskStatus('p', { taskId: 'q', toolUseId: 'uq', phase: 'done', elapsedMs: 20 });
    // Duplicate start on replay must not revive a completed row or lose model.
    useAppStore.getState().recordTaskStarted('p', start);
    });
    const entry = useAppStore.getState().jobs.p.taskChildren!.q;
    assert.equal(entry.phase, 'done'); assert.equal(entry.model, 'claude-haiku-fixture');
    assert.equal(useAppStore.getState().jobs.p.messages.filter((m) => m.id === 'task::uq').length, 1);
    await act(async () => root.render(renderRows()));
    assert.doesNotMatch(document.body.textContent!, /Waiting for/);
  } finally {
    await act(async () => root.unmount());
    useAppStore.setState(before, true); useAppStore.persist.setOptions({ storage });
    dom.window.close();
    for (const key of Object.keys(globals)) { if (saved[key]) Object.defineProperty(globalThis, key, saved[key]); else Reflect.deleteProperty(globalThis, key); }
  }
});


test('task view requires a parent task and hides without removing the child', () => {
  const before = useAppStore.getState(), storage = useAppStore.persist.getOptions().storage;
  useAppStore.persist.setOptions({ storage: { getItem: () => null, setItem() {}, removeItem() {} } });
  const sent: unknown[] = [];
  try {
    const config = { name: 'Fixture', primaryProvider: 'claude', primaryModel: 'haiku', primaryEffort: 'low', kind: 'agent' } as never;
    useAppStore.getState().createJob('parent', config);
    useAppStore.getState().createJob('child', config, undefined, 'parent');
    useAppStore.getState().createJob('other', config, undefined, 'parent');
    useAppStore.setState({ wsSendRaw: (message: unknown) => sent.push(message) } as never);
    useAppStore.getState().promoteTaskChild('other');
    assert.equal(useAppStore.getState().jobs.other.promoted, undefined);
    useAppStore.getState().recordTaskStarted('parent', { taskId: 'task', toolUseId: 'tool', description: 'Fixture', startedAt: 1, childWorkflowId: 'child' });
    useAppStore.getState().requestTaskChildView('child');
    assert.deepEqual(sent, [{ type: 'open_task_view', workflowId: 'parent', taskId: 'task', childWorkflowId: 'child', lastSeq: 0 }]);
    useAppStore.getState().promoteTaskChild('child');
    assert.equal(useAppStore.getState().activeJobId, 'child');
    assert.equal(isTaskChildView(useAppStore.getState().jobs.child, useAppStore.getState().jobs), true);
    assert.equal(isTaskChildView(useAppStore.getState().jobs.other, useAppStore.getState().jobs), false);
    assert.equal(useAppStore.getState().hideTaskChild('child'), true);
    assert.equal(useAppStore.getState().activeJobId, 'parent');
    assert.equal(useAppStore.getState().jobs.child.promoted, false);
    assert.equal(useAppStore.getState().hideTaskChild('other'), false);
    useAppStore.getState().promoteTaskChild('child');
    assert.equal(useAppStore.getState().activeJobId, 'child');
  } finally { useAppStore.setState(before, true); useAppStore.persist.setOptions({ storage }); }
});

test('expanded Task shows separate child text rounds without tool rows', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const saved = Object.getOwnPropertyDescriptors(globalThis), before = useAppStore.getState(), storage = useAppStore.persist.getOptions().storage;
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, React, IS_REACT_ACT_ENVIRONMENT: true })) Object.defineProperty(globalThis, key, { configurable: true, value });
  useAppStore.persist.setOptions({ storage: { getItem: () => null, setItem() {}, removeItem() {} } });
  const root = createRoot(document.getElementById('root')!);
  try {
    const config = { name: 'Fixture', primaryProvider: 'claude', primaryModel: 'haiku', primaryEffort: 'low' } as never;
    useAppStore.getState().createJob('p', config); useAppStore.getState().createJob('child', config, undefined, 'p');
    useAppStore.getState().recordTaskStarted('p', { taskId: 't', toolUseId: 'u', description: 'Fixture', startedAt: 1, childWorkflowId: 'child' });
    useAppStore.setState(s => ({ jobs: { ...s.jobs, child: { ...s.jobs.child, messages: [
      { id: 'one', role: 'assistant', content: 'First round', timestamp: 1, isStreaming: false },
      { id: 'tool', role: 'assistant', content: '', timestamp: 2, isStreaming: false, toolUse: { tool: 'Read', toolUseId: 'read', input: {} } },
      { id: 'two', role: 'assistant', content: 'Second round', timestamp: 3, isStreaming: false },
    ] } } }));
    await act(async () => root.render(<TaskCard parentJobId="p" toolUseId="u" />));
    await act(async () => (document.querySelector('[aria-label="Expand task"]') as HTMLButtonElement).click());
    const output = document.querySelector('[aria-label="Sub-agent output"]')!;
    assert.match(output.textContent!, /First roundSecond round/);
    assert.equal(output.querySelectorAll('hr[aria-label="Next output round"]').length, 1);
  } finally {
    await act(async () => root.unmount()); useAppStore.setState(before, true); useAppStore.persist.setOptions({ storage }); dom.window.close();
    for (const key of Object.keys({ window: 1, document: 1, localStorage: 1, React: 1, IS_REACT_ACT_ENVIRONMENT: 1 })) { if (saved[key]) Object.defineProperty(globalThis, key, saved[key]); else Reflect.deleteProperty(globalThis, key); }
  }
});

test('child send keeps its exact draft through a socket failure, disconnect and rejection until the matching receipt', async () => {
  const { TaskChildComposer } = await import('./TaskChildComposer');
  const { useDraftStore, readSavedTaskChildSends } = await import('../stores/draftStore');
  const { handleServerMessage } = await import('../ws/handleServerMessage');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const saved = Object.getOwnPropertyDescriptors(globalThis), before = useAppStore.getState(), draftsBefore = useDraftStore.getState();
  const storage = useAppStore.persist.getOptions().storage;
  const globals = { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage, React, IS_REACT_ACT_ENVIRONMENT: true };
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  useAppStore.persist.setOptions({ storage: { getItem: () => null, setItem() {}, removeItem() {} } });
  const root = createRoot(document.getElementById('root')!);
  try {
    const config = { name: 'Fixture', primaryProvider: 'claude', primaryModel: 'haiku', primaryEffort: 'low', kind: 'agent' } as never;
    useAppStore.getState().createJob('child-send', config, undefined, 'parent-send');
    useAppStore.getState().createJob('other-send', config);
    useAppStore.setState((s) => ({ jobs: { ...s.jobs, 'child-send': { ...s.jobs['child-send'], taskView: { parentWorkflowId: 'parent-send', taskId: 'task-send' } } }, activeJobId: 'other-send' }));
    const job = useAppStore.getState().jobs['child-send'];
    const otherMessages = [...useAppStore.getState().jobs['other-send'].messages];
    const content = '  keep exact text  ';
    useDraftStore.getState().setDraft(job.id, content);
    await act(async () => root.render(<TaskChildComposer job={job} canSteer send={() => false} />));
    await act(async () => document.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));
    assert.equal(useDraftStore.getState().drafts[job.id], content);
    assert.match(document.body.textContent!, /Message not delivered/);
    await act(async () => useDraftStore.getState().releaseTaskChildSend(job.id));
    const sent: any[] = [];
    await act(async () => root.render(<TaskChildComposer job={job} canSteer send={(message) => { sent.push(message); return true; }} />));
    await act(async () => document.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));
    assert.equal(sent.length, 1); assert.equal(sent[0].content, content);
    assert.deepEqual(readSavedTaskChildSends(dom.window.sessionStorage)[job.id], { id: sent[0].clientMessageId, content, state: 'unconfirmed' });
    await act(async () => useAppStore.getState().setConnected(false));
    assert.equal(useDraftStore.getState().drafts[job.id], content);
    assert.match(document.body.textContent!, /Delivery is not confirmed/);
    const deps = { wsRef: { current: null }, scheduleReconnect: () => {} } as never;
    await act(async () => handleServerMessage({ type: 'task_child_message_rejected', workflowId: job.id, clientMessageId: sent[0].clientMessageId } as never, deps));
    assert.equal(useDraftStore.getState().drafts[job.id], content);
    assert.deepEqual(useAppStore.getState().jobs['other-send'].messages, otherMessages);
    assert.match(document.body.textContent!, /Message not delivered/);
    await act(async () => useDraftStore.getState().releaseTaskChildSend(job.id));
    await act(async () => document.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));
    await act(async () => handleServerMessage({ type: 'user_message_echo', workflowId: job.id, clientMessageId: sent[1].clientMessageId, content, timestamp: Date.now(), kind: 'steer' } as never, deps));
    assert.equal(useDraftStore.getState().drafts[job.id], undefined);
    await act(async () => useAppStore.getState().setConnected(false));
    assert.equal(useDraftStore.getState().taskChildSends[job.id], undefined);
    assert.equal(useDraftStore.getState().drafts[job.id], undefined);
    assert.deepEqual(readSavedTaskChildSends(dom.window.sessionStorage), {});
    assert.equal(sent.length, 2);
  } finally {
    await act(async () => root.unmount()); useAppStore.setState(before, true); useDraftStore.setState(draftsBefore, true); useAppStore.persist.setOptions({ storage }); dom.window.close();
    for (const key of Object.keys(globals)) { if (saved[key]) Object.defineProperty(globalThis, key, saved[key]); else Reflect.deleteProperty(globalThis, key); }
  }
});


test('Gemini waiting strip only uses sub-agent activity from the current turn', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const saved = Object.getOwnPropertyDescriptors(globalThis), before = useAppStore.getState(), storage = useAppStore.persist.getOptions().storage;
  const globals = { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, React, IS_REACT_ACT_ENVIRONMENT: true };
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  useAppStore.persist.setOptions({ storage: { getItem: () => null, setItem() {}, removeItem() {} } });
  const root = createRoot(document.getElementById('root')!);
  try {
    useAppStore.setState({ connectionState: 'online' } as never);
    const entry = { id: 'old', kind: 'tool_use', tool: 'invoke_subagent', eventAt: 101, at: 5000 };
    const job = { id: 'gemini', config: { primaryProvider: 'antigravity-cli' }, busy: true, turnStartedAt: 100, lastPrimaryEventAt: Date.now(), activity: [entry] };
    await act(async () => root.render(<RuntimeStateBanner job={job as never} />));
    assert.match(document.body.textContent!, /Gemini is waiting for its sub-agents/);
    await act(async () => root.render(<RuntimeStateBanner job={{ ...job, turnStartedAt: 200 } as never} />));
    assert.doesNotMatch(document.body.textContent!, /Gemini is waiting/);
  } finally {
    await act(async () => root.unmount()); useAppStore.setState(before, true); useAppStore.persist.setOptions({ storage }); dom.window.close();
    for (const key of Object.keys(globals)) { if (saved[key]) Object.defineProperty(globalThis, key, saved[key]); else Reflect.deleteProperty(globalThis, key); }
  }
});
