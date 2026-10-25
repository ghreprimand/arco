// Director/workers Stage I — swarm graph helper smoke.
//
// Headless/module-level. Drives handleClusterSwarmCreate against a real
// cluster + cwd-scoped task kernel, with task dispatch turns disabled:
//   (a) create-only swarm builds root + N workers + verifier + synthesizer.
//   (b) create-only swarm does not dispatch or arm the daemon.
//   (c) graph replays from task_ledger_event after snapshot deletion.
//   (d) duplicate worker/verifier/synthesizer roles are rejected.
//   (e) armDispatch runs only the deterministic dispatcher and never marks
//       worker/verifier/synthesizer tasks done.
//
// Run: npm run smoke:task-swarm

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { step, assert, assertEq, summary } from './lib.js';
import type { LedgerTask } from '../../shared/src/protocol/tasks.js';

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

function requireTask(tasks: LedgerTask[], predicate: (task: LedgerTask) => boolean, label: string): LedgerTask {
  const task = tasks.find(predicate);
  assert(task, `${label} exists`);
  return task;
}

async function main(): Promise<void> {
  const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'archon-task-swarm-home-'));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'archon-task-swarm-cwd-'));
  const prevHome = process.env.HOME;
  const prevNoDispatch = process.env.ARCHON_TEST_NO_TASK_DISPATCH;
  process.env.HOME = fakeHome;
  process.env.ARCHON_TEST_NO_TASK_DISPATCH = '1';

  try {
    const clusterStore = await import('../../server/src/clusterStore.js');
    const taskLedger = await import('../../server/src/project/taskLedger.js');
    const { handleClusterSwarmCreate } = await import('../../server/src/ws/clusterHandlers.js');
    const { writeMeta } = await import('../../server/src/workflowMeta.js');
    const { initWorkflowStore, flushAll } = await import('../../server/src/workflowStore.js');
    const { workflows, workflowCwds } = await import('../../server/src/server/state.js');

    const requester = randomUUID();
    const workerA = randomUUID();
    const workerB = randomUUID();
    const verifier = randomUUID();
    const synthesizer = randomUUID();
    const wfids = [requester, workerA, workerB, verifier, synthesizer];
    for (const wfid of wfids) {
      await fs.mkdir(path.join(cwd, '.archon', 'workflows', wfid), { recursive: true });
      workflowCwds.set(wfid, cwd);
      workflows.set(wfid, {
        busy: false,
        observers: new Set(),
        config: { workingDirectory: cwd },
        primary: { provider: 'claude', model: 'smoke-model', effort: 'medium', tools: [] },
      } as unknown as Parameters<typeof workflows.set>[1]);
      await writeMeta(cwd, {
        workflowId: wfid,
        name: 'task-swarm-smoke',
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
      memberWorkflowIds: wfids,
    });
    await clusterStore.setTaskBoardMode(cluster.clusterId, 'project');
    const errors: string[] = [];
    const ws = fakeWs(errors);

    let rootId = '';
    let workerTaskIds: string[] = [];
    let verifierTaskId = '';
    let synthesizerTaskId = '';

    await step('(a) create-only swarm builds expected graph', async () => {
      errors.length = 0;
      await handleClusterSwarmCreate(ws, {
        type: 'cluster_swarm_create',
        clusterId: cluster.clusterId,
        workflowId: requester,
        requestId: 'swarm-create-only',
        goal: 'map auth migration smoke',
        workerWorkflowIds: [workerA, workerB],
        verifierWorkflowId: verifier,
        synthesizerWorkflowId: synthesizer,
      });
      assertEq(errors.length, 0, 'swarm create emitted no errors');

      const state = await taskLedger.loadKernel(cwd);
      const root = requireTask(state.tasks, (task) => task.title.startsWith('Swarm brief: map auth migration smoke'), 'root blackboard');
      const workers = state.tasks
        .filter((task) => task.title.includes(': map auth migration smoke') && task.title.startsWith('Worker '))
        .sort((a, b) => a.priority === b.priority ? a.id.localeCompare(b.id) : b.priority - a.priority);
      const verify = requireTask(state.tasks, (task) => task.title.startsWith('Verify swarm work: map auth migration smoke'), 'verifier');
      const synth = requireTask(state.tasks, (task) => task.title.startsWith('Synthesize swarm result: map auth migration smoke'), 'synthesizer');

      assertEq(root.status, 'done', 'root blackboard is immediately done context');
      assert(root.notes.includes('map auth migration smoke'), 'root carries brief');
      assertEq(workers.length, 2, 'two worker tasks created');
      assert(workers.every((task) => task.status === 'ready'), 'worker tasks start ready');
      assertEq(workers[0]?.assignee, workerA, 'worker 1 assigned');
      assertEq(workers[1]?.assignee, workerB, 'worker 2 assigned');
      assert(workers.every((task) => task.parentIds.includes(root.id)), 'workers depend on root context');
      assertEq(verify.assignee, verifier, 'verifier assigned');
      assertEq(verify.parentIds.length, 2, 'verifier depends on both workers');
      assert(workers.every((task) => verify.parentIds.includes(task.id)), 'verifier parent set is all workers');
      assertEq(synth.assignee, synthesizer, 'synthesizer assigned');
      assertEq(synth.parentIds.length, 1, 'synthesizer has one parent');
      assertEq(synth.parentIds[0], verify.id, 'synthesizer depends on verifier');

      rootId = root.id;
      workerTaskIds = workers.map((task) => task.id);
      verifierTaskId = verify.id;
      synthesizerTaskId = synth.id;
    });

    await step('(b) create-only swarm does not dispatch or arm daemon', async () => {
      const state = await taskLedger.loadKernel(cwd);
      assertEq(state.runs.length, 0, 'no task runs created without armDispatch');
      const settings = clusterStore.taskDispatcherSettingsFor(cluster.clusterId);
      assertEq(settings.enabled, false, 'dispatcher daemon remains off');
      const nonRoot = state.tasks.filter((task) => [workerTaskIds, [verifierTaskId], [synthesizerTaskId]].flat().includes(task.id));
      assert(nonRoot.every((task) => task.status !== 'done'), 'no non-root task is done');
    });

    await step('(c) swarm graph replays from events after snapshot deletion', async () => {
      await flushAll();
      await fs.rm(path.join(cwd, '.archon', 'project', 'tasks.json'), { force: true });
      const state = await taskLedger.loadKernel(cwd);
      const root = state.tasks.find((task) => task.id === rootId);
      const workers = state.tasks.filter((task) => workerTaskIds.includes(task.id));
      const verify = state.tasks.find((task) => task.id === verifierTaskId);
      const synth = state.tasks.find((task) => task.id === synthesizerTaskId);
      assertEq(root?.status, 'done', 'root status replays');
      assertEq(workers.length, 2, 'worker tasks replay');
      assert(workers.every((task) => task.parentIds.includes(rootId)), 'worker dependencies replay');
      assertEq(verify?.parentIds.length, 2, 'verifier dependencies replay');
      assertEq(synth?.parentIds[0], verifierTaskId, 'synth dependency replays');
    });

    await step('(d) duplicate worker/verifier/synthesizer roles are rejected', async () => {
      errors.length = 0;
      await handleClusterSwarmCreate(ws, {
        type: 'cluster_swarm_create',
        clusterId: cluster.clusterId,
        workflowId: requester,
        requestId: 'swarm-duplicate-role',
        goal: 'duplicate role smoke',
        workerWorkflowIds: [workerA, verifier],
        verifierWorkflowId: verifier,
        synthesizerWorkflowId: synthesizer,
      });
      assert(errors.some((message) => message.includes('duplicate_roles')), 'duplicate verifier worker role rejected');
    });

    await step('(e) armDispatch dispatches workers without auto-done', async () => {
      errors.length = 0;
      const before = await taskLedger.loadKernel(cwd);
      const previousGraph = new Set([...workerTaskIds, verifierTaskId, synthesizerTaskId]);
      await taskLedger.saveKernel(cwd, {
        ...before,
        tasks: before.tasks.map((task) => previousGraph.has(task.id)
          ? { ...task, status: 'blocked', blockedReason: 'smoke setup: keep prior graph out of dispatch queue' }
          : task),
      });
      await handleClusterSwarmCreate(ws, {
        type: 'cluster_swarm_create',
        clusterId: cluster.clusterId,
        workflowId: requester,
        requestId: 'swarm-arm-dispatch',
        goal: 'ship release checklist smoke',
        workerWorkflowIds: [workerA, workerB],
        verifierWorkflowId: verifier,
        synthesizerWorkflowId: synthesizer,
        armDispatch: true,
      });
      assertEq(errors.length, 0, 'armed swarm emitted no errors');
      const state = await taskLedger.loadKernel(cwd);
      const workers = state.tasks.filter((task) => task.title.includes(': ship release checklist smoke') && task.title.startsWith('Worker '));
      const verify = requireTask(state.tasks, (task) => task.title.startsWith('Verify swarm work: ship release checklist smoke'), 'armed verifier');
      const synth = requireTask(state.tasks, (task) => task.title.startsWith('Synthesize swarm result: ship release checklist smoke'), 'armed synthesizer');
      assertEq(workers.length, 2, 'armed swarm has two workers');
      assert(workers.every((task) => task.status === 'in_progress'), 'armDispatch fired worker tasks');
      assertEq(verify.status, 'ready', 'verifier waits for workers');
      assertEq(synth.status, 'ready', 'synthesizer waits for verifier');
      assert(workers.every((task) => task.status !== 'done'), 'workers not auto-done');
      assert(verify.status !== 'done' && synth.status !== 'done', 'verifier/synthesizer not auto-done');
      assertEq(state.runs.filter((run) => workers.some((task) => task.id === run.taskId) && run.status === 'running').length, 2, 'worker runs created');
    });

    await clusterStore.deleteCluster(cluster.clusterId).catch(() => undefined);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevNoDispatch === undefined) delete process.env.ARCHON_TEST_NO_TASK_DISPATCH;
    else process.env.ARCHON_TEST_NO_TASK_DISPATCH = prevNoDispatch;
    await fs.rm(fakeHome, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  }

  summary('task-swarm');
}

void main();
