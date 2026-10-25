// CLUSTER_MODE_PLAN.md Phase 1 — per-sender-per-turn send budget.
//
// Counts outbound peer.send calls from each member during the current
// operator turn. Reset on `primary_turn_started` for that member (called
// from seedWorker.runPrimaryTurn). Default hard cap matches plan §4 — 15
// sends per sender per turn. Violations emit a tool error visible to the
// model AND a peer_send_rejected event in events.jsonl (plan §6.2 — no
// silent budget violations).
//
// 2026-06-15 — the cap is now a per-call argument so the per-cluster
// efficiency level can tighten it (clusterEfficiency.sendBudgetFor: thorough
// 15 / balanced 8 / lean 4). The caller (clusterPeerOps.peerSend) resolves
// the sender's cluster level and passes the cap; the default keeps the
// historical 15 for any caller that doesn't (and for non-cluster paths).

export const SEND_BUDGET_PER_TURN = 15;

const counters = new Map<string, number>();

export interface BudgetDecision {
  allowed: boolean;
  count: number;
  cap: number;
}

export function recordSend(senderWfId: string, cap: number = SEND_BUDGET_PER_TURN): BudgetDecision {
  const next = (counters.get(senderWfId) ?? 0) + 1;
  counters.set(senderWfId, next);
  return { allowed: next <= cap, count: next, cap };
}

// Undo one recordSend — peerSend charges up front (so concurrent sends can't
// overshoot the cap) and refunds when the send then fails or is refused, so a
// failed send never burns budget. Floors at zero.
export function refund(senderWfId: string): void {
  const n = counters.get(senderWfId) ?? 0;
  if (n <= 1) counters.delete(senderWfId);
  else counters.set(senderWfId, n - 1);
}

export function reset(senderWfId: string): void {
  counters.delete(senderWfId);
}

// Drop all per-workflow state for a removed workflow (the counter otherwise
// lives until the next primary_turn_started, which a closed tab never has).
export function dropMember(workflowId: string): void {
  counters.delete(workflowId);
}

export function peek(senderWfId: string, cap: number = SEND_BUDGET_PER_TURN): BudgetDecision {
  const count = counters.get(senderWfId) ?? 0;
  return { allowed: count < cap, count, cap };
}
