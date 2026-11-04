// Director/workers Stage C/D — cluster task lifecycle peer-tools smoke.
//
// Headless/module-level. Drives clusterPeerOps against a real cluster +
// cwd-scoped task kernel:
//   (a) cluster_task_show returns task details.
//   (b) cluster_task_comment persists a durable task comment.
//   (c) cluster_task_block moves task to blocked and records reason/comment.
//   (d) cluster_task_complete moves task to review, not done, and records a
//       completion report comment.
//   (e) comments replay from task_ledger_event after snapshot deletion.
//
// Run: npm run smoke:task-peer-lifecycle

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { step, assert, assertEq, summary } from './lib.js';

async function main(): Promise<void> {
  const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'arco-task-life-home-'));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'arco-task-life-cwd-'));
  const prevHome = process.env.HOME;
  process.env.HOME = fakeHome;

  try {
    const clusterStore = await import('../../server/src/clusterStore.js');
    const peerOps = await import('../../server/src/clusterPeerOps.js');
    const taskLedger = await import('../../server/src/project/taskLedger.js');
    const { writeMeta } = await import('../../server/src/workflowMeta.js');
    const { initWorkflowStore, flushAll } = await import('../../server/src/workflowStore.js');
    const { workflows, workflowCwds } = await import('../../server/src/server/state.js');

    const wfA = randomUUID();
    const wfB = randomUUID();
    for (const wfid of [wfA, wfB]) {
      await fs.mkdir(path.join(cwd, '.arco', 'workflows', wfid), { recursive: true });
      workflowCwds.set(wfid, cwd);
      workflows.set(wfid, { observers: new Set(), config: { workingDirectory: cwd } } as unknown as Parameters<typeof workflows.set>[1]);
      await writeMeta(cwd, {
        workflowId: wfid,
        name: 'task-life-smoke',
        cwd,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        primaryProvider: 'claude',
        primaryModel: 'sonnet',
        primaryEffort: 'medium',
        cliSessions: [],
        operator: 'smoke',
        lastEventSeq: null,
        lastTranscriptSeq: null,
        compactedAt: null,
      } as Parameters<typeof writeMeta>[1]);
      await initWorkflowStore(cwd, wfid);
    }

    const cluster = await clusterStore.createCluster({ cwd, memberWorkflowIds: [wfA, wfB] });
    await clusterStore.setTaskBoardMode(cluster.clusterId, 'project');
    const snapshots: unknown[] = [];
    const sink = (msg: unknown) => snapshots.push(msg);
    const ctx = (workflowId: string) => ({
      workflowId,
      clusterId: cluster.clusterId,
      broadcastSender: () => undefined,
      broadcastRecipient: () => undefined,
    });

    const task = taskLedger.newTask({ title: 'implement lifecycle tools', parentIds: ['root'], reviewRequired: true });
    await taskLedger.save(cwd, [task]);

    await step('(a) peerTaskShow returns task details', async () => {
      const r = await peerOps.peerTaskShow(ctx(wfA), { id: task.id });
      assert(r.ok, 'show succeeds');
      assertEq(r.ok && r.details.task.id, task.id, 'details include task');
      assertEq(r.ok && r.details.comments.length, 0, 'details starts with no comments');
    });

    await step('(a2) peerTaskClaim assigns the task to wfA', async () => {
      // The lifecycle below completes the task, which is owner-gated (H48): a
      // member can only complete a task it owns. Claim it first so wfA is the
      // owner — otherwise peerTaskComplete correctly rejects with not_owner.
      const r = await peerOps.peerTaskClaim(ctx(wfA), { id: task.id }, sink);
      assert(r.ok, 'claim succeeds');
      assertEq(r.ok && r.task.assignee, wfA, 'task assigned to wfA');
      assertEq(r.ok && r.task.status, 'in_progress', 'claim moves task to in_progress');
    });

    await step('(b) peerTaskComment persists durable comment', async () => {
      const r = await peerOps.peerTaskComment(ctx(wfA), { id: task.id, body: 'Starting work.' }, sink);
      assert(r.ok, 'comment succeeds');
      assertEq(r.ok && r.comment.taskId, task.id, 'comment points at task');
      const state = await taskLedger.loadKernel(cwd);
      assertEq(state.comments.length, 1, 'comment persisted in kernel snapshot');
      assert(snapshots.length > 0, 'comment broadcasts a snapshot');
    });

    await step('(c) peerTaskBlock moves task to blocked and records reason/comment', async () => {
      const r = await peerOps.peerTaskBlock(ctx(wfA), { id: task.id, reason: 'missing API key' }, sink);
      assert(r.ok, 'block succeeds');
      assertEq(r.ok && r.task.status, 'blocked', 'task is blocked');
      assertEq(r.ok && r.task.blockedReason, 'missing API key', 'blockedReason stored');
      const details = await peerOps.peerTaskShow(ctx(wfA), { id: task.id });
      assert(details.ok, 'show after block succeeds');
      assert(details.ok && details.details.comments.some((c) => c.body.includes('BLOCKED')), 'blocked comment exists');
    });

    await step('(d) peerTaskComplete moves task to review, not done, and records report', async () => {
      const r = await peerOps.peerTaskComplete(ctx(wfA), { id: task.id, summary: 'Implemented and ran tests.' }, sink);
      assert(r.ok, 'complete succeeds');
      assertEq(r.ok && r.task.status, 'review', 'task moves to review');
      assert(r.ok && r.task.status !== 'done', 'complete never marks done');
      const details = await peerOps.peerTaskShow(ctx(wfA), { id: task.id });
      assert(details.ok, 'show after complete succeeds');
      assert(details.ok && details.details.comments.some((c) => c.body.includes('COMPLETION REPORT')), 'completion comment exists');
    });

    await step('(d2) peerTaskUpdate records an advisory director sign-off without marking done', async () => {
      // wfB stands in for the director reviewing the task. The director reviews
      // AFTER the worker completes (d); in this smoke those fire sub-millisecond
      // apart, which ties the event wall-clock (`at`) that rebuildFromEvents
      // folds on. Cross-workflow `seq` counters aren't comparable on a tie, so
      // without a gap the replay order of (d) vs (d2) is undefined and the
      // verdict can be folded away. A few ms models real review latency (real
      // reviews are seconds later — this never ties in production).
      await new Promise((resolve) => setTimeout(resolve, 5));
      const r = await peerOps.peerTaskUpdate(ctx(wfB), { id: task.id, status: 'review', signoff: { state: 'not_met', summary: 'tests fail on edge case' } }, sink);
      assert(r.ok, 'signoff update succeeds');
      assertEq(r.ok && r.task.signoff?.state, 'not_met', 'verdict stored');
      assertEq(r.ok && r.task.signoff?.summary, 'tests fail on edge case', 'summary stored');
      assertEq(r.ok && r.task.signoff?.byWorkflowId, wfB, 'sign-off author server-stamped to the caller');
      assert(r.ok && typeof r.task.signoff?.at === 'number', 'sign-off timestamp stamped');
      assertEq(r.ok && r.task.status, 'review', 'sign-off rides alongside a non-terminal status');
      assert(r.ok && r.task.status !== 'done', 'sign-off never marks done');
    });

    await step('(d3) a worker cannot reach done/archived through the update path', async () => {
      const r = await peerOps.peerTaskUpdate(ctx(wfA), { id: task.id, status: 'done' as never }, sink);
      assert(!r.ok && r.code === 'operator_gated', 'done stays operator-only');
    });

    await step('(d4) an invalid signoff.state is rejected', async () => {
      const r = await peerOps.peerTaskUpdate(ctx(wfB), { id: task.id, signoff: { state: 'looks_fine' } }, sink);
      assert(!r.ok && r.code === 'invalid_status', 'bogus verdict rejected');
    });

    await step('(e) comments replay from events after snapshot deletion', async () => {
      await flushAll();
      await fs.rm(path.join(cwd, '.arco', 'project', 'tasks.json'), { force: true });
      const state = await taskLedger.loadKernel(cwd);
      assert(state.comments.some((c) => c.body.includes('Starting work.')), 'plain comment replays');
      assert(state.comments.some((c) => c.body.includes('BLOCKED')), 'blocked comment replays');
      assert(state.comments.some((c) => c.body.includes('COMPLETION REPORT')), 'completion comment replays');
      const rebuilt = state.tasks.find((t) => t.id === task.id);
      assertEq(rebuilt?.status, 'review', 'task status also replays to review');
    });

    await step('(f) the director sign-off replays from events after snapshot deletion', async () => {
      await flushAll();
      await fs.rm(path.join(cwd, '.arco', 'project', 'tasks.json'), { force: true });
      const state = await taskLedger.loadKernel(cwd);
      const rebuilt = state.tasks.find((t) => t.id === task.id);
      assertEq(rebuilt?.signoff?.state, 'not_met', 'sign-off verdict replays from events');
      assertEq(rebuilt?.signoff?.byWorkflowId, wfB, 'sign-off author replays from events');
    });

    await clusterStore.deleteCluster(cluster.clusterId).catch(() => undefined);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await fs.rm(fakeHome, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  }

  summary('task-peer-lifecycle');
}

void main();
