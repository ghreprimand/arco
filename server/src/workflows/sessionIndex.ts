// docs/ARCHITECTURE.md - project-local session index.
//
// Maintains <cwd>/.arco/session-index.json: a per-project PROJECTION of that
// project's resumable sessions (one entry per (provider, sessionId) it ran).
// The resume surface (§H3) reads this single small file instead of re-scanning
// every meta.json + provider JSONL on each open.
//
// §H2 layers title quality on top of H1's data layer: the deterministic title
// skips generic openers ("continue", "ok") so a session is titled by its first
// REAL ask; a dynamic "where this left off" subtitle is derived from the last
// non-trivial operator message (a Recall summary, when present, wins and is
// sticky); and an optional gated `model` title (applyModelTitle) sits above the
// derived layers — cached by sourceHash, precedence-guarded, and audit-logged to
// title-events.jsonl. No model is ever spawned here (H3 arms that); this module
// only APPLIES a title the caller generated, so titling never fails closed.
//
// Invariants (mirror sibling persistence modules + the §H1 acceptance):
//   - All reads / writes scope to <cwd>/.arco/. The index NEVER writes to a
//     provider's own session store (~/.claude, ~/.codex, …) — it only reads
//     them. (This module reads neither; it derives purely from meta.json +
//     events.jsonl, both Arco-owned.)
//   - Writes are atomic (tmp + rename). Same pattern as workflowMeta.ts.
//   - The index is a REBUILDABLE projection, never a source of truth: deleting
//     it is harmless (rebuilt on the next turn / discovery). So every update is
//     failure-isolated by its caller (fired-and-logged, never awaited into a
//     real workflow's result) — a hiccup here must not break a turn.
//
// Update triggers (all three from the §H1 goal):
//   - after turns        → upsertSessionIndexFromMeta(), called from writeMeta
//   - on resume discovery → backfillSessionIndex(), called from discoverSessions
//   - from Recall summary → recordSessionSummary(), called from summarizeWorkflow

import { promises as fs } from 'fs';
import path from 'path';
import type { ProviderName, SessionIndex, SessionIndexEntry, SessionTitleEvent } from '@arco/shared';
import type { WorkflowMeta } from '../workflowMeta.js';
import { atomicWriteFile, withFileLock } from '../atomicFile.js';

const WFID_PATTERN = /^[a-zA-Z0-9-]{1,64}$/;
const CURRENT_INDEX_VERSION = 1;
const TITLE_MAX = 100;

// §H2 — title-layer precedence. A derived (deterministic/dynamic) upsert may
// overwrite a title only when the EXISTING source ranks no higher than `dynamic`
// — so a `model`-generated or `operator`-renamed title survives a refresh.
type TitleSource = NonNullable<SessionIndexEntry['titleSource']>;
const TITLE_RANK: Record<TitleSource, number> = { deterministic: 0, dynamic: 1, model: 2, operator: 3 };

// §H2 — generic conversation openers that make a poor title. A session that
// starts with "continue" should be titled by its first REAL ask, not "continue".
// Lowercased, trailing .?! stripped before lookup.
const GENERIC_OPENERS = new Set([
  '', 'continue', 'continue please', 'please continue', 'ok', 'okay', 'ok continue', 'okay continue',
  'go', 'go on', 'go ahead', 'proceed', 'next', 'done', 'yes', 'yep', 'yeah', 'yup', 'no', 'nope',
  'y', 'n', 'k', 'sure', 'thanks', 'thank you', 'hi', 'hello', 'hey', 'continue the work',
]);

// A message too trivial to title a session by.
function isGenericMessage(s: string): boolean {
  const t = s.replace(/\s+/g, ' ').trim().toLowerCase().replace(/[.!?]+$/, '').trim();
  if (t.length < 3) return true;
  return GENERIC_OPENERS.has(t);
}

// A title weak enough that a derived refresh may replace it even WITHOUT a
// material change: a generic opener, or the bottom `provider · project · date`
// fallback label (which carries no task signal).
function isGenericTitle(title: string): boolean {
  if (isGenericMessage(title)) return true;
  return / · .+ · \d{4}-\d{2}-\d{2}$/.test(title.trim());
}

function indexPath(cwd: string): string {
  return path.join(cwd, '.arco', 'session-index.json');
}

// Every read→mutate→write of the index runs under this. Without it a turn's
// fire-and-forget upsert (from writeMeta) read the index, an operator rename
// landed, and the upsert's write-back restored the old title. Not re-entrant:
// never call a locked export from inside another's critical section.
function withIndexLock<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  return withFileLock(indexPath(cwd), fn);
}

function emptyIndex(): SessionIndex {
  return { version: CURRENT_INDEX_VERSION, updatedAt: 0, entries: [] };
}

// (provider, sessionId) is the entry key.
function sameSession(a: SessionIndexEntry, provider: ProviderName, sessionId: string): boolean {
  return a.provider === provider && a.sessionId === sessionId;
}

// Read the project's index. Missing file → empty (it's a projection). A
// corrupt/legacy file degrades to empty rather than throwing — the next upsert
// rebuilds it from meta.json.
export async function readSessionIndex(cwd: string): Promise<SessionIndex> {
  if (!cwd) return emptyIndex();
  try {
    const raw = await fs.readFile(indexPath(cwd), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.entries)) return emptyIndex();
    return { version: Number(parsed.version) || CURRENT_INDEX_VERSION, updatedAt: Number(parsed.updatedAt) || 0, entries: parsed.entries };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyIndex();
    return emptyIndex();
  }
}

async function writeSessionIndex(cwd: string, index: SessionIndex, now: number): Promise<void> {
  index.version = CURRENT_INDEX_VERSION;
  index.updatedAt = now;
  await atomicWriteFile(indexPath(cwd), JSON.stringify(index, null, 2) + '\n');
}

function projectName(cwd: string): string {
  return path.basename(cwd) || cwd || 'unknown';
}

function trimTitle(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > TITLE_MAX ? t.slice(0, TITLE_MAX - 1).trimEnd() + '…' : t;
}

// Most recent CLI session for the workflow (cross-provider workflows can have
// interleaved entries; we want the newest overall to drive the resume key).
// Inlined rather than importing latestCliSessionFor to keep this module free of
// a runtime dependency on workflowMeta.ts (writeMeta → here is the only edge).
function newestCliSession(meta: WorkflowMeta): WorkflowMeta['cliSessions'][number] | null {
  return meta.cliSessions.length ? meta.cliSessions[meta.cliSessions.length - 1] : null;
}

// Scan events.jsonl for every operator message, in order. Mirrors
// recall/index.ts scanEvents: the `user_message_echo` event is the canonical
// operator-turn marker. The first/last meaningful entries drive the H2 title
// + "where this left off" subtitle.
export async function scanOperatorMessages(cwd: string, wfid: string): Promise<string[]> {
  if (!WFID_PATTERN.test(wfid)) return [];
  const eventsPath = path.join(cwd, '.arco', 'workflows', wfid, 'events.jsonl');
  let raw: string;
  try {
    raw = await fs.readFile(eventsPath, 'utf8');
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line || !line.includes('"user_message_echo"')) continue;
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type !== 'user_message_echo') continue;
    if (typeof entry.content === 'string' && entry.content.trim()) out.push(entry.content.trim());
  }
  return out;
}

function derivedLabel(meta: WorkflowMeta): string {
  const date = new Date(meta.createdAt || meta.lastActiveAt || 0).toISOString().slice(0, 10);
  return `${meta.primaryProvider} · ${projectName(meta.cwd)} · ${date}`;
}

// §H2 layered derived title (never blank). Fallback chain:
//   deterministic — first MEANINGFUL operator ask (generic openers skipped),
//                   else a non-default Arco workflow name;
//   dynamic       — when no opener qualifies, the last non-trivial operator
//                   message (a session that's all "continue" until a real ask);
//   deterministic — the `provider · project · date` label as the floor.
// H2's model layer + H3's operator rename sit above this and survive refreshes.
function resolveDerivedTitle(meta: WorkflowMeta, messages: string[]): { title: string; source: 'deterministic' | 'dynamic' } {
  const meaningful = messages.filter((m) => !isGenericMessage(m));
  if (meaningful.length) return { title: trimTitle(meaningful[0]), source: 'deterministic' };
  // No meaningful ask yet — fall back to the most recent non-empty message (the
  // best "what's going on" signal we have) before the bare label.
  const lastRaw = [...messages].reverse().find((m) => m.trim());
  if (lastRaw) return { title: trimTitle(lastRaw), source: 'dynamic' };
  const name = (meta.name || '').trim();
  if (name && name !== meta.workflowId && !isGenericMessage(name)) return { title: trimTitle(name), source: 'deterministic' };
  return { title: derivedLabel(meta), source: 'deterministic' };
}

// §H2 dynamic subtitle — "where this left off" when no Recall summary exists.
// The last MEANINGFUL operator message, but only when it differs from the title
// (a single-ask session's last==first==title would be noise).
function dynamicSubtitle(messages: string[], title: string): string | undefined {
  const lastMeaningful = [...messages].reverse().find((m) => !isGenericMessage(m));
  if (!lastMeaningful) return undefined;
  const sub = trimTitle(lastMeaningful);
  return sub && sub !== title ? sub : undefined;
}

// The derived fields of an entry — everything the deterministic/dynamic layers
// own. The higher layers (model title via applyModelTitle; operator tags /
// rename / telemetry via §H3) are written by their own triggers and merged in,
// never set here, so a plain meta upsert can't clobber them.
function deriveEntry(meta: WorkflowMeta, messages: string[]): SessionIndexEntry {
  const newest = newestCliSession(meta);
  // No native session (Claude Native replay / Antigravity / Ollama): the Arco
  // workflow id is the resume key, matching arcoInternalSessionInfoForMeta.
  const provider = newest?.provider ?? meta.primaryProvider;
  const sessionId = newest?.sessionId ?? meta.workflowId;
  const lastSeq = meta.lastEventSeq ?? undefined;
  const { title, source } = resolveDerivedTitle(meta, messages);
  const subtitle = dynamicSubtitle(messages, title);
  return {
    provider,
    sessionId,
    workflowId: meta.workflowId,
    cwd: meta.cwd,
    startedAt: meta.createdAt,
    lastActiveAt: meta.lastActiveAt,
    title,
    titleSource: source,
    // Cheap material-change marker — the model-title layer compares this to
    // decide whether a cached title is stale.
    sourceHash: String(meta.lastEventSeq ?? 0),
    ...(lastSeq !== undefined ? { lastSeq } : {}),
    ...(subtitle ? { subtitle, subtitleSource: 'dynamic' as const } : {}),
  };
}

// Merge a freshly-derived entry over any existing one, respecting title-layer
// precedence (§H2). The derived title (deterministic/dynamic) may replace the
// existing one only when the existing title is itself derived AND either a
// material change happened or the existing title is generic/repetitive — so a
// `model` or `operator` title survives, and an idempotent re-upsert is a no-op.
// The dynamic subtitle refreshes each upsert UNLESS a sticky summary subtitle
// is present.
function mergeEntry(existing: SessionIndexEntry | undefined, derived: SessionIndexEntry): SessionIndexEntry {
  if (!existing) return derived;
  const existingRank = TITLE_RANK[existing.titleSource ?? 'deterministic'];
  const materialChange = existing.sourceHash !== derived.sourceHash;
  const canRefreshTitle = existingRank <= TITLE_RANK.dynamic && (materialChange || isGenericTitle(existing.title));
  const title = canRefreshTitle ? derived.title : existing.title;
  const titleSource = canRefreshTitle ? derived.titleSource : existing.titleSource;

  // Subtitle: a summary-sourced subtitle is sticky (operator/LLM-generated
  // recap); otherwise take the refreshed dynamic one, falling back to whatever
  // existed.
  const keepSummary = existing.subtitleSource === 'summary' && !!existing.subtitle;
  const subtitle = keepSummary ? existing.subtitle : (derived.subtitle ?? existing.subtitle);
  const subtitleSource = keepSummary ? 'summary' : (derived.subtitle ? 'dynamic' : existing.subtitleSource);

  return {
    ...existing,
    ...derived, // advances sourceHash / lastSeq / lastActiveAt / startedAt
    title,
    // Set explicitly (not via the `...derived` spread) so a kept title doesn't
    // inherit derived's source; `undefined` is dropped by JSON.stringify.
    titleSource,
    // Keep the model-title generation stamp when we preserved a model title.
    titleGeneratedAt: canRefreshTitle ? undefined : existing.titleGeneratedAt,
    subtitle: subtitle ?? undefined,
    subtitleSource: subtitle ? subtitleSource : undefined,
    // Operator-/H3-owned fields are never present on `derived`; keep them.
    ...(existing.tags ? { tags: existing.tags } : {}),
    ...(existing.pinned ? { pinned: existing.pinned } : {}),
    ...(existing.archived ? { archived: existing.archived } : {}),
    ...(existing.lastOutcome ? { lastOutcome: existing.lastOutcome } : {}),
    ...(existing.currentQuestion ? { currentQuestion: existing.currentQuestion } : {}),
  };
}

// §H1 trigger — after a turn (every writeMeta flows through here). Derives the
// entry from meta + events.jsonl and upserts it. Caller fires-and-logs.
export async function upsertSessionIndexFromMeta(meta: WorkflowMeta): Promise<void> {
  if (!meta.cwd) return;
  const messages = await scanOperatorMessages(meta.cwd, meta.workflowId);
  const derived = deriveEntry(meta, messages);
  await withIndexLock(meta.cwd, async () => {
    const index = await readSessionIndex(meta.cwd);
    const idx = index.entries.findIndex((e) => sameSession(e, derived.provider, derived.sessionId));
    const merged = mergeEntry(idx >= 0 ? index.entries[idx] : undefined, derived);
    if (idx >= 0) index.entries[idx] = merged;
    else index.entries.push(merged);
    await writeSessionIndex(meta.cwd, index, meta.lastActiveAt || meta.createdAt || 0);
  });
}

// List the workflow ids that have a meta.json under <cwd>/.arco/workflows/.
async function listWorkflowIds(cwd: string): Promise<string[]> {
  const dir = path.join(cwd, '.arco', 'workflows');
  let ents: import('fs').Dirent[];
  try {
    ents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return ents.filter((e) => e.isDirectory() && WFID_PATTERN.test(e.name)).map((e) => e.name);
}

// §H1 trigger — on resume discovery. Rebuilds/updates the index for every
// workflow in the project (so a project first opened by a prior server process,
// with no turn yet this run, still gets a current index). Takes a meta reader
// (injected to keep this module dependency-light + testable). Caller fires-and-
// logs; reads are independent so one unreadable meta doesn't abort the rest.
export async function backfillSessionIndex(
  cwd: string,
  readMeta: (cwd: string, wfid: string) => Promise<WorkflowMeta | null>,
): Promise<void> {
  if (!cwd) return;
  for (const wfid of await listWorkflowIds(cwd)) {
    try {
      const meta = await readMeta(cwd, wfid);
      if (meta) await upsertSessionIndexFromMeta(meta);
    } catch {
      /* skip unreadable / unindexable workflow */
    }
  }
}

// §H1 trigger — a Recall summary was generated for a workflow. Records its
// first line as the entry's subtitle ("where this left off"). Found by
// workflowId (a workflow's newest session owns the row). No-op if the workflow
// isn't indexed yet (the next turn/backfill will create it). Caller fires-and-
// logs.
export async function recordSessionSummary(cwd: string, workflowId: string, summaryBody: string): Promise<void> {
  if (!cwd || !workflowId) return;
  const subtitle = summaryBody.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  if (!subtitle) return;
  await withIndexLock(cwd, async () => {
    const index = await readSessionIndex(cwd);
    const idx = index.entries.findIndex((e) => e.workflowId === workflowId);
    if (idx < 0) return;
    // subtitleSource='summary' makes this sticky — a later opportunistic upsert
    // won't overwrite it with the dynamic last-message subtitle (mergeEntry).
    index.entries[idx] = { ...index.entries[idx], subtitle: trimTitle(subtitle), subtitleSource: 'summary' };
    await writeSessionIndex(cwd, index, index.entries[idx].lastActiveAt || 0);
  });
}

// ── §H2 model-title layer (optional / operator-armed) ───────────────────────
// Privacy/cost (CLAUDE.md fences; §H2): there is NO automatic call here. This
// function only APPLIES a title string the caller already generated — it never
// spawns a model itself. H3's operator-armed trigger is the only caller that
// will feed it a live `model` title (via the framing below + a bounded
// read-only worker, mirroring recall/summarize.ts). The deterministic/dynamic
// layers above remain the default, so titling never fails closed.

// The prompt contract for the background title generator (H3 feeds the result
// to applyModelTitle). Bounded: a single short label, no model loop.
export function buildTitleFraming(transcript: string): string {
  return [
    'Produce a SHORT title (5–8 words) for this coding session, capturing the',
    'concrete task or goal. No surrounding quotes, no trailing punctuation, no',
    '"Title:" prefix — output the title text only.',
    '',
    '---',
    '',
    transcript || '(empty transcript)',
  ].join('\n');
}

const TITLE_EVENTS_FILE = 'title-events.jsonl';

async function appendTitleEvent(cwd: string, ev: SessionTitleEvent): Promise<void> {
  const p = path.join(cwd, '.arco', TITLE_EVENTS_FILE);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.appendFile(p, JSON.stringify(ev) + '\n', 'utf8');
}

// Read the project's title-change audit log (newest last). For the resume UI
// and the smoke; missing/corrupt → empty.
export async function readTitleEvents(cwd: string): Promise<SessionTitleEvent[]> {
  if (!cwd) return [];
  try {
    const raw = await fs.readFile(path.join(cwd, '.arco', TITLE_EVENTS_FILE), 'utf8');
    const out: SessionTitleEvent[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip corrupt line */ }
    }
    return out;
  } catch {
    return [];
  }
}

export interface ApplyModelTitleResult {
  // 'applied'   — a new model title was written + logged.
  // 'cached'    — the model title for this sourceHash already matched; no-op.
  // 'outranked' — an operator rename owns the title; left untouched.
  // 'missing'   — the workflow isn't indexed yet.
  status: 'applied' | 'cached' | 'outranked' | 'missing';
}

// Apply a generated `model` title to a workflow's entry. CACHES by sourceHash
// (same hash + same text → no-op, no duplicate log line), respects precedence
// (an `operator` title wins), and EVENT-LOGS every actual change to
// title-events.jsonl. Caller fires-and-logs (projection; must not fail a turn).
export async function applyModelTitle(
  cwd: string,
  workflowId: string,
  modelTitle: string,
  opts: { sourceHash?: string; now?: number } = {},
): Promise<ApplyModelTitleResult> {
  const title = trimTitle(modelTitle);
  if (!cwd || !workflowId || !title) return { status: 'missing' };
  return withIndexLock(cwd, async () => {
    const index = await readSessionIndex(cwd);
    const idx = index.entries.findIndex((e) => e.workflowId === workflowId);
    if (idx < 0) return { status: 'missing' };
    const entry = index.entries[idx];

    if (entry.titleSource === 'operator') return { status: 'outranked' };
    const sourceHash = opts.sourceHash ?? entry.sourceHash;
    // Cached: same generation marker AND identical text already in place.
    if (entry.titleSource === 'model' && entry.sourceHash === sourceHash && entry.title === title) {
      return { status: 'cached' };
    }

    const now = opts.now ?? Date.now();
    const from = entry.title;
    index.entries[idx] = {
      ...entry,
      title,
      titleSource: 'model',
      titleGeneratedAt: now,
      ...(sourceHash !== undefined ? { sourceHash } : {}),
    };
    await writeSessionIndex(cwd, index, entry.lastActiveAt || now);
    await appendTitleEvent(cwd, {
      ts: now,
      workflowId,
      provider: entry.provider,
      sessionId: entry.sessionId,
      from,
      to: title,
      source: 'model',
      ...(sourceHash !== undefined ? { sourceHash } : {}),
    });
    return { status: 'applied' };
  });
}

// ── §H3 operator ops (rename / pin / archive) ──────────────────────────────
// Direct operator edits from the resume picker. All select an entry by its
// (provider, sessionId) key, read-modify-write atomically, and return the
// updated entry (or null when no entry matched — the picker surfaces that). All
// operator-initiated + reversible (these are the four-question fences, met).

export interface SessionSelector {
  provider: ProviderName;
  sessionId: string;
}

// Find + patch one entry by key. `patch` may set undefined to clear a field
// (dropped by JSON.stringify on write). Returns the merged entry or null.
async function mutateSessionEntry(
  cwd: string,
  sel: SessionSelector,
  patch: Partial<SessionIndexEntry>,
  now: number,
): Promise<SessionIndexEntry | null> {
  if (!cwd || !sel.provider || !sel.sessionId) return null;
  return withIndexLock(cwd, async () => {
    const index = await readSessionIndex(cwd);
    const idx = index.entries.findIndex((e) => sameSession(e, sel.provider, sel.sessionId));
    if (idx < 0) return null;
    const next = { ...index.entries[idx], ...patch };
    index.entries[idx] = next;
    await writeSessionIndex(cwd, index, next.lastActiveAt || now);
    return next;
  });
}

// Operator rename — the highest title layer (always wins, survives every
// derived refresh because mergeEntry guards titleSource='operator'). Logs the
// change to title-events.jsonl. An empty title is a no-op (returns the current
// entry) — there's no "revert to derived" path here (the operator can delete
// the index to rebuild). Caller awaits (it's a direct operator action).
export async function renameSession(
  cwd: string,
  sel: SessionSelector,
  title: string,
  now = Date.now(),
): Promise<SessionIndexEntry | null> {
  const clean = trimTitle(title);
  return withIndexLock(cwd, async () => {
    const index = await readSessionIndex(cwd);
    const idx = index.entries.findIndex((e) => sameSession(e, sel.provider, sel.sessionId));
    if (idx < 0) return null;
    const entry = index.entries[idx];
    if (!clean || clean === entry.title) return entry;
    const from = entry.title;
    const next: SessionIndexEntry = { ...entry, title: clean, titleSource: 'operator', titleGeneratedAt: now };
    index.entries[idx] = next;
    await writeSessionIndex(cwd, index, entry.lastActiveAt || now);
    await appendTitleEvent(cwd, {
      ts: now,
      workflowId: entry.workflowId ?? entry.sessionId,
      provider: entry.provider,
      sessionId: entry.sessionId,
      from,
      to: clean,
      source: 'operator',
      ...(entry.sourceHash !== undefined ? { sourceHash: entry.sourceHash } : {}),
    });
    return next;
  });
}

export async function setSessionPinned(cwd: string, sel: SessionSelector, pinned: boolean, now = Date.now()): Promise<SessionIndexEntry | null> {
  return mutateSessionEntry(cwd, sel, { pinned: pinned ? true : undefined }, now);
}

export async function setSessionArchived(cwd: string, sel: SessionSelector, archived: boolean, now = Date.now()): Promise<SessionIndexEntry | null> {
  return mutateSessionEntry(cwd, sel, { archived: archived ? true : undefined }, now);
}
