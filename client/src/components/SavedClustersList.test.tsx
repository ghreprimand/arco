import assert from 'node:assert/strict';
import { test } from 'node:test';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { useClusterSnapshotsStore, registerClusterSnapshotSender } from '../stores/clusterSnapshotsStore';
import { useHubLinkStore } from '../stores/hubLinkStore';

test('saved clusters default to this folder, expose all projects, and retain restore destinations', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, React, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map([...Object.keys(globals), 'fetch'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const snapshotsBefore = useClusterSnapshotsStore.getState(), hubBefore = useHubLinkStore.getState();
  const snapshots = [
    { id: 'own', name: 'Own snapshot', sourceCwd: '/projects/fixture', createdAt: '2026-01-01', memberCount: 1 },
    { id: 'other', name: 'Other snapshot', sourceCwd: '/projects/fixture-other', createdAt: '2026-01-01', memberCount: 1 },
  ];
  const sent: any[] = [];
  registerClusterSnapshotSender(message => sent.push(message));
  useClusterSnapshotsStore.setState({ snapshots, restoringId: null, error: null });
  useHubLinkStore.setState({ known: true, connected: true });
  globalThis.fetch = async () => Response.json({ snapshots: [
    { id: 'own', name: 'Own cloud', createdAt: '2026-01-01', bytes: 1 },
    { id: 'unknown', name: 'Unknown cloud', createdAt: '2026-01-01', bytes: 1 },
  ] });
  const { createRoot } = await import('react-dom/client');
  const { SavedClustersList } = await import('./SavedClustersList');
  const root = createRoot(document.getElementById('root')!);
  const text = () => document.body.textContent!;
  const click = async (label: string) => act(async () => {
    const buttons = [...document.querySelectorAll('button')].filter(button => button.textContent === label);
    assert.equal(buttons.length, label === 'CLOUD' ? 2 : 1, label); buttons[0].click();
  });
  try {
    await act(async () => root.render(React.createElement(SavedClustersList, { scopeCwd: '/projects/fixture' } as any)));
    assert.match(text(), /Own snapshot/); assert.doesNotMatch(text(), /Other snapshot/);
    await click('RESTORE'); await click('RESTORE');
    const restored = sent.find(message => message.type === 'cluster_snapshot_restore');
    assert.deepEqual(restored, { type: 'cluster_snapshot_restore', snapshotId: 'own', turnsPerMember: 25 });
    await click('Show all projects (2)'); assert.match(text(), /Other snapshot/);
    await click('This project only'); assert.doesNotMatch(text(), /Other snapshot/);
    await click('CLOUD'); assert.match(text(), /Own cloud/); assert.doesNotMatch(text(), /Unknown cloud/);
    await click('Show all projects (2)'); assert.match(text(), /Unknown cloud/);
    // Changing the panel folder immediately restores the default scope.
    await act(async () => root.render(React.createElement(SavedClustersList, { scopeCwd: '/projects/fixture-other' } as any)));
    assert.doesNotMatch(text(), /Own cloud|Unknown cloud/);
    await click('LOCAL'); assert.match(text(), /Other snapshot/); assert.doesNotMatch(text(), /Own snapshot/);
    // The creator has no scope and retains its chosen restore destination.
    await act(async () => root.render(React.createElement(SavedClustersList, { targetCwd: '/projects/destination' })));
    assert.match(text(), /Own snapshot/); assert.match(text(), /Other snapshot/);
    await act(async () => useClusterSnapshotsStore.setState({ restoringId: null }));
    const restoreButtons = [...document.querySelectorAll('button')].filter(button => button.textContent === 'RESTORE');
    await act(async () => restoreButtons[0].click());
    await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === 'RESTORE' && !button.hasAttribute('data-help'))!.click());
    assert.equal(sent.filter(message => message.type === 'cluster_snapshot_restore').at(-1)?.targetCwd, '/projects/destination');
  } finally {
    await act(async () => root.unmount()); registerClusterSnapshotSender(null);
    useClusterSnapshotsStore.setState(snapshotsBefore, true); useHubLinkStore.setState(hubBefore, true); dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
