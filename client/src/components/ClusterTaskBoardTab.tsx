// docs/ARCHITECTURE.md - cluster task board.
//
// A kanban VIEW over the cluster cwd's project task ledger (the same
// cwd-scoped store the per-workflow LEDGER tab reads from, keyed by cwd in
// `appStore.taskLedger`).
//
// This is primarily a VIEW: mutations come from worker peer-tools
// (cluster_task_claim / cluster_task_update) which broadcast a fresh
// task_ledger_snapshot cluster-wide, and from the operator's LEDGER tab.
// `done` / `archived` are operator-only at every layer — this board exposes
// them only through explicit operator controls in the detail drawer. Cards
// surface the title, the claimant (8-char prefix), and a link count chip.

import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { DndContext, PointerSensor, TouchSensor, useSensor, useSensors, useDraggable, useDroppable } from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import type { ClusterDispatcherState, ClusterStatePayload, LedgerTask, LedgerTaskStatus, OrchestrationProposal, OrchestrationProposalItem, TaskComment, TaskDetails, TaskLink, TaskRun } from '@arco/shared';
import { useAppStore } from '../stores/appStore';
import { useOrchestrationAssistStore } from '../stores/orchestrationAssistStore';
import { PlanRefViewer } from './plans/PlanRefsSection';
import type { ClusterDispatcherSettingsPatch, ClusterSwarmCreateRequest } from './ClusterRightPanel/types';
// Pure grouping helper lives in a React-free module so the headless smoke can
// import it without the client store. Re-exported here for convenience.
import { BOARD_COLUMNS, groupByStatus, taskGraphSummary, taskShowWorkflowId } from './clusterTaskBoard.helpers';

export { BOARD_COLUMNS, groupByStatus, taskGraphSummary, taskShowWorkflowId };

const COLUMN_LABEL: Record<LedgerTaskStatus, string> = {
  triage: 'TRIAGE',
  todo: 'TODO',
  ready: 'READY',
  in_progress: 'IN PROGRESS',
  blocked: 'BLOCKED',
  review: 'REVIEW',
  done: 'DONE',
  archived: 'ARCHIVED',
};

const DEFAULT_DISPATCHER_INTERVAL_MS = 10_000;
const DEFAULT_DISPATCHER_MAX_TASKS = 4;
const RUN_STALE_AFTER_MS = 5 * 60 * 1000;
const OPEN_RUN_STATUSES = new Set<TaskRun['status']>(['claimed', 'running']);

// Stable empty fallback for the proposals selector. Returning `?? []` INSIDE a
// zustand selector hands useSyncExternalStore a fresh array reference on every
// render → it sees the snapshot "change" each time → infinite re-render → React
// #185. The fallback must be a module-level constant applied OUTSIDE the
// selector so the snapshot stays referentially stable when a cluster has no
// proposals (the common case). See docs/GOTCHAS.md.
const EMPTY_PROPOSALS: OrchestrationProposal[] = [];

type WorktreeAwareDispatcherState = ClusterDispatcherState & { autoWorktree?: boolean };
type WorktreeAwareLedgerTask = LedgerTask & { worktreeRequired?: boolean };

function dispatcherDefaults(memberCount: number): WorktreeAwareDispatcherState {
  return {
    enabled: false,
    intervalMs: DEFAULT_DISPATCHER_INTERVAL_MS,
    maxTasksPerSweep: DEFAULT_DISPATCHER_MAX_TASKS,
    maxConcurrentRuns: Math.max(8, memberCount),
    autoWorktree: false,
  };
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function statusColor(status: LedgerTaskStatus): string {
  switch (status) {
    case 'in_progress': return 'var(--color-accent-primary)';
    case 'done':        return 'var(--color-accent-secondary)';
    case 'ready':       return '#58a66c';
    case 'review':      return '#8a7cf0';
    case 'blocked':     return '#e0a030';
    case 'archived':    return '#777';
    default:            return 'var(--color-fg-muted)';
  }
}

function formatTime(ms?: number): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString();
}

function shortId(id?: string): string {
  return id ? id.slice(0, 8) : '—';
}

function taskTerminal(task: LedgerTask): boolean {
  return task.status === 'done' || task.status === 'archived';
}

function runOpen(run: TaskRun): boolean {
  return !run.endedAt && OPEN_RUN_STATUSES.has(run.status);
}

function runHeartbeatAt(run: TaskRun): number {
  return run.lastHeartbeatAt ?? run.startedAt;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function DispatcherNumberInput({
  label,
  suffix,
  value,
  disabled,
  min,
  max,
  onChange,
  onCommit,
  title,
}: {
  label: string;
  suffix?: string;
  value: string;
  disabled: boolean;
  min: number;
  max: number;
  onChange: (value: string) => void;
  onCommit: (value: string) => void;
  title: string;
}) {
  return (
    <label
      className="display-font"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        color: disabled ? 'var(--color-fg-muted)' : 'var(--color-fg)',
        fontSize: '9px',
        letterSpacing: '0.7px',
      }}
      title={title}
    >
      <span>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onBlur={(e) => onCommit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
        style={{
          width: '54px',
          background: disabled ? 'transparent' : 'var(--color-bg-inset)',
          color: disabled ? 'var(--color-fg-muted)' : 'var(--color-fg)',
          border: '1px solid var(--color-border-hairline)',
          padding: '2px 4px',
          fontSize: '10px',
        }}
      />
      {suffix && <span>{suffix}</span>}
    </label>
  );
}

export function ClusterTaskBoardTab({
  cluster,
  onDispatchOnce,
  onToggleDispatcher,
  onUpdateDispatcherSettings,
  onUpdateTaskStatus,
  onReassignTask,
  onReclaimRun,
  onTerminateRun,
  onCreateSwarm,
}: {
  cluster: ClusterStatePayload;
  onDispatchOnce?: (clusterId: string, workflowId: string, maxTasks?: number) => void;
  onToggleDispatcher?: (clusterId: string, workflowId: string, enabled: boolean) => void;
  onUpdateDispatcherSettings?: (
    clusterId: string,
    workflowId: string,
    settings: ClusterDispatcherSettingsPatch,
  ) => void;
  onUpdateTaskStatus?: (workflowId: string, taskId: string, status: LedgerTaskStatus, boardKey?: string) => void;
  onReassignTask?: (workflowId: string, taskId: string, assigneeWorkflowId: string | null, boardKey?: string) => void;
  onReclaimRun?: (clusterId: string, workflowId: string, taskId: string, runId: string, boardKey?: string) => void;
  onTerminateRun?: (clusterId: string, workflowId: string, taskId: string, runId: string, boardKey?: string) => void;
  onCreateSwarm?: (clusterId: string, workflowId: string, request: ClusterSwarmCreateRequest) => void;
}) {
  const cwd = cluster.cwd;
  const ledgerKey = cwd && cluster.taskBoardKey ? `${cwd}::${cluster.taskBoardKey}` : cwd;
  const tasks = (useAppStore((s) => (ledgerKey ? s.taskLedger[ledgerKey] : undefined)) ?? []) as WorktreeAwareLedgerTask[];
  const grouped = groupByStatus(tasks);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [details, setDetails] = useState<TaskDetails | null>(null);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const taskShowReader = taskShowWorkflowId(cluster.members);
  const dispatcher: WorktreeAwareDispatcherState = {
    ...dispatcherDefaults(cluster.members.length),
    ...((cluster.dispatcher ?? {}) as WorktreeAwareDispatcherState),
  };
  const [intervalDraft, setIntervalDraft] = useState(String(Math.round(dispatcher.intervalMs / 1000)));
  const [sweepCapDraft, setSweepCapDraft] = useState(String(dispatcher.maxTasksPerSweep));
  const [runCapDraft, setRunCapDraft] = useState(String(dispatcher.maxConcurrentRuns));
  const [swarmOpen, setSwarmOpen] = useState(false);
  const [assistOpen, setAssistOpen] = useState(false);
  // §10.7 P12.6 — the automation controls (dispatch / swarm / assist /
  // dispatcher) are collapsed behind a disclosure by default so the board reads
  // as "groom tasks," not "run a swarm." The operator opens it when ready to
  // automate; the count + toggle stay visible.
  const [automationOpen, setAutomationOpen] = useState(false);
  const [assistMode, setAssistMode] = useState<'task_graph' | 'assignments' | 'recovery' | 'synthesis' | 'swarm'>('task_graph');
  const [assistSourceWorkflowId, setAssistSourceWorkflowId] = useState(cluster.members[0]?.workflowId ?? '');
  const [assistPrompt, setAssistPrompt] = useState('');
  const proposals = useOrchestrationAssistStore((s) => s.byCluster[cluster.clusterId]) ?? EMPTY_PROPOSALS;
  const selectedProposalId = useOrchestrationAssistStore((s) => s.selectedProposalId[cluster.clusterId] ?? null);
  const dispatchAssist = useOrchestrationAssistStore((s) => s.dispatch);
  const selectProposal = useOrchestrationAssistStore((s) => s.selectProposal);
  const rejectLocalProposal = useOrchestrationAssistStore((s) => s.markRejected);
  const acceptLocalProposal = useOrchestrationAssistStore((s) => s.markApplied);
  const wsSendRaw = useAppStore((s) => s.wsSendRaw);
  const jobs = useAppStore((s) => s.jobs);
  const selectedTask = selectedTaskId
    ? (details?.task.id === selectedTaskId ? details.task : tasks.find((t) => t.id === selectedTaskId) ?? null)
    : null;
  const graph = useMemo(() => taskGraphSummary(details), [details]);
  const dispatcherControlReady = Boolean(taskShowReader && onToggleDispatcher && onUpdateDispatcherSettings);
  const activeProposal = selectedProposalId
    ? proposals.find((p) => p.id === selectedProposalId) ?? null
    : null;
  const proposedCount = proposals.filter((p) => p.status === 'proposed' || p.status === 'partially_accepted').length;

  useEffect(() => {
    setIntervalDraft(String(Math.round(dispatcher.intervalMs / 1000)));
    setSweepCapDraft(String(dispatcher.maxTasksPerSweep));
    setRunCapDraft(String(dispatcher.maxConcurrentRuns));
  }, [dispatcher.intervalMs, dispatcher.maxConcurrentRuns, dispatcher.maxTasksPerSweep]);

  useEffect(() => {
    if (!cluster.members.some((m) => m.workflowId === assistSourceWorkflowId)) {
      setAssistSourceWorkflowId(cluster.members[0]?.workflowId ?? '');
    }
  }, [assistSourceWorkflowId, cluster.members]);

  // Map a claimant workflowId → its operator-set display name (falls back to
  // the 8-char prefix the server uses everywhere else).
  const nameFor = (wfid: string): string => {
    const m = cluster.members.find((x) => x.workflowId === wfid);
    return (m?.displayName || wfid.slice(0, 8));
  };

  // §10.7 P12.2 — create a task directly on the board. Reuses the operator
  // task_ledger_create path (same one the per-workflow LEDGER tab uses); the
  // server stamps id/timestamps and lands the task as `todo`. New tasks are
  // always `todo` (the operator-confirmed-done invariant), so a single board
  // composer — not a per-column one, which would mislead since every column's
  // input would still produce a todo card — is the honest surface.
  const canCreateTask = Boolean(taskShowReader && wsSendRaw);
  const createTask = () => {
    const title = newTaskTitle.trim();
    if (!title || !taskShowReader || !wsSendRaw) return;
    wsSendRaw({
      type: 'task_ledger_create',
      workflowId: taskShowReader,
      ...(cluster.taskBoardKey ? { boardKey: cluster.taskBoardKey } : {}),
      title,
    });
    setNewTaskTitle('');
  };

  // §10.7 P12.3 — operator card editing. Folds the LEDGER tab's edit/delete
  // affordances into the board drawer (the plan's "fold into the drawer" option
  // rather than a duplicate LEDGER sub-tab). Both reuse the operator
  // task_ledger_update / task_ledger_delete paths; `done`/`archived` stay routed
  // through the dedicated status controls, never these field edits.
  const editTask = (
    taskId: string,
    patch: { title?: string; notes?: string; priority?: number; parentIds?: string[] },
  ) => {
    if (!taskShowReader || !wsSendRaw) return;
    wsSendRaw({
      type: 'task_ledger_update',
      workflowId: taskShowReader,
      ...(cluster.taskBoardKey ? { boardKey: cluster.taskBoardKey } : {}),
      id: taskId,
      ...patch,
    });
  };
  const deleteTask = (taskId: string) => {
    if (!taskShowReader || !wsSendRaw) return;
    wsSendRaw({
      type: 'task_ledger_delete',
      workflowId: taskShowReader,
      ...(cluster.taskBoardKey ? { boardKey: cluster.taskBoardKey } : {}),
      id: taskId,
    });
  };

  // §10.7 P12.4 — drag a card onto a column to change its status through the
  // operator path (task_ledger_update), so status changes are direct instead of
  // drawer-deep. done/archived confirm first (operator acceptance). dnd-kit with
  // a 4px activation distance so a plain click still opens the drawer.
  // TouchSensor mirrors PointerSensor so the board is draggable on touch
  // devices; a short press-delay distinguishes a drag from a tap that opens the
  // drawer (touch has no hover, so distance-only is unreliable there).
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
  );
  const moveTask = (taskId: string, toStatus: LedgerTaskStatus) => {
    if (!taskShowReader || !onUpdateTaskStatus) return;
    const t = tasks.find((x) => x.id === taskId);
    if (!t || t.status === toStatus) return;
    if (toStatus === 'done' || toStatus === 'archived') {
      const extra = toStatus === 'done' ? ' This marks it accepted.' : '';
      if (!window.confirm(`Move "${t.title}" to ${COLUMN_LABEL[toStatus]}?${extra}`)) return;
    }
    onUpdateTaskStatus(taskShowReader, t.id, toStatus, cluster.taskBoardKey);
  };
  const handleDragEnd = (e: DragEndEvent) => {
    const over = e.over?.id;
    if (over === undefined || over === null) return;
    moveTask(String(e.active.id), String(over) as LedgerTaskStatus);
  };

  // §D3 — quick per-card operator-accept from the REVIEW column, so marking a
  // signed-off task done doesn't require opening the drawer. Same operator path
  // as MARK ALL DONE (onUpdateTaskStatus → task_ledger_update); no confirm
  // because the labelled DONE click is itself the deliberate acceptance.
  const quickDone = (taskId: string) => {
    if (!taskShowReader || !onUpdateTaskStatus) return;
    onUpdateTaskStatus(taskShowReader, taskId, 'done', cluster.taskBoardKey);
  };

  // §D3 — pick a member to send the recheck FROM. operator_peer_send rejects a
  // self-send, so it must differ from the sign-off author (the director). Prefer
  // the worker who did the task; else any other member.
  const recheckSenderFor = (task: WorktreeAwareLedgerTask): string | null => {
    const to = task.signoff?.byWorkflowId;
    if (!to || !cluster.members.some((m) => m.workflowId === to)) return null;
    if (task.assignee && task.assignee !== to && cluster.members.some((m) => m.workflowId === task.assignee)) {
      return task.assignee;
    }
    return cluster.members.find((m) => m.workflowId !== to)?.workflowId ?? null;
  };

  // §D3 — "send back to the director": drop a recheck request into the sign-off
  // author's mailbox via the existing operator_peer_send rail. Leaves the task in
  // REVIEW with its current verdict so it stays visible until the director
  // re-signs-off; the operator can still drag it elsewhere.
  const recheckTask = (task: WorktreeAwareLedgerTask) => {
    if (!wsSendRaw) return;
    const to = task.signoff?.byWorkflowId;
    const from = recheckSenderFor(task);
    if (!to || !from) return;
    const so = task.signoff;
    const verdict = so ? `${so.state}${so.summary ? ` ("${so.summary}")` : ''}` : 'reviewed';
    const content =
      `Operator recheck request for task "${task.title}" (${shortId(task.id)}).\n\n` +
      `You signed this off as ${verdict}. The operator is asking you to re-verify it actually met its target before they accept it. ` +
      `Re-review the work and update the task with cluster_task_update — set signoff.state to met / not_met / partial and a fresh one-line summary.`;
    wsSendRaw({ type: 'operator_peer_send', clusterId: cluster.clusterId, from, to, content });
  };

  const commitDispatcherSetting = (field: 'intervalMs' | 'maxTasksPerSweep' | 'maxConcurrentRuns', raw: string) => {
    if (!taskShowReader || !onUpdateDispatcherSettings) return;
    if (field === 'intervalMs') {
      const seconds = clampInt(Number(raw), 5, 3600);
      setIntervalDraft(String(seconds));
      onUpdateDispatcherSettings(cluster.clusterId, taskShowReader, { intervalMs: seconds * 1000 });
      return;
    }
    const cap = clampInt(Number(raw), 1, 64);
    if (field === 'maxTasksPerSweep') setSweepCapDraft(String(cap));
    if (field === 'maxConcurrentRuns') setRunCapDraft(String(cap));
    onUpdateDispatcherSettings(cluster.clusterId, taskShowReader, { [field]: cap });
  };

  const requestAssist = () => {
    if (!taskShowReader || !wsSendRaw) return;
    const sourceWorkflowId = assistSourceWorkflowId || taskShowReader;
    const sourceJob = jobs[sourceWorkflowId] ?? jobs[taskShowReader];
    const provider = sourceJob?.config.primaryProvider;
    if (!provider) return;
    dispatchAssist({
      clusterId: cluster.clusterId,
      workflowId: taskShowReader,
      kind: assistMode,
      prompt: assistPrompt.trim() || 'Draft an operator-reviewable orchestration proposal for the current cluster board.',
      model: {
        provider,
        model: sourceJob?.config.primaryModel,
        effort: sourceJob?.config.primaryEffort,
        providerAccountRef: sourceJob?.config.providerAccountRef,
        memberWorkflowId: sourceWorkflowId,
      },
    });
    setSelectedTaskId(null);
    setAssistOpen(true);
  };

  const rejectProposal = (proposalId: string) => {
    wsSendRaw?.({
      type: 'cluster_orchestration_proposal_reject',
      clusterId: cluster.clusterId,
      workflowId: taskShowReader,
      proposalId,
    });
    rejectLocalProposal(cluster.clusterId, proposalId);
  };

  const acceptProposal = (
    proposalId: string,
    itemIds: string[],
    itemEdits?: Record<string, { title?: string; body?: string }>,
    applyMode?: 'task_kernel' | 'comment',
  ) => {
    if (itemIds.length === 0) return;
    wsSendRaw?.({
      type: 'cluster_orchestration_proposal_apply',
      clusterId: cluster.clusterId,
      workflowId: taskShowReader,
      proposalId,
      itemIds,
      ...(itemEdits && Object.keys(itemEdits).length > 0 ? { itemEdits } : {}),
      ...(applyMode ? { applyMode } : {}),
    });
    acceptLocalProposal(cluster.clusterId, proposalId, itemIds);
  };

  useEffect(() => {
    if (!selectedTaskId) {
      setDetails(null);
      setDetailsError(null);
      setLoadingDetails(false);
      return;
    }
    if (!taskShowReader) {
      setDetails(null);
      setDetailsError('No cluster member is available to read task details.');
      setLoadingDetails(false);
      return;
    }

    const ac = new AbortController();
    setLoadingDetails(true);
    setDetailsError(null);
    const q = new URLSearchParams({ workflowId: taskShowReader, id: selectedTaskId });
    fetch(`/api/clusters/${encodeURIComponent(cluster.clusterId)}/peer/task-show?${q.toString()}`, { signal: ac.signal })
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({})) as { error?: string; message?: string };
          throw new Error(body.message ?? body.error ?? `task-show failed (${r.status})`);
        }
        return (await r.json()) as TaskDetails;
      })
      .then((d) => setDetails(d))
      .catch((err) => {
        if (ac.signal.aborted) return;
        setDetails(null);
        setDetailsError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoadingDetails(false);
      });
    return () => ac.abort();
  }, [cluster.clusterId, taskShowReader, selectedTaskId]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div
        style={{
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
          padding: '2px 2px 8px',
          borderBottom: '1px solid var(--color-border-hairline)',
          marginBottom: '8px',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '8px',
            flexWrap: 'wrap',
          }}
        >
          <div className="display-font" style={{ fontSize: '10px', letterSpacing: '1px', color: 'var(--color-fg-muted)' }}>
            {tasks.length} TASK{tasks.length === 1 ? '' : 'S'}
          </div>
          <button
            type="button"
            data-help="cluster.board-automation-toggle"
            onClick={() => setAutomationOpen((v) => !v)}
            className="display-font"
            style={{
              border: '1px solid var(--color-border-hairline)',
              background: automationOpen ? 'var(--color-accent-primary-a06)' : 'transparent',
              color: 'var(--color-fg-muted)',
              cursor: 'pointer',
              fontSize: '9px',
              letterSpacing: '0.8px',
              padding: '3px 8px',
              whiteSpace: 'nowrap',
            }}
            title="Show / hide dispatcher, swarm, and assist automation controls."
          >
            {automationOpen ? '▾ AUTOMATION' : '▸ AUTOMATION'}{proposedCount > 0 ? ` · ${proposedCount}` : ''}
          </button>
          {automationOpen && (<>
          <button
            type="button"
            data-help="cluster.board-dispatch-once"
            disabled={!onDispatchOnce || !taskShowReader}
            onClick={() => {
              if (taskShowReader) onDispatchOnce?.(cluster.clusterId, taskShowReader);
            }}
            className="display-font"
            style={{
              border: '1px solid var(--color-border-hairline)',
              background: 'transparent',
              color: onDispatchOnce && taskShowReader ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
              cursor: onDispatchOnce && taskShowReader ? 'pointer' : 'not-allowed',
              fontSize: '10px',
              letterSpacing: '0.8px',
              padding: '4px 8px',
              whiteSpace: 'nowrap',
            }}
            title="Run one deterministic dispatch sweep for ready tasks with explicit idle assignees."
          >
            DISPATCH ONCE
          </button>
          <button
            type="button"
            data-help="cluster.swarm-create"
            disabled={!onCreateSwarm || !taskShowReader || cluster.members.length === 0}
            onClick={() => setSwarmOpen(true)}
            className="display-font"
            style={{
              border: '1px solid var(--color-border-hairline)',
              background: 'transparent',
              color: onCreateSwarm && taskShowReader && cluster.members.length > 0 ? 'var(--color-accent-secondary)' : 'var(--color-fg-muted)',
              cursor: onCreateSwarm && taskShowReader && cluster.members.length > 0 ? 'pointer' : 'not-allowed',
              fontSize: '10px',
              letterSpacing: '0.8px',
              padding: '4px 8px',
              whiteSpace: 'nowrap',
            }}
            title="Create a root, parallel worker tasks, verifier task, and synthesizer task from an operator brief."
          >
            CREATE SWARM
          </button>
          <button
            type="button"
            data-help="cluster.orchestration-assist"
            disabled={!taskShowReader || !wsSendRaw}
            onClick={() => setAssistOpen((v) => !v)}
            className="display-font"
            style={{
              border: '1px solid var(--color-border-hairline)',
              background: proposedCount > 0 ? 'var(--color-accent-primary-a06)' : 'transparent',
              color: taskShowReader && wsSendRaw ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
              cursor: taskShowReader && wsSendRaw ? 'pointer' : 'not-allowed',
              fontSize: '10px',
              letterSpacing: '0.8px',
              padding: '4px 8px',
              whiteSpace: 'nowrap',
            }}
            title="Ask a selected model/member to draft visible orchestration proposals. Nothing applies until selected items are accepted."
          >
            {proposedCount > 0 ? `PROPOSALS ${proposedCount}` : 'DRAFT ASSIST'}
          </button>
          </>)}
        </div>
        {automationOpen && assistOpen && (
          <div
            data-help="cluster.orchestration-proposals"
            style={{
              border: '1px solid var(--color-border-hairline)',
              background: 'var(--color-bg-inset)',
              padding: '8px',
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
            }}
          >
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: '8px' }}>
              <label className="display-font" style={assistLabelStyle}>
                MODE
                <select
                  value={assistMode}
                  onChange={(event) => setAssistMode(event.target.value as typeof assistMode)}
                  style={assistSelectStyle}
                >
                  <option value="task_graph">TASK GRAPH</option>
                  <option value="assignments">ASSIGNMENTS</option>
                  <option value="recovery">RECOVERY</option>
                  <option value="synthesis">SYNTHESIS</option>
                  <option value="swarm">SWARM</option>
                </select>
              </label>
              <label className="display-font" style={assistLabelStyle}>
                SOURCE
                <select
                  value={assistSourceWorkflowId}
                  onChange={(event) => setAssistSourceWorkflowId(event.target.value)}
                  style={assistSelectStyle}
                >
                  {cluster.members.map((member) => (
                    <option key={member.workflowId} value={member.workflowId}>
                      {member.displayName || shortId(member.workflowId)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <textarea
              value={assistPrompt}
              onChange={(event) => setAssistPrompt(event.target.value)}
              placeholder="Optional operator instruction for the draft."
              rows={2}
              maxLength={4000}
              style={{
                resize: 'vertical',
                minHeight: '52px',
                background: 'var(--color-bg-panel)',
                color: 'var(--color-fg)',
                border: '1px solid var(--color-border-hairline)',
                padding: '7px',
                fontFamily: 'var(--font-code)',
                fontSize: '11px',
                lineHeight: 1.4,
              }}
            />
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
              <button
                type="button"
                disabled={!taskShowReader || !wsSendRaw}
                onClick={requestAssist}
                className="display-font"
                style={smallButtonStyle(Boolean(taskShowReader && wsSendRaw))}
              >
                REQUEST DRAFT
              </button>
              <span style={{ fontSize: '10px', color: 'var(--color-fg-muted)' }}>
                Proposals are previews only. Reject is inert; accept sends selected item ids.
              </span>
            </div>
            {proposals.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {proposals.slice(0, 4).map((proposal) => (
                  <ProposalSummaryCard
                    key={proposal.id}
                    proposal={proposal}
                    selected={proposal.id === selectedProposalId}
                    nameFor={nameFor}
                    onSelect={() => {
                      setSelectedTaskId(null);
                      selectProposal(cluster.clusterId, proposal.id);
                    }}
                  />
                ))}
              </div>
            )}
            {proposals.length === 0 && (
              <div style={{ fontSize: '11px', color: 'var(--color-fg-muted)' }}>
                No proposals yet.
              </div>
            )}
          </div>
        )}
        {automationOpen && (
        <div
          data-help="cluster.board-arm-dispatcher"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            flexWrap: 'wrap',
            fontSize: '10px',
          }}
        >
          <span className="display-font" style={{ color: 'var(--color-fg-muted)', letterSpacing: '1px' }}>
            DISPATCHER
          </span>
          <button
            type="button"
            disabled={!taskShowReader || !onToggleDispatcher}
            onClick={() => {
              if (taskShowReader) onToggleDispatcher?.(cluster.clusterId, taskShowReader, !dispatcher.enabled);
            }}
            className="display-font"
            style={{
              padding: '3px 8px',
              background: dispatcher.enabled ? 'var(--color-accent-primary-a06)' : 'transparent',
              border: '1px solid ' + (dispatcher.enabled ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'),
              color: dispatcher.enabled ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
              cursor: taskShowReader && onToggleDispatcher ? 'pointer' : 'not-allowed',
              fontSize: '9px',
              letterSpacing: 0,
            }}
            title={dispatcher.enabled
              ? 'Armed — the server periodically runs deterministic ready-task dispatch sweeps.'
              : 'Off — no daemon sweeps run. Click to arm the task dispatcher.'}
          >
            {dispatcher.enabled ? 'ARMED' : 'OFF'}
          </button>
          <DispatcherNumberInput
            label="EVERY"
            suffix="S"
            value={intervalDraft}
            disabled={!dispatcherControlReady}
            min={5}
            max={3600}
            onChange={setIntervalDraft}
            onCommit={(value) => commitDispatcherSetting('intervalMs', value)}
            title="Seconds between armed dispatcher sweeps."
          />
          <DispatcherNumberInput
            label="SWEEP"
            value={sweepCapDraft}
            disabled={!dispatcherControlReady}
            min={1}
            max={64}
            onChange={setSweepCapDraft}
            onCommit={(value) => commitDispatcherSetting('maxTasksPerSweep', value)}
            title="Maximum tasks the daemon may fire per sweep."
          />
          <DispatcherNumberInput
            label="RUNS"
            value={runCapDraft}
            disabled={!dispatcherControlReady}
            min={1}
            max={64}
            onChange={setRunCapDraft}
            onCommit={(value) => commitDispatcherSetting('maxConcurrentRuns', value)}
            title="Maximum open task runs cluster-wide."
          />
          <button
            type="button"
            data-help="cluster.board-auto-worktree"
            disabled={!dispatcherControlReady}
            onClick={() => {
              if (!taskShowReader || !onUpdateDispatcherSettings) return;
              onUpdateDispatcherSettings(cluster.clusterId, taskShowReader, { autoWorktree: !dispatcher.autoWorktree });
            }}
            className="display-font"
            style={{
              padding: '3px 8px',
              background: dispatcher.autoWorktree ? 'var(--color-accent-secondary-a06)' : 'transparent',
              border: '1px solid ' + (dispatcher.autoWorktree ? 'var(--color-accent-secondary)' : 'var(--color-border-hairline)'),
              color: dispatcher.autoWorktree ? 'var(--color-accent-secondary)' : 'var(--color-fg-muted)',
              cursor: dispatcherControlReady ? 'pointer' : 'not-allowed',
              fontSize: '9px',
              letterSpacing: '1px',
              whiteSpace: 'nowrap',
            }}
            title={dispatcher.autoWorktree
              ? 'Auto worktree is on: dispatched tasks marked worktree-required will get an isolated checkout before their run.'
              : 'Off: dispatcher will not create task worktrees automatically.'}
          >
            AUTO WORKTREE {dispatcher.autoWorktree ? 'ON' : 'OFF'}
          </button>
        </div>
        )}
      </div>
      {swarmOpen && taskShowReader && (
        <SwarmCreateModal
          cluster={cluster}
          requesterWorkflowId={taskShowReader}
          onClose={() => setSwarmOpen(false)}
          onCreate={(request) => {
            onCreateSwarm?.(cluster.clusterId, taskShowReader, request);
            setSwarmOpen(false);
          }}
        />
      )}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
          padding: '2px',
        }}
      >
        {/* §10.7 P12.2 — create-on-board composer. Authors a `todo` task in the
            cluster board without leaving the board view. */}
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }} data-help="cluster.board-add-task">
          <input
            type="text"
            value={newTaskTitle}
            onChange={(e) => setNewTaskTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); createTask(); } }}
            placeholder={canCreateTask ? 'Add a task…' : 'Board not ready'}
            disabled={!canCreateTask}
            style={{
              flex: 1,
              fontSize: '12px',
              fontFamily: 'var(--font-body)',
              padding: '6px 8px',
              background: 'var(--color-bg-inset)',
              border: '1px solid var(--color-border-hairline)',
              borderRadius: '3px',
              color: 'var(--color-fg)',
              outline: 'none',
            }}
          />
          <button
            type="button"
            className="display-font"
            onClick={createTask}
            disabled={!canCreateTask || !newTaskTitle.trim()}
            title="Add a todo task to this board"
            style={{
              fontSize: '10px',
              letterSpacing: '1px',
              padding: '6px 12px',
              background: 'transparent',
              border: '1px solid var(--color-accent-primary)',
              color: canCreateTask && newTaskTitle.trim() ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
              borderRadius: '3px',
              cursor: canCreateTask && newTaskTitle.trim() ? 'pointer' : 'not-allowed',
            }}
          >
            ADD
          </button>
        </div>
        {/* §10.7 P12.4 — vertically-stacked kanban sections; drag a card onto a
            section to change its status. dnd-kit matches the TabBar drag pattern.
            Stacked (not side-by-side) so each status uses the full panel width and
            the board scrolls down the tab's vertical space instead of clipping
            columns off the right edge of the 1/3 panel. */}
        <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
          <div
            data-help="cluster.board-columns"
            style={{
              flex: 1,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
              overflowX: 'hidden',
              overflowY: 'auto',
              paddingBottom: '4px',
            }}
          >
            {BOARD_COLUMNS.map((col) => (
              <BoardColumn
                key={col}
                col={col}
                items={grouped[col]}
                selectedTaskId={selectedTaskId}
                onSelectTask={setSelectedTaskId}
                nameFor={nameFor}
                onQuickDone={col === 'review' && taskShowReader && onUpdateTaskStatus ? quickDone : undefined}
                onRecheck={col === 'review' && wsSendRaw && cluster.members.length >= 2 ? recheckTask : undefined}
                onMarkAllDone={
                  col === 'review' && taskShowReader && onUpdateTaskStatus
                    ? () => {
                        const items = grouped.review;
                        if (items.length === 0) return;
                        if (!window.confirm(`Mark all ${items.length} review task${items.length === 1 ? '' : 's'} done? This cannot be undone in bulk.`)) return;
                        for (const t of items) onUpdateTaskStatus(taskShowReader, t.id, 'done', cluster.taskBoardKey);
                      }
                    : undefined
                }
              />
            ))}
          </div>
        </DndContext>
        {tasks.length === 0 && (
          <div style={{ fontSize: '11px', color: 'var(--color-fg-muted)', padding: '8px' }}>
            No tasks on this board yet. Add one with the field above; cluster
            members then claim and update them via the{' '}
            <code>cluster_task_*</code> peer-tools. <code>done</code> is
            operator-only.
          </div>
        )}
      </div>
      {selectedTask && (
        <TaskDetailDrawer
          task={selectedTask}
          details={details}
          cwd={cwd}
          graph={graph}
          loading={loadingDetails}
          error={detailsError}
          clusterId={cluster.clusterId}
          boardKey={cluster.taskBoardKey}
          members={cluster.members}
          requesterWorkflowId={taskShowReader}
          nameFor={nameFor}
          allTasks={tasks}
          canEdit={canCreateTask}
          onEditTask={editTask}
          onDeleteTask={deleteTask}
          onUpdateTaskStatus={onUpdateTaskStatus}
          onReassignTask={onReassignTask}
          onReclaimRun={onReclaimRun}
          onTerminateRun={onTerminateRun}
          onClose={() => { setSelectedTaskId(null); }}
        />
      )}
      {activeProposal && (
        <ProposalDetailDrawer
          proposal={activeProposal}
          nameFor={nameFor}
          onClose={() => selectProposal(cluster.clusterId, null)}
          onReject={() => rejectProposal(activeProposal.id)}
          onAccept={(itemIds, itemEdits, applyMode) => acceptProposal(activeProposal.id, itemIds, itemEdits, applyMode)}
        />
      )}
    </div>
  );
}

const assistLabelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
  color: 'var(--color-fg-muted)',
  fontSize: '9px',
  letterSpacing: '0.8px',
};

const assistSelectStyle: CSSProperties = {
  background: 'var(--color-bg-panel)',
  color: 'var(--color-fg)',
  border: '1px solid var(--color-border-hairline)',
  padding: '5px 6px',
  fontSize: '11px',
};

function proposalStatusColor(status: OrchestrationProposal['status']): string {
  switch (status) {
    case 'proposed': return 'var(--color-accent-secondary)';
    case 'partially_accepted': return 'var(--color-accent-primary)';
    case 'accepted': return '#58a66c';
    case 'rejected': return 'var(--color-fg-muted)';
    default: return 'var(--color-fg-muted)';
  }
}

function proposalKindLabel(kind: OrchestrationProposalItem['type']): string {
  switch (kind) {
    case 'task_create': return 'TASK';
    case 'task_update': return 'UPDATE';
    case 'task_comment': return 'COMMENT';
    case 'note': return 'NOTE';
  }
}

function proposalItemTitle(item: OrchestrationProposalItem): string {
  switch (item.type) {
    case 'task_create': return item.title;
    case 'task_update': return item.patch.title ?? `Update ${shortId(item.taskId)}`;
    case 'task_comment': return `Comment on ${shortId(item.taskId)}`;
    case 'note': return item.title ?? 'Synthesis note';
  }
}

function proposalItemBody(item: OrchestrationProposalItem): string {
  switch (item.type) {
    case 'task_create': return item.notes ?? '';
    case 'task_update': return item.patch.notes ?? item.patch.blockedReason ?? '';
    case 'task_comment': return item.body;
    case 'note': return item.body;
  }
}

function proposalItemTaskId(item: OrchestrationProposalItem): string | undefined {
  switch (item.type) {
    case 'task_update':
    case 'task_comment':
      return item.taskId;
    case 'task_create':
    case 'note':
      return undefined;
  }
}

function proposalItemAssignee(item: OrchestrationProposalItem): string | undefined {
  switch (item.type) {
    case 'task_create': return item.assignee;
    case 'task_update': return item.patch.assignee;
    case 'task_comment':
    case 'note':
      return undefined;
  }
}

function proposalItemPriority(item: OrchestrationProposalItem): number | undefined {
  switch (item.type) {
    case 'task_create': return item.priority;
    case 'task_update': return item.patch.priority;
    case 'task_comment':
    case 'note':
      return undefined;
  }
}

function proposalItemDependsOn(item: OrchestrationProposalItem): string[] {
  if (item.type !== 'task_create') return [];
  return [...(item.parentItemIds ?? []), ...(item.parentTaskIds ?? [])];
}

function ProposalSummaryCard({
  proposal,
  selected,
  nameFor,
  onSelect,
}: {
  proposal: OrchestrationProposal;
  selected: boolean;
  nameFor: (workflowId: string) => string;
  onSelect: () => void;
}) {
  const source = proposal.model.memberWorkflowId ? `@${nameFor(proposal.model.memberWorkflowId)}` : 'model assist';
  const model = [proposal.model.provider, proposal.model.model, proposal.model.effort].filter(Boolean).join(' · ');
  return (
    <button
      type="button"
      onClick={onSelect}
      style={{
        width: '100%',
        textAlign: 'left',
        border: `1px solid ${selected ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'}`,
        background: selected ? 'var(--color-accent-primary-a06)' : 'transparent',
        color: 'var(--color-fg)',
        padding: '7px',
        cursor: 'pointer',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
        <span className="display-font" style={{ fontSize: '9px', color: proposalStatusColor(proposal.status), letterSpacing: '0.8px' }}>
          {proposal.status.toUpperCase()}
        </span>
        <span style={{ fontSize: '11px', color: 'var(--color-fg-muted)' }}>{source}</span>
        {model && <span style={{ fontSize: '10px', color: 'var(--color-fg-muted)' }}>{model}</span>}
      </div>
      <div style={{ marginTop: '3px', fontSize: '12px', color: 'var(--color-fg)', wordBreak: 'break-word' }}>
        {proposal.kind.replace(/_/g, ' ')}
      </div>
      <div style={{ marginTop: '3px', fontSize: '10px', color: 'var(--color-fg-muted)' }}>
        {proposal.items.length} item{proposal.items.length === 1 ? '' : 's'} · {formatTime(proposal.createdAt)}
      </div>
    </button>
  );
}

function ProposalDetailDrawer({
  proposal,
  nameFor,
  onClose,
  onReject,
  onAccept,
}: {
  proposal: OrchestrationProposal;
  nameFor: (workflowId: string) => string;
  onClose: () => void;
  onReject: () => void;
  onAccept: (itemIds: string[], itemEdits: Record<string, { title?: string; body?: string }>, applyMode: 'task_kernel' | 'comment') => void;
}) {
  const acceptedIds = new Set(proposal.acceptedItemIds ?? []);
  const selectable = proposal.status === 'proposed' || proposal.status === 'partially_accepted';
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set(proposal.items.filter((item) => !acceptedIds.has(item.id)).map((item) => item.id)));
  const [edits, setEdits] = useState<Record<string, { title?: string; body?: string }>>({});

  useEffect(() => {
    const accepted = new Set(proposal.acceptedItemIds ?? []);
    setSelectedIds(new Set(proposal.items.filter((item) => !accepted.has(item.id)).map((item) => item.id)));
    setEdits({});
  }, [proposal.id, proposal.items, proposal.acceptedItemIds]);

  const selectedItemIds = proposal.items.map((item) => item.id).filter((id) => selectedIds.has(id));
  const source = proposal.model.memberWorkflowId
    ? `@${nameFor(proposal.model.memberWorkflowId)} (${shortId(proposal.model.memberWorkflowId)})`
    : 'model assist';
  const model = [proposal.model.provider, proposal.model.model, proposal.model.effort].filter(Boolean).join(' · ') || '—';
  const toggle = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const editItem = (id: string, patch: { title?: string; body?: string }) => {
    setEdits((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  };
  const compactEdits = Object.fromEntries(
    Object.entries(edits).filter(([id, edit]) =>
      selectedIds.has(id) && (edit.title?.trim() || edit.body?.trim())),
  );
  return (
    <div
      data-help="cluster.orchestration-proposal"
      style={{
        flex: '0 0 min(52%, 430px)',
        minHeight: '250px',
        maxHeight: '52%',
        borderTop: '1px solid var(--color-border)',
        background: 'var(--color-bg-panel)',
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
      }}
    >
      <div
        style={{
          padding: '8px 10px',
          borderBottom: '1px solid var(--color-border-hairline)',
          display: 'flex',
          alignItems: 'flex-start',
          gap: '8px',
          flexShrink: 0,
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="display-font" style={{ fontSize: '10px', letterSpacing: '1px', color: proposalStatusColor(proposal.status) }}>
            PROPOSAL · {proposal.status.toUpperCase()} · {shortId(proposal.id)}
          </div>
          <div style={{ marginTop: '3px', fontSize: '13px', color: 'var(--color-fg)', wordBreak: 'break-word' }}>
            {proposal.kind.replace(/_/g, ' ')}
          </div>
        </div>
        <button type="button" onClick={onClose} className="display-font" style={smallButtonStyle(true)}>
          CLOSE
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '8px 10px 12px' }}>
        <DrawerSection title="Source">
          <FieldGrid>
            <Field label="Member" value={source} />
            <Field label="Model" value={model} />
            <Field label="Created" value={formatTime(proposal.createdAt)} />
            <Field label="Updated" value={formatTime(proposal.updatedAt)} />
          </FieldGrid>
          {proposal.inputRefs.length > 0 && <InlineBlock label="Input refs" body={proposal.inputRefs.map((ref) => `${ref.kind}:${ref.label ?? ref.ref}`).join('\n')} />}
          {proposal.rationale && <InlineBlock label="Rationale" body={proposal.rationale} />}
        </DrawerSection>

        <DrawerSection title="Items">
          {proposal.items.length === 0 && (
            <div style={{ fontSize: '11px', color: 'var(--color-fg-muted)' }}>
              No proposed items.
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {proposal.items.map((item) => {
              const checked = selectedIds.has(item.id);
              const accepted = acceptedIds.has(item.id);
              const title = proposalItemTitle(item);
              const body = proposalItemBody(item);
              const edit = edits[item.id] ?? {};
              const taskId = proposalItemTaskId(item);
              const assignee = proposalItemAssignee(item);
              const dependsOn = proposalItemDependsOn(item);
              return (
                <div
                  key={item.id}
                  style={{
                    border: '1px solid var(--color-border-hairline)',
                    background: checked ? 'var(--color-accent-primary-a06)' : accepted ? 'var(--color-bg-sunken)' : 'var(--color-bg-inset)',
                    padding: '8px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '6px',
                  }}
                >
                  <label style={{ display: 'flex', alignItems: 'flex-start', gap: '7px', cursor: selectable && !accepted ? 'pointer' : 'default' }}>
                    <input
                      type="checkbox"
                      disabled={!selectable || accepted}
                      checked={checked}
                      onChange={() => toggle(item.id)}
                    />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span className="display-font" style={{ fontSize: '9px', color: 'var(--color-accent-secondary)', letterSpacing: '0.8px' }}>
                        {proposalKindLabel(item.type)}
                      </span>
                      <span style={{ display: 'block', marginTop: '2px', fontSize: '12px', color: 'var(--color-fg)', wordBreak: 'break-word' }}>
                        {title}
                      </span>
                      {accepted && (
                        <span className="display-font" style={{ display: 'block', marginTop: '2px', fontSize: '9px', color: '#58a66c', letterSpacing: '0.8px' }}>
                          ACCEPTED
                        </span>
                      )}
                    </span>
                  </label>
                  <textarea
                    value={edit.title ?? title}
                    disabled={!selectable || !checked || accepted}
                    onChange={(event) => editItem(item.id, { title: event.target.value })}
                    rows={1}
                    style={proposalEditStyle(Boolean(selectable && checked && !accepted))}
                  />
                  <textarea
                    value={edit.body ?? body}
                    disabled={!selectable || !checked || accepted}
                    onChange={(event) => editItem(item.id, { body: event.target.value })}
                    rows={3}
                    placeholder="Optional item body / notes / comment text."
                    style={proposalEditStyle(Boolean(selectable && checked && !accepted))}
                  />
                  {item.rationale && <InlineBlock label="Why" body={item.rationale} />}
                  <FieldGrid>
                    <Field label="Task" value={taskId ?? 'new'} />
                    <Field label="Assignee" value={assignee ? `@${nameFor(assignee)}` : '—'} />
                    <Field label="Priority" value={typeof proposalItemPriority(item) === 'number' ? String(proposalItemPriority(item)) : '—'} />
                    <Field label="Source type" value={item.type} />
                  </FieldGrid>
                  {dependsOn.length > 0 && <InlineBlock label="Depends on" body={dependsOn.join('\n')} />}
                </div>
              );
            })}
          </div>
        </DrawerSection>
      </div>
      <div
        style={{
          borderTop: '1px solid var(--color-border-hairline)',
          padding: '8px 10px',
          display: 'flex',
          gap: '6px',
          flexWrap: 'wrap',
          alignItems: 'center',
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: '10px', color: 'var(--color-fg-muted)', marginRight: 'auto' }}>
          {selectedItemIds.length} selected
        </span>
        <button
          type="button"
          disabled={!selectable}
          onClick={onReject}
          className="display-font"
          style={smallButtonStyle(selectable)}
          title="Reject keeps the proposal inspectable and does not touch task state."
        >
          REJECT
        </button>
        <button
          type="button"
          disabled={!selectable || selectedItemIds.length === 0}
          onClick={() => onAccept(selectedItemIds, compactEdits, 'comment')}
          className="display-font"
          style={smallButtonStyle(selectable && selectedItemIds.length > 0)}
          title="Ask the backend to save selected proposal items as comments instead of applying task mutations."
        >
          SAVE COMMENT
        </button>
        <button
          type="button"
          disabled={!selectable || selectedItemIds.length === 0}
          onClick={() => onAccept(selectedItemIds, compactEdits, 'task_kernel')}
          className="display-font"
          style={{
            ...smallButtonStyle(selectable && selectedItemIds.length > 0),
            color: selectable && selectedItemIds.length > 0 ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
            borderColor: selectable && selectedItemIds.length > 0 ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)',
          }}
          title="Accept selected items explicitly. The backend should apply them via ordinary task-kernel mutations."
        >
          ACCEPT SELECTED
        </button>
      </div>
    </div>
  );
}

function proposalEditStyle(enabled: boolean): CSSProperties {
  return {
    width: '100%',
    boxSizing: 'border-box',
    resize: 'vertical',
    background: enabled ? 'var(--color-bg-panel)' : 'transparent',
    color: enabled ? 'var(--color-fg)' : 'var(--color-fg-muted)',
    border: '1px solid var(--color-border-hairline)',
    padding: '5px 6px',
    fontFamily: 'var(--font-code)',
    fontSize: '11px',
    lineHeight: 1.4,
  };
}

function SwarmCreateModal({
  cluster,
  requesterWorkflowId,
  onClose,
  onCreate,
}: {
  cluster: ClusterStatePayload;
  requesterWorkflowId: string;
  onClose: () => void;
  onCreate: (request: ClusterSwarmCreateRequest) => void;
}) {
  const members = cluster.members;
  const defaultVerifier = members[Math.max(0, members.length - 2)]?.workflowId ?? requesterWorkflowId;
  const defaultSynthesizer = members[Math.max(0, members.length - 1)]?.workflowId ?? defaultVerifier;
  const defaultWorkers = members
    .map((m) => m.workflowId)
    .filter((id) => id !== defaultVerifier && id !== defaultSynthesizer);
  const fallbackWorkers = defaultWorkers.length > 0 ? defaultWorkers : members.slice(0, 1).map((m) => m.workflowId);
  const [brief, setBrief] = useState('');
  const [workerIds, setWorkerIds] = useState<Set<string>>(() => new Set(fallbackWorkers));
  const [verifierWorkflowId, setVerifierWorkflowId] = useState(defaultVerifier);
  const [synthesizerWorkflowId, setSynthesizerWorkflowId] = useState(defaultSynthesizer);
  const [dispatchAfterCreate, setDispatchAfterCreate] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const selectedWorkerIds = Array.from(workerIds).filter((id) => members.some((m) => m.workflowId === id));
  const canCreate = brief.trim().length > 0
    && selectedWorkerIds.length > 0
    && Boolean(verifierWorkflowId)
    && Boolean(synthesizerWorkflowId);

  const memberLabel = (workflowId: string): string => {
    const member = members.find((m) => m.workflowId === workflowId);
    if (!member) return shortId(workflowId);
    return member.displayName || shortId(workflowId);
  };

  const toggleWorker = (workflowId: string) => {
    setWorkerIds((prev) => {
      const next = new Set(prev);
      if (next.has(workflowId)) next.delete(workflowId);
      else next.add(workflowId);
      return next;
    });
  };

  const submit = () => {
    if (!canCreate) return;
    onCreate({
      goal: brief.trim(),
      workerWorkflowIds: selectedWorkerIds,
      verifierWorkflowId,
      synthesizerWorkflowId,
      ...(dispatchAfterCreate ? { armDispatch: true } : {}),
    });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      data-help="cluster.swarm-create"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 80,
        background: 'rgba(0,0,0,0.48)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px',
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        style={{
          width: 'min(560px, 100%)',
          maxHeight: 'min(720px, 92vh)',
          overflowY: 'auto',
          border: '1px solid var(--color-border)',
          background: 'var(--color-bg-panel)',
          boxShadow: '0 16px 60px rgba(0,0,0,0.32)',
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
          padding: '12px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div className="display-font" style={{ flex: 1, color: 'var(--color-accent-secondary)', fontSize: '11px', letterSpacing: '1.5px' }}>
            CREATE SWARM
          </div>
          <button
            type="button"
            onClick={onClose}
            className="display-font"
            style={{
              border: '1px solid var(--color-border-hairline)',
              background: 'transparent',
              color: 'var(--color-fg-muted)',
              cursor: 'pointer',
              fontSize: '10px',
              letterSpacing: '0.8px',
              padding: '4px 8px',
            }}
          >
            CLOSE
          </button>
        </div>

        <label className="display-font" style={{ display: 'flex', flexDirection: 'column', gap: '5px', fontSize: '10px', letterSpacing: '1px', color: 'var(--color-fg-muted)' }}>
          BRIEF
          <textarea
            autoFocus
            value={brief}
            onChange={(event) => setBrief(event.target.value)}
            rows={5}
            maxLength={12000}
            style={{
              resize: 'vertical',
              minHeight: '110px',
              background: 'var(--color-bg-inset)',
              color: 'var(--color-fg)',
              border: '1px solid var(--color-border-hairline)',
              padding: '8px',
              fontFamily: 'var(--font-code)',
              fontSize: '12px',
              lineHeight: 1.45,
              letterSpacing: 0,
            }}
          />
        </label>

        <div>
          <div>
            <div className="display-font" style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '10px', letterSpacing: '1px', color: 'var(--color-fg-muted)', marginBottom: '6px' }}>
              <span>WORKERS</span>
              <span style={{ color: selectedWorkerIds.length > 0 ? 'var(--color-accent-primary)' : '#e0a030' }}>
                {selectedWorkerIds.length} SELECTED
              </span>
            </div>
            <div style={{ display: 'grid', gap: '5px' }}>
              {members.map((member) => {
                const checked = workerIds.has(member.workflowId);
                return (
                  <label
                    key={member.workflowId}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '7px',
                      border: '1px solid var(--color-border-hairline)',
                      background: checked ? 'var(--color-accent-primary-a06)' : 'transparent',
                      padding: '6px 8px',
                      cursor: 'pointer',
                      fontSize: '11px',
                      color: 'var(--color-fg)',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleWorker(member.workflowId)}
                    />
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {member.displayName || shortId(member.workflowId)}
                    </span>
                    {member.role && (
                      <span className="display-font" style={{ color: 'var(--color-fg-muted)', fontSize: '9px', letterSpacing: '0.7px' }}>
                        {member.role}
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: '10px' }}>
          <label className="display-font" style={{ display: 'flex', flexDirection: 'column', gap: '5px', fontSize: '10px', letterSpacing: '1px', color: 'var(--color-fg-muted)' }}>
            VERIFIER
            <select
              value={verifierWorkflowId}
              onChange={(event) => setVerifierWorkflowId(event.target.value)}
              style={{
                background: 'var(--color-bg-inset)',
                color: 'var(--color-fg)',
                border: '1px solid var(--color-border-hairline)',
                padding: '7px 8px',
                fontSize: '12px',
              }}
            >
              {members.map((member) => (
                <option key={member.workflowId} value={member.workflowId}>
                  {memberLabel(member.workflowId)}
                </option>
              ))}
            </select>
          </label>
          <label className="display-font" style={{ display: 'flex', flexDirection: 'column', gap: '5px', fontSize: '10px', letterSpacing: '1px', color: 'var(--color-fg-muted)' }}>
            SYNTHESIZER
            <select
              value={synthesizerWorkflowId}
              onChange={(event) => setSynthesizerWorkflowId(event.target.value)}
              style={{
                background: 'var(--color-bg-inset)',
                color: 'var(--color-fg)',
                border: '1px solid var(--color-border-hairline)',
                padding: '7px 8px',
                fontSize: '12px',
              }}
            >
              {members.map((member) => (
                <option key={member.workflowId} value={member.workflowId}>
                  {memberLabel(member.workflowId)}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          <label className="display-font" style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', color: 'var(--color-fg-muted)', fontSize: '10px', letterSpacing: '1px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={dispatchAfterCreate}
              onChange={(event) => setDispatchAfterCreate(event.target.checked)}
            />
            DISPATCH
          </label>
          <button
            type="submit"
            disabled={!canCreate}
            className="display-font"
            style={{
              marginLeft: 'auto',
              border: '1px solid ' + (canCreate ? 'var(--color-accent-secondary)' : 'var(--color-border-hairline)'),
              background: canCreate ? 'var(--color-accent-secondary)' : 'transparent',
              color: canCreate ? 'var(--color-bg)' : 'var(--color-fg-muted)',
              cursor: canCreate ? 'pointer' : 'not-allowed',
              fontSize: '10px',
              letterSpacing: '1px',
              padding: '6px 12px',
            }}
          >
            CREATE
          </button>
        </div>
      </form>
    </div>
  );
}

function TaskDetailDrawer({
  task,
  details,
  cwd,
  graph,
  loading,
  error,
  clusterId,
  boardKey,
  members,
  requesterWorkflowId,
  nameFor,
  allTasks,
  canEdit,
  onEditTask,
  onDeleteTask,
  onUpdateTaskStatus,
  onReassignTask,
  onReclaimRun,
  onTerminateRun,
  onClose,
}: {
  task: WorktreeAwareLedgerTask;
  details: TaskDetails | null;
  cwd?: string;
  graph: ReturnType<typeof taskGraphSummary>;
  loading: boolean;
  error: string | null;
  clusterId: string;
  boardKey?: string;
  members: ClusterStatePayload['members'];
  requesterWorkflowId: string | null;
  nameFor: (workflowId: string) => string;
  allTasks: WorktreeAwareLedgerTask[];
  canEdit: boolean;
  onEditTask: (taskId: string, patch: { title?: string; notes?: string; priority?: number; parentIds?: string[] }) => void;
  onDeleteTask: (taskId: string) => void;
  onUpdateTaskStatus?: (workflowId: string, taskId: string, status: LedgerTaskStatus, boardKey?: string) => void;
  onReassignTask?: (workflowId: string, taskId: string, assigneeWorkflowId: string | null, boardKey?: string) => void;
  onReclaimRun?: (clusterId: string, workflowId: string, taskId: string, runId: string, boardKey?: string) => void;
  onTerminateRun?: (clusterId: string, workflowId: string, taskId: string, runId: string, boardKey?: string) => void;
  onClose: () => void;
}) {
  const runs = details?.runs ?? [];
  const openRuns = runs.filter(runOpen);
  const linkedRefs = details?.referenceDocs?.refs ?? [];
  const [openRef, setOpenRef] = useState<{ planId: string; slug: string; exists: boolean } | null>(null);
  const [statusDraft, setStatusDraft] = useState<LedgerTaskStatus>(task.status);
  const [assigneeDraft, setAssigneeDraft] = useState(task.assignee ?? '');
  const [titleDraft, setTitleDraft] = useState(task.title);
  const [notesDraft, setNotesDraft] = useState(task.notes ?? '');
  const [priorityDraft, setPriorityDraft] = useState(String(task.priority));
  const [addParentId, setAddParentId] = useState('');
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    setStatusDraft(task.status);
    setAssigneeDraft(task.assignee ?? '');
    setTitleDraft(task.title);
    setNotesDraft(task.notes ?? '');
    setPriorityDraft(String(task.priority));
    setAddParentId('');
  }, [task.assignee, task.id, task.status, task.title, task.notes, task.priority]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(id);
  }, []);

  const canReassign = Boolean(requesterWorkflowId && onReassignTask);
  const canUpdateStatus = Boolean(requesterWorkflowId && onUpdateTaskStatus);
  const commitStatus = (next: LedgerTaskStatus = statusDraft) => {
    if (!requesterWorkflowId || !onUpdateTaskStatus) return;
    if (task.status === next) return;
    if ((next === 'done' || next === 'archived') && openRuns.length > 0) {
      const ok = window.confirm(`This task has ${openRuns.length} open run${openRuns.length === 1 ? '' : 's'}. Mark it ${COLUMN_LABEL[next]} anyway?`);
      if (!ok) return;
    }
    onUpdateTaskStatus(requesterWorkflowId, task.id, next, boardKey);
  };
  const commitReassign = () => {
    if (!requesterWorkflowId || !onReassignTask) return;
    const next = assigneeDraft || null;
    if ((task.assignee ?? null) === next) return;
    onReassignTask(requesterWorkflowId, task.id, next, boardKey);
  };

  // §10.7 P12.3 — field editing. Title/notes/priority commit together (one
  // task_ledger_update); dependency add/remove and delete are discrete actions.
  const parentIds = task.parentIds ?? [];
  const priorityNum = Number(priorityDraft);
  const fieldsDirty =
    titleDraft.trim() !== task.title ||
    notesDraft !== (task.notes ?? '') ||
    (Number.isFinite(priorityNum) && priorityNum !== task.priority);
  const saveFields = () => {
    if (!canEdit || !fieldsDirty) return;
    const patch: { title?: string; notes?: string; priority?: number } = {};
    const t = titleDraft.trim();
    if (t && t !== task.title) patch.title = t;
    if (notesDraft !== (task.notes ?? '')) patch.notes = notesDraft;
    if (Number.isFinite(priorityNum) && priorityNum !== task.priority) patch.priority = priorityNum;
    if (Object.keys(patch).length === 0) return;
    onEditTask(task.id, patch);
  };
  const resetFields = () => {
    setTitleDraft(task.title);
    setNotesDraft(task.notes ?? '');
    setPriorityDraft(String(task.priority));
  };
  const addParent = () => {
    if (!canEdit || !addParentId || parentIds.includes(addParentId) || addParentId === task.id) return;
    onEditTask(task.id, { parentIds: [...parentIds, addParentId] });
    setAddParentId('');
  };
  const removeParent = (id: string) => {
    if (!canEdit) return;
    onEditTask(task.id, { parentIds: parentIds.filter((p) => p !== id) });
  };
  const confirmDelete = () => {
    if (!canEdit) return;
    if (!window.confirm(`Delete task "${task.title}"? This removes it from the board. This cannot be undone.`)) return;
    onDeleteTask(task.id);
    onClose();
  };
  const parentCandidates = allTasks.filter((t) => t.id !== task.id && !parentIds.includes(t.id));
  const titleFor = (id: string): string => allTasks.find((t) => t.id === id)?.title ?? shortId(id);

  return (
    <div
      data-help="cluster.task-drawer"
      style={{
        flex: '0 0 min(46%, 380px)',
        minHeight: '220px',
        maxHeight: '46%',
        borderTop: '1px solid var(--color-border)',
        background: 'var(--color-bg-panel)',
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
      }}
    >
      <div
        style={{
          padding: '8px 10px',
          borderBottom: '1px solid var(--color-border-hairline)',
          display: 'flex',
          alignItems: 'flex-start',
          gap: '8px',
          flexShrink: 0,
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="display-font" style={{ fontSize: '10px', letterSpacing: '1px', color: statusColor(task.status) }}>
            {COLUMN_LABEL[task.status]} · {shortId(task.id)}
          </div>
          <div style={{ marginTop: '3px', fontSize: '13px', color: 'var(--color-fg)', wordBreak: 'break-word' }}>
            {task.title}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="display-font"
          style={{
            border: '1px solid var(--color-border-hairline)',
            background: 'transparent',
            color: 'var(--color-fg-muted)',
            cursor: 'pointer',
            fontSize: '10px',
            letterSpacing: '0.5px',
            padding: '3px 7px',
            flexShrink: 0,
          }}
        >
          CLOSE
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '8px 10px 12px' }}>
        {loading && (
          <div style={{ fontSize: '11px', color: 'var(--color-fg-muted)', marginBottom: '8px' }}>
            Loading task details…
          </div>
        )}
        {error && (
          <div
            style={{
              fontSize: '11px',
              color: '#e0a030',
              border: '1px solid var(--color-border-hairline)',
              padding: '6px',
              marginBottom: '8px',
              wordBreak: 'break-word',
            }}
          >
            Detail read failed: {error}
          </div>
        )}

        {linkedRefs.length > 0 && (
          <DrawerSection title="Reference docs">
            <div data-help="plan.refs" style={{ display: 'flex', flexWrap: 'wrap', gap: '5px' }}>
              {linkedRefs.map((r) => (
                <button
                  key={`${r.planId}/${r.slug}`}
                  type="button"
                  disabled={!cwd || !r.planId}
                  onClick={() => setOpenRef({ planId: r.planId, slug: r.slug, exists: r.exists })}
                  title={r.exists ? `${r.path} — click to read` : `ref:${r.slug} is linked but not written yet`}
                  style={{
                    padding: '1px 7px',
                    background: r.exists ? 'var(--color-accent-secondary-a10)' : 'transparent',
                    border: `1px ${r.exists ? 'solid' : 'dashed'} var(--color-accent-secondary-dim)`,
                    borderRadius: '3px',
                    color: 'var(--color-accent-secondary)',
                    opacity: r.exists ? 1 : 0.55,
                    cursor: 'pointer',
                    fontSize: '10px',
                    fontFamily: 'var(--font-body)',
                  }}
                >
                  ⧉ {r.title ?? r.slug}
                </button>
              ))}
            </div>
          </DrawerSection>
        )}
        {openRef && cwd && (
          <PlanRefViewer
            cwd={cwd}
            planId={openRef.planId}
            slug={openRef.slug}
            exists={openRef.exists}
            onClose={() => setOpenRef(null)}
            onChanged={() => { /* the drawer refetches on reselect */ }}
          />
        )}

        {canEdit && (
          <DrawerSection title="Edit">
            <div
              data-help="cluster.task-edit"
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
                border: `1px solid ${fieldsDirty ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'}`,
                padding: '8px',
                background: 'var(--color-bg-inset)',
              }}
            >
              <label style={editLabelStyle}>TITLE</label>
              <input
                type="text"
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                style={editInputStyle}
              />
              <label style={editLabelStyle}>NOTES</label>
              <textarea
                value={notesDraft}
                onChange={(e) => setNotesDraft(e.target.value)}
                spellCheck={false}
                rows={Math.min(8, Math.max(2, notesDraft.split('\n').length))}
                style={{ ...editInputStyle, resize: 'vertical', fontFamily: 'var(--font-code)' }}
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <label style={editLabelStyle}>PRIORITY</label>
                <input
                  type="number"
                  value={priorityDraft}
                  onChange={(e) => setPriorityDraft(e.target.value)}
                  style={{ ...editInputStyle, width: '80px' }}
                />
              </div>
              <div style={{ display: 'flex', gap: '6px' }}>
                <button
                  type="button"
                  className="display-font"
                  disabled={!fieldsDirty}
                  onClick={saveFields}
                  style={smallButtonStyle(fieldsDirty)}
                >
                  SAVE
                </button>
                <button
                  type="button"
                  className="display-font"
                  disabled={!fieldsDirty}
                  onClick={resetFields}
                  style={smallButtonStyle(fieldsDirty)}
                >
                  RESET
                </button>
              </div>
            </div>

            {/* Dependencies (parent tasks). Add/remove are discrete edits. */}
            <div style={{ marginTop: '8px' }}>
              <div style={editLabelStyle}>DEPENDS ON (PARENTS)</div>
              {parentIds.length === 0 && (
                <div style={{ fontSize: '11px', color: 'var(--color-fg-muted)', padding: '2px 0' }}>none</div>
              )}
              {parentIds.map((pid) => (
                <div key={pid} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '2px 0' }}>
                  <span style={{ fontSize: '11px', color: 'var(--color-fg)', flex: 1, wordBreak: 'break-word' }}>
                    {titleFor(pid)} <span style={{ color: 'var(--color-fg-muted)' }}>({shortId(pid)})</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => removeParent(pid)}
                    title="Remove dependency"
                    style={{ ...smallButtonStyle(true), color: 'var(--color-error, #e0524f)', borderColor: 'var(--color-error, #e0524f)' }}
                  >
                    ×
                  </button>
                </div>
              ))}
              {parentCandidates.length > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '4px' }}>
                  <select
                    value={addParentId}
                    onChange={(e) => setAddParentId(e.target.value)}
                    style={{ ...editInputStyle, flex: 1 }}
                  >
                    <option value="">+ add a parent…</option>
                    {parentCandidates.map((t) => (
                      <option key={t.id} value={t.id}>{t.title} ({shortId(t.id)})</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="display-font"
                    disabled={!addParentId}
                    onClick={addParent}
                    style={smallButtonStyle(Boolean(addParentId))}
                  >
                    ADD
                  </button>
                </div>
              )}
            </div>

            <div style={{ marginTop: '10px', display: 'flex', justifyContent: 'flex-end' }}>
              <button
                type="button"
                className="display-font"
                onClick={confirmDelete}
                title="Delete this task from the board"
                style={{ ...smallButtonStyle(true), color: 'var(--color-error, #e0524f)', borderColor: 'var(--color-error, #e0524f)' }}
              >
                DELETE TASK
              </button>
            </div>
          </DrawerSection>
        )}

        <DrawerSection title="Overview">
          <FieldGrid>
            <Field label="Assignee" value={task.assignee ? `@${nameFor(task.assignee)} (${shortId(task.assignee)})` : 'UNCLAIMED'} />
            <Field label="Priority" value={String(task.priority)} />
            <Field label="Review" value={task.reviewRequired ? 'required' : 'not required'} />
            <Field label="Goal mode" value={task.goalMode ? `on${task.goalMaxTurns ? ` · ${task.goalMaxTurns} turns` : ''}` : 'off'} />
            <Field label="Worktree required" value={task.worktreeRequired ? 'yes' : 'no'} />
            <Field label="Current worktree" value={task.worktree ? `${task.worktree.branch} · ${task.worktree.path}` : 'none'} />
            <Field label="Created" value={formatTime(task.createdAt)} />
            <Field label="Updated" value={formatTime(task.updatedAt)} />
          </FieldGrid>
          {task.blockedReason && <InlineBlock label="Blocked reason" body={task.blockedReason} />}
          {/* §D3 — director's advisory sign-off (the same verdict surfaced as a
              chip on the card). Advisory only; done stays operator-only. */}
          {task.signoff && (
            <InlineBlock
              label="Director sign-off"
              body={`${signoffChip(task.signoff).label}${task.signoff.summary ? ` — ${task.signoff.summary}` : ''}\n${task.signoff.byWorkflowId ? `by ${nameFor(task.signoff.byWorkflowId)} · ` : ''}${formatTime(task.signoff.at)}`}
            />
          )}
          {task.notes && <InlineBlock label="Notes" body={task.notes} />}
          <LinksView links={task.links} />
        </DrawerSection>

        <DrawerSection title="Operator Status">
          <div
            data-help="cluster.task-status"
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '7px',
              border: '1px solid var(--color-border-hairline)',
              padding: '7px',
              background: 'var(--color-bg-inset)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
              <span className="display-font" style={{ fontSize: '9px', letterSpacing: '0.7px', color: 'var(--color-fg-muted)' }}>
                CURRENT
              </span>
              <span className="display-font" style={{ fontSize: '10px', letterSpacing: '0.8px', color: statusColor(task.status) }}>
                {COLUMN_LABEL[task.status]}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
              <select
                value={statusDraft}
                disabled={!canUpdateStatus}
                onChange={(e) => setStatusDraft(e.target.value as LedgerTaskStatus)}
                style={{
                  minWidth: '150px',
                  background: canUpdateStatus ? 'var(--color-bg-panel)' : 'transparent',
                  color: canUpdateStatus ? statusColor(statusDraft) : 'var(--color-fg-muted)',
                  border: '1px solid var(--color-border-hairline)',
                  padding: '4px 6px',
                  fontSize: '11px',
                }}
                title={canUpdateStatus ? 'Operator-only task status. DONE and ARCHIVED are never available to worker tools.' : 'No cluster member is available to send the operator status update.'}
              >
                {BOARD_COLUMNS.map((status) => (
                  <option key={status} value={status}>{COLUMN_LABEL[status]}</option>
                ))}
              </select>
              <button
                type="button"
                disabled={!canUpdateStatus || statusDraft === task.status}
                onClick={() => commitStatus()}
                className="display-font"
                style={smallButtonStyle(canUpdateStatus && statusDraft !== task.status)}
              >
                APPLY
              </button>
              <button
                type="button"
                disabled={!canUpdateStatus || task.status === 'done'}
                onClick={() => commitStatus('done')}
                className="display-font"
                style={{
                  ...smallButtonStyle(canUpdateStatus && task.status !== 'done'),
                  color: canUpdateStatus && task.status !== 'done' ? 'var(--color-accent-secondary)' : 'var(--color-fg-muted)',
                  borderColor: canUpdateStatus && task.status !== 'done' ? 'var(--color-accent-secondary)' : 'var(--color-border-hairline)',
                }}
                title="Operator acceptance: move this task to DONE."
              >
                MARK DONE
              </button>
              <button
                type="button"
                disabled={!canUpdateStatus || task.status === 'archived'}
                onClick={() => commitStatus('archived')}
                className="display-font"
                style={smallButtonStyle(canUpdateStatus && task.status !== 'archived')}
                title="Archive this task after acceptance."
              >
                ARCHIVE
              </button>
            </div>
            <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', lineHeight: 1.35 }}>
              DONE / ARCHIVED are operator-only. Worker tools can still complete work only into REVIEW.
            </div>
          </div>
        </DrawerSection>

        <DrawerSection title="Recovery Controls">
          <div
            data-help="cluster.task-recovery"
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
              border: '1px solid var(--color-border-hairline)',
              padding: '7px',
              background: 'var(--color-bg-inset)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', fontSize: '11px' }}>
              <RunSummaryPill label="OPEN RUNS" value={String(openRuns.length)} tone={openRuns.length > 0 ? 'active' : 'muted'} />
              {openRuns.some((run) => now - runHeartbeatAt(run) >= RUN_STALE_AFTER_MS) && (
                <RunSummaryPill label="STALE" value="YES" tone="warn" />
              )}
              {!requesterWorkflowId && <span style={{ color: '#e0a030' }}>No cluster member can send recovery mutations.</span>}
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', fontSize: '11px' }}>
              <span className="display-font" style={{ fontSize: '9px', letterSpacing: '0.5px', color: 'var(--color-fg-muted)' }}>
                REASSIGN
              </span>
              <select
                value={assigneeDraft}
                disabled={!canReassign}
                onChange={(e) => setAssigneeDraft(e.target.value)}
                style={{
                  minWidth: '140px',
                  maxWidth: '100%',
                  background: canReassign ? 'var(--color-bg-panel)' : 'transparent',
                  color: canReassign ? 'var(--color-fg)' : 'var(--color-fg-muted)',
                  border: '1px solid var(--color-border-hairline)',
                  padding: '3px 5px',
                  fontSize: '11px',
                }}
                title={canReassign ? 'Select the task assignee. This does not mark the task done.' : 'Reassign callback is not available.'}
              >
                <option value="">UNASSIGNED</option>
                {members.map((member) => (
                  <option key={member.workflowId} value={member.workflowId}>
                    {member.displayName || shortId(member.workflowId)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={!canReassign || (task.assignee ?? '') === assigneeDraft}
                onClick={commitReassign}
                className="display-font"
                style={smallButtonStyle(canReassign && (task.assignee ?? '') !== assigneeDraft)}
              >
                APPLY
              </button>
            </label>
          </div>
        </DrawerSection>

        <DrawerSection title="Dependency Graph">
          <div style={{ fontSize: '11px', color: 'var(--color-fg-muted)', marginBottom: '6px' }}>
            {graph.parentCount} parent{graph.parentCount === 1 ? '' : 's'} · {graph.childCount} child{graph.childCount === 1 ? '' : 'ren'} · {graph.blockedParentCount} blocked parent{graph.blockedParentCount === 1 ? '' : 's'} · {graph.openChildCount} open child{graph.openChildCount === 1 ? '' : 'ren'}
          </div>
          <TaskList label="Parents" tasks={details?.parents ?? []} />
          <TaskList label="Children" tasks={details?.children ?? []} />
        </DrawerSection>

        <DrawerSection title="Comments">
          <CommentsView comments={details?.comments ?? []} nameFor={nameFor} />
        </DrawerSection>

        <DrawerSection title="Runs + Heartbeats">
          <RunsView
            taskId={task.id}
            clusterId={clusterId}
            boardKey={boardKey}
            requesterWorkflowId={requesterWorkflowId}
            runs={runs}
            nameFor={nameFor}
            onReclaimRun={onReclaimRun}
            onTerminateRun={onTerminateRun}
          />
        </DrawerSection>
      </div>
    </div>
  );
}

function DrawerSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ paddingTop: '8px', marginTop: '8px', borderTop: '1px solid var(--color-border-hairline)' }}>
      <div className="display-font" style={{ fontSize: '10px', letterSpacing: '1px', color: 'var(--color-fg-muted)', marginBottom: '6px' }}>
        {title}
      </div>
      {children}
    </section>
  );
}

function FieldGrid({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(118px, 1fr))',
        gap: '6px',
      }}
    >
      {children}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div className="display-font" style={{ fontSize: '9px', letterSpacing: '0.5px', color: 'var(--color-fg-muted)' }}>
        {label}
      </div>
      <div style={{ fontSize: '11px', color: 'var(--color-fg)', wordBreak: 'break-word' }}>
        {value}
      </div>
    </div>
  );
}

function InlineBlock({ label, body }: { label: string; body: string }) {
  return (
    <div style={{ marginTop: '8px', minWidth: 0 }}>
      <div className="display-font" style={{ fontSize: '9px', letterSpacing: '0.5px', color: 'var(--color-fg-muted)' }}>
        {label}
      </div>
      <div style={{ fontSize: '11px', color: 'var(--color-fg)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
        {body}
      </div>
    </div>
  );
}

function LinksView({ links }: { links: TaskLink[] }) {
  if (links.length === 0) {
    return <div style={{ marginTop: '8px', fontSize: '11px', color: 'var(--color-fg-muted)' }}>No links.</div>;
  }
  return (
    <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <div className="display-font" style={{ fontSize: '9px', letterSpacing: '0.5px', color: 'var(--color-fg-muted)' }}>
        Links
      </div>
      {links.map((l, i) => (
        <div key={`${l.kind}-${l.ref}-${i}`} style={lineStyle}>
          <span className="display-font" style={{ fontSize: '9px', color: 'var(--color-accent-primary)', flexShrink: 0 }}>
            {l.kind.toUpperCase()}
          </span>
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={l.ref}>
            {l.label || l.ref}
          </span>
        </div>
      ))}
    </div>
  );
}

function TaskList({ label, tasks }: { label: string; tasks: LedgerTask[] }) {
  return (
    <div style={{ marginTop: '6px' }}>
      <div className="display-font" style={{ fontSize: '9px', letterSpacing: '0.5px', color: 'var(--color-fg-muted)', marginBottom: '3px' }}>
        {label}
      </div>
      {tasks.length === 0 ? (
        <div style={{ fontSize: '11px', color: 'var(--color-fg-muted)' }}>None.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {tasks.map((t) => (
            <div key={t.id} style={lineStyle} title={t.id}>
              <span className="display-font" style={{ fontSize: '9px', color: statusColor(t.status), flexShrink: 0 }}>
                {COLUMN_LABEL[t.status]}
              </span>
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {t.title}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CommentsView({ comments, nameFor }: { comments: TaskComment[]; nameFor: (workflowId: string) => string }) {
  if (comments.length === 0) {
    return <div style={{ fontSize: '11px', color: 'var(--color-fg-muted)' }}>No comments yet.</div>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      {comments.map((c) => (
        <div key={c.id} style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '10px', color: 'var(--color-fg-muted)', flexWrap: 'wrap' }}>
            <span className="display-font" style={{ color: 'var(--color-accent-primary)', letterSpacing: '0.5px' }}>
              {c.authorWorkflowId ? `@${nameFor(c.authorWorkflowId)}` : c.authorLabel}
            </span>
            <span>{formatTime(c.createdAt)}</span>
          </div>
          <div style={{ marginTop: '2px', fontSize: '11px', color: 'var(--color-fg)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {c.body}
          </div>
        </div>
      ))}
    </div>
  );
}

function RunSummaryPill({ label, value, tone }: { label: string; value: string; tone: 'active' | 'muted' | 'warn' }) {
  const color = tone === 'warn'
    ? '#e0a030'
    : tone === 'active'
      ? 'var(--color-accent-primary)'
      : 'var(--color-fg-muted)';
  return (
    <span
      className="display-font"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        border: `1px solid ${color}`,
        color,
        padding: '2px 5px',
        fontSize: '9px',
        letterSpacing: '0.5px',
      }}
    >
      <span>{label}</span>
      <span>{value}</span>
    </span>
  );
}

// §10.7 P12.4 — one kanban column. A dnd-kit drop target; dropping a dragged
// card here fires the parent's onDragEnd → moveTask(taskId, col).
function BoardColumn({
  col,
  items,
  selectedTaskId,
  onSelectTask,
  nameFor,
  onMarkAllDone,
  onQuickDone,
  onRecheck,
}: {
  col: LedgerTaskStatus;
  items: WorktreeAwareLedgerTask[];
  selectedTaskId: string | null;
  onSelectTask: (id: string) => void;
  nameFor: (workflowId: string) => string;
  onMarkAllDone?: () => void;
  onQuickDone?: (taskId: string) => void;
  onRecheck?: (task: WorktreeAwareLedgerTask) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: col });
  return (
    <div
      ref={setNodeRef}
      data-help="cluster.board-column"
      style={{
        flexShrink: 0,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        border: `1px solid ${isOver ? 'var(--color-accent-primary)' : 'transparent'}`,
        borderRadius: '3px',
        background: isOver ? 'var(--color-accent-primary-a06)' : 'transparent',
        padding: '2px',
      }}
    >
      <div
        className="display-font"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          fontSize: '10px',
          letterSpacing: '1.5px',
          color: statusColor(col),
          borderBottom: '1px solid var(--color-border-hairline)',
          paddingBottom: '4px',
          marginBottom: '6px',
          flexShrink: 0,
        }}
      >
        <span>{COLUMN_LABEL[col]}</span>
        <span style={{ color: 'var(--color-fg-muted)' }}>{items.length}</span>
        {/* Bulk operator-accept for REVIEW. Reuses the per-task operator path
            (onUpdateTaskStatus → task_ledger_update) one task at a time, so each
            is persisted + logged individually — no worker-settable `done`. */}
        {onMarkAllDone && items.length > 0 && (
          <button
            type="button"
            className="display-font"
            title={`Mark all ${items.length} review task${items.length === 1 ? '' : 's'} done`}
            onClick={(e) => { e.stopPropagation(); onMarkAllDone(); }}
            style={{
              marginLeft: 'auto',
              fontSize: '9px',
              letterSpacing: '0.5px',
              color: statusColor('done'),
              background: 'transparent',
              border: '1px solid currentColor',
              padding: '1px 6px',
              cursor: 'pointer',
            }}
          >
            MARK ALL DONE
          </button>
        )}
      </div>
      {/* Cards flow in a responsive grid so wide panels pack several per row and
          the narrow 1/3 default collapses to a single column. The board itself
          (parent container) owns the vertical scroll; a section grows to fit its
          cards rather than clipping them behind a per-column scrollbar. */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
          gap: '6px',
          alignContent: 'start',
        }}
      >
        {items.length === 0 && (
          <div style={{ fontSize: '11px', color: 'var(--color-fg-muted)', padding: '2px 4px 8px' }}>—</div>
        )}
        {items.map((t) => (
          <BoardCard
            key={t.id}
            task={t}
            col={col}
            selected={selectedTaskId === t.id}
            onSelect={onSelectTask}
            nameFor={nameFor}
            onQuickDone={onQuickDone}
            onRecheck={onRecheck}
          />
        ))}
      </div>
    </div>
  );
}

// §10.7 P12.4 — one draggable task card. A plain click (no 4px move) still opens
// the drawer via onSelect; a drag is picked up by the parent DndContext.
// §D3 — at-a-glance sign-off chip. Absent verdict reads as PENDING so the
// operator can see the director hasn't weighed in yet.
function signoffChip(signoff?: LedgerTask['signoff']): { label: string; color: string } {
  if (!signoff) return { label: '⋯ PENDING', color: 'var(--color-fg-muted)' };
  switch (signoff.state) {
    case 'met':     return { label: '✓ MET', color: '#58a66c' };
    case 'not_met': return { label: '✗ NOT MET', color: '#e0a030' };
    case 'partial': return { label: '~ PARTIAL', color: '#8a7cf0' };
  }
}

function BoardCard({
  task: t,
  col,
  selected,
  onSelect,
  nameFor,
  onQuickDone,
  onRecheck,
}: {
  task: WorktreeAwareLedgerTask;
  col: LedgerTaskStatus;
  selected: boolean;
  onSelect: (id: string) => void;
  nameFor: (workflowId: string) => string;
  onQuickDone?: (taskId: string) => void;
  onRecheck?: (task: WorktreeAwareLedgerTask) => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: t.id });
  const so = t.signoff;
  // Show a verdict chip wherever a sign-off exists; on REVIEW cards also show
  // PENDING when none yet, since that's where the operator awaits the director.
  const showSignoff = Boolean(so) || col === 'review';
  const chip = signoffChip(so);
  const signoffTitle = so
    ? `Director sign-off: ${so.state}${so.summary ? ` — ${so.summary}` : ''}${so.byWorkflowId ? ` (by ${nameFor(so.byWorkflowId)}, ${formatTime(so.at)})` : ''}`
    : 'No director sign-off yet';
  // A per-card click target that must not trigger the card drag or open the
  // drawer — stop pointer + click from bubbling to the draggable card button.
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  const canRecheck = Boolean(onRecheck && so?.byWorkflowId);
  return (
    <button
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      type="button"
      onClick={() => onSelect(t.id)}
      data-help="cluster.board-card"
      style={{
        width: '100%',
        textAlign: 'left',
        border: '1px solid var(--color-border-hairline)',
        borderLeft: `3px solid ${statusColor(t.status)}`,
        background: selected ? 'var(--color-accent-primary-a06)' : 'var(--color-bg-inset)',
        color: 'inherit',
        padding: '8px',
        opacity: isDragging ? 0.4 : (taskTerminal(t) ? 0.6 : 1),
        cursor: 'grab',
        display: 'block',
        touchAction: 'none',
      }}
    >
      <div
        style={{
          fontSize: '12px',
          color: 'var(--color-fg)',
          wordBreak: 'break-word',
          textDecoration: taskTerminal(t) ? 'line-through' : 'none',
        }}
      >
        {t.title}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '6px', flexWrap: 'wrap' }}>
        {showSignoff && (
          <span
            className="display-font"
            style={{
              fontSize: '9px',
              letterSpacing: '0.5px',
              color: chip.color,
              border: '1px solid currentColor',
              padding: '1px 5px',
            }}
            title={signoffTitle}
          >
            {chip.label}
          </span>
        )}
        {t.assignee ? (
          <span
            className="display-font"
            style={{
              fontSize: '9px',
              letterSpacing: 0,
              color: 'var(--color-accent-primary)',
              border: '1px solid var(--color-accent-primary)',
              padding: '1px 5px',
            }}
            title={`Claimed by ${nameFor(t.assignee)} (${t.assignee})`}
          >
            @{nameFor(t.assignee)}
          </span>
        ) : (
          <span
            className="display-font"
            style={{ fontSize: '9px', letterSpacing: '0.5px', color: 'var(--color-fg-muted)' }}
          >
            UNCLAIMED
          </span>
        )}
        {t.links.length > 0 && (
          <span
            style={{ fontSize: '9px', color: 'var(--color-fg-muted)' }}
            title={`${t.links.length} link${t.links.length === 1 ? '' : 's'}`}
          >
            🔗 {t.links.length}
          </span>
        )}
        {t.worktreeRequired && (
          <span
            className="display-font"
            style={{
              fontSize: '9px',
              letterSpacing: 0,
              color: t.worktree ? 'var(--color-accent-secondary)' : '#e0a030',
              border: '1px solid currentColor',
              padding: '1px 5px',
            }}
            title={t.worktree ? `Worktree ready: ${t.worktree.path}` : 'This task requires an isolated worktree.'}
          >
            WT REQ
          </span>
        )}
        {t.worktree && !t.worktreeRequired && (
          <span
            className="display-font"
            style={{
              fontSize: '9px',
              letterSpacing: '0.5px',
              color: 'var(--color-accent-secondary)',
              border: '1px solid currentColor',
              padding: '1px 5px',
            }}
            title={t.worktree.path}
          >
            WT
          </span>
        )}
        {(t.parentIds?.length ?? 0) > 0 && (
          <span style={{ fontSize: '9px', color: 'var(--color-fg-muted)' }} title={`${t.parentIds.length} parent task${t.parentIds.length === 1 ? '' : 's'}`}>
            P {t.parentIds.length}
          </span>
        )}
      </div>
      {/* §D3 — per-card operator actions (REVIEW column): accept without drilling
          in, or bounce the task back to the director who signed it off. Rendered
          as role=button spans (not <button>) because the card itself is a button;
          pointer/click are stopped so they neither drag the card nor open the
          drawer. */}
      {(onQuickDone || canRecheck) && (
        <div
          style={{ display: 'flex', gap: '6px', marginTop: '8px', flexWrap: 'wrap' }}
          onPointerDown={stop}
        >
          {onQuickDone && (
            <span
              role="button"
              tabIndex={0}
              className="display-font"
              title="Accept this task — mark it done."
              onPointerDown={stop}
              onClick={(e) => { stop(e); onQuickDone(t.id); }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { stop(e); e.preventDefault(); onQuickDone(t.id); } }}
              style={{
                fontSize: '9px',
                letterSpacing: '0.8px',
                color: '#58a66c',
                border: '1px solid currentColor',
                padding: '2px 8px',
                cursor: 'pointer',
              }}
            >
              ✓ DONE
            </span>
          )}
          {canRecheck && (
            <span
              role="button"
              tabIndex={0}
              className="display-font"
              title={`Ask ${so?.byWorkflowId ? nameFor(so.byWorkflowId) : 'the director'} to re-verify this task actually met its target.`}
              onPointerDown={stop}
              onClick={(e) => { stop(e); onRecheck?.(t); }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { stop(e); e.preventDefault(); onRecheck?.(t); } }}
              style={{
                fontSize: '9px',
                letterSpacing: '0.8px',
                color: 'var(--color-accent-primary)',
                border: '1px solid currentColor',
                padding: '2px 8px',
                cursor: 'pointer',
              }}
            >
              ↩ RECHECK
            </span>
          )}
        </div>
      )}
    </button>
  );
}

function smallButtonStyle(enabled: boolean): CSSProperties {
  return {
    border: '1px solid var(--color-border-hairline)',
    background: enabled ? 'var(--color-accent-primary-a06)' : 'transparent',
    color: enabled ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
    cursor: enabled ? 'pointer' : 'not-allowed',
    fontSize: '9px',
    letterSpacing: '0.7px',
    padding: '3px 7px',
    whiteSpace: 'nowrap',
  };
}

// §10.7 P12.3 — shared field-edit styling for the drawer editor (mirrors the
// DEBAG GateApprovalNotice editable-field look: inset bg, hairline border,
// accent on dirty). Inline rather than a forced shared component — the gate card
// carries gate-specific approve/reject/remember semantics that don't fit task
// authoring (see checkpoint notes).
const editLabelStyle: CSSProperties = {
  fontSize: '9px',
  letterSpacing: '0.7px',
  color: 'var(--color-fg-muted)',
  fontFamily: 'var(--font-display)',
};
const editInputStyle: CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  background: 'var(--color-bg-panel)',
  border: '1px solid var(--color-border-hairline)',
  borderRadius: '3px',
  color: 'var(--color-fg)',
  fontSize: '12px',
  fontFamily: 'var(--font-body)',
  padding: '5px 7px',
  outline: 'none',
};

function RunsView({
  taskId,
  clusterId,
  boardKey,
  requesterWorkflowId,
  runs,
  nameFor,
  onReclaimRun,
  onTerminateRun,
}: {
  taskId: string;
  clusterId: string;
  boardKey?: string;
  requesterWorkflowId: string | null;
  runs: TaskRun[];
  nameFor: (workflowId: string) => string;
  onReclaimRun?: (clusterId: string, workflowId: string, taskId: string, runId: string, boardKey?: string) => void;
  onTerminateRun?: (clusterId: string, workflowId: string, taskId: string, runId: string, boardKey?: string) => void;
}) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(id);
  }, []);

  if (runs.length === 0) {
    return <div style={{ fontSize: '11px', color: 'var(--color-fg-muted)' }}>No run records yet.</div>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      {[...runs].reverse().map((r) => {
        const open = runOpen(r);
        const heartbeatAt = runHeartbeatAt(r);
        const heartbeatAge = now - heartbeatAt;
        const stale = open && heartbeatAge >= RUN_STALE_AFTER_MS;
        const canReclaim = Boolean(stale && requesterWorkflowId && onReclaimRun);
        const canTerminate = Boolean(open && requesterWorkflowId && onTerminateRun);
        return (
        <div key={r.id} data-help="cluster.task-run-row" style={{ minWidth: 0, borderBottom: '1px solid var(--color-border-hairline)', paddingBottom: '6px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', fontSize: '10px' }}>
            <span className="display-font" style={{ color: 'var(--color-accent-primary)', letterSpacing: '0.5px' }}>
              @{nameFor(r.workflowId)}
            </span>
            <span className="display-font" style={{ color: 'var(--color-fg)', letterSpacing: '0.5px' }}>
              {r.status.toUpperCase()}
            </span>
            <RunSummaryPill label={open ? (stale ? 'STALE' : 'ACTIVE') : 'CLOSED'} value={open ? formatDuration(heartbeatAge) : formatDuration((r.endedAt ?? now) - r.startedAt)} tone={stale ? 'warn' : open ? 'active' : 'muted'} />
            <span style={{ color: 'var(--color-fg-muted)' }}>started {formatTime(r.startedAt)}</span>
          </div>
          <FieldGrid>
            <Field label="Last heartbeat" value={formatTime(r.lastHeartbeatAt)} />
            <Field label="Heartbeat age" value={open ? formatDuration(heartbeatAge) : '—'} />
            <Field label="Ended" value={formatTime(r.endedAt)} />
            <Field label="Session" value={r.sessionId ?? '—'} />
            <Field label="Worker" value={r.workerId ?? '—'} />
          </FieldGrid>
          {open && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', marginTop: '6px' }}>
              <button
                type="button"
                disabled={!canReclaim}
                onClick={() => {
                  if (!requesterWorkflowId || !onReclaimRun) return;
                  onReclaimRun(clusterId, requesterWorkflowId, taskId, r.id, boardKey);
                }}
                className="display-font"
                style={smallButtonStyle(canReclaim)}
                title={canReclaim ? 'Reclaim this stale open run so the task can be recovered.' : 'Only stale open runs can be reclaimed from this control.'}
              >
                RECLAIM
              </button>
              <button
                type="button"
                disabled={!canTerminate}
                onClick={() => {
                  if (!requesterWorkflowId || !onTerminateRun) return;
                  if (!window.confirm('Terminate this task run? This does not mark the task done.')) return;
                  onTerminateRun(clusterId, requesterWorkflowId, taskId, r.id, boardKey);
                }}
                className="display-font"
                style={smallButtonStyle(canTerminate)}
                title={canTerminate ? 'Terminate exactly this run. The task remains recoverable.' : 'Run terminate callback is not available yet.'}
              >
                TERMINATE
              </button>
            </div>
          )}
          {r.summary && <InlineBlock label="Summary" body={r.summary} />}
          {r.outcome && <InlineBlock label="Outcome" body={r.outcome} />}
          {r.error && <InlineBlock label="Error" body={r.error} />}
        </div>
        );
      })}
    </div>
  );
}

const lineStyle: CSSProperties = {
  minWidth: 0,
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  border: '1px solid var(--color-border-hairline)',
  padding: '4px 6px',
  fontSize: '11px',
  color: 'var(--color-fg)',
};
