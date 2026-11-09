import { test } from 'node:test';
import assert from 'node:assert/strict';
import { narrativeEventFromMessage } from './historyEvents';

test('checkpoint and revert history retain the full named scope limitation', () => {
  const limitation = 'Nested repositories not included: "nested".';
  const created = narrativeEventFromMessage({ type: 'checkpoint_created', workflowId: 'fixture', seq: 2, checkpointSeq: 1, ref: 'refs/arco/fixture/1', label: 'fixture', ts: 1, fileCount: 1, limitation } as any);
  assert.equal((created as any)?.checkpointLimitation, limitation);
  assert.match(created!.summary!, /nested/);
  const reverted = narrativeEventFromMessage({ type: 'checkpoint_reverted', workflowId: 'fixture', seq: 3, fileCount: 1, safetySnapshotRef: 'refs/arco/fixture/2', safetySnapshotSeq: 2, backend: 'git', ts: 2, limitation } as any);
  assert.equal((reverted as any)?.checkpointLimitation, limitation);
});
