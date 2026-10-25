// Director/workers Stage F — one-shot task dispatcher.
//
// This is deliberately deterministic and narrow:
//   - operator-triggered only (`cluster_dispatch_once`)
//   - explicit-assignee-only routing
//   - one task per member per sweep
//   - no terminal-status mutation
//   - task/run events are persisted before any synthetic turn is started

import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import {
  isClusterMemberProvider,
  type ClusterDispatchFired,
  type ClusterDispatchSkipReason,
  type ClusterDispatchSkipped,
  type ClusterDispatcherState,
  type LedgerTask,
  type TaskRun,
} from '@arco/shared';
import * as clusterStore from './clusterStore.js';
import * as taskLedger from './project/taskLedger.js';
import { createTaskWorktree, TaskWorktreeError } from './project/taskWorktree.js';
import { workflows } from './server/state.js';
import { persistLedgerKernelMutation } from './ws/taskLedgerHandlers.js';

export interface DispatchOnceResult {
  clusterId: string;
  workflowId: string;
  requestId?: string;
  source?: 'manual' | 'daemon';
  fired: ClusterDispatchFired[];
  skipped: ClusterDispatchSkipped[];
  at: number;
}

export interface DispatchOnceOptions {
  clusterId: string;
  requestedByWorkflowId: string;
  requestId?: string;
  maxTasks?: number;
  dispatchTaskTurn: (workflowId: string, prompt: string) => void;
  source?: 'manual' | 'daemon';
  shouldContinue?: () => boolean | Promise<boolean>;
}

interface CandidateFire {
  task: LedgerTask;
  assignee: string;
  needsAutoWorktree: boolean;
}

const OPEN_RUN_STATUSES = new Set<TaskRun['status']>(['claimed', 'running']);
const DISPATCHER_DAEMON_TICK_MS = (() => {
  const raw = process.env.ARCO_TASK_DISPATCHER_TICK_MS;
  if (!raw) return 1000;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 250 ? parsed : 1000;
})();

interface DaemonClusterState {
  nextSweepAt: number;
  running: boolean;
}

interface DispatcherDaemonConfig {
  dispatchTaskTurn: (workflowId: string, prompt: string) => void;
  publishResult?: (result: DispatchOnceResult) => void | Promise<void>;
  onDispatchResult?: (result: DispatchOnceResult) => void | Promise<void>;
}

const daemonState = new Map<string, DaemonClusterState>();
let daemonConfig: DispatcherDaemonConfig | undefined;
let daemonTimer: NodeJS.Timeout | undefined;

function hasOpenRun(runs: TaskRun[], taskId: string): boolean {
  return runs.some((run) => run.taskId === taskId && !run.endedAt && OPEN_RUN_STATUSES.has(run.status));
}

function countOpenClusterRuns(runs: TaskRun[], clusterId: string): number {
  return runs.filter((run) => run.clusterId === clusterId && !run.endedAt && OPEN_RUN_STATUSES.has(run.status)).length;
}

function taskSort(a: LedgerTask, b: LedgerTask): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id.localeCompare(b.id);
}

export function buildTaskDispatchPrompt(task: LedgerTask): string {
  const lines = [
    `(task-dispatch) You have been assigned task ${task.id}: ${task.title}.`,
    '',
    'Call cluster_task_show first. Work only on this task. Use the task comment thread and refs as your source of truth — if it lists referenceDocs, read them before starting.',
    'If you need human input, call cluster_task_block. If you are still working after a meaningful interval, call cluster_task_heartbeat.',
    'If you finish, call cluster_task_complete with summary, changed files, tests run, artifacts, and follow-up tasks created. Do not mark done.',
  ];
  if (task.worktree) {
    lines.push(
      '',
      `Task worktree: ${task.worktree.path}`,
      `Task branch: ${task.worktree.branch}`,
      'Use the task worktree for file edits for this task. Do not make task edits in the main checkout.',
    );
  }
  return lines.join('\n');
}

async function recordSkip(
  cwd: string,
  boardKey: string | undefined,
  requester: string,
  clusterId: string,
  skipped: ClusterDispatchSkipped,
): Promise<void> {
  await persistLedgerKernelMutation(requester, cwd, 'dispatch_skipped', (state) => ({
    state,
    id: skipped.taskId,
    payload: {
      clusterId,
      reason: skipped.reason,
      ...(skipped.assignee ? { assignee: skipped.assignee } : {}),
      ...(skipped.detail ? { detail: skipped.detail } : {}),
    },
  }), { boardKey });
}

function skip(
  out: ClusterDispatchSkipped[],
  task: LedgerTask,
  reason: ClusterDispatchSkipReason,
  detail?: string,
): void {
  out.push({
    taskId: task.id,
    reason,
    ...(task.assignee ? { assignee: task.assignee } : {}),
    ...(detail ? { detail } : {}),
  });
}

export async function dispatchOnce(opts: DispatchOnceOptions): Promise<DispatchOnceResult | { error: string }> {
  const cluster = await clusterStore.readCluster(opts.clusterId).catch(() => null);
  if (!cluster) return { error: `Unknown cluster ${opts.clusterId.slice(0, 8)}` };
  if (!clusterStore.isTaskBoardEnabledForState(cluster)) {
    return { error: `cluster_dispatch_once rejected: board_detached` };
  }
  if (!cluster.members.includes(opts.requestedByWorkflowId)) {
    return { error: `cluster_dispatch_once rejected: ${opts.requestedByWorkflowId.slice(0, 8)} is not a cluster member` };
  }

  const boardKey = clusterStore.taskBoardKeyForState(cluster);
  const state = await taskLedger.loadKernel(cluster.cwd, boardKey);
  const byId = new Map(state.tasks.map((task) => [task.id, task]));
  const skipped: ClusterDispatchSkipped[] = [];
  const fired: ClusterDispatchFired[] = [];
  const planned: CandidateFire[] = [];
  const selectedMembers = new Set<string>();
  const maxTasks = Math.max(0, Math.floor(opts.maxTasks ?? cluster.members.length));
  const dispatcherSettings = clusterStore.normalizeTaskDispatcherSettings(cluster.dispatcher);

  for (const task of state.tasks.filter((t) => t.status === 'ready').sort(taskSort)) {
    const missingParent = task.parentIds.find((id) => !byId.has(id));
    if (missingParent) {
      skip(skipped, task, 'dependency_missing', missingParent);
      continue;
    }
    const blockedParent = task.parentIds.find((id) => byId.get(id)?.status !== 'done');
    if (blockedParent) {
      skip(skipped, task, 'dependency_blocked', blockedParent);
      continue;
    }
    if (hasOpenRun(state.runs, task.id)) {
      skip(skipped, task, 'active_run');
      continue;
    }
    if (!task.assignee) {
      skip(skipped, task, 'no_assignee');
      continue;
    }
    if (!cluster.members.includes(task.assignee)) {
      skip(skipped, task, 'assignee_not_member');
      continue;
    }
    const wf = workflows.get(task.assignee);
    if (!wf) {
      skip(skipped, task, 'member_not_hydrated');
      continue;
    }
    if (wf.busy) {
      skip(skipped, task, 'member_busy');
      continue;
    }
    if (!isClusterMemberProvider(wf.primary.provider)) {
      skip(skipped, task, 'unsupported_provider', wf.primary.provider);
      continue;
    }
    if (task.worktreeRequired === true && !task.worktree && !dispatcherSettings.autoWorktree) {
      skip(skipped, task, 'worktree_required');
      continue;
    }
    if (selectedMembers.has(task.assignee)) {
      skip(skipped, task, 'member_cap');
      continue;
    }
    if (planned.length >= maxTasks) {
      skip(skipped, task, 'cluster_cap');
      continue;
    }
    planned.push({ task, assignee: task.assignee, needsAutoWorktree: task.worktreeRequired === true && !task.worktree });
    selectedMembers.add(task.assignee);
  }

  for (const item of skipped) {
    await recordSkip(cluster.cwd, boardKey, opts.requestedByWorkflowId, opts.clusterId, item);
  }

  for (const item of planned) {
    if (opts.shouldContinue && !(await opts.shouldContinue())) break;
    const claimLock = `${hostname()}:dispatch:${randomUUID()}`;
    let run: TaskRun | null = null;
    let autoWorktree: LedgerTask['worktree'] | undefined;
    if (item.needsAutoWorktree) {
      try {
        autoWorktree = await createTaskWorktree(cluster.cwd, item.task.id);
      } catch (err) {
        const itemSkip: ClusterDispatchSkipped = {
          taskId: item.task.id,
          reason: 'worktree_failed',
          assignee: item.assignee,
          detail: err instanceof TaskWorktreeError ? err.message : (err as Error).message,
        };
        skipped.push(itemSkip);
        await recordSkip(cluster.cwd, boardKey, opts.requestedByWorkflowId, opts.clusterId, itemSkip);
        continue;
      }
    }
    const result = await persistLedgerKernelMutation(item.assignee, cluster.cwd, 'dispatch_fired', (current) => {
      const currentTask = current.tasks.find((task) => task.id === item.task.id);
      if (!currentTask || currentTask.status !== 'ready' || hasOpenRun(current.runs, item.task.id)) {
        return null;
      }
      if (currentTask.worktreeRequired === true && !currentTask.worktree && !autoWorktree) {
        return null;
      }
      const applied = taskLedger.applyUpdate(current.tasks, currentTask.id, {
        status: 'in_progress',
        assignee: item.assignee,
        ...(currentTask.worktreeRequired === true && !currentTask.worktree && autoWorktree ? { worktree: autoWorktree } : {}),
        updatedBy: opts.requestedByWorkflowId,
      });
      if (!applied) return null;
      run = taskLedger.newTaskRun({
        taskId: currentTask.id,
        workflowId: item.assignee,
        clusterId: opts.clusterId,
        claimLock,
        workerId: clusterStore.displayNameFor(item.assignee),
        metadata: {
          dispatchedBy: opts.requestedByWorkflowId,
          requestId: opts.requestId ?? '',
        },
      });
      return {
        state: {
          tasks: applied.tasks,
          comments: current.comments,
          runs: [...current.runs, run],
        },
        id: currentTask.id,
        task: applied.updated,
        payload: {
          clusterId: opts.clusterId,
          run,
          claimLock,
          promptPreview: buildTaskDispatchPrompt(applied.updated).slice(0, 500),
        },
      };
    }, { boardKey });
    const createdRun = run as TaskRun | null;
    if (!result || !createdRun || result.task?.status !== 'in_progress') {
      const itemSkip: ClusterDispatchSkipped = {
        taskId: item.task.id,
        reason: 'race_lost',
        assignee: item.assignee,
      };
      skipped.push(itemSkip);
      await recordSkip(cluster.cwd, boardKey, opts.requestedByWorkflowId, opts.clusterId, itemSkip);
      continue;
    }
    fired.push({ taskId: item.task.id, workflowId: item.assignee, runId: createdRun.id });
    opts.dispatchTaskTurn(item.assignee, buildTaskDispatchPrompt(result.task));
  }

  return {
    clusterId: opts.clusterId,
    workflowId: opts.requestedByWorkflowId,
    ...(opts.requestId ? { requestId: opts.requestId } : {}),
    ...(opts.source ? { source: opts.source } : {}),
    fired,
    skipped,
    at: Date.now(),
  };
}

export function configureDispatcherDaemon(config: DispatcherDaemonConfig): void {
  daemonConfig = config;
}

export function configureDaemon(config: DispatcherDaemonConfig): void {
  configureDispatcherDaemon(config);
}

export function startDispatcherDaemon(): void {
  if (daemonTimer) return;
  daemonTimer = setInterval(() => {
    void sweepDispatcherDaemon();
  }, DISPATCHER_DAEMON_TICK_MS);
  if (typeof daemonTimer.unref === 'function') daemonTimer.unref();
}

export function startDaemon(): void {
  startDispatcherDaemon();
}

export function stopDispatcherDaemon(): void {
  if (!daemonTimer) return;
  clearInterval(daemonTimer);
  daemonTimer = undefined;
}

export function stopDaemon(): void {
  stopDispatcherDaemon();
}

export function notifyDispatcherSettingsChanged(clusterId: string): void {
  const settings = clusterStore.taskDispatcherSettingsFor(clusterId);
  if (!settings.enabled) {
    daemonState.delete(clusterId);
    return;
  }
  daemonState.set(clusterId, { nextSweepAt: Date.now(), running: false });
}

export function dropCluster(clusterId: string): void {
  daemonState.delete(clusterId);
}

export function dropClusterDaemonState(clusterId: string): void {
  dropCluster(clusterId);
}

export async function sweepDispatcherDaemon(): Promise<void> {
  await sweepDaemon(Date.now());
}

export async function sweepDaemon(now: number = Date.now()): Promise<void> {
  if (!daemonConfig) return;
  for (const clusterId of clusterStore.listKnownClusterIds()) {
    await sweepDispatcherCluster(clusterId, now).catch((err) => {
      console.error(`[arco] task-dispatcher sweep failed for ${clusterId.slice(0, 8)}:`, err);
    });
  }
}

async function sweepDispatcherCluster(clusterId: string, now: number): Promise<void> {
  if (!daemonConfig) return;
  const cluster = await clusterStore.readCluster(clusterId).catch(() => null);
  if (!cluster) {
    daemonState.delete(clusterId);
    return;
  }
  if (!clusterStore.isTaskBoardEnabledForState(cluster)) {
    daemonState.delete(clusterId);
    return;
  }
  const settings = clusterStore.normalizeTaskDispatcherSettings(cluster.dispatcher);
  if (!settings.enabled) {
    daemonState.delete(clusterId);
    return;
  }
  const state = daemonState.get(clusterId) ?? { nextSweepAt: now, running: false };
  daemonState.set(clusterId, state);
  if (state.running || now < state.nextSweepAt) return;
  state.running = true;
  try {
    const requester = dispatcherRequester(cluster.members, settings);
    if (!requester) return;
    const boardKey = clusterStore.taskBoardKeyForState(cluster);
    const ledger = await taskLedger.loadKernel(cluster.cwd, boardKey);
    const openRuns = countOpenClusterRuns(ledger.runs, clusterId);
    const remainingRunSlots = Math.max(0, settings.maxConcurrentRuns - openRuns);
    const maxTasks = Math.min(settings.maxTasksPerSweep, remainingRunSlots);
    if (maxTasks <= 0) return;
    const requestId = `daemon:${clusterId.slice(0, 8)}:${now}`;
    const result = await dispatchOnce({
      clusterId,
      requestedByWorkflowId: requester,
      requestId,
      maxTasks,
      source: 'daemon',
      dispatchTaskTurn: daemonConfig.dispatchTaskTurn,
      shouldContinue: () => clusterStore.isTaskDispatcherEnabled(clusterId),
    });
    if ('error' in result) {
      console.warn(`[arco] task-dispatcher sweep rejected for ${clusterId.slice(0, 8)}: ${result.error}`);
      return;
    }
    if (result.fired.length > 0 || result.skipped.length > 0) {
      await (daemonConfig.publishResult ?? daemonConfig.onDispatchResult)?.(result);
    }
  } finally {
    const latest = clusterStore.taskDispatcherSettingsFor(clusterId);
    state.running = false;
    state.nextSweepAt = Date.now() + latest.intervalMs;
    if (!latest.enabled) daemonState.delete(clusterId);
  }
}

function dispatcherRequester(members: string[], settings: ClusterDispatcherState): string | undefined {
  if (settings.armedByWorkflowId && members.includes(settings.armedByWorkflowId)) {
    return settings.armedByWorkflowId;
  }
  return members[0];
}
