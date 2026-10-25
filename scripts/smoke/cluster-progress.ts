// 2026-06-29 — headless smoke for the per-cluster progress-tracking mode.
//
// Covers:
//   1. Pure doctrine builder (clusterProgress.ts): which clauses appear per
//      mode, and the existence-gating (a 'plan'/'both' mode with no plan, or a
//      'board'/'both' mode with no board, drops that clause; nothing-to-track
//      returns undefined). Default ('both' via undefined) injects both clauses
//      plus the reconciliation line when both surfaces exist.
//   2. WS round-trip — cluster_progress_set flips cluster_state.progressTracking
//      (plan → board → back to both, where the default field drops).
//
// Skips (manual-only): real LLM turns — the system-prompt INJECTION of the
// doctrine is verified by typecheck + the pure asserts here + an operator pass
// with a live cluster.
//
// Run with the dev server up:
//   npm run dev:server &
//   npm run smoke:cluster-progress
//
// Exits 0 on all-pass, 1 on any failure.

import { connect, step, assert, assertEq, summary } from './lib.js';
import { buildProgressDoctrine } from '../../server/src/clusterProgress.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function main(): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), 'arco-smoke-prog-'));
  console.log(`Cluster-progress smoke — cwd ${cwd}`);
  console.log('');

  await step('1: doctrine clauses per mode (both surfaces present)', async () => {
    const both = buildProgressDoctrine('both', true, true);
    assert(!!both && both.includes('cluster_plan_tick'), 'both → plan clause present');
    assert(!!both && both.includes('task board'), 'both → board clause present');
    assert(!!both && both.includes('different granularities'), 'both → reconciliation line present');

    const planOnly = buildProgressDoctrine('plan', true, true);
    assert(!!planOnly && planOnly.includes('cluster_plan_tick'), 'plan mode → plan clause');
    assert(!!planOnly && !planOnly.includes('task board'), 'plan mode → no board clause');

    const boardOnly = buildProgressDoctrine('board', true, true);
    assert(!!boardOnly && boardOnly.includes('task board'), 'board mode → board clause');
    assert(!!boardOnly && !boardOnly.includes('cluster_plan_tick'), 'board mode → no plan clause');
  });

  await step('2: existence-gating + undefined default', async () => {
    // mode 'both' but no plan → only board clause, no reconciliation line.
    const boardOnlyByGate = buildProgressDoctrine('both', false, true);
    assert(!!boardOnlyByGate && boardOnlyByGate.includes('task board'), 'no plan → board clause stays');
    assert(!!boardOnlyByGate && !boardOnlyByGate.includes('cluster_plan_tick'), 'no plan → plan clause gated off');
    assert(!!boardOnlyByGate && !boardOnlyByGate.includes('different granularities'), 'one surface → no reconciliation line');

    // mode 'plan' but no plan → nothing to track.
    assertEq(buildProgressDoctrine('plan', false, true), undefined, 'plan mode + no plan → undefined');
    // mode 'board' but no board → nothing to track.
    assertEq(buildProgressDoctrine('board', true, false), undefined, 'board mode + no board → undefined');
    // No surfaces at all → undefined regardless of mode.
    assertEq(buildProgressDoctrine('both', false, false), undefined, 'no surfaces → undefined');

    // undefined mode falls back to default 'both'.
    const def = buildProgressDoctrine(undefined, true, true);
    assert(!!def && def.includes('cluster_plan_tick') && def.includes('task board'), 'undefined mode defaults to both');
  });

  const c = await connect();
  let sourceWfid = '';
  let clusterId = '';

  await step('3: create Native source + 1-sibling cluster', async () => {
    c.send({
      type: 'create_workflow',
      config: {
        name: 'Smoke Prog Native Source',
        primaryProvider: 'claude',
        primaryModel: 'claude-opus-4-7',
        primaryEffort: 'normal',
        skipPermissions: true,
        workingDirectory: cwd,
        claudeTransport: 'native',
      },
    });
    const m = await c.waitFor(
      (x) => x.type === 'workflow_created' && (x.config as { name?: string }).name === 'Smoke Prog Native Source',
      8000,
      'workflow_created',
    );
    sourceWfid = m.workflowId as string;
    c.send({
      type: 'cluster_create_with_fresh_workers',
      sourceWorkflowId: sourceWfid,
      additionalCount: 1,
      name: 'Progress Smoke Cluster',
    });
    const cm = await c.waitFor(
      (x) => x.type === 'cluster_created' &&
        ((x.state as { members: Array<{ workflowId: string }> }).members.some((mem) => mem.workflowId === sourceWfid)),
      8000,
      'cluster_created',
    );
    clusterId = cm.clusterId as string;
    // Fresh clusters default to 'both' → progressTracking field absent.
    const state = cm.state as { progressTracking?: string };
    assert(state.progressTracking === undefined, 'fresh cluster defaults to both (field absent)');
  });

  await step('4: set progress → plan', async () => {
    const ackP = c.waitFor(
      (x) => x.type === 'cluster_state' && x.clusterId === clusterId &&
        (x.state as { progressTracking?: string }).progressTracking === 'plan',
      3000,
      'cluster_state progressTracking === plan',
    );
    c.send({ type: 'cluster_progress_set', clusterId, mode: 'plan' });
    await ackP;
  });

  await step('5: set progress → board', async () => {
    const ackP = c.waitFor(
      (x) => x.type === 'cluster_state' && x.clusterId === clusterId &&
        (x.state as { progressTracking?: string }).progressTracking === 'board',
      3000,
      'cluster_state progressTracking === board',
    );
    c.send({ type: 'cluster_progress_set', clusterId, mode: 'board' });
    await ackP;
  });

  await step('6: set progress back → both drops the field', async () => {
    const ackP = c.waitFor(
      (x) => x.type === 'cluster_state' && x.clusterId === clusterId &&
        (x.state as { progressTracking?: string }).progressTracking === undefined,
      3000,
      'cluster_state progressTracking cleared on both (default)',
    );
    c.send({ type: 'cluster_progress_set', clusterId, mode: 'both' });
    await ackP;
  });

  await step('7: teardown', async () => {
    c.send({ type: 'cluster_delete', clusterId });
    await new Promise((r) => setTimeout(r, 200));
    await c.close();
    rmSync(cwd, { recursive: true, force: true });
  });

  summary('Cluster-progress smoke');
}

main().catch((err) => {
  console.error('Cluster-progress smoke crashed:', err);
  process.exit(2);
});
