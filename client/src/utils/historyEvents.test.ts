import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ServerMessage } from '@arco/shared';
import { narrativeEventFromMessage } from './historyEvents';

// A checkpoint marker offers REVERT TO HERE and the diff for its checkpoint:
// 0.1.5 events carry the checkpoint number in `checkpointSeq`; older events
// only in the ref, and their `seq` may be the checkpoint's own number.
test('checkpoint markers find their checkpoint on new and older events', () => {
  const fresh = narrativeEventFromMessage({ type: 'checkpoint_created', workflowId: 'w', seq: 42, checkpointSeq: 40, ref: 'refs/arco/w/40', label: 'before turn', ts: 1, fileCount: 2 } as unknown as ServerMessage);
  assert.equal(fresh?.seq, 42);
  assert.equal(fresh?.checkpointSeq, 40);
  const legacy = narrativeEventFromMessage({ type: 'checkpoint_created', workflowId: 'w', seq: 40, ref: 'refs/arco/w/40', label: 'before turn', ts: 1, fileCount: 2 } as unknown as ServerMessage);
  assert.equal(legacy?.checkpointSeq, 40);
  const tar = narrativeEventFromMessage({ type: 'checkpoint_created', workflowId: 'w', seq: 7, ref: 'w.5.tar', label: 'before turn', ts: 1, fileCount: 2 } as unknown as ServerMessage);
  assert.equal(tar?.checkpointSeq, 5);
  const reverted = narrativeEventFromMessage({ type: 'checkpoint_reverted', workflowId: 'w', seq: 50, restoredSeq: 40, fileCount: 2, safetySnapshotRef: 'refs/arco/w/49', safetySnapshotSeq: 49, backend: 'git' } as unknown as ServerMessage);
  assert.equal(reverted?.seq, 50);
  assert.equal(reverted?.revertedCheckpointSeq, 40);
});
