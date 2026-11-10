// Pins the per-claim busy ownership that closes the STOP + quick-resend race:
// turn 1's loop (still unwinding post-settle awaits after STOP) must not clear
// the busy flag turn 2 claimed.

import assert from 'node:assert/strict';
import test from 'node:test';
import { claimBusy, ownsBusy, releaseBusy, revokeBusy } from './turnEngine.js';
import { workflows } from '../server/state.js';
import { _setChannelsPathForTest, saveChannels, loadChannels } from '../attention.js';
import { initNotifications } from '../notifications.js';
import type { ServerMessage } from '@arco/shared';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkflowState } from '../workflows/types.js';

test('a revoked claim cannot release a newer claim', () => {
  const wf = { busy: false } as WorkflowState;
  const turn1 = claimBusy(wf);
  assert.equal(wf.busy, true);
  wf.turnStartedAt = 1000;
  revokeBusy(wf); // STOP
  assert.equal(wf.busy, false);
  assert.equal(wf.turnStartedAt, undefined);
  assert.equal(ownsBusy(wf, turn1), false);
  const turn2 = claimBusy(wf); // quick resend
  wf.turnStartedAt = 2000;
  assert.equal(releaseBusy(wf, turn1), false, 'stale loop release is a no-op');
  assert.equal(wf.busy, true, "turn 2's busy survives turn 1's finally");
  assert.equal(wf.turnStartedAt, 2000);
  assert.equal(ownsBusy(wf, turn2), true);
  assert.equal(releaseBusy(wf, turn2), true);
  assert.equal(wf.busy, false);
  assert.equal(wf.turnStartedAt, undefined);
  assert.equal(releaseBusy(wf, turn2), false, 'double release is a no-op');
});

test('a turn released as failed raises one failed alert, an interrupted one raises none', async (t) => {
  const sent: ServerMessage[] = [];
  const dir = await mkdtemp(join(tmpdir(), 'arco-busy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  _setChannelsPathForTest(join(dir, 'notification-channels.json'));
  await initNotifications((m) => { sent.push(m); });
  await loadChannels();
  await saveChannels({ desktop: { failed: true } });
  const wf = { busy: false, config: { name: 'Fix login' } } as unknown as WorkflowState;
  workflows.set('wf-busy-failed', wf);
  try {
    releaseBusy(wf, claimBusy(wf), 'interrupted');
    assert.equal(sent.filter((m) => m.type === 'attention_event').length, 0);
    releaseBusy(wf, claimBusy(wf), 'failed');
    const events = sent.filter((m) => m.type === 'attention_event');
    assert.equal(events.length, 1);
    assert.equal((events[0] as { kind: string }).kind, 'failed');
  } finally { workflows.delete('wf-busy-failed'); }
});
