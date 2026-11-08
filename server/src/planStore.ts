import { openCheckedFile, readCheckedText, atomicCheckedWriteFile as atomicWriteFile } from './checkedFile.js';
import { managedPath, projectDocumentPath } from './managedPath.js';
import { ensureProjectStateIgnore } from './projectStateIgnore.js';
// Plan store — long-form markdown briefs that workflows can attach to.
//
// Layout under <cwd>/.arco/plans/:
//   - index.json     → { plans: [{ id, title, createdAt, updatedAt }] }
//   - <planId>.md    → markdown body
//   - <planId>.refs/<slug>.md → reference docs for that plan (directory-
//     listed, no index entry — an agent can add one with plain file tools)
//
// Multiple plans per cwd. Workflows attach by id (meta.planId); attachment
// is explicit, not derived from cwd, so the same folder can host independent
// projects. Atomic-write pattern matches workflowMeta.ts.

import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type { PlanSummary, PlanFull, PlanRefSummary, PlanRefFull } from '@arco/shared';
import { withFileLock } from './atomicFile.js';

const PLAN_ID_PATTERN = /^[a-zA-Z0-9-]{1,64}$/;
const TITLE_MAX = 200;
const BODY_MAX = 256 * 1024; // 256 KB — generous for long-form briefs

function plansDir(cwd: string): string {
  return projectDocumentPath(cwd, 'plans');
}

function indexPath(cwd: string): string {
  return projectDocumentPath(cwd, 'plans', 'index.json');
}

function bodyPath(cwd: string, planId: string): string {
  return projectDocumentPath(cwd, 'plans', `${planId}.md`);
}

export function isValidPlanId(id: string): boolean {
  return PLAN_ID_PATTERN.test(id);
}

// Reference docs. The `.refs` suffix keeps the dir name from ever matching
// the plans watcher's `<planId>.md` filter, and the watcher is non-recursive,
// so ref writes never trigger a plan reconcile.
const REF_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const REF_BODY_MAX = 256 * 1024;
export const REF_COUNT_MAX = 64;

export function isValidRefSlug(slug: string): boolean {
  return REF_SLUG_PATTERN.test(slug);
}

export function planRefsDir(cwd: string, planId: string): string {
  return projectDocumentPath(cwd, 'plans', `${planId}.refs`);
}

function refPath(cwd: string, planId: string, slug: string): string {
  return projectDocumentPath(cwd, 'plans', `${planId}.refs`, `${slug}.md`);
}

interface PlanIndex {
  plans: PlanSummary[];
}

async function readIndex(cwd: string): Promise<PlanIndex> {
  try {
    const raw = await readCheckedText(indexPath(cwd));
    const parsed = JSON.parse(raw) as PlanIndex;
    if (!parsed || !Array.isArray(parsed.plans)) return { plans: [] };
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { plans: [] };
    throw err;
  }
}

// index.json is read-modify-written by every mutator below, from the REST
// routes, the plans-dir watcher (reconcilePlanFile), tab close
// (closeOpenSpansForWorkflow) and genesis — concurrently. Without the lock a
// watcher reconcile racing an attach wrote back its stale copy and dropped
// the attachment span (or a freshly created plan). Keyed per cwd's index
// path; not re-entrant, and no mutator holds two cwds' locks at once.
function withIndexLock<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  ensureProjectStateIgnore(cwd);
  return withFileLock(indexPath(cwd), fn);
}

async function writeIndex(cwd: string, idx: PlanIndex): Promise<void> {
  await atomicWriteFile(indexPath(cwd), JSON.stringify(idx, null, 2) + '\n');
}

export async function listPlans(cwd: string): Promise<PlanSummary[]> {
  if (!cwd) return [];
  const { plans } = await readIndex(cwd);
  // Most-recently-updated first; matches the Resume picker's "what was I
  // working on" intent.
  return [...plans].sort((a, b) => b.updatedAt - a.updatedAt);
}

// Cache only counts, never authorization: each lookup still resolves the
// managed path, pins the ordinary file, and checks its current identity.
const taskCounts = new Map<string, { signature: string; count: number }>();
export async function listPlansWithTaskCounts(cwd: string): Promise<PlanSummary[]> {
  const plans = await listPlans(cwd);
  if (!plans.length) return plans;
  const directory = plansDir(cwd);
  const result: PlanSummary[] = [];
  for (const plan of plans) {
    let taskCount: number | null = null;
    if (isValidPlanId(plan.id)) {
      try {
        const file = managedPath(directory, `${plan.id}.md`);
        const handle = await openCheckedFile(file);
        try {
          const stat = await handle.stat();
          const signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
          const cached = taskCounts.get(file);
          taskCount = cached?.signature === signature ? cached.count
            : (await handle.readFile('utf8')).split('\n').filter(line => /^\s*-\s+\[[ xX]\]\s+/.test(line)).length;
          taskCounts.set(file, { signature, count: taskCount });
          if (taskCounts.size > 512) taskCounts.delete(taskCounts.keys().next().value!);
        } finally { await handle.close(); }
      } catch { /* Missing or unsafe bodies remain unavailable for counting. */ }
    }
    result.push({ ...plan, taskCount });
  }
  return result;
}

export async function readPlan(cwd: string, planId: string): Promise<PlanFull | null> {
  if (!cwd || !isValidPlanId(planId)) return null;
  const { plans } = await readIndex(cwd);
  const summary = plans.find((p) => p.id === planId);
  if (!summary) return null;
  let body: string;
  try {
    body = await readCheckedText(bodyPath(cwd, planId));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  return { ...summary, body };
}

export async function readPlanSummary(cwd: string, planId: string): Promise<PlanSummary | null> {
  if (!cwd || !isValidPlanId(planId)) return null;
  const { plans } = await readIndex(cwd);
  return plans.find((p) => p.id === planId) ?? null;
}

export async function createPlan(
  cwd: string,
  input: { title: string; body: string },
): Promise<PlanFull> {
  if (!cwd) throw new Error('createPlan: cwd required');
  const title = (input.title ?? '').trim().slice(0, TITLE_MAX) || 'Untitled plan';
  const body = (input.body ?? '').slice(0, BODY_MAX);
  const id = randomUUID();
  const now = Date.now();
  const summary: PlanSummary = { id, title, createdAt: now, updatedAt: now, attachments: [], completedAt: null };
  return withIndexLock(cwd, async () => {
    const idx = await readIndex(cwd);
    idx.plans.push(summary);
    await atomicWriteFile(bodyPath(cwd, id), body);
    await writeIndex(cwd, idx);
    return { ...summary, body };
  });
}

export type PlanPatch = { title?: string; body?: string; completedAt?: number | null };
export class PlanConflictError extends Error {
  constructor() { super('The plan changed since it was displayed. Reload it before saving again.'); }
}

export async function updatePlan(
  cwd: string,
  planId: string,
  input: PlanPatch | ((current: PlanFull) => PlanPatch),
  opts: { expectedBody?: string } = {},
): Promise<PlanFull | null> {
  if (!cwd || !isValidPlanId(planId)) return null;
  return withIndexLock(cwd, async () => {
    const idx = await readIndex(cwd);
    const i = idx.plans.findIndex((p) => p.id === planId);
    if (i === -1) return null;
    let currentBody: string | undefined;
    if (typeof input === 'function' || opts.expectedBody !== undefined) {
      currentBody = await readCheckedText(bodyPath(cwd, planId));
      if (opts.expectedBody !== undefined && currentBody !== opts.expectedBody) throw new PlanConflictError();
    }
    // Callbacks run under the canonical index lock and must not call another
    // plan mutator. They derive their patch from the version being saved.
    const patch = typeof input === 'function' ? input({ ...idx.plans[i], body: currentBody! }) : input;
    const now = Date.now();
    let nextTitle = idx.plans[i].title;
    if (typeof patch.title === 'string') {
      nextTitle = patch.title.trim().slice(0, TITLE_MAX) || idx.plans[i].title;
    }
    let nextBody: string;
    if (typeof patch.body === 'string') {
      nextBody = patch.body.slice(0, BODY_MAX);
      await atomicWriteFile(bodyPath(cwd, planId), nextBody);
    } else {
      try {
        nextBody = await readCheckedText(bodyPath(cwd, planId));
      } catch {
        nextBody = '';
      }
    }
    idx.plans[i] = { ...idx.plans[i], title: nextTitle, updatedAt: now };
    if (patch.completedAt !== undefined) {
      idx.plans[i].completedAt = patch.completedAt;
    }
    await writeIndex(cwd, idx);
    return { ...idx.plans[i], body: nextBody };
  });
}

// Reference documents of a plan as one comparable value (names and contents).
async function refsSnapshot(cwd: string, planId: string): Promise<string> {
  const dir = planRefsDir(cwd, planId);
  let names: string[];
  try { names = (await fs.readdir(dir)).sort(); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '[]'; throw err; }
  const out: Array<[string, string | null]> = [];
  for (const name of names) {
    let content: string | null = null;
    const file = managedPath(dir, name);
    try { content = await readCheckedText(file); } catch { /* not a readable file */ }
    out.push([name, content]);
  }
  return JSON.stringify(out);
}

async function checkRefsTree(cwd: string, planId: string): Promise<void> {
  const root = planRefsDir(cwd, planId);
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const file = managedPath(root, path.relative(root, dir), entry.name);
      if (entry.isDirectory()) await walk(file);
    }
  };
  await walk(root);
}

// The target's reference documents become a copy of the source's.
async function copyRefs(sourceCwd: string, targetCwd: string, planId: string): Promise<void> {
  await checkRefsTree(sourceCwd, planId);
  await fs.rm(planRefsDir(targetCwd, planId), { recursive: true, force: true });
  try {
    await fs.cp(planRefsDir(sourceCwd, planId), planRefsDir(targetCwd, planId), { recursive: true, force: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

const MOVE_ATTEMPTS = 3;

// Move a plan from one cwd to another. Writes the target first (atomic
// safety — if the second step fails we still have the source intact),
// then drops the source. The plan id stays the same; UUIDs make collision
// risk effectively zero, but we still guard against it (an operator can
// have manually copied a plan id between projects). Attachments are NOT
// carried over — the source attachments record workflows in the source cwd
// which won't apply at the destination. Caller is responsible for detaching
// workflows in the source cwd after success (broadcasts plan_detached) and for
// setting watcher skip-flags on both cwds.
//
// The source is removed only while it still matches what the target holds
// (text, title, done state and reference documents), checked under the
// source's index lock, which plan and reference-document writes also take.
// An edit saved in between is copied to the target and checked again; after
// MOVE_ATTEMPTS changing rounds the move stops, the source keeps everything
// and the target copy is removed.
export async function movePlan(
  sourceCwd: string,
  planId: string,
  targetCwd: string,
): Promise<{ ok: true; plan: PlanFull } | { ok: false; error: string }> {
  if (!sourceCwd || !targetCwd) return { ok: false, error: 'sourceCwd and targetCwd required' };
  if (!isValidPlanId(planId)) return { ok: false, error: 'invalid plan id' };
  if (sourceCwd === targetCwd) return { ok: false, error: 'source and target must differ' };
  await checkRefsTree(sourceCwd, planId);
  let source = await readPlan(sourceCwd, planId);
  if (!source) return { ok: false, error: 'source plan not found' };
  const movedSummary: PlanSummary = {
    id: source.id,
    title: source.title,
    createdAt: source.createdAt,
    updatedAt: Date.now(),
    attachments: [],
    completedAt: source.completedAt ?? null,
  };
  // Separate critical sections (target, then source) — never both locks at
  // once, so an A→B move racing a B→A move can't deadlock.
  const collided = await withIndexLock(targetCwd, async () => {
    const targetIdx = await readIndex(targetCwd);
    if (targetIdx.plans.some((p) => p.id === planId)) return true;
    // Write target body + index first; if either fails the source is untouched.
    await atomicWriteFile(bodyPath(targetCwd, planId), source!.body);
    targetIdx.plans.push(movedSummary);
    await writeIndex(targetCwd, targetIdx);
    return false;
  });
  if (collided) return { ok: false, error: 'target already has a plan with this id' };
  for (let attempt = 1; ; attempt++) {
    // Refs travel with the plan. Copied before the source is dropped so a
    // failure leaves the source complete.
    await copyRefs(sourceCwd, targetCwd, planId);
    const targetRefs = await refsSnapshot(targetCwd, planId);
    const copied: PlanFull = source;
    // Source removal. If this errors we've duplicated the plan (target now
    // has it, source still has it). Caller can retry the delete by reissuing
    // the move; the target-already-has-this-id guard above will refuse, so
    // the operator gets a clear error and can deletePlan() the source manually.
    const changed = await withIndexLock(sourceCwd, async () => {
      const now = await readPlan(sourceCwd, planId);
      if (now && (now.body !== copied.body || now.title !== copied.title || (now.completedAt ?? null) !== (copied.completedAt ?? null)
        || await refsSnapshot(sourceCwd, planId) !== targetRefs)) return now;
      const sourceIdx = await readIndex(sourceCwd);
      sourceIdx.plans = sourceIdx.plans.filter((p) => p.id !== planId);
      await writeIndex(sourceCwd, sourceIdx);
      try { await fs.unlink(bodyPath(sourceCwd, planId)); } catch { /* ENOENT */ }
      await fs.rm(planRefsDir(sourceCwd, planId), { recursive: true, force: true }).catch(() => { /* best-effort */ });
      return null;
    });
    if (!changed) return { ok: true, plan: { ...movedSummary, title: copied.title, completedAt: copied.completedAt ?? null, body: copied.body } };
    if (attempt >= MOVE_ATTEMPTS) {
      // Undo the copy only while it is still exactly what MOVE wrote.
      await withIndexLock(targetCwd, async () => {
        const mine = await readPlan(targetCwd, planId);
        if (!mine || mine.body !== copied.body || await refsSnapshot(targetCwd, planId) !== targetRefs) return;
        const targetIdx = await readIndex(targetCwd);
        targetIdx.plans = targetIdx.plans.filter((p) => p.id !== planId);
        await writeIndex(targetCwd, targetIdx);
        try { await fs.unlink(bodyPath(targetCwd, planId)); } catch { /* ENOENT */ }
        await fs.rm(planRefsDir(targetCwd, planId), { recursive: true, force: true }).catch(() => { /* best-effort */ });
      });
      return { ok: false, error: 'the plan kept changing during the move; it stays in the source project, try MOVE again' };
    }
    // An edit landed after the copy: bring the target up to date and check again.
    source = changed;
    const latest = changed;
    await withIndexLock(targetCwd, async () => {
      const targetIdx = await readIndex(targetCwd);
      const i = targetIdx.plans.findIndex((p) => p.id === planId);
      if (i === -1) return;
      await atomicWriteFile(bodyPath(targetCwd, planId), latest.body);
      targetIdx.plans[i] = { ...targetIdx.plans[i], title: latest.title, completedAt: latest.completedAt ?? null, updatedAt: Date.now() };
      await writeIndex(targetCwd, targetIdx);
    });
  }
}

// Hard-delete: drop the plan from the index and remove its body file.
// Caller is responsible for detaching workflows beforehand (so observers
// see plan_detached) and for setting the watcher skip-flag if applicable.
export async function deletePlan(cwd: string, planId: string): Promise<boolean> {
  if (!cwd || !isValidPlanId(planId)) return false;
  return withIndexLock(cwd, async () => {
    const idx = await readIndex(cwd);
    const i = idx.plans.findIndex((p) => p.id === planId);
    if (i === -1) return false;
    idx.plans.splice(i, 1);
    await writeIndex(cwd, idx);
    try { await fs.unlink(bodyPath(cwd, planId)); } catch { /* ENOENT — already gone */ }
    await fs.rm(planRefsDir(cwd, planId), { recursive: true, force: true }).catch(() => { /* best-effort */ });
    return true;
  });
}

// Append an open attachment span (workflow → plan) to the plan's history.
// Idempotent: if an open span already exists for this (planId, workflowId)
// pair we leave it alone so a rehydrate doesn't double-record. Returns the
// updated PlanSummary, or null when the plan id wasn't found.
export async function recordAttachment(
  cwd: string,
  planId: string,
  workflowId: string,
  workflowName: string,
): Promise<PlanSummary | null> {
  if (!cwd || !isValidPlanId(planId)) return null;
  return withIndexLock(cwd, async () => {
    const idx = await readIndex(cwd);
    const i = idx.plans.findIndex((p) => p.id === planId);
    if (i === -1) return null;
    const plan = idx.plans[i];
    plan.attachments = plan.attachments ?? [];
    const open = plan.attachments.find((a) => a.workflowId === workflowId && a.detachedAt === null);
    if (open) return plan;
    plan.attachments.push({
      workflowId,
      workflowName,
      attachedAt: Date.now(),
      detachedAt: null,
    });
    await writeIndex(cwd, idx);
    return plan;
  });
}

// Close any open span for (planId, workflowId). No-op when none is open
// (e.g. the operator detached and then closed the tab; the close path also
// fires this and finds nothing to do).
export async function recordDetachment(
  cwd: string,
  planId: string,
  workflowId: string,
): Promise<void> {
  if (!cwd || !isValidPlanId(planId)) return;
  return withIndexLock(cwd, async () => {
    const idx = await readIndex(cwd);
    const plan = idx.plans.find((p) => p.id === planId);
    if (!plan?.attachments) return;
    const open = plan.attachments.find((a) => a.workflowId === workflowId && a.detachedAt === null);
    if (!open) return;
    open.detachedAt = Date.now();
    await writeIndex(cwd, idx);
  });
}

// Workflow-level cleanup: when the operator closes a tab, every plan in this
// cwd that still shows the workflow as actively attached gets stamped with a
// detach timestamp. The span sticks around in "previously attached" for
// archival; the next operator-driven re-attach (re-opening the same workflow)
// will append a fresh open span via recordAttachment.
export async function closeOpenSpansForWorkflow(
  cwd: string,
  workflowId: string,
): Promise<void> {
  if (!cwd) return;
  return withIndexLock(cwd, async () => {
    const idx = await readIndex(cwd);
    const now = Date.now();
    let changed = false;
    for (const plan of idx.plans) {
      if (!plan.attachments) continue;
      for (const span of plan.attachments) {
        if (span.workflowId === workflowId && span.detachedAt === null) {
          span.detachedAt = now;
          changed = true;
        }
      }
    }
    if (changed) await writeIndex(cwd, idx);
  });
}

// Pick the first markdown H1 ("# Title") line out of a body, if any.
// Used to title agent-created plan files that bypass the REST POST path.
function extractTitleFromBody(body: string): string {
  const m = body.match(/^\s*#\s+(.+?)\s*$/m);
  if (!m) return '';
  return m[1].trim().slice(0, TITLE_MAX);
}

// Watcher-driven reconcile: a `.md` file under `.arco/plans/` changed on
// disk (most often because the agent edited it with its native file tools).
// Fold the change into index.json so the per-turn header + UI list pick it
// up. Cases:
//   - file missing  → drop the entry from the index, signal deletion
//   - file present, no entry  → seed a new entry (agent-created plan)
//   - file present, entry exists  → bump updatedAt; do NOT clobber the
//     operator-set title from the entry — the agent edits the body, the
//     operator owns the title via the UI/PATCH path.
export type ReconcileResult =
  | { kind: 'updated'; summary: PlanSummary }
  | { kind: 'deleted' }
  | { kind: 'noop' };

export async function reconcilePlanFile(cwd: string, planId: string): Promise<ReconcileResult> {
  if (!cwd || !isValidPlanId(planId)) return { kind: 'noop' };
  return withIndexLock(cwd, async () => {
    let body: string | null = null;
    try {
      body = await readCheckedText(bodyPath(cwd, planId));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const idx = await readIndex(cwd);
    const i = idx.plans.findIndex((p) => p.id === planId);
    if (body === null) {
      if (i === -1) return { kind: 'noop' };
      idx.plans.splice(i, 1);
      await writeIndex(cwd, idx);
      return { kind: 'deleted' };
    }
    const now = Date.now();
    if (i === -1) {
      const titleFromBody = extractTitleFromBody(body);
      const summary: PlanSummary = {
        id: planId,
        title: titleFromBody || `Plan ${planId.slice(0, 8)}`,
        createdAt: now,
        updatedAt: now,
        attachments: [],
      };
      idx.plans.push(summary);
      await writeIndex(cwd, idx);
      return { kind: 'updated', summary };
    }
    idx.plans[i] = { ...idx.plans[i], updatedAt: now };
    await writeIndex(cwd, idx);
    return { kind: 'updated', summary: idx.plans[i] };
  });
}

// ── Reference docs ──

export async function listPlanRefs(cwd: string, planId: string): Promise<PlanRefSummary[]> {
  if (!cwd || !isValidPlanId(planId)) return [];
  let names: string[];
  try {
    names = await fs.readdir(planRefsDir(cwd, planId));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: PlanRefSummary[] = [];
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    const slug = name.slice(0, -3);
    // Agent-written files with a non-conforming name are skipped rather than
    // surfaced — every ref must be addressable by `ref:<slug>`.
    if (!isValidRefSlug(slug)) continue;
    try {
      const p = refPath(cwd, planId, slug);
      const st = await fs.stat(p);
      if (!st.isFile()) continue;
      // Title from the head only — a 256 KB ref shouldn't be read to list it.
      const fh = await openCheckedFile(p);
      let head = '';
      try {
        const buf = Buffer.alloc(Math.min(st.size, 4096));
        await fh.read(buf, 0, buf.length, 0);
        head = buf.toString('utf8');
      } finally {
        await fh.close();
      }
      out.push({ slug, title: extractTitleFromBody(head) || slug, bytes: st.size, updatedAt: Math.round(st.mtimeMs) });
    } catch { /* raced a delete */ }
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

export async function readPlanRef(cwd: string, planId: string, slug: string): Promise<PlanRefFull | null> {
  if (!cwd || !isValidPlanId(planId) || !isValidRefSlug(slug)) return null;
  try {
    const p = refPath(cwd, planId, slug);
    const [body, st] = await Promise.all([readCheckedText(p), fs.stat(p)]);
    return { slug, title: extractTitleFromBody(body) || slug, bytes: st.size, updatedAt: Math.round(st.mtimeMs), body };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export type WritePlanRefResult =
  | { ok: true; ref: PlanRefSummary; created: boolean }
  | { ok: false; error: string };

// Create or replace. Refuses (rather than truncating, as plan bodies do) an
// over-cap body: a silently clipped spec is worse than an error the agent can
// act on by splitting the doc.
export async function writePlanRef(
  cwd: string, planId: string, slug: string,
  input: string | ((current: string | null) => string),
  opts: { createOnly?: boolean } = {},
): Promise<WritePlanRefResult> {
  if (!cwd || !isValidPlanId(planId)) return { ok: false, error: 'invalid plan id' };
  if (!isValidRefSlug(slug)) return { ok: false, error: 'invalid slug - use lowercase letters, digits, and dashes (max 64)' };
  return withIndexLock(cwd, async (): Promise<WritePlanRefResult> => {
    if (!(await readPlanSummary(cwd, planId))) return { ok: false, error: 'plan not found' };
    const body = typeof input === 'function' ? input((await readPlanRef(cwd, planId, slug))?.body ?? null) : input;
    if (Buffer.byteLength(body, 'utf8') > REF_BODY_MAX) return { ok: false, error: `ref body exceeds ${REF_BODY_MAX} bytes - split it into several refs` };
    const existing = await listPlanRefs(cwd, planId);
    const created = !existing.some((r) => r.slug === slug);
    if (opts.createOnly && !created) return { ok: false, error: 'ref already exists' };
    if (created && existing.length >= REF_COUNT_MAX) return { ok: false, error: `plan already has ${REF_COUNT_MAX} refs` };
    const file = refPath(cwd, planId, slug);
    if (opts.createOnly) {
      const temp = `${file}.create-${randomUUID()}`;
      try {
        await atomicWriteFile(temp, body);
        // Link the completed file exclusively. Existing files and links are
        // refused even if an unreadable ref was absent from the listing.
        await fs.link(temp, file);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') return { ok: false, error: 'ref already exists' };
        throw err;
      } finally { await fs.rm(temp, { force: true }).catch(() => undefined); }
    } else await atomicWriteFile(file, body);
    const st = await fs.stat(file);
    return { ok: true, created, ref: { slug, title: extractTitleFromBody(body.slice(0, 4096)) || slug, bytes: st.size, updatedAt: Math.round(st.mtimeMs) } };
  });
}

export async function deletePlanRef(cwd: string, planId: string, slug: string): Promise<boolean> {
  if (!cwd || !isValidPlanId(planId) || !isValidRefSlug(slug)) return false;
  return withIndexLock(cwd, async () => {
    try {
      await fs.unlink(refPath(cwd, planId, slug));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  });
}

// Bump the plan's updatedAt without touching its body — a ref change is a
// plan change for every observer (Plan tabs refetch on updatedAt).
export async function touchPlan(cwd: string, planId: string): Promise<PlanSummary | null> {
  if (!cwd || !isValidPlanId(planId)) return null;
  return withIndexLock(cwd, async () => {
    const idx = await readIndex(cwd);
    const i = idx.plans.findIndex((p) => p.id === planId);
    if (i === -1) return null;
    idx.plans[i] = { ...idx.plans[i], updatedAt: Date.now() };
    await writeIndex(cwd, idx);
    return idx.plans[i];
  });
}
