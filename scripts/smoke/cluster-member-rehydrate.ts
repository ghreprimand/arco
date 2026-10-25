// 2026-07-10 — headless smoke for cluster_member_rehydrate (the client-driven
// repair for a cluster member absent from the in-memory `workflows` map).
//
// The reconstruction path (materializeMemberFromMeta) fires when a member is
//   (a) still in the cluster roster, (b) has meta.json on disk, but (c) NOT in
// the `workflows` map. `remove_workflow` produces exactly that state WITHOUT a
// server restart: it deletes the map entry but touches neither clusterStore's
// roster nor the on-disk meta.json. So we drive the real meta-reconstruction
// (config rebuilt field-by-field via workflowConfigFromMeta) in-process. This
// is also a faithful stand-in for the operator constraint the fix targets —
// members added/removed frequently mid-project.
//
// Covers:
//   1. cluster_member_rehydrate for an EVICTED member → server materializes the
//      job from meta and replies workflow_created (correct workflowId +
//      workingDirectory === cluster cwd + non-empty name). The creation-time
//      workflow_created is drained first so this assertion is load-bearing —
//      it would fail if the rehydrate handler regressed.
//   2. Membership guard — cluster_member_rehydrate for a workflow that HAS
//      meta.json on disk but is NOT in the roster is ignored (no
//      workflow_created). Using a with-meta non-member makes the assertion
//      depend on the guard, not on readMeta returning null.
//
// Skips (manual/typecheck-only): the eager BOOT registration half
// (registerAllClusterMembersOnBoot) can't be exercised without an actual
// process restart — it's covered by typecheck + an operator pass.
//
// Run with the dev server up:
//   npm run dev:server &
//   npm run smoke:cluster-member-rehydrate
//
// Exits 0 on all-pass, 1 on any failure.

import { connect, step, assert, assertEq, summary, type AnyMessage } from './lib.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function main(): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), 'archon-smoke-cmr-'));
  console.log(`cluster_member_rehydrate smoke — cwd ${cwd}`);
  console.log('');

  const c = await connect();
  let sourceWfid = '';
  let memberB = '';
  let clusterId = '';
  let nonMemberWfid = '';

  await step('1: create Native source + 1-sibling cluster', async () => {
    c.send({
      type: 'create_workflow',
      config: {
        name: 'CMR Native Source',
        primaryProvider: 'claude',
        primaryModel: 'claude-opus-4-7',
        primaryEffort: 'normal',
        skipPermissions: true,
        workingDirectory: cwd,
        claudeTransport: 'native',
      },
    });
    const m = await c.waitFor(
      (x) => x.type === 'workflow_created' && (x.config as { name?: string }).name === 'CMR Native Source',
      8000,
      'workflow_created (source)',
    );
    sourceWfid = m.workflowId as string;
    c.send({
      type: 'cluster_create_with_fresh_workers',
      sourceWorkflowId: sourceWfid,
      additionalCount: 1,
      name: 'CMR Cluster',
    });
    const cm = await c.waitFor(
      (x) => x.type === 'cluster_created' &&
        (x.state as { members: Array<{ workflowId: string }> }).members.some((mem) => mem.workflowId === sourceWfid),
      8000,
      'cluster_created',
    );
    clusterId = cm.clusterId as string;
    const members = (cm.state as { members: Array<{ workflowId: string }> }).members;
    assertEq(members.length, 2, 'cluster has 2 members');
    memberB = members.find((mem) => mem.workflowId !== sourceWfid)!.workflowId;
    assert(memberB.length > 0, 'fresh member B workflowId present');
    // Drain member B's CREATION-time workflow_created (createBlankNativeWorkflow
    // emits one before cluster_created). Without this, step 4's buffer-first
    // waitFor would match the stale creation message and pass even if the
    // rehydrate handler were completely broken.
    await c.waitFor(
      (x) => x.type === 'workflow_created' && (x as { workflowId?: string }).workflowId === memberB,
      5000,
      'workflow_created (member B at creation — drained so step 4 is load-bearing)',
    );
  });

  await step('2: create a with-meta NON-member workflow (for the guard test)', async () => {
    c.send({
      type: 'create_workflow',
      config: {
        name: 'CMR Non-Member',
        primaryProvider: 'claude',
        primaryModel: 'claude-opus-4-7',
        primaryEffort: 'normal',
        skipPermissions: true,
        workingDirectory: cwd,
        claudeTransport: 'native',
      },
    });
    const m = await c.waitFor(
      (x) => x.type === 'workflow_created' && (x.config as { name?: string }).name === 'CMR Non-Member',
      8000,
      'workflow_created (non-member)',
    );
    nonMemberWfid = m.workflowId as string;
    assert(nonMemberWfid.length > 0 && nonMemberWfid !== memberB, 'non-member workflowId present + distinct');
  });

  await step('3: cluster_subscribe (mirror the real client)', async () => {
    c.send({ type: 'cluster_subscribe', clusterId });
    await c.waitFor(
      (x) => x.type === 'cluster_state' && x.clusterId === clusterId,
      3000,
      'cluster_state',
    );
  });

  await step('4: remove_workflow(memberB) — evict from the workflows map', async () => {
    // Reproduces the post-restart "unregistered member" state: drops the map
    // entry but keeps the cluster roster (getMembers still includes it) and the
    // on-disk meta.json.
    c.send({ type: 'remove_workflow', workflowId: memberB });
    await new Promise((r) => setTimeout(r, 300));
  });

  await step('5: cluster_member_rehydrate materializes the job from meta', async () => {
    c.send({ type: 'cluster_member_rehydrate', clusterId, workflowId: memberB });
    const created = await c.waitFor(
      (x) => x.type === 'workflow_created' && (x as { workflowId?: string }).workflowId === memberB,
      5000,
      'workflow_created for rehydrated member B',
    ) as AnyMessage & { config: { name?: string; workingDirectory?: string } };
    assertEq(created.config.workingDirectory, cwd, 'reconstructed config.workingDirectory === cluster cwd');
    assert(
      typeof created.config.name === 'string' && created.config.name!.length > 0,
      'reconstructed config.name is non-empty (came from meta.json)',
    );
    // No-turn member → the from-seq-0 replay filters out workflow_created, so the
    // materialized job (workflow_created above) is the load-bearing signal.
  });

  await step('6: membership guard — a with-meta NON-member id is ignored', async () => {
    // nonMemberWfid HAS meta.json on disk, so without the membership guard
    // materializeMemberFromMeta would reconstruct + reply workflow_created. The
    // guard (getMembers(clusterId) excludes it) must reject it first.
    c.send({ type: 'cluster_member_rehydrate', clusterId, workflowId: nonMemberWfid });
    let materialized = false;
    try {
      await c.waitFor(
        (x) => x.type === 'workflow_created' && (x as { workflowId?: string }).workflowId === nonMemberWfid,
        900,
        'workflow_created for non-member (must NOT arrive)',
      );
      materialized = true;
    } catch {
      /* expected timeout — the guard rejected a non-member that has meta */
    }
    assert(!materialized, 'membership guard rejects a with-meta non-member cluster_member_rehydrate');
  });

  await step('7: teardown', async () => {
    c.send({ type: 'cluster_delete', clusterId });
    await new Promise((r) => setTimeout(r, 200));
    c.send({ type: 'remove_workflow', workflowId: sourceWfid });
    c.send({ type: 'remove_workflow', workflowId: memberB });
    c.send({ type: 'remove_workflow', workflowId: nonMemberWfid });
    await c.close();
    rmSync(cwd, { recursive: true, force: true });
  });

  summary('cluster_member_rehydrate smoke');
}

main().catch((err) => {
  console.error('cluster_member_rehydrate smoke crashed:', err);
  process.exit(2);
});
