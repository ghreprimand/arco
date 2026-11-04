// Phase 3 acceptance — live model swap + mid-turn steer (queue-after-result).
//
// Exercises the two Phase-3 behaviours that are observable in-process (resume
// needs a worker death + re-spawn, covered by the session/load probe + manual
// UI check, noted in the plan):
//
//   1. Live model swap — after a first turn on `auto`, `update_primary_config`
//      changes the model to a pinned frontier model; the next turn emits a
//      "model swapped" system_notice (ACP session/set_model, no respawn) and
//      still round-trips.
//   2. Mid-turn steer — a message sent while a turn is in flight is queued and
//      dispatched as a follow-up turn after the current turn's result (Cursor
//      never calls drainSteer, so the generic post-turn drain applies).
//
//   ARCO_SMOKE_WS_URL=ws://localhost:3011/ws npx tsx scripts/smoke/cursor-phase-3.ts
//
// ⚠️ METERED: makes ~3 real Cursor turns (tiny prompts). `auto` draws the
// Auto+Composer pool; the swap target (`glm-5.2`) draws the frontier pool.
// The worker must be logged in (`cursor-agent login`).

import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { connect, step, assert, summary } from './lib.js';

const TURN_TIMEOUT_MS = 90_000;
const SWAP_MODEL = 'glm-5.2';

async function main(): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), 'cursor-smoke-p3-'));
  writeFileSync(join(cwd, 'README.md'), '# cursor phase-3 sandbox\n');

  const c = await connect();
  let wfid = '';

  await step('create a cursor (ACP) workflow on auto', async () => {
    c.send({
      type: 'create_workflow',
      config: {
        name: 'cursor phase-3',
        primaryProvider: 'cursor',
        primaryModel: 'auto',
        primaryEffort: 'medium',
        skipPermissions: true,
        workingDirectory: cwd,
      },
    });
    const m = await c.waitFor((x) => x.type === 'workflow_created', 8000, 'workflow_created');
    wfid = m.workflowId as string;
    assert(typeof wfid === 'string' && wfid.length > 0, 'workflowId returned');
  });

  await step('turn 1 on auto round-trips', async () => {
    c.send({ type: 'user_message', workflowId: wfid, content: 'Reply with exactly: ONE. Nothing else.' });
    await c.waitFor(
      (x) => x.type === 'primary_complete' && (x as { workflowId?: string }).workflowId === wfid,
      TURN_TIMEOUT_MS,
      'primary_complete #1',
    );
  });

  await step(`live model swap auto → ${SWAP_MODEL} takes effect on turn 2`, async () => {
    c.send({ type: 'update_primary_config', workflowId: wfid, model: SWAP_MODEL });
    c.send({ type: 'user_message', workflowId: wfid, content: 'Reply with exactly: TWO. Nothing else.' });
    await c.waitFor(
      (x) => x.type === 'primary_complete' && (x as { workflowId?: string }).workflowId === wfid,
      TURN_TIMEOUT_MS,
      'primary_complete #2',
    );
    const notices = c
      .peekMessages()
      .filter((m) => m.type === 'system_notice' && (m as { workflowId?: string }).workflowId === wfid)
      .map((m) => (m as { content?: string }).content ?? '');
    const swapNotice = notices.find((n) => /model swap/i.test(n));
    if (notices.length) console.log('        notices:', notices.map((n) => JSON.stringify(n.slice(0, 120))).join(' | '));
    assert(!!swapNotice, `a "model swapped" system_notice was emitted (got ${notices.length} notice(s))`);
    assert(new RegExp(SWAP_MODEL, 'i').test(swapNotice ?? ''), `swap notice names ${SWAP_MODEL}`);
  });

  await step('mid-turn steer is queued and dispatched after the current turn', async () => {
    // Start a turn, then immediately queue a steer message. Cursor serialises
    // turns (beginTurn guards) and never calls drainSteer, so the steer lands
    // as a follow-up turn after the first result → two primary_complete events.
    c.send({ type: 'user_message', workflowId: wfid, content: 'Reply with exactly: FIRST. Nothing else.' });
    c.send({ type: 'user_message', workflowId: wfid, content: 'Reply with exactly: SECOND. Nothing else.' });

    let completes = 0;
    await c.waitFor((x) => {
      if (x.type === 'primary_complete' && (x as { workflowId?: string }).workflowId === wfid) completes += 1;
      return completes >= 2;
    }, TURN_TIMEOUT_MS * 2, 'two primary_complete events (turn + steered follow-up)');
    assert(completes >= 2, `both the turn and the queued steer ran (saw ${completes} completes)`);
  });

  await c.close();
  summary('cursor-phase-3');
}

main().catch((err) => {
  console.error('cursor-phase-3 crashed:', err);
  process.exit(1);
});
