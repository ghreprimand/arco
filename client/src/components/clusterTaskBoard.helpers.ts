// docs/ARCHITECTURE.md - pure board-grouping helper.
//
// Split out of ClusterTaskBoardTab.tsx so the headless smoke
// (scripts/smoke/task-board.ts) can import + assert the bucketing without
// dragging React / Zustand / the whole client store into a node context.

import type { ClusterMember, LedgerTask, LedgerTaskStatus, TaskDetails } from '@arco/shared';

// Column order for the kanban view.
export const BOARD_COLUMNS: LedgerTaskStatus[] = [
  'triage',
  'todo',
  'ready',
  'in_progress',
  'blocked',
  'review',
  'done',
  'archived',
];

// Bucket a flat task list into the kanban columns, preserving input order
// within each bucket. Unknown statuses are dropped (defensive — the enum is
// closed, but a corrupt snapshot shouldn't crash the board).
export function groupByStatus(tasks: LedgerTask[]): Record<LedgerTaskStatus, LedgerTask[]> {
  const out: Record<LedgerTaskStatus, LedgerTask[]> = {
    triage: [],
    todo: [],
    ready: [],
    in_progress: [],
    blocked: [],
    review: [],
    done: [],
    archived: [],
  };
  for (const t of tasks) {
    if (out[t.status]) out[t.status].push(t);
  }
  return out;
}

export function taskShowWorkflowId(members: Pick<ClusterMember, 'workflowId'>[]): string | null {
  return members[0]?.workflowId ?? null;
}

export function taskGraphSummary(details: Pick<TaskDetails, 'parents' | 'children'> | null | undefined): {
  parentCount: number;
  childCount: number;
  blockedParentCount: number;
  openChildCount: number;
} {
  const parents = details?.parents ?? [];
  const children = details?.children ?? [];
  return {
    parentCount: parents.length,
    childCount: children.length,
    blockedParentCount: parents.filter((t) => t.status === 'blocked').length,
    openChildCount: children.filter((t) => t.status !== 'done' && t.status !== 'archived').length,
  };
}
