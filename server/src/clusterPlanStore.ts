// CLUSTER_MODE_PLAN.md Phase 2.6 — shared cluster plan store.
//
// One markdown document per cluster, persisted at
// ~/.arco/clusters/<id>/plan.md. Every cluster member's Native worker
// reads the body via handleUserMessage at turn start and injects it as a
// forced system block (after FORCED_FIRST_BLOCK, before the operator's
// appendSystemPrompt / systemPrompt).
//
// Empty file ≡ no plan attached. Hard cap PLAN_MAX_BYTES (32768) enforced
// at write time — the server rejects oversize cluster_plan_set bodies
// upfront so steady-state context cost is bounded. 8 KB was too tight for
// non-trivial multi-phase plans; per-turn cost stays bounded because the
// plan body lands inside the Anthropic prompt-cache window (CLUSTER_MODE_PLAN
// §13 2026-05-11).
//
// Atomic writes via proper-lockfile (mirror clusterStore's meta.json
// pattern). In-memory cache by clusterId so per-turn reads don't hit disk.

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { clusterDir } from './clusterStore.js';
import { atomicWriteFile } from './atomicFile.js';

export const PLAN_MAX_BYTES = 32768;
export const PLAN_SOFT_WARN_BYTES = 28672;

export interface PlanRecord {
  body: string;
  updatedAt: number;
}

const cache = new Map<string, PlanRecord>();

function planPath(clusterId: string): string {
  return join(clusterDir(clusterId), 'plan.md');
}

function planMetaPath(clusterId: string): string {
  return join(clusterDir(clusterId), 'plan.meta.json');
}

export class PlanTooLargeError extends Error {
  readonly limit = PLAN_MAX_BYTES;
  readonly actual: number;
  constructor(actual: number) {
    super(`cluster plan exceeds ${PLAN_MAX_BYTES} chars (got ${actual})`);
    this.actual = actual;
  }
}

// Read the current plan body for a cluster. Returns null when no plan
// has been attached (file absent or empty). Cached in-memory; the cache
// is populated lazily on first read and invalidated by writePlan /
// clearPlan.
export async function readPlan(clusterId: string): Promise<PlanRecord | null> {
  const hit = cache.get(clusterId);
  if (hit) return hit;
  let body = '';
  try {
    body = await fs.readFile(planPath(clusterId), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  if (body.length === 0) return null;
  let updatedAt = Date.now();
  try {
    const meta = await fs.readFile(planMetaPath(clusterId), 'utf8');
    const parsed = JSON.parse(meta) as { updatedAt?: number };
    if (typeof parsed.updatedAt === 'number') updatedAt = parsed.updatedAt;
  } catch { /* meta absent → use now() */ }
  const rec: PlanRecord = { body, updatedAt };
  cache.set(clusterId, rec);
  return rec;
}

// Synchronous variant for buildClusterStatePayload hot-path use after a
// read has populated the cache. Returns null if not cached.
export function peekPlan(clusterId: string): PlanRecord | null {
  return cache.get(clusterId) ?? null;
}

// Write a new plan body. Empty / whitespace bodies are rejected — callers
// should use clearPlan() to wipe instead. Returns the new record on
// success; throws PlanTooLargeError when over PLAN_MAX_BYTES.
export async function writePlan(clusterId: string, body: string): Promise<PlanRecord> {
  if (body.length > PLAN_MAX_BYTES) throw new PlanTooLargeError(body.length);
  if (body.trim().length === 0) {
    throw new Error('cluster plan body cannot be empty (use clearPlan to wipe)');
  }
  await fs.mkdir(clusterDir(clusterId), { recursive: true });
  const filePath = planPath(clusterId);
  try { await fs.access(filePath); }
  catch { await fs.writeFile(filePath, ''); }
  const release = await lockfile.lock(filePath, { retries: { retries: 5, minTimeout: 25, maxTimeout: 250 } });
  const updatedAt = Date.now();
  try {
    // Atomic per file. The PAIR is not atomic — a crash between the two can
    // leave a new body with a stale `updatedAt` — but neither file can be
    // truncated, which is what a plain writeFile risked. Body first so a
    // half-applied pair errs toward "content newer than its timestamp"
    // rather than a timestamp pointing at a body that was never written.
    await atomicWriteFile(filePath, body);
    await atomicWriteFile(planMetaPath(clusterId), JSON.stringify({ updatedAt }, null, 2));
  } finally {
    await release();
  }
  const rec: PlanRecord = { body, updatedAt };
  cache.set(clusterId, rec);
  return rec;
}

// Wipe a cluster's plan. Removes plan.md + plan.meta.json from disk; the
// next readPlan() returns null. No-op when no plan was attached.
export async function clearPlan(clusterId: string): Promise<void> {
  cache.delete(clusterId);
  await fs.rm(planPath(clusterId), { force: true });
  await fs.rm(planMetaPath(clusterId), { force: true });
}

// Test/debug surface only. Drops the in-memory cache for a cluster so a
// subsequent readPlan() hits disk again. Used by deleteCluster() in
// clusterStore.ts — when the cluster directory is removed wholesale, the
// in-memory plan cache needs to drop with it.
export function dropCache(clusterId: string): void {
  cache.delete(clusterId);
}

// CLUSTER_MODE_PLAN.md — peer tool `cluster_plan_tick`.
//
// Toggle a single `- [ ]` / `- [x]` checkbox at `lineIndex` (0-based against
// the rendered plan body). No structural edits — flips just the bracket
// content on that one line. Persists via writePlan() so the disk write +
// cache invalidation + atomic lock match the operator-side path; callers
// then re-emit cluster_plan_changed so subscribers re-render.
//
// Return shape carries `toggledLine`, `before`, `after`, plus the new full
// body so the caller can broadcast it without re-reading.
//
// Errors are returned as discriminated unions (not thrown) so the peer-tool
// dispatcher can map them to the documented `out_of_range` /
// `not_a_checkbox_line` / `no_plan` codes without exception plumbing.
const CHECKBOX_RE = /^(\s*[-*]\s+)\[( |x|X)\](.*)$/;

export interface PlanCheckboxItem {
  lineIndex: number;
  text: string;
  normalizedText: string;
  checked: boolean;
}

export interface PlanWritePreservationViolation {
  removed: string[];
  statusChanged: Array<{ text: string; before: '[ ]' | '[x]'; after: '[ ]' | '[x]' }>;
}

export type PlanWritePreservationResult =
  | { ok: true }
  | { ok: false; violation: PlanWritePreservationViolation };

function normalizeCheckboxText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

export function extractPlanCheckboxItems(body: string): PlanCheckboxItem[] {
  const items: PlanCheckboxItem[] = [];
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = CHECKBOX_RE.exec(lines[i]);
    if (!m) continue;
    const text = m[3].trim();
    const normalizedText = normalizeCheckboxText(text);
    if (!normalizedText) continue;
    items.push({
      lineIndex: i,
      text,
      normalizedText,
      checked: m[2] === 'x' || m[2] === 'X',
    });
  }
  return items;
}

// Model-authored cluster_plan_write is additive by default: it may append
// sections/items and reorganize prose, but it must not delete existing
// checkbox tasks or change their completion state. Status changes go
// through cluster_plan_tick so they remain narrow and auditable; destructive
// plan replacement stays operator-only via the PLAN tab.
export function validatePlanWritePreservesCheckboxes(
  existingBody: string,
  nextBody: string,
): PlanWritePreservationResult {
  const existing = extractPlanCheckboxItems(existingBody);
  if (existing.length === 0) return { ok: true };

  const next = extractPlanCheckboxItems(nextBody);
  const nextByText = new Map<string, PlanCheckboxItem[]>();
  for (const item of next) {
    const bucket = nextByText.get(item.normalizedText) ?? [];
    bucket.push(item);
    nextByText.set(item.normalizedText, bucket);
  }

  const usedNext = new Set<PlanCheckboxItem>();
  const removed: string[] = [];
  const statusChanged: Array<{ text: string; before: '[ ]' | '[x]'; after: '[ ]' | '[x]' }> = [];

  for (const oldItem of existing) {
    const candidates = nextByText.get(oldItem.normalizedText) ?? [];
    const sameStatus = candidates.find((candidate) => candidate.checked === oldItem.checked && !usedNext.has(candidate));
    if (sameStatus) {
      usedNext.add(sameStatus);
      continue;
    }

    const oppositeStatus = candidates.find((candidate) => candidate.checked !== oldItem.checked && !usedNext.has(candidate));
    if (oppositeStatus) {
      usedNext.add(oppositeStatus);
      statusChanged.push({
        text: oldItem.text,
        before: oldItem.checked ? '[x]' : '[ ]',
        after: oppositeStatus.checked ? '[x]' : '[ ]',
      });
      continue;
    }

    removed.push(oldItem.text);
  }

  if (removed.length === 0 && statusChanged.length === 0) return { ok: true };
  return { ok: false, violation: { removed, statusChanged } };
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
  const rec = await readPlan(clusterId);
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
  const newBody = lines.join('\n');
  const writeRec = await writePlan(clusterId, newBody);
  return {
    ok: true,
    toggledLine: lineIndex,
    before,
    after,
    body: writeRec.body,
    updatedAt: writeRec.updatedAt,
  };
}

// Resolve a fuzzy taskText match to a unique line index. Case-insensitive
// substring against the post-checkbox content. Returns the line index on
// unique match; otherwise a discriminated rejection.
export type PlanTaskResolution =
  | { ok: true; lineIndex: number }
  | { ok: false; code: 'no_plan' | 'task_not_found' | 'ambiguous_task'; message: string; matches?: number[] };

export async function resolvePlanTask(clusterId: string, taskText: string): Promise<PlanTaskResolution> {
  const rec = await readPlan(clusterId);
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
