import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useStorageWarningStore } from './storageWarningStore';

test('warnings merge by item and removing one leaves the others visible', () => {
  useStorageWarningStore.setState({ warnings: [] });
  const add = useStorageWarningStore.getState().add;
  const base = { type: 'storage_warning' as const, workflowId: 'w', fileThresholdBytes: 1, conversationThresholdBytes: 2 };
  add({ ...base, items: [{ path: 'artifacts/a', bytes: 3, kind: 'file' }] });
  add({ ...base, items: [{ path: 'artifacts/b', bytes: 4, kind: 'file' }] });
  assert.deepEqual(useStorageWarningStore.getState().warnings[0].items.map(i => i.path), ['artifacts/a', 'artifacts/b']);
  useStorageWarningStore.getState().removeItem('w', 'artifacts/a');
  assert.deepEqual(useStorageWarningStore.getState().warnings[0].items.map(i => i.path), ['artifacts/b']);
  useStorageWarningStore.getState().removeItem('w', 'artifacts/b');
  assert.equal(useStorageWarningStore.getState().warnings.length, 0);
});
