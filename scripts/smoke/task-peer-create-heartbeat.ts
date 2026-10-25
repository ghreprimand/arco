// Director/workers lifecycle slice — cluster task create + heartbeat smoke.
//
// Headless/module-level. Drives clusterPeerOps against a real cluster +
// cwd-scoped task kernel:
//   (a) cluster_task_create rejects empty titles.
//   (b) cluster_task_create validates parent dependencies.
//   (c) cluster_task_create creates a todo task with metadata + assignee.
//   (d) cluster_task_heartbeat creates a visible run + durable note.
//   (e) run/comment replay from task_ledger_event after snapshot deletion.
//
// Run: npm run smoke:task-peer-create-heartbeat

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { step, assert, assertEq, summary } from './lib.js';

async function main(): Promise<void> {
  const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'archon-task-create-home-'));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'archon-task-create-cwd-'));
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
      await fs.mkdir(path.join(cwd, '.archon', 'workflows', wfid), { recursive: true });
      workflowCwds.set(wfid, cwd);
      workflows.set(wfid, { observers: new Set(), config: { workingDirectory: cwd } } as unknown as Parameters<typeof workflows.set>[1]);
      await writeMeta(cwd, {
        workflowId: wfid,
        name: 'task-create-smoke',
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
    const snapshots: Array<{ type: string; tasks: unknown[] }> = [];
    const sink = (msg: { type: string; tasks?: unknown[] }) => {
      if (msg.type === 'task_ledger_snapshot') snapshots.push({ type: msg.type, tasks: msg.tasks ?? [] });
    };
    const ctx = (workflowId: string) => ({
      workflowId,
      clusterId: cluster.clusterId,
      broadcastSender: () => undefined,
      broadcastRecipient: () => undefined,
    });

    const parent = taskLedger.newTask({ title: 'parent dependency' });
    await taskLedger.save(cwd, [parent]);
    let createdId = '';

    await step('(a) peerTaskCreate rejects empty titles', async () => {
      const r = await peerOps.peerTaskCreate(ctx(wfA), { title: '   ' }, sink);
      assert(!r.ok, 'empty title rejected');
      assertEq(!r.ok && r.code, 'empty_title', 'empty title code');
    });

    await step('(b) peerTaskCreate validates parent dependencies', async () => {
      const r = await peerOps.peerTaskCreate(ctx(wfA), { title: 'child', parentIds: ['missing-parent'] }, sink);
      assert(!r.ok, 'missing parent rejected');
      assertEq(!r.ok && r.code, 'invalid_link', 'missing parent uses invalid_link');
    });

    await step('(c) peerTaskCreate creates todo task with metadata + assignee', async () => {
      const r = await peerOps.peerTaskCreate(ctx(wfA), {
        title: 'build heartbeat support',
        body: 'Initial body text.',
        assignee: wfB.slice(0, 8),
        priority: 7,
        parentIds: [parent.id],
        links: [{ kind: 'url', ref: 'https://example.invalid/task', label: 'spec' }],
        reviewRequired: true,
        goalMode: true,
        goalMaxTurns: 3,
      }, sink);
      assert(r.ok, `create succeeds (got ${r.ok ? 'ok' : (r as { code: string }).code})`);
      assertEq(r.ok && r.task.status, 'todo', 'worker-created task starts todo');
      assertEq(r.ok && r.task.assignee, wfB, 'assignee resolves from prefix');
      assertEq(r.ok && r.task.notes, 'Initial body text.', 'body maps to notes');
      assertEq(r.ok && r.task.priority, 7, 'priority persists');
      assert(r.ok && r.task.parentIds.includes(parent.id), 'parent dependency persists');
      assert(r.ok && r.task.reviewRequired === true, 'reviewRequired persists');
      assert(r.ok && r.task.goalMode === true, 'goalMode persists');
      assertEq(r.ok && r.task.goalMaxTurns, 3, 'goalMaxTurns persists');
      createdId = r.ok ? r.task.id : '';
      assert(snapshots.length >= 1, 'create broadcasts snapshot');
    });

    await step('(d) peerTaskHeartbeat creates visible run + durable note', async () => {
      const r = await peerOps.peerTaskHeartbeat(ctx(wfB), { id: createdId, note: 'still testing heartbeat' }, sink);
      assert(r.ok, `heartbeat succeeds (got ${r.ok ? 'ok' : (r as { code: string }).code})`);
      assertEq(r.ok && r.run.taskId, createdId, 'run points at task');
      assertEq(r.ok && r.run.workflowId, wfB, 'run points at heartbeat worker');
      assertEq(r.ok && r.run.status, 'running', 'heartbeat run is running');
      assert(r.ok && typeof r.run.lastHeartbeatAt === 'number', 'lastHeartbeatAt is set');
      const details = await peerOps.peerTaskShow(ctx(wfA), { id: createdId });
      assert(details.ok, 'show after heartbeat succeeds');
      assert(details.ok && details.details.runs.some((run) => run.id === (r.ok && r.run.id)), 'show includes heartbeat run');
      assert(details.ok && details.details.comments.some((c) => c.body.includes('HEARTBEAT')), 'show includes heartbeat comment');
    });

    await step('(e) heartbeat run/comment replay after snapshot deletion', async () => {
      await flushAll();
      await fs.rm(path.join(cwd, '.archon', 'project', 'tasks.json'), { force: true });
      const state = await taskLedger.loadKernel(cwd);
      const rebuilt = state.tasks.find((t) => t.id === createdId);
      assert(rebuilt, 'created task replays from create event');
      assertEq(rebuilt?.assignee, wfB, 'created assignee replays');
      assert(state.runs.some((run) => run.taskId === createdId && run.workflowId === wfB), 'heartbeat run replays');
      assert(state.comments.some((c) => c.taskId === createdId && c.body.includes('HEARTBEAT')), 'heartbeat comment replays');
    });

    await clusterStore.deleteCluster(cluster.clusterId).catch(() => undefined);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await fs.rm(fakeHome, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  }

  summary('task-peer-create-heartbeat');
}

void main();
