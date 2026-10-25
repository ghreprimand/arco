// Director/workers Stage H — selected task-run recovery smoke.
//
// Headless/module-level. Drives the `task_run_recover` WS handler against a
// real cwd-scoped task kernel:
//   (a) stale-only reclaim rejects a fresh run.
//   (b) recovery rejects a closed run.
//   (c) stale reclaim mutates exactly one selected run and resets the task.
//   (d) terminate mutates exactly one selected run and blocks the task.
//   (e) reassign resolves a cluster member and makes the task ready.
//   (f) failure breaker blocks after N consecutive failed runs.
//   (g) recovered runs/tasks replay from task_ledger_event after snapshot loss.
//
// Run: npm run smoke:task-recovery

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { step, assert, assertEq, summary } from './lib.js';
import type { LedgerTask, TaskRun, TaskRunRecoverAction } from '../../shared/src/protocol/tasks.js';

const tasksJsonPath = (cwd: string) => path.join(cwd, '.arco', 'project', 'tasks.json');

function fakeWs(errors: string[]): WebSocket {
  return {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send(payload: string) {
      const parsed = JSON.parse(payload) as { type?: string; message?: string };
      if (parsed.type === 'error' && parsed.message) errors.push(parsed.message);
    },
  } as unknown as WebSocket;
}

function run(input: Partial<TaskRun> & Pick<TaskRun, 'taskId' | 'workflowId'>): TaskRun {
  const startedAt = input.startedAt ?? Date.now();
  return {
    id: input.id ?? randomUUID(),
    taskId: input.taskId,
    workflowId: input.workflowId,
    status: input.status ?? 'running',
    startedAt,
    lastHeartbeatAt: input.lastHeartbeatAt ?? startedAt,
    ...(input.clusterId ? { clusterId: input.clusterId } : {}),
    ...(input.endedAt ? { endedAt: input.endedAt } : {}),
    ...(input.error ? { error: input.error } : {}),
  };
}

async function main(): Promise<void> {
  const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'arco-task-recovery-home-'));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'arco-task-recovery-cwd-'));
  const prevHome = process.env.HOME;
  process.env.HOME = fakeHome;

  try {
    const taskLedger = await import('../../server/src/project/taskLedger.js');
    const clusterStore = await import('../../server/src/clusterStore.js');
    const { handleTaskRunRecover } = await import('../../server/src/ws/taskLedgerHandlers.js');
    const { writeMeta } = await import('../../server/src/workflowMeta.js');
    const { initWorkflowStore, flushAll } = await import('../../server/src/workflowStore.js');
    const { workflows, workflowCwds } = await import('../../server/src/server/state.js');

    const director = randomUUID();
    const workerA = randomUUID();
    const workerB = randomUUID();
    const wfids = [director, workerA, workerB];
    for (const wfid of wfids) {
      await fs.mkdir(path.join(cwd, '.arco', 'workflows', wfid), { recursive: true });
      workflowCwds.set(wfid, cwd);
      workflows.set(wfid, { observers: new Set(), config: { workingDirectory: cwd } } as unknown as Parameters<typeof workflows.set>[1]);
      await writeMeta(cwd, {
        workflowId: wfid,
        name: 'task-recovery-smoke',
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
    const cluster = await clusterStore.createCluster({ cwd, memberWorkflowIds: [director, workerA, workerB] });
    await clusterStore.setTaskBoardMode(cluster.clusterId, 'project');
    const errors: string[] = [];
    const ws = fakeWs(errors);

    async function recover(
      task: LedgerTask,
      selected: TaskRun,
      action: TaskRunRecoverAction,
      opts: Partial<{
        reason: string;
        reassignToWorkflowId: string;
        staleOnly: boolean;
        staleAfterMs: number;
        failureLimit: number;
      }> = {},
    ): Promise<void> {
      await handleTaskRunRecover(ws, {
        type: 'task_run_recover',
        workflowId: director,
        taskId: task.id,
        runId: selected.id,
        action,
        ...opts,
      });
    }

    await step('(a) stale-only reclaim rejects a fresh run', async () => {
      errors.length = 0;
      const task = taskLedger.newTask({ title: 'fresh run' });
      const fresh = run({ taskId: task.id, workflowId: workerA, clusterId: cluster.clusterId });
      await taskLedger.saveKernel(cwd, { tasks: [{ ...task, status: 'in_progress', assignee: workerA }], comments: [], runs: [fresh] });
      await recover(task, fresh, 'reclaim', { staleOnly: true, staleAfterMs: 60_000, reason: 'too fresh' });
      assert(errors.some((message) => message.includes('is not stale')), 'fresh reclaim is rejected');
      const state = await taskLedger.loadKernel(cwd);
      assertEq(state.runs.find((r) => r.id === fresh.id)?.status, 'running', 'fresh run remains running');
      assertEq(state.tasks.find((t) => t.id === task.id)?.status, 'in_progress', 'fresh task remains in_progress');
    });

    let reclaimedTaskId = '';
    let reclaimedRunId = '';

    await step('(b) recovery rejects a closed run', async () => {
      errors.length = 0;
      const task = taskLedger.newTask({ title: 'closed run' });
      const closed = run({
        taskId: task.id,
        workflowId: workerA,
        clusterId: cluster.clusterId,
        status: 'completed',
        endedAt: Date.now() - 1_000,
      });
      await taskLedger.saveKernel(cwd, { tasks: [{ ...task, status: 'review', assignee: workerA }], comments: [], runs: [closed] });
      await recover(task, closed, 'terminate', { reason: 'already closed' });
      assert(errors.some((message) => message.includes('is not open')), 'closed run recovery is rejected');
      const state = await taskLedger.loadKernel(cwd);
      assertEq(state.runs.find((r) => r.id === closed.id)?.status, 'completed', 'closed run remains completed');
      assertEq(state.tasks.find((t) => t.id === task.id)?.status, 'review', 'closed task remains review');
    });

    await step('(c) stale reclaim mutates exactly one selected run', async () => {
      errors.length = 0;
      const task = taskLedger.newTask({ title: 'stale reclaim' });
      const old = Date.now() - 10 * 60 * 1000;
      const stale = run({ taskId: task.id, workflowId: workerA, clusterId: cluster.clusterId, startedAt: old, lastHeartbeatAt: old });
      const sibling = run({ taskId: task.id, workflowId: workerB, clusterId: cluster.clusterId });
      await taskLedger.saveKernel(cwd, { tasks: [{ ...task, status: 'in_progress', assignee: workerA }], comments: [], runs: [stale, sibling] });
      await recover(task, stale, 'reclaim', { staleOnly: true, staleAfterMs: 60_000, reason: 'stale owner vanished' });
      assertEq(errors.length, 0, 'stale reclaim produces no errors');
      const state = await taskLedger.loadKernel(cwd);
      const recovered = state.runs.find((r) => r.id === stale.id);
      assertEq(recovered?.status, 'reclaimed', 'selected stale run is reclaimed');
      assert(recovered?.endedAt, 'selected stale run gets endedAt');
      assertEq(state.runs.find((r) => r.id === sibling.id)?.status, 'running', 'sibling run remains running');
      const updated = state.tasks.find((t) => t.id === task.id);
      assertEq(updated?.status, 'ready', 'task returns to ready');
      assertEq(updated?.assignee, undefined, 'reclaim clears assignee');
      reclaimedTaskId = task.id;
      reclaimedRunId = stale.id;
    });

    await step('(d) terminate mutates exactly one selected run and blocks task', async () => {
      const task = taskLedger.newTask({ title: 'terminate one run' });
      const selected = run({ taskId: task.id, workflowId: workerA, clusterId: cluster.clusterId });
      const sibling = run({ taskId: task.id, workflowId: workerB, clusterId: cluster.clusterId });
      await taskLedger.saveKernel(cwd, { tasks: [{ ...task, status: 'in_progress', assignee: workerA }], comments: [], runs: [selected, sibling] });
      await recover(task, selected, 'terminate', { reason: 'operator stop' });
      const state = await taskLedger.loadKernel(cwd);
      assertEq(state.runs.find((r) => r.id === selected.id)?.status, 'terminated', 'selected run is terminated');
      assertEq(state.runs.find((r) => r.id === sibling.id)?.status, 'running', 'sibling run is untouched');
      const updated = state.tasks.find((t) => t.id === task.id);
      assertEq(updated?.status, 'blocked', 'terminated task is blocked');
      assert(updated?.blockedReason.includes('operator stop'), 'blocked reason records operator reason');
    });

    await step('(e) reassign resolves cluster member and makes task ready', async () => {
      const task = taskLedger.newTask({ title: 'reassign run' });
      const selected = run({ taskId: task.id, workflowId: workerA, clusterId: cluster.clusterId });
      await taskLedger.saveKernel(cwd, { tasks: [{ ...task, status: 'in_progress', assignee: workerA }], comments: [], runs: [selected] });
      await recover(task, selected, 'reassign', { reassignToWorkflowId: workerB.slice(0, 8), reason: 'move to available worker' });
      const state = await taskLedger.loadKernel(cwd);
      assertEq(state.runs.find((r) => r.id === selected.id)?.status, 'reclaimed', 'old run is reclaimed for reassign');
      const updated = state.tasks.find((t) => t.id === task.id);
      assertEq(updated?.status, 'ready', 'reassigned task is ready');
      assertEq(updated?.assignee, workerB, 'reassign resolves member prefix to workflow id');
    });

    await step('(f) failure breaker blocks after consecutive failures', async () => {
      const task = taskLedger.newTask({ title: 'failure breaker' });
      const now = Date.now();
      const failedOne = run({ taskId: task.id, workflowId: workerA, status: 'failed', endedAt: now - 3_000, startedAt: now - 5_000, error: 'first' });
      const failedTwo = run({ taskId: task.id, workflowId: workerB, status: 'failed', endedAt: now - 2_000, startedAt: now - 4_000, error: 'second' });
      const selected = run({ taskId: task.id, workflowId: workerA, status: 'running', startedAt: now - 1_000 });
      await taskLedger.saveKernel(cwd, { tasks: [{ ...task, status: 'in_progress', assignee: workerA }], comments: [], runs: [failedOne, failedTwo, selected] });
      await recover(task, selected, 'fail', { reason: 'third failure', failureLimit: 3 });
      const state = await taskLedger.loadKernel(cwd);
      assertEq(state.runs.find((r) => r.id === selected.id)?.status, 'failed', 'selected run is failed');
      const updated = state.tasks.find((t) => t.id === task.id);
      assertEq(updated?.status, 'blocked', 'task blocks at failure limit');
      assert(updated?.blockedReason.includes('3 consecutive failed runs'), 'blocked reason records breaker count');
    });

    await step('(g) recovered run/task replay from events after snapshot loss', async () => {
      await flushAll();
      await fs.rm(tasksJsonPath(cwd), { force: true });
      const state = await taskLedger.loadKernel(cwd);
      assert(state.tasks.some((task) => task.id === reclaimedTaskId && task.status === 'ready'), 'reclaimed task replays');
      assert(state.runs.some((r) => r.id === reclaimedRunId && r.status === 'reclaimed'), 'reclaimed run replays');
    });

    await clusterStore.deleteCluster(cluster.clusterId).catch(() => undefined);
    for (const wfid of wfids) {
      workflows.delete(wfid);
      workflowCwds.delete(wfid);
    }
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await fs.rm(fakeHome, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  }

  summary('task-recovery');
}

void main();
