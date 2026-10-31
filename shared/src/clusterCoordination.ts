// Shared deterministic coordination wording for worker prompts and operator nudges.
import { CLUSTER_EFFICIENCY_ADDENDUM_MAX, type ClusterEfficiencyLevel, type ClusterMessageGuard } from './protocol/clusters.js';

export const isClusterDirector = (role?: string): boolean => /^\s*(?:director|coordinator)\b/i.test(role ?? '');

/** Explain why a role list cannot be used for a new cluster. */
export function clusterDirectorProblem(roles: readonly (string | undefined)[]): string | null {
  return roles.filter(isClusterDirector).length > 1
    ? 'A cluster may have at most one director. Change one director\'s role.'
    : null;
}

export function buildClusterCoordination(level: ClusterEfficiencyLevel = 'thorough', note?: string, role?: string): string {
  const lines = [`--- Cluster efficiency: ${level.toUpperCase()} ---`];
  lines.push('Coordination style does not change message guards, required tests, safety checks, operator-requested review or landing review. Standing project rules still apply.');
  if (isClusterDirector(role)) {
    lines.push('Assign complete outcomes with exact placement, affected surfaces, invariants, dependencies and acceptance evidence. Builders own routine compatible choices within that scope. Identify unresolved blockers before full verification.');
    lines.push('Reconcile relevant tasks and new evidence; read broader history when relevant or stale. Inspect the final diff and required evidence once, then land accepted changes. Request more work only for concrete blockers or a changed relevant integration base.');
  } else {
    lines.push('Finish the assigned outcome through its required work, authorized compatible decisions and verification. Raise one actionable unresolved blocker before the full gate, or send one final evidence packet with base, candidate tree or patch, checks and remaining limits.');
  }
  if (level === 'thorough') lines.push('Include explanatory context when it helps a decision; redundant cross-review is not required.');
  else lines.push('Group related work into coherent outcomes. Avoid acknowledgment and status-ping loops, duplicate verification and unnecessary handoffs. Do not reopen successful work without concrete contradictory findings.');
  if (level === 'lean') lines.push('Keep optional narration and peer messages brief. Brevity never removes required checks, review or evidence.');
  const addendum = (note ?? '').trim().slice(0, CLUSTER_EFFICIENCY_ADDENDUM_MAX);
  if (addendum) lines.push(`Operator NOTE (appended instruction, not a mode or budget): ${addendum}`);
  return lines.join('\n\n');
}

export const PEER_SEND_GUARD_DESCRIPTION = 'The independent message guard is Warn only, Hard limit or No limit. The current effective guard is in your cluster policy; successful sends return its count and threshold/remaining allowance. Warn only accepts sends above its threshold with one warning per primary turn; Hard limit rejects undelivered sends at the cap. No limit removes only the peer-send quota, not automatic-execution or provider limits. Counts span all recipients, reset at each primary_turn_started and are process-local (not persisted across restart). Failed/refused sends refund the count. Consolidate related information for the same recipient. Rejected mail was not delivered; do not start turns to evade a guard.';

export function buildMessageGuardPolicy(guard: ClusterMessageGuard): string {
  const effective = guard.mode === 'none' ? 'No limit (no peer-send quota)' : `${guard.mode === 'warn' ? 'Warn only' : 'Hard limit'}: ${guard.threshold} messages per sender per primary turn`;
  return `--- Cluster message guard ---\n${effective}.\n${PEER_SEND_GUARD_DESCRIPTION}`;
}

function mailAction(level: ClusterEfficiencyLevel, role?: string): string {
  const action = isClusterDirector(role) ? 'Delegate concrete implementation findings and keep the affected task current; perform the required landing review.' : 'Act on actionable assignments or concrete findings within your assigned scope.';
  const common = `${action} Reopen completed work only for concrete contradictory evidence. Preserve required tests and review.`;
  return level === 'thorough' ? `${common} Include useful context, without redundant cross-review.` : `${common} Send one actionable blocker or final evidence packet; avoid acknowledgment and status-ping loops.`;
}
export function buildClusterNudge(level: ClusterEfficiencyLevel = 'thorough', active = false, role?: string): string {
  return active
    ? `(nudge) You are currently working. At a convenient point, check pending peer mail without interrupting current work, then continue your assignment. ${mailAction(level, role)}`
    : `(nudge) Read pending peer messages and act on their contents. ${mailAction(level, role)}`;
}
export function buildClusterMailboxNotice(level: ClusterEfficiencyLevel = 'thorough', depth: number, role?: string): string {
  return `--- PEER MAILBOX ---\nYou have ${depth} pending peer message${depth === 1 ? '' : 's'}. Read them with peer_read. ${mailAction(level, role)}`;
}
export function buildClusterAutoPickup(level: ClusterEfficiencyLevel = 'thorough', role?: string): string {
  return `(auto-pickup) Peer mail arrived while idle. Read your mailbox. ${mailAction(level, role)}`;
}
