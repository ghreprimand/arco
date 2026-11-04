// Pure Needs-you counting and board accept/clutter helpers (no React).
// Covered by scripts/smoke/task-board.ts and unit-style asserts there.

import type { LedgerTask, TaskSignoff } from '@arco/shared';

export const REVIEW_OLDER_MS = 7 * 24 * 60 * 60 * 1000;

/** Blocked reasons that ask the operator (not a peer) for a decision. */
const OPERATOR_BLOCKED =
  /\b(operator|human|you\b|your\s+(?:decision|input|approval|go)|needs?\s+(?:you|operator|human)|awaiting\s+(?:you|operator)|approve|accept|confirm)\b/i;

export type NeedsYouKind = 'review' | 'blocked' | 'question';

export interface NeedsYouItem {
  kind: NeedsYouKind;
  id: string;
  title: string;
  detail?: string;
  taskId?: string;
  workflowId?: string;
}

export function isOperatorBlockedReason(reason: string | undefined | null): boolean {
  return Boolean(reason && OPERATOR_BLOCKED.test(reason.trim()));
}

export function reviewNeedsOperator(task: Pick<LedgerTask, 'status' | 'signoff'>): boolean {
  return task.status === 'review' && Boolean(task.signoff);
}

export function blockedNeedsOperator(task: Pick<LedgerTask, 'status' | 'blockedReason'>): boolean {
  return task.status === 'blocked' && isOperatorBlockedReason(task.blockedReason);
}

/** Git-ish hashes named in free text (notes, sign-off summary, comments). */
export function namedCommitsInText(text: string | undefined | null): string[] {
  if (!text) return [];
  const found = text.match(/\b[0-9a-f]{7,40}\b/gi) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const h of found) {
    const key = h.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}

export function namedCommitsForTask(task: Pick<LedgerTask, 'notes' | 'signoff'>): string[] {
  return namedCommitsInText([task.notes ?? '', task.signoff?.summary ?? ''].join('\n'));
}

export function reviewTasksWithMetSignoff(tasks: readonly LedgerTask[]): LedgerTask[] {
  return tasks.filter((t) => t.status === 'review' && t.signoff?.state === 'met');
}

export function reviewAgeMs(task: Pick<LedgerTask, 'signoff' | 'updatedAt'>, now = Date.now()): number {
  const at = task.signoff?.at ?? task.updatedAt;
  return Math.max(0, now - at);
}

export function splitRecentAndOlderReview(
  tasks: readonly LedgerTask[],
  now = Date.now(),
  olderMs = REVIEW_OLDER_MS,
): { recent: LedgerTask[]; older: LedgerTask[] } {
  const recent: LedgerTask[] = [];
  const older: LedgerTask[] = [];
  for (const t of tasks) {
    if (t.status !== 'review') continue;
    if (reviewAgeMs(t, now) > olderMs) older.push(t);
    else recent.push(t);
  }
  return { recent, older };
}

export const BOARD_SHOW_DONE_KEY = 'arco.board.showDone';

// SHOW DONE is on unless the operator turned it off; the choice is stored only once changed.
export function readBoardShowDone(storage?: Pick<Storage, 'getItem'>): boolean {
  try { return (storage ?? localStorage).getItem(BOARD_SHOW_DONE_KEY) !== '0'; } catch { return true; }
}

// Release filter values: null shows every task, NO_RELEASE the unlabeled ones,
// any other string that label.
export const NO_RELEASE = '\u0000none';

export function releaseLabels(tasks: readonly LedgerTask[]): string[] {
  const labels = new Set<string>();
  for (const t of tasks) if (t.release) labels.add(t.release);
  return [...labels].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
}

export function filterVisibleBoardTasks(
  tasks: readonly LedgerTask[],
  opts: { showDone: boolean; release?: string | null },
): LedgerTask[] {
  let list = opts.showDone ? [...tasks] : tasks.filter((t) => t.status !== 'done' && t.status !== 'archived');
  if (opts.release === NO_RELEASE) list = list.filter((t) => !t.release);
  else if (typeof opts.release === 'string' && opts.release) list = list.filter((t) => t.release === opts.release);
  return list;
}

// "Ready to release" counts for one label: how many tasks are in it, how many
// the operator accepted (done), and how many are left (not done, not archived).
export function releaseSummary(tasks: readonly LedgerTask[], release: string): { total: number; accepted: number; left: number } {
  let total = 0, accepted = 0, left = 0;
  for (const t of tasks) {
    if (t.release !== release || t.status === 'archived') continue;
    total++;
    if (t.status === 'done') accepted++;
    else left++;
  }
  return { total, accepted, left };
}

export function buildNeedsYouItems(input: {
  tasks: readonly LedgerTask[];
  waitingQuestions: readonly { workflowId: string; displayName: string; label?: string }[];
}): NeedsYouItem[] {
  const items: NeedsYouItem[] = [];
  for (const t of input.tasks) {
    if (reviewNeedsOperator(t)) {
      const so = t.signoff as TaskSignoff;
      items.push({
        kind: 'review',
        id: `review:${t.id}`,
        title: t.title,
        detail: `${so.state}${so.summary ? `: ${so.summary}` : ''}`,
        taskId: t.id,
      });
    } else if (blockedNeedsOperator(t)) {
      items.push({
        kind: 'blocked',
        id: `blocked:${t.id}`,
        title: t.title,
        detail: t.blockedReason || undefined,
        taskId: t.id,
      });
    }
  }
  for (const q of input.waitingQuestions) {
    items.push({
      kind: 'question',
      id: `question:${q.workflowId}`,
      title: q.displayName,
      detail: q.label || 'Waiting question',
      workflowId: q.workflowId,
    });
  }
  return items;
}

export function needsYouLabel(count: number): string {
  return `${count} NEED YOU`;
}
