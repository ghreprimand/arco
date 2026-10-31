// Project task ledger - docs/ARCHITECTURE.md.
//
// A durable, cwd-scoped task list at <cwd>/.arco/project/tasks.json. The JSON
// is a *rebuildable projection over events.jsonl*, NOT the source of truth
// (Appendix B): every mutation appends a `task_ledger_event` to the originating
// workflow's events.jsonl (the durable log) AND atomically rewrites this
// snapshot. On normal boot we load the snapshot; on parse failure / missing
// file we fall back to rebuildFromEvents(), folding every workflow's
// task_ledger_event under the cwd.
//
// Storage sits behind load() / save() / query() so a JSON→SQLite swap is a
// one-file change (the migration trigger — >~a few thousand rows or full-text
// need — is documented in docs/TASK_LEDGER.md, not assumed). The working set is
// small + single-writer, so query() is load-all + filter-in-JS.
//
// LOAD-BEARING INVARIANT (§D1 acceptance): there is NO code path that sets
// status: 'done' except an explicit operator-originated update (applyUpdate
// below). create() never accepts a status; rebuildFromEvents only replays
// recorded operator events; there is no auto-done / no inference anywhere.

import { promises as fs, existsSync } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type {
  LedgerTask,
  LedgerTaskStatus,
  TaskLink,
  TaskSignoff,
  TaskSignoffState,
  TaskWorktree,
  TaskLedgerEventMessage,
  TaskKernelSnapshot,
  TaskComment,
  TaskRun,
  TaskDetails,
  TaskBoardKey,
} from '@arco/shared';
import { replayEvents } from '../workflowStore.js';
import { listWorkflowMetas } from '../workflowMeta.js';
import { atomicWriteFile } from '../atomicFile.js';

const TITLE_MAX = 500;
const NOTES_MAX = 16 * 1024;
const COMMENT_MAX = 32 * 1024;
const TASK_KERNEL_VERSION = 1;
const VALID_STATUS: ReadonlySet<LedgerTaskStatus> = new Set([
  'triage',
  'todo',
  'ready',
  'in_progress',
  'blocked',
  'review',
  'done',
  'archived',
]);

function projectDir(cwd: string): string {
  return path.join(cwd, '.arco', 'project');
}

function sanitizeBoardKey(boardKey?: TaskBoardKey): string | undefined {
  if (typeof boardKey !== 'string') return undefined;
  const trimmed = boardKey.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 160);
}

export function taskBoardStoreKey(cwd: string, boardKey?: TaskBoardKey): string {
  const key = sanitizeBoardKey(boardKey);
  return key ? `${cwd}::${key}` : cwd;
}

// Board directory names must be valid on every platform. A sanitized key may
// contain ':' (cluster boards use `cluster:<id>`), which Windows rejects in a
// path segment, so ':' maps to '~' (never present in a sanitized key, so the
// mapping stays one-to-one). A board written before this mapping on Linux or
// macOS keeps its existing `boards/<key>` directory instead of being orphaned.
export function taskBoardDirName(key: string): string {
  return key.replace(/:/g, '~');
}

function tasksPath(cwd: string, boardKey?: TaskBoardKey): string {
  const key = sanitizeBoardKey(boardKey);
  if (!key) return path.join(projectDir(cwd), 'tasks.json');
  const boards = path.join(projectDir(cwd), 'boards');
  const portable = path.join(boards, taskBoardDirName(key), 'tasks.json');
  if (process.platform !== 'win32' && key.includes(':') && !existsSync(portable)) {
    const legacy = path.join(boards, key, 'tasks.json');
    if (existsSync(legacy)) return legacy;
  }
  return portable;
}

type LegacyTasksFile = { tasks: unknown[] };
type TaskKernelFile = TaskKernelSnapshot | LegacyTasksFile;

interface TaskKernelState {
  tasks: LedgerTask[];
  comments: TaskComment[];
  runs: TaskRun[];
}

function sanitizeLinks(links: unknown): TaskLink[] {
  if (!Array.isArray(links)) return [];
  const out: TaskLink[] = [];
  for (const l of links) {
    if (!l || typeof l !== 'object') continue;
    const kind = (l as { kind?: unknown }).kind;
    const ref = (l as { ref?: unknown }).ref;
    if (
      (kind === 'plan' || kind === 'review' || kind === 'workflow' || kind === 'url')
      && typeof ref === 'string'
    ) {
      const label = (l as { label?: unknown }).label;
      out.push({ kind, ref, ...(typeof label === 'string' ? { label } : {}) });
    }
  }
  return out;
}

// §D3 — assignee is an OPTIONAL field (claimant workflowId). We normalize to a
// `{ assignee }` spread or `{}` so callers can splice it onto a task without a
// stray `assignee: undefined` key. Empty / non-string → unclaimed (omit the
// field). isLedgerTask deliberately does NOT require it — pre-D3 snapshots have
// no assignee and must still load.
function sanitizeAssignee(v: unknown): { assignee: string } | Record<string, never> {
  return typeof v === 'string' && v.trim().length > 0 ? { assignee: v } : {};
}

const SIGNOFF_STATES: ReadonlySet<TaskSignoffState> = new Set(['met', 'not_met', 'partial']);
const SIGNOFF_SUMMARY_MAX = 1000;

// §D3 — validate a sign-off verdict from disk or a peer-tool. Returns a clean
// TaskSignoff or null (drop the field). `byWorkflowId`/`at` are caller-stamped;
// we keep them if present and well-typed.
function sanitizeSignoff(v: unknown): TaskSignoff | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.state !== 'string' || !SIGNOFF_STATES.has(o.state as TaskSignoffState)) return null;
  const out: TaskSignoff = {
    state: o.state as TaskSignoffState,
    at: typeof o.at === 'number' && Number.isFinite(o.at) ? o.at : Date.now(),
  };
  if (typeof o.summary === 'string' && o.summary.trim().length > 0) {
    out.summary = o.summary.trim().slice(0, SIGNOFF_SUMMARY_MAX);
  }
  if (typeof o.byWorkflowId === 'string' && o.byWorkflowId.trim().length > 0) {
    out.byWorkflowId = o.byWorkflowId.trim();
  }
  return out;
}

function sanitizeParentIds(parentIds: unknown): string[] {
  if (!Array.isArray(parentIds)) return [];
  return [...new Set(parentIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0))]
    .map((id) => id.trim());
}

function sanitizePriority(priority: unknown): number {
  return typeof priority === 'number' && Number.isFinite(priority) ? Math.trunc(priority) : 0;
}

function sanitizeGoalMaxTurns(value: unknown): { goalMaxTurns: number } | Record<string, never> {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? { goalMaxTurns: Math.trunc(value) }
    : {};
}

function sanitizeRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isLedgerTask(t: unknown): t is LedgerTask {
  if (!t || typeof t !== 'object') return false;
  const o = t as Record<string, unknown>;
  return (
    typeof o.id === 'string'
    && typeof o.title === 'string'
    && typeof o.status === 'string'
    && VALID_STATUS.has(o.status as LedgerTaskStatus)
    && typeof o.createdAt === 'number'
    && typeof o.updatedAt === 'number'
  );
}

function normalizeTask(task: LedgerTask): LedgerTask {
  const raw = task as LedgerTask & Record<string, unknown>;
  const next: LedgerTask = {
    ...task,
    status: VALID_STATUS.has(task.status) ? task.status : 'todo',
    links: sanitizeLinks(task.links),
    notes: typeof task.notes === 'string' ? task.notes : '',
    priority: sanitizePriority(raw.priority),
    parentIds: sanitizeParentIds(raw.parentIds),
    blockedReason: typeof raw.blockedReason === 'string' ? raw.blockedReason : '',
    reviewRequired: raw.reviewRequired === true,
    goalMode: raw.goalMode === true,
    worktreeRequired: raw.worktreeRequired === true,
    ...sanitizeGoalMaxTurns(raw.goalMaxTurns),
    ...sanitizeAssignee(raw.assignee),
  };
  if (!(typeof raw.assignee === 'string' && raw.assignee.trim().length > 0)) delete next.assignee;
  if (!(typeof raw.goalMaxTurns === 'number' && Number.isFinite(raw.goalMaxTurns) && raw.goalMaxTurns > 0)) {
    delete next.goalMaxTurns;
  }
  if (typeof raw.createdBy === 'string' && raw.createdBy.trim().length > 0) next.createdBy = raw.createdBy.trim();
  else delete next.createdBy;
  if (typeof raw.updatedBy === 'string' && raw.updatedBy.trim().length > 0) next.updatedBy = raw.updatedBy.trim();
  else delete next.updatedBy;
  const signoff = sanitizeSignoff(raw.signoff);
  if (signoff) next.signoff = signoff;
  else delete next.signoff;
  return next;
}

function isTaskComment(c: unknown): c is TaskComment {
  if (!c || typeof c !== 'object') return false;
  const o = c as Record<string, unknown>;
  return (
    typeof o.id === 'string'
    && typeof o.taskId === 'string'
    && typeof o.authorLabel === 'string'
    && typeof o.body === 'string'
    && typeof o.createdAt === 'number'
  );
}

function normalizeComment(comment: TaskComment): TaskComment {
  const raw = comment as TaskComment & Record<string, unknown>;
  const metadata = sanitizeRecord(raw.metadata);
  const next: TaskComment = {
    id: raw.id,
    taskId: raw.taskId,
    authorLabel: raw.authorLabel.trim().slice(0, 200) || 'unknown',
    body: raw.body.slice(0, COMMENT_MAX),
    createdAt: raw.createdAt,
    ...(typeof raw.authorWorkflowId === 'string' && raw.authorWorkflowId.trim().length > 0
      ? { authorWorkflowId: raw.authorWorkflowId.trim() }
      : {}),
    ...(metadata ? { metadata } : {}),
  };
  return next;
}

function isTaskRun(r: unknown): r is TaskRun {
  if (!r || typeof r !== 'object') return false;
  const o = r as Record<string, unknown>;
  return (
    typeof o.id === 'string'
    && typeof o.taskId === 'string'
    && typeof o.workflowId === 'string'
    && typeof o.status === 'string'
    && typeof o.startedAt === 'number'
  );
}

function normalizeRun(run: TaskRun): TaskRun {
  const raw = run as TaskRun & Record<string, unknown>;
  const metadata = sanitizeRecord(raw.metadata);
  return {
    id: raw.id,
    taskId: raw.taskId,
    workflowId: raw.workflowId,
    status: raw.status,
    startedAt: raw.startedAt,
    ...(typeof raw.clusterId === 'string' ? { clusterId: raw.clusterId } : {}),
    ...(typeof raw.outcome === 'string' ? { outcome: raw.outcome } : {}),
    ...(typeof raw.claimLock === 'string' ? { claimLock: raw.claimLock } : {}),
    ...(typeof raw.lastHeartbeatAt === 'number' ? { lastHeartbeatAt: raw.lastHeartbeatAt } : {}),
    ...(typeof raw.endedAt === 'number' ? { endedAt: raw.endedAt } : {}),
    ...(typeof raw.sessionId === 'string' ? { sessionId: raw.sessionId } : {}),
    ...(typeof raw.workerId === 'string' ? { workerId: raw.workerId } : {}),
    ...(typeof raw.summary === 'string' ? { summary: raw.summary.slice(0, COMMENT_MAX) } : {}),
    ...(typeof raw.error === 'string' ? { error: raw.error.slice(0, COMMENT_MAX) } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function taskKernelState(file: TaskKernelFile): TaskKernelState | null {
  if (!file || !Array.isArray(file.tasks)) return null;
  const tasks: LedgerTask[] = [];
  for (const task of file.tasks) {
    if (isLedgerTask(task)) tasks.push(normalizeTask(task));
  }
  const raw = file as Partial<TaskKernelSnapshot>;
  const comments = Array.isArray(raw.comments)
    ? raw.comments.filter(isTaskComment).map((comment) => normalizeComment(comment))
    : [];
  const runs = Array.isArray(raw.runs)
    ? raw.runs.filter(isTaskRun).map((run) => normalizeRun(run))
    : [];
  return { tasks, comments, runs };
}

// ── load / save / query boundary ──────────────────────────────────────────

// Load the snapshot. Returns null when the file is missing OR unparseable, so
// the caller can decide whether to rebuild. (Empty-but-valid file → [].)
async function readKernelSnapshot(cwd: string, boardKey?: TaskBoardKey): Promise<TaskKernelState | null> {
  let raw: string;
  try {
    raw = await fs.readFile(tasksPath(cwd, boardKey), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as TaskKernelFile;
    return taskKernelState(parsed);
  } catch {
    return null; // corrupt JSON — caller rebuilds from events
  }
}

async function readSnapshot(cwd: string, boardKey?: TaskBoardKey): Promise<LedgerTask[] | null> {
  const state = await readKernelSnapshot(cwd, boardKey);
  return state?.tasks ?? null;
}

// Public load(): snapshot first, rebuild-from-events on miss/corruption. This
// is the projection's recovery path — the JSON is just a cache.
export async function load(cwd: string, boardKey?: TaskBoardKey): Promise<LedgerTask[]> {
  if (!cwd) return [];
  const snapshot = await readSnapshot(cwd, boardKey);
  if (snapshot !== null) return snapshot;
  // Snapshot missing or corrupt — rebuild from the durable event log and
  // re-materialize the cache so the next load is cheap.
  const rebuilt = await rebuildFromEvents(cwd, boardKey);
  const comments = await rebuildCommentsFromEvents(cwd, boardKey);
  const runs = await rebuildRunsFromEvents(cwd, boardKey);
  await saveKernel(cwd, { tasks: rebuilt, comments, runs }, boardKey).catch(() => { /* best-effort cache write */ });
  return rebuilt;
}

export async function save(cwd: string, tasks: LedgerTask[], boardKey?: TaskBoardKey): Promise<void> {
  if (!cwd) return;
  const prev = await readKernelSnapshot(cwd, boardKey).catch(() => null);
  const file: TaskKernelSnapshot = {
    version: TASK_KERNEL_VERSION,
    tasks: tasks.map(normalizeTask),
    ...(prev?.comments.length ? { comments: prev.comments } : {}),
    ...(prev?.runs.length ? { runs: prev.runs } : {}),
  };
  await atomicWriteFile(tasksPath(cwd, boardKey), JSON.stringify(file, null, 2) + '\n');
}

export async function loadKernel(cwd: string, boardKey?: TaskBoardKey): Promise<TaskKernelState> {
  if (!cwd) return { tasks: [], comments: [], runs: [] };
  const snapshot = await readKernelSnapshot(cwd, boardKey);
  if (snapshot !== null) return snapshot;
  const tasks = await rebuildFromEvents(cwd, boardKey);
  const comments = await rebuildCommentsFromEvents(cwd, boardKey);
  const runs = await rebuildRunsFromEvents(cwd, boardKey);
  await saveKernel(cwd, { tasks, comments, runs }, boardKey).catch(() => { /* best-effort cache write */ });
  return { tasks, comments, runs };
}

export async function saveKernel(cwd: string, state: TaskKernelState, boardKey?: TaskBoardKey): Promise<void> {
  if (!cwd) return;
  const file: TaskKernelSnapshot = {
    version: TASK_KERNEL_VERSION,
    tasks: state.tasks.map(normalizeTask),
    ...(state.comments.length ? { comments: state.comments.map(normalizeComment) } : {}),
    ...(state.runs.length ? { runs: state.runs.map(normalizeRun) } : {}),
  };
  await atomicWriteFile(tasksPath(cwd, boardKey), JSON.stringify(file, null, 2) + '\n');
}

// query(): load-all + filter-in-JS. The working set is small and single-writer,
// so none of SQLite's indexing wins apply (Appendix B). Filter is optional.
export async function query(
  cwd: string,
  filter?: { status?: LedgerTaskStatus },
  boardKey?: TaskBoardKey,
): Promise<LedgerTask[]> {
  const tasks = await load(cwd, boardKey);
  if (!filter?.status) return tasks;
  return tasks.filter((t) => t.status === filter.status);
}

// ── model-facing board view ─────────────────────────────────────────────────
//
// cluster_task_list used to dump the entire ledger — every task regardless of
// status, oldest-first, with full notes — into a worker's context, where it hits
// the 64KB tool-output cap (MAX_TOOL_OUTPUT_BYTES in claude-native/tools.ts).
// Because the dump was oldest-first the byte-slice lopped off the NEWEST/active
// rows (the only ones a worker claiming work cares about) and left INVALID JSON
// cut mid-object. On a 128-task board (120 done) the live rows were never even
// visible. This projection is the fix — four things at once:
//   1. drop done/archived from the live list (still fetchable by id via
//      cluster_task_show; a compact `recentlyCompleted` tail keeps visibility)
//   2. strip fat notes to a one-line preview + length
//   3. surface active work newest-updated-first
//   4. bound to VALID JSON under a byte budget below the cap — drop from the
//      tail (oldest), never mid-object, and report how many were omitted
// The operator UI is unaffected: it renders from task_ledger_snapshot WS
// broadcasts (LedgerTab / ClusterTaskBoardTab), not this path.
const BOARD_ACTIVE_STATUSES: ReadonlySet<LedgerTaskStatus> = new Set([
  'triage', 'todo', 'ready', 'in_progress', 'blocked', 'review',
]);
const BOARD_NOTES_PREVIEW = 160; // chars of notes kept inline
const BOARD_RECENT_DONE = 10; // recently-finished tasks shown as one-liners
const BOARD_BYTE_BUDGET = 48 * 1024; // stay well under the 64KB tool-output cap

function notesPreview(notes: string): string {
  const oneLine = notes.replace(/\s+/g, ' ').trim();
  return oneLine.length <= BOARD_NOTES_PREVIEW ? oneLine : oneLine.slice(0, BOARD_NOTES_PREVIEW) + '…';
}

function toBoardRow(t: LedgerTask): Record<string, unknown> {
  const notes = t.notes ?? '';
  const preview = notesPreview(notes);
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    ...(t.assignee ? { assignee: t.assignee } : {}),
    priority: t.priority,
    ...(t.status === 'blocked' && t.blockedReason ? { blockedReason: t.blockedReason } : {}),
    ...(t.parentIds?.length ? { parentIds: t.parentIds } : {}),
    ...(t.links?.length ? { links: t.links } : {}),
    ...(t.reviewRequired ? { reviewRequired: true } : {}),
    ...(preview ? { notesPreview: preview } : {}),
    ...(notes.length > BOARD_NOTES_PREVIEW ? { notesLength: notes.length } : {}),
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

// Render the live board as a compact, always-valid JSON string for a worker's
// tool result. Pure — no IO. Callers: the Native peerTools dispatcher and the
// /task-list REST endpoint (read by the cluster MCP child for CLI/Codex workers).
export function formatBoardForModel(tasks: LedgerTask[]): string {
  const active = tasks
    .filter((t) => BOARD_ACTIVE_STATUSES.has(t.status))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const completed = tasks
    .filter((t) => !BOARD_ACTIVE_STATUSES.has(t.status))
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const rows = active.map(toBoardRow);
  const recentlyCompleted = completed.slice(0, BOARD_RECENT_DONE).map((t) => ({
    id: t.id, title: t.title, status: t.status, updatedAt: t.updatedAt,
  }));

  let omitted = 0;
  const build = () => JSON.stringify({
    activeCount: active.length,
    completedCount: completed.length,
    ...(omitted ? { omittedActive: omitted } : {}),
    tasks: rows,
    ...(recentlyCompleted.length ? { recentlyCompleted } : {}),
    hint:
      'Live board: done/archived hidden from `tasks` (completedCount totals them; ' +
      'recentlyCompleted lists the latest). Call cluster_task_show <id> for full ' +
      'notes or any finished task by id.',
  }, null, 2);

  // Drop oldest-updated active rows until the payload fits the budget, keeping the
  // JSON structurally valid — unlike the raw byte-slice this replaces.
  while (rows.length > 0 && Buffer.byteLength(build(), 'utf8') > BOARD_BYTE_BUDGET) {
    rows.pop();
    omitted++;
  }
  return build();
}

// ── projection / rebuild ────────────────────────────────────────────────────

// Fold every workflow's task_ledger_event under this cwd into the current task
// set. Events are read per-workflow in seq order; we then sort the flattened
// stream by the event's `at` timestamp (seq is per-workflow, so it can't order
// across workflows) and apply in order. This is the authoritative recovery
// path when tasks.json is missing/corrupt.
function eventBelongsToBoard(ev: TaskLedgerEventMessage, boardKey?: TaskBoardKey): boolean {
  return sanitizeBoardKey(ev.boardKey) === sanitizeBoardKey(boardKey);
}

export async function rebuildFromEvents(cwd: string, boardKey?: TaskBoardKey): Promise<LedgerTask[]> {
  if (!cwd) return [];
  const metas = await listWorkflowMetas(cwd).catch(() => []);
  const events: Array<TaskLedgerEventMessage & { seq: number }> = [];
  for (const meta of metas) {
    const msgs = await replayEvents(cwd, meta.workflowId, 0).catch(() => []);
    for (const m of msgs) {
      if (m.type !== 'task_ledger_event') continue;
      const ev = m as unknown as TaskLedgerEventMessage & { seq?: number };
      // Only fold events for THIS cwd (a workflow's log is cwd-local, but the
      // event carries cwd explicitly — guard against a moved log).
      if (ev.cwd !== cwd || !eventBelongsToBoard(ev, boardKey)) continue;
      events.push({ ...ev, seq: ev.seq ?? 0 });
    }
  }
  events.sort((a, b) => (a.at - b.at) || (a.seq - b.seq));
  const byId = new Map<string, LedgerTask>();
  for (const ev of events) {
    if (ev.op === 'delete') {
      byId.delete(ev.id);
    } else if (ev.task && isLedgerTask(ev.task)) {
      // create + update both carry the resulting task — last-writer-wins fold.
      byId.set(ev.id, normalizeTask(ev.task));
    }
  }
  return [...byId.values()].sort((a, b) => a.createdAt - b.createdAt);
}

async function taskLedgerEvents(cwd: string, boardKey?: TaskBoardKey): Promise<Array<TaskLedgerEventMessage & { seq: number }>> {
  if (!cwd) return [];
  const metas = await listWorkflowMetas(cwd).catch(() => []);
  const events: Array<TaskLedgerEventMessage & { seq: number }> = [];
  for (const meta of metas) {
    const msgs = await replayEvents(cwd, meta.workflowId, 0).catch(() => []);
    for (const m of msgs) {
      if (m.type !== 'task_ledger_event') continue;
      const ev = m as unknown as TaskLedgerEventMessage & { seq?: number };
      if (ev.cwd !== cwd || !eventBelongsToBoard(ev, boardKey)) continue;
      events.push({ ...ev, seq: ev.seq ?? 0 });
    }
  }
  events.sort((a, b) => (a.at - b.at) || (a.seq - b.seq));
  return events;
}

export async function rebuildCommentsFromEvents(cwd: string, boardKey?: TaskBoardKey): Promise<TaskComment[]> {
  const comments: TaskComment[] = [];
  for (const ev of await taskLedgerEvents(cwd, boardKey)) {
    const comment = ev.payload?.comment;
    if (isTaskComment(comment)) {
      comments.push(normalizeComment(comment));
    }
  }
  comments.sort((a, b) => a.createdAt - b.createdAt);
  return comments;
}

export async function rebuildRunsFromEvents(cwd: string, boardKey?: TaskBoardKey): Promise<TaskRun[]> {
  const byId = new Map<string, TaskRun>();
  for (const ev of await taskLedgerEvents(cwd, boardKey)) {
    const run = ev.payload?.run;
    if (
      (ev.op === 'run_started'
        || ev.op === 'run_completed'
        || ev.op === 'run_failed'
        || ev.op === 'run_reclaimed'
        || ev.op === 'run_terminated'
        || ev.op === 'dispatch_fired'
        || ev.op === 'heartbeat')
      && isTaskRun(run)
    ) {
      byId.set(run.id, normalizeRun(run));
    }
  }
  return [...byId.values()].sort((a, b) => a.startedAt - b.startedAt);
}

// ── mutation helpers (pure — caller persists + emits the event) ──────────────

export function newTask(input: {
  title: string;
  notes?: string;
  links?: TaskLink[];
  priority?: number;
  parentIds?: string[];
  reviewRequired?: boolean;
  goalMode?: boolean;
  goalMaxTurns?: number;
  worktreeRequired?: boolean;
  createdBy?: string;
}): LedgerTask {
  const now = Date.now();
  // New tasks are ALWAYS 'todo'. There is no create-as-done path — the
  // operator-confirmed-done invariant (§D1) starts here.
  return {
    id: randomUUID(),
    title: (input.title ?? '').trim().slice(0, TITLE_MAX) || 'Untitled task',
    status: 'todo',
    links: sanitizeLinks(input.links),
    notes: (input.notes ?? '').slice(0, NOTES_MAX),
    priority: sanitizePriority(input.priority),
    parentIds: sanitizeParentIds(input.parentIds),
    blockedReason: '',
    reviewRequired: input.reviewRequired === true,
    goalMode: input.goalMode === true,
    worktreeRequired: input.worktreeRequired === true,
    ...sanitizeGoalMaxTurns(input.goalMaxTurns),
    ...(typeof input.createdBy === 'string' && input.createdBy.trim().length > 0
      ? { createdBy: input.createdBy.trim(), updatedBy: input.createdBy.trim() }
      : {}),
    createdAt: now,
    updatedAt: now,
  };
}

export function newTaskComment(input: {
  taskId: string;
  body: string;
  authorWorkflowId?: string;
  authorLabel?: string;
  metadata?: Record<string, unknown>;
}): TaskComment {
  return normalizeComment({
    id: randomUUID(),
    taskId: input.taskId,
    authorLabel: input.authorLabel ?? 'worker',
    body: input.body,
    createdAt: Date.now(),
    ...(typeof input.authorWorkflowId === 'string' ? { authorWorkflowId: input.authorWorkflowId } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  });
}

export function newTaskRun(input: {
  taskId: string;
  workflowId: string;
  clusterId?: string;
  status?: TaskRun['status'];
  claimLock?: string;
  workerId?: string;
  metadata?: Record<string, unknown>;
}): TaskRun {
  const now = Date.now();
  return normalizeRun({
    id: randomUUID(),
    taskId: input.taskId,
    workflowId: input.workflowId,
    status: input.status ?? 'running',
    startedAt: now,
    lastHeartbeatAt: now,
    ...(typeof input.clusterId === 'string' && input.clusterId.trim().length > 0 ? { clusterId: input.clusterId.trim() } : {}),
    ...(typeof input.claimLock === 'string' && input.claimLock.trim().length > 0 ? { claimLock: input.claimLock.trim() } : {}),
    ...(typeof input.workerId === 'string' && input.workerId.trim().length > 0 ? { workerId: input.workerId.trim() } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  });
}

export function heartbeatRun(
  runs: TaskRun[],
  input: {
    taskId: string;
    workflowId: string;
    clusterId?: string;
    workerId?: string;
    note?: string;
  },
): { runs: TaskRun[]; run: TaskRun } {
  const now = Date.now();
  const i = runs.findIndex((run) =>
    run.taskId === input.taskId
    && run.workflowId === input.workflowId
    && !run.endedAt
    && (run.status === 'claimed' || run.status === 'running'),
  );
  const noteEntry = typeof input.note === 'string' && input.note.trim().length > 0
    ? { at: now, body: input.note.trim().slice(0, COMMENT_MAX) }
    : null;
  if (i === -1) {
    const run = newTaskRun({
      taskId: input.taskId,
      workflowId: input.workflowId,
      clusterId: input.clusterId,
      workerId: input.workerId,
      metadata: noteEntry ? { heartbeatNotes: [noteEntry] } : undefined,
    });
    return { runs: [...runs, run], run };
  }
  const prev = runs[i];
  const prevMetadata = sanitizeRecord(prev.metadata) ?? {};
  const heartbeatNotes = Array.isArray(prevMetadata.heartbeatNotes)
    ? [...prevMetadata.heartbeatNotes]
    : [];
  if (noteEntry) heartbeatNotes.push(noteEntry);
  const next = normalizeRun({
    ...prev,
    status: 'running',
    lastHeartbeatAt: now,
    ...(typeof input.clusterId === 'string' && input.clusterId.trim().length > 0 ? { clusterId: input.clusterId.trim() } : {}),
    ...(typeof input.workerId === 'string' && input.workerId.trim().length > 0 ? { workerId: input.workerId.trim() } : {}),
    metadata: {
      ...prevMetadata,
      ...(heartbeatNotes.length ? { heartbeatNotes } : {}),
    },
  });
  const out = [...runs];
  out[i] = next;
  return { runs: out, run: next };
}

export function taskDetails(state: TaskKernelState, id: string): TaskDetails | null {
  const task = state.tasks.find((t) => t.id === id);
  if (!task) return null;
  const parentSet = new Set(task.parentIds);
  return {
    task,
    comments: state.comments.filter((c) => c.taskId === id).sort((a, b) => a.createdAt - b.createdAt),
    runs: state.runs.filter((r) => r.taskId === id).sort((a, b) => a.startedAt - b.startedAt),
    parents: state.tasks.filter((t) => parentSet.has(t.id)),
    children: state.tasks.filter((t) => t.parentIds.includes(id)),
  };
}

// Apply an operator-originated patch to a task. This is the ONLY path that may
// set status: 'done' — it accepts whatever status the operator's update
// message carries. There is intentionally no auto/derived status anywhere else
// (§D1 acceptance invariant). Returns the updated task, or null if not found.
export function applyUpdate(
  tasks: LedgerTask[],
  id: string,
  // §K5 — `worktree` is SERVER-SET only (the WS update message never carries it;
  // only the worktree handlers pass it). An object sets it; `null` clears it;
  // `undefined` leaves it untouched.
  patch: {
    title?: string;
    status?: LedgerTaskStatus;
    notes?: string;
    links?: TaskLink[];
    priority?: number;
    parentIds?: string[];
    blockedReason?: string;
    reviewRequired?: boolean;
    goalMode?: boolean;
    goalMaxTurns?: number | null;
    assignee?: string;
    worktreeRequired?: boolean;
    worktree?: TaskWorktree | null;
    // §D3 — director's advisory verdict. An object sets it (caller stamps
    // byWorkflowId/at); `null` clears it; `undefined` leaves it untouched.
    signoff?: TaskSignoff | null;
    updatedBy?: string;
  },
): { tasks: LedgerTask[]; updated: LedgerTask } | null {
  const i = tasks.findIndex((t) => t.id === id);
  if (i === -1) return null;
  const prev = tasks[i];
  const next: LedgerTask = {
    ...prev,
    ...(typeof patch.title === 'string'
      ? { title: patch.title.trim().slice(0, TITLE_MAX) || prev.title }
      : {}),
    ...(patch.status && VALID_STATUS.has(patch.status) ? { status: patch.status } : {}),
    ...(typeof patch.notes === 'string' ? { notes: patch.notes.slice(0, NOTES_MAX) } : {}),
    ...(patch.links !== undefined ? { links: sanitizeLinks(patch.links) } : {}),
    ...(patch.priority !== undefined ? { priority: sanitizePriority(patch.priority) } : {}),
    ...(patch.parentIds !== undefined ? { parentIds: sanitizeParentIds(patch.parentIds) } : {}),
    ...(typeof patch.blockedReason === 'string' ? { blockedReason: patch.blockedReason.slice(0, NOTES_MAX) } : {}),
    ...(typeof patch.reviewRequired === 'boolean' ? { reviewRequired: patch.reviewRequired } : {}),
    ...(typeof patch.goalMode === 'boolean' ? { goalMode: patch.goalMode } : {}),
    ...(typeof patch.worktreeRequired === 'boolean' ? { worktreeRequired: patch.worktreeRequired } : {}),
    ...(typeof patch.updatedBy === 'string' && patch.updatedBy.trim().length > 0
      ? { updatedBy: patch.updatedBy.trim() }
      : {}),
    updatedAt: Date.now(),
  };
  if (patch.goalMaxTurns !== undefined) {
    if (patch.goalMaxTurns === null) delete next.goalMaxTurns;
    else {
      delete next.goalMaxTurns;
      Object.assign(next, sanitizeGoalMaxTurns(patch.goalMaxTurns));
    }
  }
  // §D3 — assignee patch: a non-empty string claims/reassigns; an empty string
  // explicitly UNASSIGNS (delete the key so the projection stays clean — the
  // field is optional, absent = unclaimed). Undefined leaves it untouched.
  if (typeof patch.assignee === 'string') {
    const trimmed = patch.assignee.trim();
    if (trimmed.length > 0) next.assignee = trimmed;
    else delete next.assignee;
  }
  // §K5 — worktree set/clear. null explicitly removes the field (keeps the
  // projection clean — absent = no worktree); undefined leaves it untouched.
  if (patch.worktree !== undefined) {
    if (patch.worktree === null) delete next.worktree;
    else next.worktree = patch.worktree;
  }
  // §D3 — sign-off set/clear. null clears (back to PENDING); undefined leaves
  // it untouched; an object is sanitized (drops a malformed verdict).
  if (patch.signoff !== undefined) {
    const clean = patch.signoff === null ? null : sanitizeSignoff(patch.signoff);
    if (clean) next.signoff = clean;
    else delete next.signoff;
  }
  const out = [...tasks];
  out[i] = next;
  return { tasks: out, updated: next };
}

export function removeTask(tasks: LedgerTask[], id: string): LedgerTask[] | null {
  if (!tasks.some((t) => t.id === id)) return null;
  return tasks.filter((t) => t.id !== id);
}

// ── reverse link query (§D2) ─────────────────────────────────────────────────

// Reverse of `task.links`: given a target (a plan id / review artifact / workflow
// id / url), return the tasks that link to it. The forward direction is already
// the task's own `links[]`; this is the target→tasks half that makes the
// reference bidirectional (the D2 capability — a plan/review/workflow can ask
// "which ledger tasks point at me?"). Pure: match on exact {kind, ref}; same ref
// under a different kind does NOT cross-match (a workflow id and a url that
// happen to share a string are distinct targets).
export function tasksLinkedTo(
  tasks: LedgerTask[],
  target: { kind: TaskLink['kind']; ref: string },
): LedgerTask[] {
  return tasks.filter((t) =>
    t.links.some((l) => l.kind === target.kind && l.ref === target.ref),
  );
}
