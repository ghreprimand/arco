// Director/workers Stage F smoke — one-shot deterministic dispatcher.
//
// Exercises the dispatcher directly with fake workflow state and a stubbed
// turn dispatcher. No provider process is started.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { step, assert, assertEq, summary } from './lib.js';

async function main(): Promise<void> {
  const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'archon-task-dispatch-home-'));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'archon-task-dispatch-cwd-'));
  const prevHome = process.env.HOME;
  process.env.HOME = fakeHome;

  try {
    const clusterStore = await import('../../server/src/clusterStore.js');
    const taskLedger = await import('../../server/src/project/taskLedger.js');
    const dispatcher = await import('../../server/src/taskDispatcher.js');
    const { workflows, workflowCwds } = await import('../../server/src/server/state.js');
    const { writeMeta } = await import('../../server/src/workflowMeta.js');
    const { initWorkflowStore, flushAll } = await import('../../server/src/workflowStore.js');

    const requester = randomUUID();
    const worker = randomUUID();
    const busyWorker = randomUUID();
    const unsupportedWorker = randomUUID();
    for (const [wfid, busy, provider] of [
      [requester, false, 'claude'],
      [worker, false, 'claude'],
      [busyWorker, true, 'claude'],
      [unsupportedWorker, false, 'gemini'],
    ] as const) {
      await fs.mkdir(path.join(cwd, '.archon', 'workflows', wfid), { recursive: true });
      workflowCwds.set(wfid, cwd);
      workflows.set(wfid, {
        busy,
        observers: new Set(),
        config: { workingDirectory: cwd },
        primary: { provider, model: 'smoke-model', effort: 'medium', tools: [] },
      } as unknown as Parameters<typeof workflows.set>[1]);
      await writeMeta(cwd, {
        workflowId: wfid,
        name: 'task-dispatch-smoke',
        cwd,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        primaryProvider: provider,
        primaryModel: 'smoke-model',
        primaryEffort: 'medium',
        cliSessions: [],
        operator: 'smoke',
        lastEventSeq: null,
        lastTranscriptSeq: null,
        compactedAt: null,
      } as Parameters<typeof writeMeta>[1]);
      await initWorkflowStore(cwd, wfid);
    }

    const cluster = await clusterStore.createCluster({
      cwd,
      memberWorkflowIds: [requester, worker, busyWorker, unsupportedWorker],
    });
    await clusterStore.setTaskBoardMode(cluster.clusterId, 'project');
    const doneParent = taskLedger.newTask({ title: 'done parent' });
    const blockedParent = taskLedger.newTask({ title: 'blocked parent' });
    const doneParentTask = taskLedger.applyUpdate([doneParent], doneParent.id, { status: 'done' })!.updated;
    const ready = (title: string, assignee?: string, parentIds: string[] = []) => {
      const task = taskLedger.newTask({ title, parentIds });
      return taskLedger.applyUpdate([task], task.id, {
        status: 'ready',
        ...(assignee ? { assignee } : {}),
        priority: title === 'fire me' ? 10 : 1,
      })!.updated;
    };
    const fireMe = ready('fire me', worker, [doneParent.id]);
    const sameMember = ready('same member later', worker, [doneParent.id]);
    const noAssignee = ready('no assignee');
    const missingAssignee = ready('not a member', randomUUID());
    const busy = ready('busy worker', busyWorker);
    const unsupported = ready('unsupported worker', unsupportedWorker);
    const dependencyBlocked = ready('blocked dependency', worker, [blockedParent.id]);
    await taskLedger.save(cwd, [
      doneParentTask,
      blockedParent,
      fireMe,
      sameMember,
      noAssignee,
      missingAssignee,
      busy,
      unsupported,
      dependencyBlocked,
    ]);

    const dispatched: Array<{ workflowId: string; prompt: string }> = [];
    let result: Awaited<ReturnType<typeof dispatcher.dispatchOnce>> | null = null;

    await step('(a) dispatchOnce fires exactly one eligible ready task', async () => {
      result = await dispatcher.dispatchOnce({
        clusterId: cluster.clusterId,
        requestedByWorkflowId: requester,
        dispatchTaskTurn: (workflowId, prompt) => dispatched.push({ workflowId, prompt }),
      });
      assert(result !== null && !('error' in result), 'dispatch returns result');
      if (!result || 'error' in result) return;
      assertEq(result.fired.length, 1, 'one task fired');
      assertEq(result.fired[0]?.taskId, fireMe.id, 'highest-priority eligible task fired');
      assertEq(dispatched.length, 1, 'one synthetic turn dispatched');
      assertEq(dispatched[0]?.workflowId, worker, 'turn dispatched to assignee');
      assert(dispatched[0]?.prompt.includes('cluster_task_show'), 'prompt instructs worker to call task show');
    });

    await step('(b) dispatcher records expected skip reasons', async () => {
      assert(result !== null && !('error' in result), 'dispatch result exists');
      if (!result || 'error' in result) return;
      const reasons = new Map(result.skipped.map((s) => [s.taskId, s.reason]));
      assertEq(reasons.get(sameMember.id), 'member_cap', 'one task per member cap');
      assertEq(reasons.get(noAssignee.id), 'no_assignee', 'no assignee skipped');
      assertEq(reasons.get(missingAssignee.id), 'assignee_not_member', 'non-member skipped');
      assertEq(reasons.get(busy.id), 'member_busy', 'busy member skipped');
      assertEq(reasons.get(unsupported.id), 'unsupported_provider', 'unsupported provider skipped');
      assertEq(reasons.get(dependencyBlocked.id), 'dependency_blocked', 'blocked dependency skipped');
    });

    await step('(c) dispatch writes task status + run before turn starts', async () => {
      const state = await taskLedger.loadKernel(cwd);
      const updated = state.tasks.find((task) => task.id === fireMe.id);
      assertEq(updated?.status, 'in_progress', 'fired task moved to in_progress');
      assert(state.runs.some((run) => run.taskId === fireMe.id && run.workflowId === worker && run.status === 'running'), 'run created for fired task');
    });

    await step('(d) dispatch run replays from events after snapshot deletion', async () => {
      await flushAll();
      await fs.rm(path.join(cwd, '.archon', 'project', 'tasks.json'), { force: true });
      const state = await taskLedger.loadKernel(cwd);
      assert(state.runs.some((run) => run.taskId === fireMe.id && run.workflowId === worker), 'run replayed');
      assertEq(state.tasks.find((task) => task.id === fireMe.id)?.status, 'in_progress', 'status replayed');
    });

    await clusterStore.deleteCluster(cluster.clusterId).catch(() => undefined);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await fs.rm(fakeHome, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  }

  summary('task-dispatch-once');
}

void main();
