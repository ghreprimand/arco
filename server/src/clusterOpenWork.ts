// Director open-work block: a short, bounded view of the cluster's own task
// board added to each Director turn, so a turn that answers a question still
// sees which tasks wait on the operator, which are blocked and who owns what
// is in flight. It rides with the Director's instructions, so it carries only
// values Arco generates (task ids, member workflow ids, states and counts) and
// never member-written text such as titles, names or blocked reasons; the
// Director reads those with cluster_task_show, where they arrive as tool
// output. Read-only and per cluster; it never wakes anyone. See
// docs/PROTOCOL_CLUSTER.md "Director roles and work size".

import { isOperatorBlockedReason, type LedgerTask } from '@arco/shared';

export const OPEN_WORK_MAX_BYTES = 2048;

const HEADER = '--- Open work on the board ---';
const GUIDE = 'Task ids by state, from this cluster\'s board. Titles, owners\' names and blocked reasons are not shown here: read them with cluster_task_show <id>.';

// Ids are server-generated UUIDs; anything else is left out rather than echoed.
const SAFE_ID = /^[0-9A-Za-z-]{1,64}$/;

/** Unread peer mail per member and whether AUTO-PICKUP wakes idle members.
 * Arco-generated counts and states only. */
export interface OpenWorkMail {
  members: Array<{ workflowId: string; unread: number; busy?: boolean }>;
  autoPickupWakes: boolean;
}

/** Build the block from a cluster board and mail state. Undefined when
 * nothing is open and no member has unread mail. */
export function buildDirectorOpenWork(tasks: readonly LedgerTask[], mail?: OpenWorkMail, maxBytes = OPEN_WORK_MAX_BYTES): string | undefined {
  const newest = tasks.filter((t) => SAFE_ID.test(t.id)).sort((a, b) => b.updatedAt - a.updatedAt);
  const owner = (t: LedgerTask) => (t.assignee && SAFE_ID.test(t.assignee) ? ` owner ${t.assignee}` : ' no owner');
  const line = (t: LedgerTask) => `- ${t.id}${owner(t)}`;

  const unread = (mail?.members ?? [])
    .filter((m) => SAFE_ID.test(m.workflowId) && Number.isInteger(m.unread) && m.unread > 0)
    .map((m) => `- ${m.workflowId} ${m.unread} unread, ${m.busy === undefined ? 'state unknown' : m.busy ? 'working' : 'idle'}`);
  const sections: Array<{ title: string; lines: string[] }> = [
    { title: 'Waiting on the operator', lines: newest.filter((t) => t.status === 'blocked' && isOperatorBlockedReason(t.blockedReason)).map(line) },
    { title: 'Unread peer mail', lines: unread },
    { title: 'Blocked on others', lines: newest.filter((t) => t.status === 'blocked' && !isOperatorBlockedReason(t.blockedReason)).map(line) },
    { title: 'In progress', lines: newest.filter((t) => t.status === 'in_progress').map(line) },
    { title: 'In review', lines: newest.filter((t) => t.status === 'review').map(line) },
  ];
  const notStarted = newest.filter((t) => t.status === 'triage' || t.status === 'todo' || t.status === 'ready').length;
  if (sections.every((s) => s.lines.length === 0) && notStarted === 0) return undefined;

  // Lines are dropped from the end (lowest section, oldest first) until the
  // block fits; the operator section comes first so it is the last to go.
  let omitted = 0;
  const render = () => {
    const out = [HEADER, GUIDE];
    if (mail) out.push(mail.autoPickupWakes
      ? 'AUTO-PICKUP is on: it may wake an idle member when mail reaches it, but its limits or its evaluator can hold a wake back.'
      : 'AUTO-PICKUP is off or paused: an idle member, including one you send mail to in this turn, wakes only when the operator nudges it.');
    for (const s of sections) if (s.lines.length > 0) out.push(`${s.title}:`, ...s.lines);
    if (notStarted > 0) out.push(`Not started: ${notStarted} task${notStarted === 1 ? '' : 's'} (backlog; new work waits for the operator's approval).`);
    if (omitted > 0) out.push(`${omitted} more not shown; call cluster_task_list.`);
    return out.join('\n');
  };
  let text = render();
  while (Buffer.byteLength(text, 'utf8') > maxBytes) {
    const last = [...sections].reverse().find((s) => s.lines.length > 0);
    if (!last) break;
    last.lines.pop();
    omitted++;
    text = render();
  }
  return text;
}
