// GOAL_RUN_PLAN.md — headless WS smoke for the north-star auto-continue.
//
// Covers the protocol surface without burning real model turns: arm refusal
// with no north star, arm → goal_run_state + system_notice, re-arm resets the
// counters, and disarm. The tick itself (dispatch after a settled turn) needs a
// live provider turn, so it stays a UI/manual acceptance step — everything the
// server owns up to the dispatch is asserted here.
//
// Run with the dev server up:
//   npm run dev:server &
//   npm run smoke:goal-run
//
// Exits 0 on all-pass, 1 on any failure.

import { connect, step, assert, assertEq, summary, type AnyMessage } from './lib.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function main() {
  const cwd = mkdtempSync(join(tmpdir(), 'archon-smoke-goalrun-'));
  console.log(`Goal-run smoke — cwd ${cwd}`);
  console.log('');

  const c = await connect();
  let wfid = '';

  await step('create Native workflow', async () => {
    c.send({
      type: 'create_workflow',
      config: {
        name: 'Smoke Goal Run',
        primaryProvider: 'claude',
        primaryModel: 'claude-opus-4-7',
        primaryEffort: 'normal',
        skipPermissions: true,
        workingDirectory: cwd,
        claudeTransport: 'native',
      },
    });
    const m = await c.waitFor((x) => x.type === 'workflow_created', 8000, 'workflow_created');
    wfid = m.workflowId as string;
    assert(typeof wfid === 'string' && wfid.length > 0, 'workflowId returned');
  });

  await step('arm without a north star is refused', async () => {
    c.send({ type: 'update_primary_config', workflowId: wfid, goalRun: { enabled: true, total: 5 } });
    const m = await c.waitFor((x) => x.type === 'error', 5000, 'error');
    assert(
      String(m.message).includes('north star'),
      `refusal names the missing north star (got: ${String(m.message)})`,
    );
  });

  await step('set a north star', async () => {
    c.send({ type: 'update_primary_config', workflowId: wfid, goal: 'Ship the smoke test.' });
    const m = await c.waitFor((x) => x.type === 'goal_set', 5000, 'goal_set');
    assertEq(m.goal as string, 'Ship the smoke test.', 'goal echoed back');
  });

  await step('arm for 3 iterations', async () => {
    c.send({ type: 'update_primary_config', workflowId: wfid, goalRun: { enabled: true, total: 3 } });
    const m = await c.waitFor((x) => x.type === 'goal_run_state', 5000, 'goal_run_state');
    assertEq(m.enabled as boolean, true, 'armed');
    assertEq(m.total as number, 3, 'total = 3');
    assertEq(m.remaining as number, 3, 'remaining = 3 (nothing spent yet)');
    assertEq(m.tokensUsed as number, 0, 'tokensUsed = 0');
    const notice = await c.waitFor(
      (x: AnyMessage) => x.type === 'system_notice' && String(x.content).includes('[GOAL RUN]'),
      5000,
      'arm system_notice',
    );
    assert(String(notice.content).includes('3 iterations'), 'notice states the budget');
  });

  await step('iteration budget is clamped, not trusted', async () => {
    c.send({ type: 'update_primary_config', workflowId: wfid, goalRun: { enabled: true, total: 99999 } });
    const m = await c.waitFor((x) => x.type === 'goal_run_state', 5000, 'goal_run_state');
    assertEq(m.total as number, 500, 'clamped to GOAL_RUN_MAX_ITERATIONS');
    assertEq(m.remaining as number, 500, 're-arm reset the counter');
  });

  await step('disarm', async () => {
    c.send({ type: 'update_primary_config', workflowId: wfid, goalRun: { enabled: false } });
    const m = await c.waitFor((x) => x.type === 'goal_run_state', 5000, 'goal_run_state');
    assertEq(m.enabled as boolean, false, 'disarmed');
  });

  await step('teardown', async () => {
    // remove_workflow has no dedicated ack broadcast — settle briefly, then
    // clean the scratch cwd (mirrors scripts/smoke/phase-e.ts).
    c.send({ type: 'remove_workflow', workflowId: wfid });
    await new Promise((r) => setTimeout(r, 600));
    rmSync(cwd, { recursive: true, force: true });
  });

  c.close();
  summary('goal-run');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
