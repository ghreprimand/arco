// Director/workers Stage G smoke — armed task dispatcher daemon.
//
// Exercises the daemon directly with fake workflow state and a stubbed turn
// dispatcher. No server, provider, or API key is required.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { step, assert, assertEq, summary } from './lib.js';

async function main(): Promise<void> {
  const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'arco-task-dispatch-daemon-home-'));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'arco-task-dispatch-daemon-cwd-'));
  const prevHome = process.env.HOME;
  const prevMinInterval = process.env.ARCO_TASK_DISPATCHER_MIN_INTERVAL_MS;
  const prevDefaultInterval = process.env.ARCO_TASK_DISPATCHER_DEFAULT_INTERVAL_MS;
  process.env.HOME = fakeHome;
  process.env.ARCO_TASK_DISPATCHER_MIN_INTERVAL_MS = '100';
  process.env.ARCO_TASK_DISPATCHER_DEFAULT_INTERVAL_MS = '100';

  try {
    const clusterStore = await import('../../server/src/clusterStore.js');
    const taskLedger = await import('../../server/src/project/taskLedger.js');
    const dispatcher = await import('../../server/src/taskDispatcher.js');
    const { workflows, workflowCwds } = await import('../../server/src/server/state.js');
    const { writeMeta } = await import('../../server/src/workflowMeta.js');
    const { initWorkflowStore, flushAll } = await import('../../server/src/workflowStore.js');

    const requester = randomUUID();
    const workerA = randomUUID();
    const workerB = randomUUID();
    for (const wfid of [requester, workerA, workerB]) {
      await fs.mkdir(path.join(cwd, '.arco', 'workflows', wfid), { recursive: true });
      workflowCwds.set(wfid, cwd);
      workflows.set(wfid, {
        busy: false,
        observers: new Set(),
        config: { workingDirectory: cwd },
        primary: { provider: 'claude', model: 'smoke-model', effort: 'medium', tools: [] },
      } as unknown as Parameters<typeof workflows.set>[1]);
      await writeMeta(cwd, {
        workflowId: wfid,
        name: 'task-dispatch-daemon-smoke',
        cwd,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        primaryProvider: 'claude',
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
      memberWorkflowIds: [requester, workerA, workerB],
    });
    await clusterStore.setTaskBoardMode(cluster.clusterId, 'project');

    const ready = (title: string, assignee: string, priority: number) => {
      const task = taskLedger.newTask({ title, priority });
      return taskLedger.applyUpdate([task], task.id, { status: 'ready', assignee, priority })!.updated;
    };

    const first = ready('default off then fire', workerA, 50);
    await taskLedger.save(cwd, [first]);

    const dispatched: Array<{ workflowId: string; prompt: string }> = [];
    const results: dispatcher.DispatchOnceResult[] = [];
    dispatcher.configureDispatcherDaemon({
      dispatchTaskTurn: (workflowId, prompt) => dispatched.push({ workflowId, prompt }),
      publishResult: (result) => { results.push(result); },
    });

    await step('(a) dispatcher settings default OFF and do not fire ready work', async () => {
      const settings = clusterStore.taskDispatcherSettingsFor(cluster.clusterId);
      assertEq(settings.enabled, false, 'default enabled=false');
      await dispatcher.sweepDispatcherDaemon();
      assertEq(dispatched.length, 0, 'no dispatch while disabled');
    });

    await step('(b) settings update + toggle ON persist in cluster meta', async () => {
      await clusterStore.updateTaskDispatcherSettings(cluster.clusterId, {
        intervalMs: 100,
        maxTasksPerSweep: 1,
        maxConcurrentRuns: 1,
      });
      await clusterStore.setTaskDispatcherEnabled(cluster.clusterId, true);
      const persisted = await clusterStore.readCluster(cluster.clusterId);
      assertEq(persisted?.dispatcher?.enabled, true, 'enabled persisted');
      assertEq(persisted?.dispatcher?.intervalMs, 100, 'interval persisted');
      assertEq(persisted?.dispatcher?.maxTasksPerSweep, 1, 'sweep cap persisted');
      assertEq(persisted?.dispatcher?.maxConcurrentRuns, 1, 'run cap persisted');
    });

    await step('(c) daemon sweep fires one eligible explicit-assignee task', async () => {
      await dispatcher.sweepDispatcherDaemon();
      assertEq(dispatched.length, 1, 'one task dispatched');
      assertEq(dispatched[0]?.workflowId, workerA, 'dispatched to explicit assignee');
      assert(results.some((r) => r.fired.some((f) => f.taskId === first.id)), 'dispatch result recorded');
      const state = await taskLedger.loadKernel(cwd);
      assertEq(state.tasks.find((task) => task.id === first.id)?.status, 'in_progress', 'task moved to in_progress');
      assert(state.runs.some((run) => run.taskId === first.id && run.status === 'running'), 'run created');
    });

    await step('(d) maxConcurrentRuns prevents double-feed while a run is open', async () => {
      const second = ready('held by run cap', workerB, 99);
      const state = await taskLedger.loadKernel(cwd);
      await taskLedger.saveKernel(cwd, { ...state, tasks: [...state.tasks, second] });
      dispatcher.notifyDispatcherSettingsChanged(cluster.clusterId);
      await dispatcher.sweepDispatcherDaemon();
      assertEq(dispatched.length, 1, 'no second dispatch while run cap is saturated');
      const firstFires = results.flatMap((r) => r.fired).filter((f) => f.taskId === first.id);
      assertEq(firstFires.length, 1, 'open run was not double-dispatched');
    });

    await step('(e) sweep cap honors deterministic priority once capacity opens', async () => {
      await clusterStore.updateTaskDispatcherSettings(cluster.clusterId, { maxConcurrentRuns: 3 });
      dispatcher.notifyDispatcherSettingsChanged(cluster.clusterId);
      const low = ready('low later', workerB, 1);
      const high = ready('high first', workerB, 100);
      const state = await taskLedger.loadKernel(cwd);
      await taskLedger.saveKernel(cwd, { ...state, tasks: [...state.tasks, low, high] });
      await dispatcher.sweepDispatcherDaemon();
      assert(results.some((r) => r.fired.some((f) => f.taskId === high.id)), 'highest priority fired');
      assert(!results.some((r) => r.fired.some((f) => f.taskId === low.id)), 'low priority did not fire in capped sweep');
    });

    await step('(f) toggle OFF stops new fires and replay preserves daemon-created runs', async () => {
      await clusterStore.setTaskDispatcherEnabled(cluster.clusterId, false);
      const afterOff = ready('after off', workerA, 200);
      const state = await taskLedger.loadKernel(cwd);
      await taskLedger.saveKernel(cwd, { ...state, tasks: [...state.tasks, afterOff] });
      const before = dispatched.length;
      await dispatcher.sweepDispatcherDaemon();
      assertEq(dispatched.length, before, 'no dispatch after disable');
      await flushAll();
      await fs.rm(path.join(cwd, '.arco', 'project', 'tasks.json'), { force: true });
      const rebuilt = await taskLedger.loadKernel(cwd);
      assert(rebuilt.runs.some((run) => run.taskId === first.id), 'dispatch run replayed');
    });

    dispatcher.dropCluster(cluster.clusterId);
    await clusterStore.deleteCluster(cluster.clusterId).catch(() => undefined);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevMinInterval === undefined) delete process.env.ARCO_TASK_DISPATCHER_MIN_INTERVAL_MS;
    else process.env.ARCO_TASK_DISPATCHER_MIN_INTERVAL_MS = prevMinInterval;
    if (prevDefaultInterval === undefined) delete process.env.ARCO_TASK_DISPATCHER_DEFAULT_INTERVAL_MS;
    else process.env.ARCO_TASK_DISPATCHER_DEFAULT_INTERVAL_MS = prevDefaultInterval;
    await fs.rm(fakeHome, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  }

  summary('task-dispatch-daemon');
}

void main();
