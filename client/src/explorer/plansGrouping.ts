import type { PlanLibraryEntry } from '@arco/shared';

export function probablyFinished(plan: PlanLibraryEntry, now = Date.now()): boolean {
  return !plan.attached && plan.completedAt == null &&
    ((Boolean(plan.checkboxTotal) && plan.checkboxTotal === plan.checkboxDone) || now - plan.updatedAt >= 30 * 86400000);
}

export function foldVersions(plans: PlanLibraryEntry[]): PlanLibraryEntry[][] {
  const groups = new Map<string, PlanLibraryEntry[]>();
  for (const plan of plans) {
    const key = plan.title.trim().toLocaleLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), plan]);
  }
  return [...groups.values()];
}
