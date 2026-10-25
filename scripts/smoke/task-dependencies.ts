// Director/workers Stage C — task dependency peer-tools smoke.
//
// Headless/module-level. Verifies cluster_task_link / cluster_task_unlink:
//   (a) link adds parentId to child.
//   (b) show returns parent/child graph.
//   (c) cycle is rejected.
//   (d) unlink removes the dependency.
//
// Run: npm run smoke:task-dependencies

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { step, assert, assertEq, summary } from './lib.js';

async function main(): Promise<void> {
  const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'archon-task-deps-home-'));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'archon-task-deps-cwd-'));
  const prevHome = process.env.HOME;
  process.env.HOME = fakeHome;

  try {
    const clusterStore = await import('../../server/src/clusterStore.js');
    const peerOps = await import('../../server/src/clusterPeerOps.js');
    const taskLedger = await import('../../server/src/project/taskLedger.js');
    const { writeMeta } = await import('../../server/src/workflowMeta.js');
    const { initWorkflowStore } = await import('../../server/src/workflowStore.js');
    const { workflows, workflowCwds } = await import('../../server/src/server/state.js');

    const wfA = randomUUID();
    const wfB = randomUUID();
    for (const wfid of [wfA, wfB]) {
      await fs.mkdir(path.join(cwd, '.archon', 'workflows', wfid), { recursive: true });
      workflowCwds.set(wfid, cwd);
      workflows.set(wfid, { observers: new Set(), config: { workingDirectory: cwd } } as unknown as Parameters<typeof workflows.set>[1]);
      await writeMeta(cwd, {
        workflowId: wfid,
        name: 'task-deps-smoke',
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
    const sink = () => undefined;
    const ctx = { workflowId: wfA, clusterId: cluster.clusterId, broadcastSender: () => undefined, broadcastRecipient: () => undefined };

    const parent = taskLedger.newTask({ title: 'parent task' });
    const child = taskLedger.newTask({ title: 'child task' });
    const grandchild = taskLedger.newTask({ title: 'grandchild task' });
    await taskLedger.save(cwd, [parent, child, grandchild]);

    await step('(a) peerTaskLink adds parentId to child', async () => {
      const r = await peerOps.peerTaskLink(ctx, { parentId: parent.id, childId: child.id }, sink);
      assert(r.ok, 'link succeeds');
      assert(r.ok && r.task.parentIds.includes(parent.id), 'child carries parent id');
      const persisted = (await taskLedger.load(cwd)).find((t) => t.id === child.id);
      assert(persisted?.parentIds.includes(parent.id), 'dependency persisted');
    });

    await step('(b) peerTaskShow returns graph relations', async () => {
      await peerOps.peerTaskLink(ctx, { parentId: child.id, childId: grandchild.id }, sink);
      const childDetails = await peerOps.peerTaskShow(ctx, { id: child.id });
      assert(childDetails.ok, 'show child succeeds');
      assertEq(childDetails.ok && childDetails.details.parents.length, 1, 'child has one parent');
      assertEq(childDetails.ok && childDetails.details.children.length, 1, 'child has one child');
      assertEq(childDetails.ok && childDetails.details.parents[0].id, parent.id, 'parent relation is correct');
      assertEq(childDetails.ok && childDetails.details.children[0].id, grandchild.id, 'child relation is correct');
    });

    await step('(c) peerTaskLink rejects cycles', async () => {
      const r = await peerOps.peerTaskLink(ctx, { parentId: grandchild.id, childId: parent.id }, sink);
      assert(!r.ok, 'cycle link rejected');
      assertEq(!r.ok && r.code, 'invalid_link', 'cycle rejection code');
    });

    await step('(d) peerTaskUnlink removes dependency', async () => {
      const r = await peerOps.peerTaskUnlink(ctx, { parentId: parent.id, childId: child.id }, sink);
      assert(r.ok, 'unlink succeeds');
      assert(r.ok && !r.task.parentIds.includes(parent.id), 'parent id removed');
      const persisted = (await taskLedger.load(cwd)).find((t) => t.id === child.id);
      assert(persisted && !persisted.parentIds.includes(parent.id), 'unlink persisted');
    });

    await clusterStore.deleteCluster(cluster.clusterId).catch(() => undefined);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await fs.rm(fakeHome, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  }

  summary('task-dependencies');
}

void main();
