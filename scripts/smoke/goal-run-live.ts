// GOAL_RUN_PLAN.md — LIVE tick verification. Unlike smoke:goal-run (protocol
// only), this burns real model turns: it arms a 2-iteration run behind a
// trivial north star, sends one operator turn, and asserts that exactly two
// auto-continuations follow, that the run then stops on its own, and that a
// later operator turn does NOT resurrect it.
//
// Not wired into a `smoke:` script on purpose — it costs tokens. Run by hand:
//   npx tsx scripts/smoke/goal-run-live.ts

import { connect, step, assert, summary, type AnyMessage } from './lib.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const goalRunNotice = (needle: string) => (m: AnyMessage) =>
  m.type === 'system_notice' && String(m.content).includes('[GOAL RUN]') && String(m.content).includes(needle);

async function main() {
  const cwd = mkdtempSync(join(tmpdir(), 'arco-goalrun-live-'));
  console.log(`Goal-run LIVE — cwd ${cwd}`);
  const c = await connect();
  let wfid = '';

  await step('create Native workflow + arm a 2-iteration run', async () => {
    c.send({
      type: 'create_workflow',
      config: {
        name: 'Goal Run Live', primaryProvider: 'claude', primaryModel: 'claude-sonnet-5',
        primaryEffort: 'low', skipPermissions: true, workingDirectory: cwd, claudeTransport: 'native',
      },
    });
    wfid = (await c.waitFor((x) => x.type === 'workflow_created', 8000, 'workflow_created')).workflowId as string;
    c.send({ type: 'update_primary_config', workflowId: wfid, goal: 'Answer every message with a single short sentence. Nothing else.' });
    await c.waitFor((x) => x.type === 'goal_set', 5000, 'goal_set');
    c.send({ type: 'update_primary_config', workflowId: wfid, goalRun: { enabled: true, total: 2 } });
    await c.waitFor(goalRunNotice('Armed'), 5000, 'arm notice');
  });

  await step('operator turn → tick 1/2 fires', async () => {
    c.send({ type: 'user_message', workflowId: wfid, content: 'Say hello in one short sentence.' });
    const m = await c.waitFor(goalRunNotice('iteration 1/2'), 180000, 'tick 1/2');
    console.log('    ' + String(m.content));
  });

  await step('tick 2/2 fires', async () => {
    const m = await c.waitFor(goalRunNotice('iteration 2/2'), 180000, 'tick 2/2');
    console.log('    ' + String(m.content));
  });

  await step('run stops itself on the iteration budget', async () => {
    const m = await c.waitFor(goalRunNotice('Stopped'), 180000, 'stop notice');
    console.log('    ' + String(m.content));
    assert(String(m.content).includes('iteration budget spent'), 'stopped on budget, not an error');
    const state = await c.waitFor((x) => x.type === 'goal_run_state' && x.enabled === false, 5000, 'goal_run_state off');
    assert(state.enabled === false, 'state broadcast reports disarmed');
  });

  await step('a later operator turn does not resurrect the run', async () => {
    c.send({ type: 'user_message', workflowId: wfid, content: 'Say goodbye in one short sentence.' });
    await c.waitFor((x) => x.type === 'primary_turn_ended', 180000, 'primary_turn_ended');
    await new Promise((r) => setTimeout(r, 4000));
    const stray = c.peekMessages().filter((m) => goalRunNotice('Auto-continuing')(m));
    assert(stray.length === 0, `no further ticks after the run ended (got ${stray.length})`);
  });

  await step('teardown', async () => {
    c.send({ type: 'remove_workflow', workflowId: wfid });
    await new Promise((r) => setTimeout(r, 600));
    rmSync(cwd, { recursive: true, force: true });
  });

  c.close();
  summary('goal-run-live');
}

main().catch((err) => { console.error(err); process.exit(1); });
