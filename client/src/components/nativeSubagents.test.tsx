import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useAppStore } from '../stores/appStore';
import { NativeSubagentControls } from './NativeSubagentControls';
import { TaskCard } from './TaskCard';
import { TasksPanel } from './TasksPanel';
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
