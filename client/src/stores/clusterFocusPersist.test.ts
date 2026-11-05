// P8.11: the member in view in a cluster tab survives a reload, and a saved
// focus on a member that is gone is dropped (the director takes over).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useAppStore } from './appStore.js';

const member = (workflowId: string, role?: string) => ({ workflowId, displayName: workflowId, status: 'idle', ...(role ? { role } : {}) });
const cluster = (members: ReturnType<typeof member>[]) => ({ clusterId: 'c1', name: 'C', cwd: '/fixture', createdAt: '2026-11-05T00:00:00Z', members, mailboxDepth: {} }) as never;

test('the focused member is saved with the cluster and restored only while it is a member', async () => {
  const store = useAppStore;
  store.getState().setClusterState('c1', cluster([member('director', 'Director'), member('builder', 'Builder')]));
  assert.equal(store.getState().clusterFocusedMember.c1, 'director');
  store.getState().setClusterFocusedMember('c1', 'builder');
  const options = store.persist.getOptions();
  const saved = options.partialize!(store.getState()) as { clusterFocusedMember: Record<string, string> };
  assert.deepEqual(saved.clusterFocusedMember, { c1: 'builder' });

  // Reload: the saved slice comes back, then the server's cluster state.
  store.setState({ clusterFocusedMember: {} });
  const merged = options.merge!(saved, store.getState()) as ReturnType<typeof store.getState>;
  store.setState(merged);
  store.getState().setClusterState('c1', cluster([member('director', 'Director'), member('builder', 'Builder')]));
  assert.equal(store.getState().clusterFocusedMember.c1, 'builder');

  // The focused member left: the director is in view again and nothing stale is saved.
  store.getState().setClusterState('c1', cluster([member('director', 'Director')]));
  assert.equal(store.getState().clusterFocusedMember.c1, 'director');
  // A saved focus for a member no longer in the saved cluster is dropped on save.
  store.setState({ clusterFocusedMember: { c1: 'builder', gone: 'x' } });
  assert.deepEqual((options.partialize!(store.getState()) as { clusterFocusedMember: Record<string, string> }).clusterFocusedMember, {});
});
