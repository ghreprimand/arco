// Process-local per-sender counts. The existing primary-turn lifecycle resets
// these counters; failed/refused sends refund their reservation.
import type { ClusterMessageGuard } from '@arco/shared';
export const SEND_BUDGET_PER_TURN = 15;
const counters = new Map<string, number>();
const warned = new Set<string>();
export interface BudgetDecision {
  allowed: boolean;
  count: number;
  cap: number | null;
  mode: ClusterMessageGuard['mode'];
  threshold: number | null;
  remaining: number | null;
}
function decision(count: number, value: number | ClusterMessageGuard): BudgetDecision {
  const g = typeof value === 'number' ? { mode: 'hard' as const, threshold: value } : value;
  const cap = g.mode === 'hard' ? g.threshold : null;
  return { allowed: cap === null || count <= cap, count, cap, mode: g.mode,
    threshold: g.mode === 'none' ? null : g.threshold, remaining: cap === null ? null : Math.max(0, cap - count) };
}
export function recordSend(sender: string, guard: number | ClusterMessageGuard = SEND_BUDGET_PER_TURN): BudgetDecision {
  const count = (counters.get(sender) ?? 0) + 1;
  counters.set(sender, count);
  return decision(count, guard);
}
// Only claim a warning after enqueue succeeds. Failed sends cannot consume it.
export function takeWarning(sender: string, guard: ClusterMessageGuard, sentCount = counters.get(sender) ?? 0): boolean {
  if (guard.mode !== 'warn' || sentCount <= guard.threshold || warned.has(sender)) return false;
  warned.add(sender);
  return true;
}
export function refund(sender: string): void {
  const count = counters.get(sender) ?? 0;
  if (count <= 1) counters.delete(sender); else counters.set(sender, count - 1);
}
export function reset(sender: string): void { counters.delete(sender); warned.delete(sender); }
export const dropMember = reset;
export function peek(sender: string, guard: number | ClusterMessageGuard = SEND_BUDGET_PER_TURN): BudgetDecision {
  const result = decision(counters.get(sender) ?? 0, guard);
  return { ...result, allowed: result.cap === null || result.count < result.cap };
}
