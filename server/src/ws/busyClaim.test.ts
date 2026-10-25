// Pins the per-claim busy ownership that closes the STOP + quick-resend race:
// turn 1's loop (still unwinding post-settle awaits after STOP) must not clear
// the busy flag turn 2 claimed.

import assert from 'node:assert/strict';
import test from 'node:test';
import { claimBusy, ownsBusy, releaseBusy, revokeBusy } from './turnEngine.js';
import type { WorkflowState } from '../workflows/types.js';

test('a revoked claim cannot release a newer claim', () => {
  const wf = { busy: false } as WorkflowState;
  const turn1 = claimBusy(wf);
  assert.equal(wf.busy, true);
  revokeBusy(wf); // STOP
  assert.equal(wf.busy, false);
  assert.equal(ownsBusy(wf, turn1), false);
  const turn2 = claimBusy(wf); // quick resend
  assert.equal(releaseBusy(wf, turn1), false, 'stale loop release is a no-op');
  assert.equal(wf.busy, true, "turn 2's busy survives turn 1's finally");
  assert.equal(ownsBusy(wf, turn2), true);
  assert.equal(releaseBusy(wf, turn2), true);
  assert.equal(wf.busy, false);
  assert.equal(releaseBusy(wf, turn2), false, 'double release is a no-op');
});
