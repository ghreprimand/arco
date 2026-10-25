// Slot 5 — Continuity Phase D. Per-workflow event log on disk.
//
// Every workflow-scoped ServerMessage broadcast by the server is appended
// (with a monotonic `seq`) to <cwd>/.archon/workflows/<wfid>/events.jsonl.
// On reconnect, handleRehydrateWorkflows consults this log to stream any
// events the client missed while disconnected — making reconnect lossless
// across drops of arbitrary length.
//
// Invariants:
//   - Seq allocation is synchronous AFTER initWorkflowStore resolves for a
//     (cwd, wfid) pair. Callers must await init before the first broadcast,
//     otherwise seq stamping silently skips (message delivered live but not
//     persisted). handleCreateWorkflow / handleRehydrateWorkflows do this.
//   - Writes are coalesced. The buffer flushes on the 100ms debounce timer
//     OR when pendingBytes crosses 64KB, whichever first. Worst-case crash
//     loses ~100ms of events; seq gaps make the client notice next time.
//   - Flush serializes per workflow (one appendFile in flight at a time),
//     but loops until the buffer is drained so late arrivals during a flush
//     don't get stranded.
//   - wfid must match a UUID-ish shape (path-scope defense).

import { promises as fs, createReadStream } from 'fs';
import { createInterface } from 'readline';
import path from 'path';
import type { ServerMessage } from '@archon/shared';

const FLUSH_DEBOUNCE_MS = 100;
const FLUSH_BYTES_THRESHOLD = 64 * 1024;
// Read at most 1 MB from the tail of events.jsonl on init to find the latest
// seq. At 100 MB rotation cap and avg ~400B per event, 1 MB holds ~2500
// entries — plenty to scan backward for a well-formed line.
const INIT_TAIL_READ_BYTES = 1 * 1024 * 1024;
// Read at most 4 KB from the head of events.jsonl to find the first seq
// (snapshot-only rotation fallback). Entries are bounded well under 4 KB.
const FIRST_SEQ_HEAD_READ_BYTES = 4 * 1024;
const WFID_PATTERN = /^[a-zA-Z0-9-]{1,64}$/;

interface WorkflowBuffer {
  cwd: string;
  wfid: string;
  seq: number;                   // highest seq allocated so far
  initialized: boolean;
  pending: string[];             // NDJSON lines awaiting flush
  pendingBytes: number;
  flushTimer: NodeJS.Timeout | null;
  flushInFlight: Promise<void> | null;
  // Memoized init. Two concurrent inits used to both pass the `initialized`
  // check, the second's readLatestSeq landing AFTER the first had stamped
  // events — rolling buf.seq back and writing duplicate seqs to events.jsonl.
  initPromise: Promise<void> | null;
}

const buffers = new Map<string, WorkflowBuffer>();

function bufferKey(cwd: string, wfid: string): string {
  return `${cwd}::${wfid}`;
}

function workflowDir(cwd: string, wfid: string): string {
  return path.join(cwd, '.archon', 'workflows', wfid);
}

function eventsPath(cwd: string, wfid: string): string {
  return path.join(workflowDir(cwd, wfid), 'events.jsonl');
}

function validateWfid(wfid: string): void {
  if (!WFID_PATTERN.test(wfid)) {
    throw new Error(`workflowStore: invalid wfid shape ${JSON.stringify(wfid)}`);
  }
}

// Scan the tail of events.jsonl for the highest seq. Used on first touch of a
// workflow (fresh process, existing file on disk) to pick up where we left off.
async function readLatestSeq(filePath: string): Promise<number> {
  let stats;
  try {
    stats = await fs.stat(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
  if (stats.size === 0) return 0;
  const readSize = Math.min(stats.size, INIT_TAIL_READ_BYTES);
  const fh = await fs.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(readSize);
    await fh.read(buf, 0, readSize, stats.size - readSize);
    const text = buf.toString('utf8');
    const lines = text.split('\n').filter((l) => l.trim().length > 0);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (typeof entry.seq === 'number') return entry.seq;
      } catch { /* malformed tail — keep scanning */ }
    }
    return 0;
  } finally {
    await fh.close();
  }
}

// Prime the in-memory buffer for a workflow. Must be called (and awaited)
// before the first persistAndStampSeq for the pair. Idempotent: repeated
// calls are cheap no-ops once initialized, and concurrent calls share one
// in-flight init.
export async function initWorkflowStore(cwd: string, wfid: string): Promise<void> {
  if (!cwd) return;
  validateWfid(wfid);
  const key = bufferKey(cwd, wfid);
  let buf = buffers.get(key);
  if (buf?.initialized) return;
  if (!buf) {
    buf = {
      cwd,
      wfid,
      seq: 0,
      initialized: false,
      pending: [],
      pendingBytes: 0,
      flushTimer: null,
      flushInFlight: null,
      initPromise: null,
    };
    buffers.set(key, buf);
  }
  if (!buf.initPromise) buf.initPromise = primeBuffer(buf);
  await buf.initPromise;
}

async function primeBuffer(buf: WorkflowBuffer): Promise<void> {
  const { cwd, wfid } = buf;
  try {
    buf.seq = await readLatestSeq(eventsPath(cwd, wfid));
  } catch (err) {
    console.error(`[archon] workflowStore init failed for ${wfid.slice(0, 8)}:`, err);
    buf.seq = 0;
  }
  // Pre-create the artifacts directory. The worker-safety footer advertises
  // this path as "already exists" so workers write there on the first turn
  // without needing their own mkdir. Cheap (recursive, idempotent) and keeps
  // the cwd root clean of worker-written reports.
  try {
    await fs.mkdir(path.join(workflowDir(cwd, wfid), 'artifacts'), { recursive: true });
  } catch (err) {
    console.error(`[archon] artifacts dir mkdir failed for ${wfid.slice(0, 8)}:`, err);
  }
  // Drop a .archon/.gitignore on first-workflow-init per cwd so per-workflow
  // state (events.jsonl, transcript.md, artifacts, etc.) doesn't land in git
  // if the operator commits from the repo root. STATE.md + SCRATCHPADS/ live
  // at .archon/ top level (outside workflows/) and stay committable.
  // Write-once: skip if the file already exists so operator edits aren't
  // clobbered on every rehydrate.
  try {
    const gitignorePath = path.join(cwd, '.archon', '.gitignore');
    await fs.access(gitignorePath).catch(async () => {
      await fs.writeFile(
        gitignorePath,
        // session-index.json (ARCHON_OPS_PLAN.md §H1) + title-events.jsonl (§H2)
        // are rebuildable projections of meta.json/events.jsonl — ephemeral like
        // workflows/, so they're ignored too.
        '# Arco per-workflow state — ephemeral, don\'t commit\nworkflows/\nsession-index.json\ntitle-events.jsonl\n',
        'utf8',
      );
    });
  } catch (err) {
    console.error(`[archon] .archon/.gitignore write failed for ${wfid.slice(0, 8)}:`, err);
  }
  buf.initialized = true;
}

// Highest seq allocated so far for a workflow (0 when uninitialized). Used by
// the A2 checkpoint hook to derive a stable per-turn ref suffix without
// racing the broadcast stamp. Returns 0 when the store isn't ready.
export function currentSeq(cwd: string, wfid: string): number {
  if (!cwd) return 0;
  const buf = buffers.get(bufferKey(cwd, wfid));
  return buf?.initialized ? buf.seq : 0;
}

// Allocate a seq for `message`, queue an envelope for the next flush, and
// return the stamped wire form. Call site (server/src/index.ts send()) wraps
// this so every workflow-scoped broadcast carries a monotonic seq the client
// can track. Returns `message` unchanged when the store isn't ready (first-
// turn events during init, or missing cwd / wfid).
export function persistAndStampSeq(
  cwd: string,
  wfid: string,
  message: ServerMessage,
): ServerMessage {
  if (!cwd) return message;
  const buf = buffers.get(bufferKey(cwd, wfid));
  if (!buf || !buf.initialized) return message;
  // Phase 0 — link each event back to its predecessor for HISTORY (Phase 8)
  // and forks (Phase 9). Linear workflows: parent = previous seq. The very
  // first event has no parent (left undefined; readers treat absent as
  // "previous in seq order").
  const parentEventSeq = buf.seq > 0 ? buf.seq : undefined;
  buf.seq += 1;
  const seq = buf.seq;
  const ts = Date.now();
  // Cast through unknown: ServerMessage's union members don't declare `seq` /
  // `parentEventSeq` individually, but the wire convention (see protocol.ts
  // WorkflowEvent + ServerMessage comment) adds them to every workflow-scoped
  // broadcast. Client reads via an inline cast on the receive path.
  const stamped = {
    ...message,
    seq,
    ...(parentEventSeq !== undefined ? { parentEventSeq } : {}),
  } as unknown as ServerMessage;
  // On-disk envelope keeps `ts` separate from the message body so the replay
  // path can reconstruct the original broadcast shape cleanly.
  const line = JSON.stringify({
    seq,
    ts,
    ...(parentEventSeq !== undefined ? { parentEventSeq } : {}),
    ...message,
  }) + '\n';
  buf.pending.push(line);
  buf.pendingBytes += line.length;
  scheduleFlush(buf);
  return stamped;
}

function scheduleFlush(buf: WorkflowBuffer): void {
  if (buf.pendingBytes >= FLUSH_BYTES_THRESHOLD) {
    if (buf.flushTimer) {
      clearTimeout(buf.flushTimer);
      buf.flushTimer = null;
    }
    void flushBuffer(buf);
    return;
  }
  if (buf.flushTimer) return;
  buf.flushTimer = setTimeout(() => {
    buf.flushTimer = null;
    void flushBuffer(buf);
  }, FLUSH_DEBOUNCE_MS);
}

async function flushBuffer(buf: WorkflowBuffer): Promise<void> {
  if (buf.flushInFlight) {
    return buf.flushInFlight;
  }
  buf.flushInFlight = (async () => {
    const filePath = eventsPath(buf.cwd, buf.wfid);
    // Loop so events queued during the write are included in this flush
    // round and don't wait for the next debounce tick.
    while (buf.pending.length > 0) {
      const chunk = buf.pending.join('');
      buf.pending = [];
      buf.pendingBytes = 0;
      try {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.appendFile(filePath, chunk, 'utf8');
      } catch (err) {
        console.error(`[archon] workflowStore flush failed for ${buf.wfid.slice(0, 8)}:`, err);
        // Events are lost from disk for this round. The seq gap the client
        // sees on next reconnect triggers the snapshot-only fallback.
        return;
      }
    }
  })();
  try {
    await buf.flushInFlight;
  } finally {
    buf.flushInFlight = null;
  }
}

// Flush a single workflow's pending events to disk now (clearing its debounce
// timer). Used by the Genesis rebind (M2) before moving a workflow's on-disk
// store from the scratch ideation dir to the real project dir — every queued
// event must land in the scratch events.jsonl before the file moves. No-op if
// the buffer is absent. Never throws past flushBuffer's own handling.
export async function flushWorkflowBuffer(cwd: string, wfid: string): Promise<void> {
  if (!cwd) return;
  const buf = buffers.get(bufferKey(cwd, wfid));
  if (!buf) return;
  if (buf.flushTimer) {
    clearTimeout(buf.flushTimer);
    buf.flushTimer = null;
  }
  await flushBuffer(buf);
}

// Drop a workflow's in-memory buffer entry. Used by the Genesis rebind (M2)
// AFTER the on-disk store has moved + flushed: the stale `${scratchCwd}::${wfid}`
// buffer would otherwise linger (harmless but leaky), and the destination buffer
// is re-created fresh by initWorkflowStore(realDir) — which recovers the seq from
// the moved events.jsonl tail, so monotonic seq continuity is preserved across
// the move. Flush BEFORE calling this or pending events are lost.
export function forgetWorkflowBuffer(cwd: string, wfid: string): void {
  if (!cwd) return;
  buffers.delete(bufferKey(cwd, wfid));
}

// Best-effort sync for shutdown. Clears any pending debounce timers and
// awaits all in-flight + queued flushes. Never throws — the caller is
// probably exiting anyway.
export async function flushAll(): Promise<void> {
  const tasks: Promise<void>[] = [];
  for (const buf of buffers.values()) {
    if (buf.flushTimer) {
      clearTimeout(buf.flushTimer);
      buf.flushTimer = null;
    }
    if (buf.pending.length > 0 || buf.flushInFlight) {
      tasks.push(flushBuffer(buf));
    }
  }
  await Promise.all(tasks);
}

// Server's authoritative head seq for a workflow. Used by the snapshot
// emitter so the client can reset its persisted lastSeq.
export async function getHeadSeq(cwd: string, wfid: string): Promise<number> {
  if (!cwd) return 0;
  validateWfid(wfid);
  await initWorkflowStore(cwd, wfid);
  const buf = buffers.get(bufferKey(cwd, wfid));
  return buf?.seq ?? 0;
}

// Read the seq of the first line in events.jsonl. Null if the file is
// missing or empty. Used by handleRehydrateWorkflows to detect the gap-
// resolution-#4 rotation case: if clientLastSeq + 1 < firstSeq, the client's
// last seen event has rotated off disk and we fall back to snapshot-only
// rather than streaming a partial replay.
export async function readFirstSeq(cwd: string, wfid: string): Promise<number | null> {
  if (!cwd) return null;
  validateWfid(wfid);
  const filePath = eventsPath(cwd, wfid);
  let fh;
  try {
    fh = await fs.open(filePath, 'r');
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(FIRST_SEQ_HEAD_READ_BYTES);
    const { bytesRead } = await fh.read(buf, 0, FIRST_SEQ_HEAD_READ_BYTES, 0);
    if (bytesRead === 0) return null;
    const text = buf.subarray(0, bytesRead).toString('utf8');
    const nlIdx = text.indexOf('\n');
    const firstLine = nlIdx >= 0 ? text.slice(0, nlIdx) : text;
    if (!firstLine.trim()) return null;
    try {
      const entry = JSON.parse(firstLine);
      return typeof entry.seq === 'number' ? entry.seq : null;
    } catch {
      return null;
    }
  } finally {
    await fh.close();
  }
}

// Replay all events with seq > fromSeq, in seq order, preserving the on-disk
// `ts` (broadcast time) alongside each message. Used by the resume-picker
// merge path (index.ts) where we need timestamps to interleave events.jsonl
// entries with Claude CLI JSONL user prompts in chronological order.
// Stamped seq is preserved on the message as-is.
export async function replayEventsWithTs(
  cwd: string,
  wfid: string,
  fromSeq: number,
): Promise<Array<{ ts: number; message: ServerMessage }>> {
  if (!cwd) return [];
  validateWfid(wfid);
  const buf = buffers.get(bufferKey(cwd, wfid));
  if (buf) {
    if (buf.flushTimer) {
      clearTimeout(buf.flushTimer);
      buf.flushTimer = null;
    }
    await flushBuffer(buf);
  }
  const filePath = eventsPath(cwd, wfid);
  let text: string;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: Array<{ ts: number; message: ServerMessage }> = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry: { seq?: number; ts?: number; [k: string]: unknown };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry.seq !== 'number' || entry.seq <= fromSeq) continue;
    const ts = typeof entry.ts === 'number' ? entry.ts : 0;
    const { ts: _ts, ...rest } = entry;
    void _ts;
    out.push({ ts, message: rest as unknown as ServerMessage });
  }
  return out;
}

// Replay all events with seq > fromSeq, in seq order. Caller streams each
// returned ServerMessage to the newly-connected WS (stamped seq included on
// the wire object). Flushes pending first so the replay is head-current.
export async function replayEvents(
  cwd: string,
  wfid: string,
  fromSeq: number,
): Promise<ServerMessage[]> {
  if (!cwd) return [];
  validateWfid(wfid);
  const buf = buffers.get(bufferKey(cwd, wfid));
  if (buf) {
    if (buf.flushTimer) {
      clearTimeout(buf.flushTimer);
      buf.flushTimer = null;
    }
    await flushBuffer(buf);
  }
  const filePath = eventsPath(cwd, wfid);
  let text: string;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: ServerMessage[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry: { seq?: number; ts?: number; [k: string]: unknown };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry.seq !== 'number' || entry.seq <= fromSeq) continue;
    const { ts: _ts, ...rest } = entry;
    // `rest` carries seq + original message fields — the wire shape the
    // client expects from a live broadcast. Cast through unknown because
    // ServerMessage is a tagged union and we've stripped nothing essential.
    void _ts;
    out.push(rest as unknown as ServerMessage);
  }
  return out;
}

// Tail-first replay for a browser that has never seen this workflow (a tab
// mirrored from another browser via server/src/workspace.ts). Reads only the
// last `maxBytes` of events.jsonl and starts at the first turn boundary
// (`user_message_echo`) inside that window, so no streaming delta is
// stranded without its start. 2026-10-14 incident: a fresh MacBook browser
// full-replayed 73 mirrored tabs from seq 0 at once (three 103 MB logs) and
// OOM-killed the shared server under the workstation's browser too.
export async function replayTailEvents(
  cwd: string,
  wfid: string,
  maxBytes: number,
): Promise<{ events: ServerMessage[]; truncated: boolean }> {
  if (!cwd) return { events: [], truncated: false };
  validateWfid(wfid);
  const buf = buffers.get(bufferKey(cwd, wfid));
  if (buf) {
    if (buf.flushTimer) {
      clearTimeout(buf.flushTimer);
      buf.flushTimer = null;
    }
    await flushBuffer(buf);
  }
  const filePath = eventsPath(cwd, wfid);
  let size: number;
  try {
    size = (await fs.stat(filePath)).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { events: [], truncated: false };
    throw err;
  }
  if (size <= maxBytes) return { events: await replayEvents(cwd, wfid, 0), truncated: false };
  const fh = await fs.open(filePath, 'r');
  let text: string;
  try {
    const chunk = Buffer.alloc(maxBytes);
    const { bytesRead } = await fh.read(chunk, 0, maxBytes, size - maxBytes);
    text = chunk.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
  // The first line is almost certainly cut mid-record (and may start mid
  // UTF-8 sequence) — drop it.
  const lines = text.split('\n').slice(1);
  const parsed: Array<{ type?: string; [k: string]: unknown }> = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: { seq?: number; ts?: number; type?: string; [k: string]: unknown };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry.seq !== 'number') continue;
    const { ts: _ts, ...rest } = entry;
    void _ts;
    parsed.push(rest);
  }
  const boundary = parsed.findIndex((e) => e.type === 'user_message_echo');
  const events = (boundary >= 0 ? parsed.slice(boundary) : parsed) as unknown as ServerMessage[];
  return { events, truncated: true };
}

// Stream events.jsonl and return only events whose `type` is in `types`,
// JSON-parsing just the lines that textually mention one of them. For the
// per-rehydrate scans (task lifecycle, Z.ai prompt tokens) that used to
// replayEvents(…, 0) the whole log — a full parse of a 100 MB log per tab per
// reconnect was most of the 2026-10-14 OOM's heap.
// A synchronous visitor projects events without retaining the matching history;
// callers needing only the latest reply keep bounded memory even on long logs.
export async function scanEventsOfTypes(
  cwd: string,
  wfid: string,
  types: readonly string[],
  visit?: (event: ServerMessage) => void,
): Promise<ServerMessage[]> {
  if (!cwd) return [];
  validateWfid(wfid);
  const buf = buffers.get(bufferKey(cwd, wfid));
  if (buf) {
    if (buf.flushTimer) {
      clearTimeout(buf.flushTimer);
      buf.flushTimer = null;
    }
    await flushBuffer(buf);
  }
  const needles = types.map((t) => `"${t}"`);
  const out: ServerMessage[] = [];
  const stream = createReadStream(eventsPath(cwd, wfid), { encoding: 'utf8' });
  try {
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!needles.some((n) => line.includes(n))) continue;
      let entry: { seq?: number; ts?: number; type?: string; [k: string]: unknown };
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof entry.seq !== 'number' || !entry.type || !types.includes(entry.type)) continue;
      const { ts: _ts, ...rest } = entry;
      void _ts;
      const event = rest as unknown as ServerMessage;
      if (visit) visit(event);
      else out.push(event);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  } finally {
    stream.destroy();
  }
  return out;
}

export async function readEventsPageBefore(
  cwd: string,
  wfid: string,
  beforeSeq: number,
  limit: number,
): Promise<{ events: ServerMessage[]; hasEarlier: boolean; earlierCursor?: number; total: number }> {
  if (!cwd) return { events: [], hasEarlier: false, total: 0 };
  validateWfid(wfid);
  const buf = buffers.get(bufferKey(cwd, wfid));
  if (buf) {
    if (buf.flushTimer) {
      clearTimeout(buf.flushTimer);
      buf.flushTimer = null;
    }
    await flushBuffer(buf);
  }
  const filePath = eventsPath(cwd, wfid);
  let text: string;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { events: [], hasEarlier: false, total: 0 };
    }
    throw err;
  }
  const parsed: ServerMessage[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry: { seq?: number; ts?: number; [k: string]: unknown };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry.seq !== 'number') continue;
    if (Number.isFinite(beforeSeq) && entry.seq >= beforeSeq) continue;
    const { ts, ...rest } = entry;
    parsed.push({
      ...rest,
      ...(typeof ts === 'number' ? { ts } : {}),
    } as unknown as ServerMessage);
  }
  const total = parsed.length;
  const start = Math.max(0, total - limit);
  const events = parsed.slice(start);
  const hasEarlier = start > 0;
  const firstSeq = events.length > 0 ? (events[0] as { seq?: number }).seq : undefined;
  return {
    events,
    hasEarlier,
    ...(hasEarlier && typeof firstSeq === 'number' ? { earlierCursor: firstSeq } : {}),
    total,
  };
}
