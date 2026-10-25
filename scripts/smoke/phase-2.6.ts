// CLUSTER_MODE_PLAN.md Phase 2.6 — headless WS smoke.
//
// Covers steps 2–9 of the manual acceptance recipe (set plan, propagate via
// cluster_state, 32 KB cap, empty/whitespace reject, role set + clear, plan
// clear, reversibility) + the 2026-05-11 follow-up coverage (24 KB plan
// accepted, 33 KB plan rejected, F5 rename_workflow round-trip). Skips:
//   - Step 1 (PLAN sub-tab renders) — UI-only.
//   - Step 4 ("propagates next turn, not mid-turn") — would require spawning
//     a real Native worker against the live Anthropic API; not worth the
//     spend for a smoke.
//   - Step 8 (emergent director conversation) — UI affordance + LLM behavior.
//
// Run with the dev server up:
//   npm run dev:server  &
//   npm run smoke:cluster-26
//
// Exits 0 on all-pass, 1 on any failure.

import { connect, step, assert, assertEq, summary, requireServerEnv, type AnyMessage } from './lib.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function main() {
  // The EnterPlanMode coverage rides the __debug_native_plan_set hook, which
  // index.ts gates on ARCO_TEST=1 so production never honours it.
  requireServerEnv({ ARCO_TEST: '1' }, 'Phase 2.6 (__debug_native_plan_set hook)');
  const cwd = mkdtempSync(join(tmpdir(), 'arco-smoke-2.6-'));
  console.log(`Phase 2.6 smoke — cwd ${cwd}`);
  console.log('');

  const c = await connect();

  let sourceWfid = '';
  let clusterId = '';
  let memberIds: string[] = [];

  await step('connect + create Native source workflow', async () => {
    c.send({
      type: 'create_workflow',
      config: {
        name: 'Smoke 2.6 Source',
        primaryProvider: 'claude',
        primaryModel: 'claude-opus-4-7',
        primaryEffort: 'normal',
        skipPermissions: true,
        workingDirectory: cwd,
        claudeTransport: 'native',
      },
    });
    const m = await c.waitFor((x) => x.type === 'workflow_created', 8000, 'workflow_created');
    sourceWfid = m.workflowId as string;
    assert(typeof sourceWfid === 'string' && sourceWfid.length > 0, 'workflowId returned');
  });

  await step('cluster_create_with_fresh_workers (+1 child)', async () => {
    c.send({
      type: 'cluster_create_with_fresh_workers',
      sourceWorkflowId: sourceWfid,
      additionalCount: 1,
      name: 'Smoke 2.6 Cluster',
    });
    const m = await c.waitFor((x) => x.type === 'cluster_created', 8000, 'cluster_created');
    clusterId = m.clusterId as string;
    const state = m.state as { members: Array<{ workflowId: string }> };
    memberIds = state.members.map((mem) => mem.workflowId);
    assert(clusterId.length > 0, 'clusterId returned');
    assertEq(memberIds.length, 2, 'cluster has 2 members (source + 1 fresh)');
    assertEq(memberIds[0], sourceWfid, 'source is first member');
  });

  // Phase 2.6 step 2 — set plan, expect cluster_plan_changed + cluster_state.plan.body.
  const planBody = '# Smoke 2.6 plan\n\nDirector role: source\nWorker: child #2\n';
  await step('cluster_plan_set: propagates via cluster_plan_changed', async () => {
    c.send({ type: 'cluster_plan_set', clusterId, body: planBody });
    const changed = await c.waitFor((x) => x.type === 'cluster_plan_changed', 3000, 'cluster_plan_changed') as AnyMessage & { body: string; bodyLength: number };
    assertEq(changed.body, planBody, 'cluster_plan_changed.body matches');
    assertEq(changed.bodyLength, planBody.length, 'cluster_plan_changed.bodyLength matches');
  });

  await step('cluster_plan_set: propagates via cluster_state', async () => {
    const state = await c.waitFor(
      (x) => x.type === 'cluster_state' && (x.state as { plan?: { body: string } })?.plan?.body === planBody,
      3000,
      'cluster_state with plan body',
    ) as AnyMessage & { state: { plan: { body: string; updatedAt: number } } };
    assert(typeof state.state.plan.updatedAt === 'number', 'plan.updatedAt is a number');
  });

  // 2026-05-11 — plan cap raised 8 KB → 32 KB. 24 KB body should be accepted
  // (under the new cap; would have been rejected under the old).
  await step('cluster_plan_set: 24 KB body accepted', async () => {
    const big = '# Heading\n\n' + 'y'.repeat(24576 - 11);
    c.send({ type: 'cluster_plan_set', clusterId, body: big });
    const changed = await c.waitFor(
      (x) => x.type === 'cluster_plan_changed' && (x as { body?: string }).body === big,
      3000,
      'cluster_plan_changed 24 KB',
    ) as AnyMessage & { bodyLength: number };
    assertEq(changed.bodyLength, big.length, 'cluster_plan_changed.bodyLength matches 24 KB body');
  });

  // 2026-05-11 — 33 KB body should now be the rejection threshold (32768 cap).
  await step('cluster_plan_set: 33 KB cap rejected', async () => {
    const oversized = 'x'.repeat(33 * 1024);
    c.send({ type: 'cluster_plan_set', clusterId, body: oversized });
    const err = await c.waitFor(
      (x) => x.type === 'error' && typeof x.message === 'string' && (x.message as string).includes('body_too_large'),
      3000,
      'error: body_too_large',
    );
    assert(typeof err.message === 'string', 'error.message present');
  });

  // Empty / whitespace rejected — operator must use cluster_plan_clear.
  await step('cluster_plan_set: whitespace-only rejected', async () => {
    c.send({ type: 'cluster_plan_set', clusterId, body: '   \n   ' });
    const err = await c.waitFor(
      (x) => x.type === 'error' && typeof x.message === 'string' && (x.message as string).includes('empty_body'),
      3000,
      'error: empty_body',
    );
    assert(typeof err.message === 'string', 'error.message present');
  });

  // Phase 2.6 step 7 — role set on source member.
  await step('cluster_member_role_set: role applied to source', async () => {
    c.send({ type: 'cluster_member_role_set', clusterId, workflowId: sourceWfid, role: 'Coordinator' });
    const state = await c.waitFor(
      (x) => {
        if (x.type !== 'cluster_state') return false;
        const members = (x.state as { members: Array<{ workflowId: string; role?: string }> }).members;
        const me = members.find((m) => m.workflowId === sourceWfid);
        return me?.role === 'Coordinator';
      },
      3000,
      'cluster_state with role Coordinator',
    );
    assert(state, 'cluster_state observed');
  });

  // Role cleared via empty string — should drop the field.
  await step('cluster_member_role_set: empty clears role', async () => {
    c.send({ type: 'cluster_member_role_set', clusterId, workflowId: sourceWfid, role: '' });
    const state = await c.waitFor(
      (x) => {
        if (x.type !== 'cluster_state') return false;
        const members = (x.state as { members: Array<{ workflowId: string; role?: string }> }).members;
        const me = members.find((m) => m.workflowId === sourceWfid);
        return me !== undefined && (me.role === undefined || me.role === '');
      },
      3000,
      'cluster_state with role cleared',
    );
    assert(state, 'cluster_state observed');
  });

  // Phase 2.6 step 6 — clear plan.
  await step('cluster_plan_clear: removes plan from state', async () => {
    c.send({ type: 'cluster_plan_clear', clusterId });
    const changed = await c.waitFor(
      (x) => x.type === 'cluster_plan_changed' && (x as { body?: string }).body === '',
      3000,
      'cluster_plan_changed cleared',
    ) as AnyMessage & { bodyLength: number };
    assertEq(changed.bodyLength, 0, 'cluster_plan_changed.bodyLength=0');
    const state = await c.waitFor(
      (x) => {
        if (x.type !== 'cluster_state') return false;
        const plan = (x.state as { plan?: { body: string } }).plan;
        return plan === undefined || plan.body === '';
      },
      3000,
      'cluster_state without plan',
    );
    assert(state, 'cluster_state observed');
  });

  // Reversibility — re-set plan after clear, should land normally.
  await step('reversibility: re-set plan after clear', async () => {
    c.send({ type: 'cluster_plan_set', clusterId, body: 'second pass plan' });
    const changed = await c.waitFor(
      (x) => x.type === 'cluster_plan_changed' && (x as { body?: string }).body === 'second pass plan',
      3000,
      'cluster_plan_changed second pass',
    );
    assert(changed, 'plan re-set observed');
  });

  // F5 (2026-05-11) — rename_workflow updates ClusterMember.displayName.
  await step('rename_workflow: sets ClusterMember.displayName', async () => {
    c.send({ type: 'rename_workflow', workflowId: sourceWfid, name: 'Backend builder' });
    const state = await c.waitFor(
      (x) => {
        if (x.type !== 'cluster_state') return false;
        const members = (x.state as { members: Array<{ workflowId: string; displayName: string }> }).members;
        const me = members.find((m) => m.workflowId === sourceWfid);
        return me?.displayName === 'Backend builder';
      },
      3000,
      'cluster_state with renamed displayName',
    );
    assert(state, 'rename observed in cluster_state');
  });

  // F5 — empty rename clears the override; displayName falls back to wfid prefix.
  await step('rename_workflow: empty restores wfid prefix', async () => {
    c.send({ type: 'rename_workflow', workflowId: sourceWfid, name: '' });
    const prefix = sourceWfid.slice(0, 8);
    const state = await c.waitFor(
      (x) => {
        if (x.type !== 'cluster_state') return false;
        const members = (x.state as { members: Array<{ workflowId: string; displayName: string }> }).members;
        const me = members.find((m) => m.workflowId === sourceWfid);
        return me?.displayName === prefix;
      },
      3000,
      'cluster_state with displayName reset to wfid prefix',
    );
    assert(state, 'clear observed in cluster_state');
  });

  // F5 — 64-char cap enforced server-side.
  await step('rename_workflow: > 64 chars rejected', async () => {
    const tooLong = 'z'.repeat(65);
    c.send({ type: 'rename_workflow', workflowId: sourceWfid, name: tooLong });
    const err = await c.waitFor(
      (x) => x.type === 'error' && typeof x.message === 'string' && (x.message as string).includes('name_too_long'),
      3000,
      'error: name_too_long',
    );
    assert(typeof err.message === 'string', 'error.message present');
  });

  // 2026-05-11 — fresh-worker spawn picker. ADD FRESH with provider: 'codex'
  // should produce a member whose primaryProvider == 'codex' on its
  // workflow_created config. The Claude anchor stays Claude; only the new
  // worker overrides.
  await step('cluster_add_fresh_workers: provider override yields codex member', async () => {
    c.send({
      type: 'cluster_add_fresh_workers',
      clusterId,
      count: 1,
      provider: 'codex',
      model: 'gpt-5.5',
      effort: 'medium',
    });
    // The server emits `workflow_created` for the new tab BEFORE the
    // `cluster_member_added` + final `cluster_state` push. Wait for the
    // first workflow_created we haven't already seen; assert provider/
    // model/effort were honoured on the spawned config.
    const created = await c.waitFor(
      (x) => x.type === 'workflow_created' && !memberIds.includes((x as { workflowId?: string }).workflowId ?? ''),
      8000,
      'workflow_created for codex member',
    ) as AnyMessage & { workflowId: string; config: { primaryProvider?: string; primaryModel?: string; primaryEffort?: string } };
    assertEq(created.config.primaryProvider, 'codex', 'new member primaryProvider === codex');
    assertEq(created.config.primaryModel, 'gpt-5.5', 'new member primaryModel === gpt-5.5');
    assertEq(created.config.primaryEffort, 'medium', 'new member primaryEffort === medium');
    memberIds.push(created.workflowId);

    // Drain the trailing cluster_state so subsequent steps see a clean wire.
    await c.waitFor(
      (x) => {
        if (x.type !== 'cluster_state') return false;
        const members = (x.state as { members: Array<{ workflowId: string }> }).members;
        return members.length >= 3;
      },
      5000,
      'cluster_state reflecting new codex member',
    );
  });

  // 2026-05-11 — cluster auto-attach gate for Native EnterPlanMode. When a
  // cluster member's worker emits a plan via `EnterPlanMode`, the server
  // skips `handlePlanAttach` and emits `plan_candidate_ready` instead so
  // the PlanCandidateBanner can offer SAVE & ATTACH TO WORKER / ATTACH TO
  // CLUSTER / DISCARD. `plan_set` still fires for the events.jsonl audit;
  // `plan_attached` MUST NOT fire on this path. Driven via the
  // ARCO_TEST-gated `__debug_native_plan_set` hook so we don't burn real
  // Anthropic spend.
  await step('cluster member: EnterPlanMode emits plan_candidate_ready, not plan_attached', async () => {
    const planBody = '# Cluster member plan\n\n- step one\n- step two\n';
    c.send({ type: '__debug_native_plan_set', workflowId: sourceWfid, plan: planBody });

    const ready = await c.waitFor(
      (x) => x.type === 'plan_candidate_ready' && (x as { workflowId?: string }).workflowId === sourceWfid,
      3000,
      'plan_candidate_ready for cluster member',
    ) as AnyMessage & { body: string; source: string; planTitle?: string };
    assertEq(ready.body, planBody, 'plan_candidate_ready.body matches');
    assertEq(ready.source, 'native-plan-tool', 'plan_candidate_ready.source === native-plan-tool');
    assert(typeof ready.planTitle === 'string' && ready.planTitle.length > 0, 'plan_candidate_ready.planTitle present');

    // plan_set still fires (audit). plan_attached MUST NOT fire — drain a
    // short window and assert none was observed.
    await c.waitFor(
      (x) => x.type === 'plan_set' && (x as { workflowId?: string }).workflowId === sourceWfid,
      2000,
      'plan_set (audit) fires alongside plan_candidate_ready',
    );

    // Race: if the gate misfires, plan_attached would land in the same
    // microtask flush as plan_set. We already drained plan_set above; any
    // plan_attached would be in the queue right now.
    const attached = c.peekMessages().find(
      (m) => m.type === 'plan_attached' && (m as { workflowId?: string }).workflowId === sourceWfid,
    );
    assert(!attached, 'plan_attached MUST NOT fire for cluster-member EnterPlanMode');
  });

  // 2026-05-11 bug fix — a WS subscribed to a cluster but NOT directly to
  // any member must still receive per-member workflow events (so the
  // cluster ACTIVITY tab can surface primary_tool_use / primary_thinking
  // etc.). Drive the existing `__debug_native_plan_set` hook on the
  // second member from a fresh WS that subscribed ONLY to the cluster,
  // and assert it sees the `plan_set` broadcast.
  await step('cluster subscribe also observes member workflows (Bug 1)', async () => {
    // Fresh WS that subscribes ONLY to the cluster — never observes any
    // member directly. Pre-fix this WS missed per-member events; post-
    // fix it must see them.
    const c2 = await connect();
    try {
      c2.send({ type: 'cluster_subscribe', clusterId });
      await c2.waitFor(
        (x) => x.type === 'cluster_state' && (x as { clusterId?: string }).clusterId === clusterId,
        3000,
        'cluster_state on c2 (post-subscribe)',
      );

      // Fire __debug_native_plan_set on memberIds[1] (the fresh Native
      // sibling — Native-only hook, so don't aim it at the codex 3rd
      // member that was added later). The plan_set broadcast goes
      // through broadcastWorkflow → wf.observers; without the attach-
      // on-subscribe fix, c2 would NOT be in that observers set and
      // would miss this event.
      const planBody = '# Observer-attach probe\n\n- check member B fans out via cluster sub.\n';
      c.send({ type: '__debug_native_plan_set', workflowId: memberIds[1], plan: planBody });

      const seen = await c2.waitFor(
        (x) => x.type === 'plan_set' && (x as { workflowId?: string }).workflowId === memberIds[1],
        3000,
        'plan_set on c2 for memberIds[1] via cluster sub',
      ) as AnyMessage & { plan?: string };
      // Some plan_set shapes carry the body under `plan`; if absent the
      // event delivery alone is the assertion.
      void seen;
    } finally {
      await c2.close();
    }
  });

  // Teardown — leave-no-trace. cluster_delete removes the cluster + cached
  // plan; remove_workflow drops in-memory state. On-disk meta survives but
  // lives in our scratch cwd, which we wipe below.
  await step('teardown: cluster_delete + remove_workflow + rm cwd', async () => {
    c.send({ type: 'cluster_delete', clusterId });
    await c.waitFor((x) => x.type === 'cluster_deleted', 3000, 'cluster_deleted');
    for (const id of memberIds) c.send({ type: 'remove_workflow', workflowId: id });
    await c.close();
    rmSync(cwd, { recursive: true, force: true });
  });

  summary('Phase 2.6 smoke');
}

main().catch((err) => {
  console.error('Phase 2.6 smoke crashed:', err);
  process.exit(2);
});
