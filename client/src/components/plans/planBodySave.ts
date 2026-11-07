import type { PlanFull } from '@arco/shared';

export class PlanBodySaveError extends Error {
  constructor(message: string, readonly plan?: PlanFull) { super(message); }
}

// The body displayed by the control is a compare-and-swap precondition,
// not permission to replace a later accepted edit.
export async function updatePlanBody(cwd: string, planId: string, expectedBody: string, body: string): Promise<PlanFull> {
  const query = new URLSearchParams({ path: cwd, planId });
  const response = await fetch(`/api/plans?${query}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body, expectedBody }),
  });
  const result = await response.json() as { plan?: PlanFull; error?: string };
  if (!response.ok || !result.plan) throw new PlanBodySaveError(result.error ?? `Could not save the plan (HTTP ${response.status}).`, result.plan);
  return result.plan;
}
