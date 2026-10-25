// Director/workers Stage J smoke — worktree-aware task dispatch.
//
// Exercises the dispatcher directly against a temp git repo. No provider
// process is started; the turn dispatch is stubbed.

import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { step, assert, assertEq, summary } from './lib.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function writeWorkflowMeta(cwd: string, workflowId: string, provider: 'claude'): Promise<void> {
  const { workflowCwds, workflows } = await import('../../server/src/server/state.js');
  const { writeMeta } = await import('../../server/src/workflowMeta.js');
  const { initWorkflowStore } = await import('../../server/src/workflowStore.js');

  await fs.mkdir(path.join(cwd, '.arco', 'workflows', workflowId), { recursive: true });
  workflowCwds.set(workflowId, cwd);
  workflows.set(workflowId, {
    busy: false,
    observers: new Set(),
    config: { workingDirectory: cwd },
    primary: { provider, model: 'smoke-model', effort: 'medium', tools: [] },
  } as unknown as Parameters<typeof workflows.set>[1]);
  await writeMeta(cwd, {
    workflowId,
    name: 'task-dispatch-worktree-smoke',
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
  await initWorkflowStore(cwd, workflowId);
}

async function main(): Promise<void> {
  const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'arco-task-dispatch-wt-home-'));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'arco-task-dispatch-wt-cwd-'));
  const prevHome = process.env.HOME;
  process.env.HOME = fakeHome;

  try {
    git(cwd, 'init', '-q');
    git(cwd, 'config', 'user.email', 'test@arco.local');
    git(cwd, 'config', 'user.name', 'arco-test');
    git(cwd, 'checkout', '-q', '-B', 'main');
    await fs.writeFile(path.join(cwd, 'tracked.txt'), 'original\n');
    git(cwd, 'add', 'tracked.txt');
    git(cwd, 'commit', '-q', '-m', 'initial');

    const headBefore = git(cwd, 'rev-parse', 'HEAD');

    const clusterStore = await import('../../server/src/clusterStore.js');
    const taskLedger = await import('../../server/src/project/taskLedger.js');
    const dispatcher = await import('../../server/src/taskDispatcher.js');
    const { worktreesRoot, listTaskWorktrees } = await import('../../server/src/project/taskWorktree.js');

    const requester = randomUUID();
    const worker = randomUUID();
    await writeWorkflowMeta(cwd, requester, 'claude');
    await writeWorkflowMeta(cwd, worker, 'claude');

    const cluster = await clusterStore.createCluster({
      cwd,
      memberWorkflowIds: [requester, worker],
    });
    await clusterStore.setTaskBoardMode(cluster.clusterId, 'project');

    const task = taskLedger.newTask({ title: 'isolate before dispatch', worktreeRequired: true });
    const ready = taskLedger.applyUpdate([task], task.id, {
      status: 'ready',
      assignee: worker,
      priority: 10,
    })!.updated;
    await taskLedger.save(cwd, [ready]);

    const dispatched: Array<{ workflowId: string; prompt: string }> = [];

    await step('(a) required worktree task is skipped when autoWorktree is off', async () => {
      const result = await dispatcher.dispatchOnce({
        clusterId: cluster.clusterId,
        requestedByWorkflowId: requester,
        dispatchTaskTurn: (workflowId, prompt) => dispatched.push({ workflowId, prompt }),
      });
      assert(!('error' in result), 'dispatch should return a result');
      if ('error' in result) return;
      assertEq(result.fired.length, 0, 'no task fired');
      assertEq(result.skipped.find((s) => s.taskId === ready.id)?.reason, 'worktree_required', 'skip reason should be worktree_required');
      assertEq(dispatched.length, 0, 'no synthetic turn should be sent');
      const state = await taskLedger.loadKernel(cwd);
      const stillReady = state.tasks.find((t) => t.id === ready.id);
      assertEq(stillReady?.status, 'ready', 'task remains ready');
      assert(!stillReady?.worktree, 'dispatcher should not create a worktree while off');
      assertEq((await listTaskWorktrees(cwd)).length, 0, 'no managed worktrees created');
    });

    await step('(b) autoWorktree provisions managed checkout before firing', async () => {
      const statusBefore = git(cwd, 'status', '--porcelain');
      await clusterStore.updateTaskDispatcherSettings(cluster.clusterId, { autoWorktree: true }, requester);
      const result = await dispatcher.dispatchOnce({
        clusterId: cluster.clusterId,
        requestedByWorkflowId: requester,
        dispatchTaskTurn: (workflowId, prompt) => dispatched.push({ workflowId, prompt }),
      });
      assert(!('error' in result), 'dispatch should return a result');
      if ('error' in result) return;
      assertEq(result.fired.length, 1, 'one task fired');
      assertEq(result.fired[0]?.taskId, ready.id, 'required task fired');
      assertEq(dispatched.length, 1, 'one synthetic turn should be sent');
      assertEq(dispatched[0]?.workflowId, worker, 'turn should go to assignee');
      assert(dispatched[0]?.prompt.includes('Task worktree:'), 'prompt includes worktree path');
      assert(dispatched[0]?.prompt.includes('Do not make task edits in the main checkout.'), 'prompt tells worker to use the worktree');

      const state = await taskLedger.loadKernel(cwd);
      const updated = state.tasks.find((t) => t.id === ready.id);
      assertEq(updated?.status, 'in_progress', 'task moved to in_progress');
      assert(updated?.worktree?.path.startsWith(worktreesRoot(cwd) + path.sep), 'worktree path should be under managed root');
      assertEq(updated?.worktree?.branch, `arco/task/${ready.id}`, 'branch should use task id');
      assertEq(updated?.worktree?.baseRef, headBefore, 'base ref should be dispatch-time HEAD');
      assert(state.runs.some((run) => run.taskId === ready.id && run.workflowId === worker && run.status === 'running'), 'run created');
      assertEq(git(cwd, 'status', '--porcelain'), statusBefore, 'main checkout status should stay unchanged');
    });

    await clusterStore.deleteCluster(cluster.clusterId).catch(() => undefined);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await fs.rm(fakeHome, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  }

  summary('task-dispatch-worktree');
}

void main();
