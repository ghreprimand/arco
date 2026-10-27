// docs/GOTCHAS.md - headless smoke for the operator-set persistent
// north-star.
//
// Covers:
//   1. Pure helper (goalBlock.ts): null-when-empty (zero-token default path),
//      the load-bearing anti-autonomy trailer, the objective embedded verbatim,
//      and capGoal's trim / blank-clears / UTF-8-boundary byte cap.
//   2. WS round-trip — update_primary_config { goal } flips the value, broadcasts
//      goal_set { goal, byteLen }, and persists to meta.json; an empty string
//      clears it (goal_set { goal: null, byteLen: 0 } + meta.goal dropped).
//
// Skips (manual-only):
//   - Real LLM turns (no API spend). The system-prompt INJECTION of the block
//     (Native forced block after FORCED_FIRST_BLOCK; per-provider fold on the
//     other transports) is verified by typecheck + the pure asserts here + an
//     operator pass with a live tab.
//
// Run with the dev server up:
//   npm run dev:server &
//   npm run smoke:goal
//
// Exits 0 on all-pass, 1 on any failure.

import { connect, step, assert, assertEq, summary } from './lib.js';
import { goalBlock, capGoal, GOAL_MAX_BYTES } from '../../server/src/providers/goalBlock.js';
import { readMeta } from '../../server/src/workflowMeta.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function main(): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), 'arco-smoke-goal-'));
  console.log(`Goal-northstar smoke — cwd ${cwd}`);
  console.log('');

  await step('1: goalBlock is null for empty / blank (zero-token default)', () => {
    assertEq(goalBlock(undefined), null, 'undefined ⇒ null');
    assertEq(goalBlock(''), null, 'empty ⇒ null');
    assertEq(goalBlock('   \n  '), null, 'whitespace-only ⇒ null');
  });

  await step('2: goalBlock embeds the objective + the anti-autonomy trailer', () => {
    const b = goalBlock('Ship the v2 billing rewrite; keep the public API stable.');
    assert(!!b, 'block produced');
    assert(b!.includes('Ship the v2 billing rewrite; keep the public API stable.'), 'objective embedded verbatim');
    assert(b!.includes('north-star'), 'labelled as a north-star');
    // Load-bearing: forecloses reading it as license to self-drive.
    assert(b!.includes('not an instruction to act autonomously'), 'anti-autonomy trailer present');
    assert(b!.includes('not trigger unrequested work'), 'no-unrequested-work clause present');
  });

  await step('3: capGoal trims, clears on blank, byte-caps at GOAL_MAX_BYTES', () => {
    assertEq(capGoal('  Ship v2  '), 'Ship v2', 'trims surrounding whitespace');
    assertEq(capGoal('   '), '', 'blank ⇒ empty (clear)');
    const huge = 'x'.repeat(GOAL_MAX_BYTES + 500);
    const capped = capGoal(huge);
    assert(Buffer.byteLength(capped, 'utf8') <= GOAL_MAX_BYTES, `capped to ≤ ${GOAL_MAX_BYTES}B`);
    // Multibyte boundary: a string of 2-byte chars must not be split into a
    // lone replacement char at the cut.
    const multibyte = 'é'.repeat(GOAL_MAX_BYTES); // 2 bytes each ⇒ well over the cap
    const cappedMb = capGoal(multibyte);
    assert(Buffer.byteLength(cappedMb, 'utf8') <= GOAL_MAX_BYTES, 'multibyte capped to ≤ cap');
    assert(!cappedMb.includes('�'), 'no replacement char left at the UTF-8 cut');
  });

  const c = await connect();
  let wfid = '';
  const GOAL = 'Ship the v2 billing rewrite; keep the public API stable.';

  await step('4: create a Native workflow', async () => {
    c.send({
      type: 'create_workflow',
      config: {
        name: 'Smoke Goal Northstar',
        primaryProvider: 'claude',
        primaryModel: 'claude-opus-4-7',
        primaryEffort: 'normal',
        skipPermissions: true,
        workingDirectory: cwd,
        claudeTransport: 'native',
      },
    });
    const m = await c.waitFor(
      (x) => x.type === 'workflow_created' && (x.config as { name?: string }).name === 'Smoke Goal Northstar',
      8000,
      'workflow_created',
    );
    wfid = m.workflowId as string;
    assert(!!wfid, 'workflow id assigned');
  });

  await step('5: set north-star ⇒ goal_set broadcast with matching byteLen', async () => {
    c.send({ type: 'update_primary_config', workflowId: wfid, goal: GOAL });
    const ev = await c.waitFor((x) => x.type === 'goal_set' && x.workflowId === wfid, 5000, 'goal_set');
    assertEq(ev.goal, GOAL, 'broadcast carries the objective');
    assertEq(ev.byteLen, Buffer.byteLength(GOAL, 'utf8'), 'byteLen matches UTF-8 length');
  });

  await step('6: north-star persisted to meta.json', async () => {
    const meta = await readMeta(cwd, wfid);
    assert(!!meta, 'meta.json exists');
    assertEq(meta!.goal, GOAL, 'meta.goal persisted');
  });

  await step('7: clear ⇒ goal_set { goal: null, byteLen: 0 } + meta.goal dropped', async () => {
    c.send({ type: 'update_primary_config', workflowId: wfid, goal: '' });
    const ev = await c.waitFor((x) => x.type === 'goal_set' && x.workflowId === wfid, 5000, 'goal_set(clear)');
    assertEq(ev.goal, null, 'cleared broadcast carries null');
    assertEq(ev.byteLen, 0, 'cleared byteLen is 0');
    const meta = await readMeta(cwd, wfid);
    assert(meta ? meta.goal === undefined : true, 'meta.goal dropped on clear');
  });

  await c.close();
  summary('goal-northstar');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
