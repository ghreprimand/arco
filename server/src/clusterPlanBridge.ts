// Unified cluster-plan bridge.
//
// Clusters attach exactly one active plan, just like workflows. The body is
// canonical under <cwd>/.arco/plans/<planId>.md; cluster meta.json stores
// only planId. Older clusters wrote ~/.arco/clusters/<id>/plan.md, so reads
// lazily migrate that legacy body into the canonical per-cwd plan store.

import * as clusterStore from './clusterStore.js';
import * as legacyClusterPlanStore from './clusterPlanStore.js';
import {
  createPlan,
  readPlan,
  readPlanSummary,
  updatePlan,
} from './planStore.js';
import type { PlanFull } from '@arco/shared';
import { withFileLock } from './atomicFile.js';

export const PLAN_MAX_BYTES = legacyClusterPlanStore.PLAN_MAX_BYTES;
export const PLAN_SOFT_WARN_BYTES = legacyClusterPlanStore.PLAN_SOFT_WARN_BYTES;

export class PlanTooLargeError extends Error {
  readonly limit = PLAN_MAX_BYTES;
  readonly actual: number;
  constructor(actual: number) {
    super(`cluster plan exceeds ${PLAN_MAX_BYTES} chars (got ${actual})`);
    this.actual = actual;
  }
}

export interface ClusterPlanRecord {
  planId: string;
  title: string;
  body: string;
  updatedAt: number;
}

const CHECKBOX_RE = /^(\s*[-*]\s+)\[( |x|X)\](.*)$/;

function titleFromBody(body: string, fallback: string): string {
  const h1 = body.match(/^\s*#\s+(.+?)\s*$/m);
  if (h1) return h1[1].trim().slice(0, 80) || fallback;
  const first = body.split('\n').map((l) => l.trim()).find(Boolean);
  return (first ? first.slice(0, 80) : fallback) || 'Cluster plan';
}

function toRecord(plan: PlanFull): ClusterPlanRecord {
  return {
    planId: plan.id,
    title: plan.title,
    body: plan.body,
    updatedAt: plan.updatedAt,
  };
}

function assertBodyWritable(body: string): void {
  if (body.length > PLAN_MAX_BYTES) throw new PlanTooLargeError(body.length);
  if (body.trim().length === 0) {
    throw new Error('cluster plan body cannot be empty (use clearPlan to detach)');
  }
}

// Per-cluster serialization of every plan-bridge op that can create, attach, or
// rewrite the cluster's plan. Two members hitting setClusterPlanBody with no
// plan attached both saw "no plan", both createPlan'd, and the later setPlanId
// orphaned the first plan file; two togglePlanItem calls each rewrote the
// body from the same snapshot and one tick vanished. Public entry points take
// the lock; the *Unlocked twins are for use from inside it (withFileLock is
// not re-entrant).
function withClusterPlanLock<T>(clusterId: string, fn: () => Promise<T>): Promise<T> {
  return withFileLock(`cluster-plan:${clusterId}`, fn);
}

export async function readClusterPlan(clusterId: string): Promise<ClusterPlanRecord | null> {
  // Locked: the legacy-migration branch creates a plan + setPlanId.
  return withClusterPlanLock(clusterId, () => readClusterPlanUnlocked(clusterId));
}

async function readClusterPlanUnlocked(clusterId: string): Promise<ClusterPlanRecord | null> {
  const state = await clusterStore.readCluster(clusterId);
  if (!state) return null;

  if (state.planId) {
    const plan = await readPlan(state.cwd, state.planId);
    if (plan) return toRecord(plan);
    await clusterStore.clearPlanId(clusterId).catch(() => null);
  }

  const legacy = await legacyClusterPlanStore.readPlan(clusterId).catch(() => null);
  if (!legacy) return null;

  const title = titleFromBody(legacy.body, state.name ?? `Cluster ${clusterId.slice(0, 8)} plan`);
  const created = await createPlan(state.cwd, { title, body: legacy.body });
  await clusterStore.setPlanId(clusterId, created.id);
  await legacyClusterPlanStore.clearPlan(clusterId).catch(() => undefined);
  return toRecord(created);
}

export async function attachExistingPlan(clusterId: string, planId: string): Promise<ClusterPlanRecord | null> {
  return withClusterPlanLock(clusterId, async () => {
    const state = await clusterStore.readCluster(clusterId);
    if (!state) return null;
    const plan = await readPlan(state.cwd, planId);
    if (!plan) return null;
    if (plan.body.length > PLAN_MAX_BYTES) throw new PlanTooLargeError(plan.body.length);
    await clusterStore.setPlanId(clusterId, plan.id);
    return toRecord(plan);
  });
}

export async function setClusterPlanBody(clusterId: string, body: string): Promise<ClusterPlanRecord | null> {
  return withClusterPlanLock(clusterId, () => setClusterPlanBodyUnlocked(clusterId, body));
}

async function setClusterPlanBodyUnlocked(clusterId: string, body: string): Promise<ClusterPlanRecord | null> {
  assertBodyWritable(body);
  const state = await clusterStore.readCluster(clusterId);
  if (!state) return null;

  const existing = await readClusterPlanUnlocked(clusterId);
  if (existing) {
    const updated = await updatePlan(state.cwd, existing.planId, { body });
    return updated ? toRecord(updated) : null;
  }

  const title = titleFromBody(body, state.name ?? `Cluster ${clusterId.slice(0, 8)} plan`);
  const created = await createPlan(state.cwd, { title, body });
  await clusterStore.setPlanId(clusterId, created.id);
  return toRecord(created);
}

export async function clearClusterPlan(clusterId: string): Promise<void> {
  await withClusterPlanLock(clusterId, async () => {
    await clusterStore.clearPlanId(clusterId);
    await legacyClusterPlanStore.clearPlan(clusterId).catch(() => undefined);
  });
}

export type PlanTickResult =
  | {
      ok: true;
      toggledLine: number;
      before: '[ ]' | '[x]';
      after: '[ ]' | '[x]';
      body: string;
      updatedAt: number;
    }
  | { ok: false; code: 'no_plan' | 'out_of_range' | 'not_a_checkbox_line'; message: string };

export async function togglePlanItem(clusterId: string, lineIndex: number): Promise<PlanTickResult> {
  // Whole read→flip→write under the lock so concurrent ticks don't clobber.
  return withClusterPlanLock(clusterId, () => togglePlanItemUnlocked(clusterId, lineIndex));
}

async function togglePlanItemUnlocked(clusterId: string, lineIndex: number): Promise<PlanTickResult> {
  const rec = await readClusterPlanUnlocked(clusterId);
  if (!rec) {
    return { ok: false, code: 'no_plan', message: 'no cluster plan is attached; nothing to toggle.' };
  }
  const lines = rec.body.split('\n');
  if (!Number.isInteger(lineIndex) || lineIndex < 0 || lineIndex >= lines.length) {
    return {
      ok: false,
      code: 'out_of_range',
      message: `lineIndex ${lineIndex} is out of range (plan has ${lines.length} lines, 0-based).`,
    };
  }
  const target = lines[lineIndex];
  const m = CHECKBOX_RE.exec(target);
  if (!m) {
    return {
      ok: false,
      code: 'not_a_checkbox_line',
      message: `line ${lineIndex} is not a checkbox line (no leading "- [ ]" / "- [x]").`,
    };
  }
  const prefix = m[1];
  const wasChecked = m[2] === 'x' || m[2] === 'X';
  const rest = m[3];
  const before: '[ ]' | '[x]' = wasChecked ? '[x]' : '[ ]';
  const after: '[ ]' | '[x]' = wasChecked ? '[ ]' : '[x]';
  lines[lineIndex] = `${prefix}${after}${rest}`;
  const updated = await setClusterPlanBodyUnlocked(clusterId, lines.join('\n'));
  if (!updated) return { ok: false, code: 'no_plan', message: 'cluster disappeared while updating plan.' };
  return {
    ok: true,
    toggledLine: lineIndex,
    before,
    after,
    body: updated.body,
    updatedAt: updated.updatedAt,
  };
}

export type PlanTaskResolution =
  | { ok: true; lineIndex: number }
  | { ok: false; code: 'no_plan' | 'task_not_found' | 'ambiguous_task'; message: string; matches?: number[] };

export async function resolvePlanTask(clusterId: string, taskText: string): Promise<PlanTaskResolution> {
  const rec = await readClusterPlan(clusterId);
  if (!rec) {
    return { ok: false, code: 'no_plan', message: 'no cluster plan is attached; nothing to match against.' };
  }
  const needle = taskText.trim().toLowerCase();
  if (needle.length === 0) {
    return { ok: false, code: 'task_not_found', message: 'taskText is empty after trim.' };
  }
  const lines = rec.body.split('\n');
  const hits: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = CHECKBOX_RE.exec(lines[i]);
    if (!m) continue;
    const taskBody = m[3].toLowerCase();
    if (taskBody.includes(needle)) hits.push(i);
  }
  if (hits.length === 0) {
    return { ok: false, code: 'task_not_found', message: `no checkbox line matches "${taskText.slice(0, 80)}".` };
  }
  if (hits.length > 1) {
    return {
      ok: false,
      code: 'ambiguous_task',
      message: `"${taskText.slice(0, 80)}" matches ${hits.length} checkbox lines (${hits.join(', ')}); narrow the substring.`,
      matches: hits,
    };
  }
  return { ok: true, lineIndex: hits[0] };
}

export async function planExistsForClusterCwd(clusterId: string, planId: string): Promise<boolean> {
  const state = await clusterStore.readCluster(clusterId);
  if (!state) return false;
  return (await readPlanSummary(state.cwd, planId)) !== null;
}
