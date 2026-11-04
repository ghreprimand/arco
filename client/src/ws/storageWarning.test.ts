import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleServerMessage } from './handleServerMessage';
import { useStorageWarningStore } from '../stores/storageWarningStore';

test('storage warning reaches the approval notice', () => {
  useStorageWarningStore.setState({ warnings: [] });
  handleServerMessage({ type: 'storage_warning', workflowId: 'fixture', fileThresholdBytes: 100, conversationThresholdBytes: 500, items: [{ path: 'artifacts/large.bin', bytes: 200, kind: 'file' }] }, { wsRef: { current: null }, scheduleReconnect: () => {} });
  assert.deepEqual(useStorageWarningStore.getState().warnings[0].items.map(item => item.path), ['artifacts/large.bin']);
});
