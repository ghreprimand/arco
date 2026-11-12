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
  lines.push('Efficiency guides coordination and testing. Message guards, safety checks, operator-requested review and landing review stay unchanged.');
  lines.push('Before sending, check that the message gives the recipient something to act on or something it is waiting for. A closing note to a member whose work is finished (landed, thanks, nothing further) does neither; record it on the board instead.');
  lines.push("When a report states the sender's next step, no reply approves it; reply only to change that step, answer a question, or assign other work. Reports that continue on their own end with their next step.");
  lines.push('Do not wait inside a turn for long-running checks: never sleep or poll for more than 60 seconds at a time. Start long runs in the background or hand them off, report what is running, and end the turn.');
  if (isClusterDirector(role)) {
    lines.push('Assign complete outcomes with exact placement, affected surfaces, constraints and dependencies. Builders own routine compatible choices within that scope. Ask them to say what was done, what was run and what is not covered.');
    lines.push('Reconcile relevant tasks and new findings; read broader history when relevant or stale. Read the final diff and check that the project-required checks were run, then land accepted changes. Request more work only for concrete blockers or a changed relevant integration base.');
  } else {
    lines.push('Finish the assigned outcome and make authorized compatible decisions. Report one actionable unresolved blocker, or say what was done, what was run and what is not covered.');
  }
  if (level === 'thorough') lines.push('Include explanatory context when it helps a decision; redundant cross-review is not required.');
  else lines.push('Group related work into coherent outcomes. Avoid acknowledgment and status-ping loops, duplicate verification and unnecessary handoffs. Do not reopen successful work without concrete contradictory findings.');
  if (level === 'lean') lines.push('Keep optional narration and peer messages brief. Safety checks, operator-requested review and landing review still apply.');
  const proportion = 'Before a failure holds work up, say whether it is a fault in the product or in the test, and what a user would lose if it were real; fix the product fault, or fix or delete the faulty test, and note cosmetic or momentary faults and carry on.';
  if (level === 'lean') lines.push(`Testing: run only the tests for what you changed. Add a test only for a fault that was actually found. Do not run the full check or add suites, gates or CI checks unless the operator asks. ${proportion}`);
  else if (level === 'thorough') lines.push(`Testing: test new behaviour and each fault you fix, run the neighbouring tests, and run the full check before handing work over. Ask the operator before adding new suites, gates or CI checks. ${proportion}`);
  else lines.push(`Testing: add one test for each real fault you fix, at the level where it appeared. Prefer the lowest-level test that would catch the fault; use a browser or end-to-end test only for a user journey that needs a real screen, one per journey, not one per layout, theme or size. Run the tests for the area you changed; run the project's full check once before a release, not for each change. Do not add test matrices unless the operator asks. Ask the operator, with the operator-question tool where the cluster has it, before adding a suite, a gate, test tooling or a CI check. ${proportion} Keep the project's full check to about ten minutes; if it is longer, tell the operator and propose what to cut before adding tests. A flaky test is fixed or deleted, not retried.`);
  lines.push("The operator's own project rules or plan take precedence when they ask for more or less testing.");
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
  const common = `${action} Reopen completed work only for concrete contradictory evidence. Follow the cluster testing directive and the project rules; keep safety checks and requested review.`;
  return level === 'thorough' ? `${common} Include useful context, without redundant cross-review.` : `${common} Send one actionable blocker or a final summary of what was done, run and not covered; avoid acknowledgment and status-ping loops.`;
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
