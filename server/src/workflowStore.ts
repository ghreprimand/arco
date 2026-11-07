import { ensureProjectStateIgnore } from './projectStateIgnore.js';
// Slot 5 — Continuity Phase D. Per-workflow event log on disk.
//
// Every workflow-scoped ServerMessage broadcast by the server is appended
// (with a monotonic `seq`) to <cwd>/.arco/workflows/<wfid>/events.jsonl.
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

import { promises as fs } from 'fs';
import path from 'path';
import {
  LOG_FORMAT, firstSealedSeq, readLogFormat, readLogLines, readLogTail, sealLiveLog,
  sealThresholdBytes, highestNamedSeq, lineSeq, listSegments, type SealResult,
} from './eventLog.js';
import type { ServerMessage } from '@arco/shared';

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
  // Bytes in the live events.jsonl (P7.3). Sealing runs after an append that
  // takes it past the seal threshold; a failed seal waits for another
  // threshold's worth of growth before it is tried again.
  liveBytes: number;
  sealRetryAt: number;
  // A log written by a newer release (format above LOG_FORMAT): events are
  // still delivered live but not written, so the newer history is not damaged.
  readOnly: boolean;
}

const buffers = new Map<string, WorkflowBuffer>();

function bufferKey(cwd: string, wfid: string): string {
  return `${cwd}::${wfid}`;
}

function workflowDir(cwd: string, wfid: string): string {
  return path.join(cwd, '.arco', 'workflows', wfid);
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

// Effective sequence numbers. Releases before 0.1.5 wrote a checkpoint
// record with its checkpoint's number instead of the next one, so a log can
// repeat a number (every checkpoint) or go back to an older one (REVERT TO
// HERE), and a restart right after such a record continued numbering from it,
// reusing numbers already in the log. Nothing on disk is rewritten: readers
// give every record, in file order, the effective number max(own, previous
// effective + 1). A log in order keeps its numbers.
type SeqStep = (raw: number) => { seq: number; parent: number | undefined };
function seqStepper(prev = 0): SeqStep {
  return (raw) => {
    const parent = prev > 0 ? prev : undefined;
    const seq = raw > prev ? raw : prev + 1;
    prev = seq;
    return { seq, parent };
  };
}
// Rewrites a parsed record to its effective number (and its predecessor) when
// the two differ.
function applyStep(entry: { seq?: unknown; parentEventSeq?: unknown }, step: { seq: number; parent: number | undefined }): void {
  if (entry.seq === step.seq) return;
  entry.seq = step.seq;
  if (step.parent !== undefined) entry.parentEventSeq = step.parent;
  else delete entry.parentEventSeq;
}

// Per conversation folder: the last effective number, and whether effective
// numbers differ from the written ones past a record the log already held
// (`drift`). Without drift, a reader may start partway through (a tail, or
// after the sealed segments it skips) and still get the same numbers as a
// full read; with drift, readers read the whole history. Numbers written by
// this release always follow the last effective one, so they never add drift.
interface SeqScan { effEnd: number; drift: boolean }
const seqScans = new Map<string, SeqScan>();
async function scanSeqs(dir: string): Promise<SeqScan> {
  const step = seqStepper();
  let effEnd = 0, maxRaw = 0, drift = false;
  for await (const line of readLogLines(dir)) {
    const raw = lineSeq(line);
    if (raw === null) continue;
    const { seq } = step(raw);
    if (raw < maxRaw || (raw > maxRaw && seq !== raw)) drift = true;
    if (raw > maxRaw) maxRaw = raw;
    effEnd = seq;
  }
  const scan = { effEnd, drift };
  if (seqScans.size > 4096) seqScans.clear();
  seqScans.set(dir, scan);
  return scan;
}
async function historyDrift(dir: string): Promise<boolean> {
  return (seqScans.get(dir) ?? await scanSeqs(dir)).drift;
}

// Every record line with its effective number, from `fromSeq` on (records at
// or below it are still yielded; callers filter on the effective number).
async function* effectiveLines(dir: string, fromSeq = 0): AsyncGenerator<{ line: string; raw: number | null; step?: { seq: number; parent: number | undefined } }> {
  let start = 0;
  if (fromSeq > 0 && !(await historyDrift(dir))) {
    // Whole segments below fromSeq are skipped by readLogLines; the effective
    // numbers carry on from the highest number they hold.
    for (const seg of await listSegments(dir)) if (seg.lastSeq < fromSeq) start = Math.max(start, seg.lastSeq);
  } else fromSeq = 0;
  const step = seqStepper(start);
  for await (const line of readLogLines(dir, { fromSeq })) {
    const raw = lineSeq(line);
    yield raw === null ? { line, raw } : { line, raw, step: step(raw) };
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
      liveBytes: 0,
      sealRetryAt: 0,
      readOnly: false,
    };
    buffers.set(key, buf);
  }
  if (!buf.initPromise) buf.initPromise = primeBuffer(buf);
  try { await buf.initPromise; } catch (error) { buf.initPromise = null; throw error; }
}

// A crash or a failed append can leave the live log ending without a newline.
// Appending then would glue the next event to that record and both would be
// skipped on replay. A complete record only gets its newline. An incomplete one
// is copied (and flushed) to `events.jsonl.partial-<time>` beside the log,
// then cut from the live file, so every line of the log parses again.
async function repairLiveTail(filePath: string, wfid: string): Promise<void> {
  let fh;
  try { fh = await fs.open(filePath, 'r+'); } catch { return; }
  try {
    const size = (await fh.stat()).size;
    if (size === 0) return;
    const last = Buffer.alloc(1);
    await fh.read(last, 0, 1, size - 1);
    if (last[0] === 0x0a) return;
    // Find the start of the last line, reading backwards.
    let start = 0;
    const CHUNK = 64 * 1024;
    for (let end = size; end > 0 && start === 0; end -= CHUNK) {
      const from = Math.max(0, end - CHUNK);
      const buf = Buffer.alloc(end - from);
      await fh.read(buf, 0, buf.length, from);
      const nl = buf.lastIndexOf(0x0a);
      if (nl >= 0) start = from + nl + 1;
      if (from === 0) break;
    }
    const tail = Buffer.alloc(size - start);
    await fh.read(tail, 0, tail.length, start);
    let complete = false;
    try { const v = JSON.parse(tail.toString('utf8')); complete = !!v && typeof v === 'object'; } catch { /* incomplete */ }
    if (complete) {
      await fh.write('\n', size);
      await fh.sync();
      return;
    }
    const aside = `${filePath}.partial-${Date.now()}`;
    const out = await fs.open(aside, 'wx', 0o600);
    try { await out.writeFile(tail); await out.sync(); } finally { await out.close(); }
    await fh.truncate(start);
    await fh.sync();
    console.error(`[arco] workflow ${wfid.slice(0, 8)}: the log ended in an incomplete record (${tail.length} bytes); it was moved to ${path.basename(aside)} and new events start on a new line`);
  } finally { await fh.close(); }
}

async function primeBuffer(buf: WorkflowBuffer): Promise<void> {
  const { cwd, wfid } = buf;
  // Not for a log a newer release wrote: this release does not write to it.
  if (await readLogFormat(workflowDir(cwd, wfid)) <= LOG_FORMAT) {
    await repairLiveTail(eventsPath(cwd, wfid), wfid).catch((err) => console.error(`[arco] workflow ${wfid.slice(0, 8)}: checking the end of its log failed:`, err));
  }
  try {
    // A live file that holds no record (all of it sealed) falls back to the
    // highest sequence number any segment name has claimed, damaged ones moved
    // aside included, so no number is ever reused.
    // Continue after the last effective number, so a log written by an older
    // release never gets a number again that it already holds.
    const scan = await scanSeqs(workflowDir(cwd, wfid));
    buf.seq = Math.max(scan.effEnd, await readLatestSeq(eventsPath(cwd, wfid)), await highestNamedSeq(workflowDir(cwd, wfid)));
  } catch (err) {
    console.error(`[arco] workflowStore init failed for ${wfid.slice(0, 8)}:`, err);
    buf.seq = 0;
  }
  try { buf.liveBytes = (await fs.stat(eventsPath(cwd, wfid))).size; } catch { buf.liveBytes = 0; }
  if (await readLogFormat(workflowDir(cwd, wfid)) > LOG_FORMAT) {
    buf.readOnly = true;
    console.error(`[arco] workflow ${wfid.slice(0, 8)}: its log was written by a newer Arco release; new events are shown but not saved. Update Arco to continue saving this conversation.`);
  }
  // Protect all project state before creating the first workflow directory.
  ensureProjectStateIgnore(cwd);
  await fs.mkdir(path.join(workflowDir(cwd, wfid), 'artifacts'), { recursive: true });
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
  if (!buf || !buf.initialized || buf.readOnly) return message;
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
  // The log assigns the number. A `seq` or `parentEventSeq` in the payload
  // (a re-sent event, or a field named like the envelope) never replaces it;
  // releases before 0.1.5 let a checkpoint's own number through to disk.
  // `eventTs` is the wire copy of the envelope `ts` (see replayEvents); it is
  // never written into the body.
  const { seq: _payloadSeq, parentEventSeq: _payloadParent, eventTs: _payloadTs, ...body } = message as ServerMessage & { seq?: unknown; parentEventSeq?: unknown; eventTs?: unknown };
  void _payloadSeq; void _payloadParent; void _payloadTs;
  const stamped = {
    ...body,
    seq,
    ...(parentEventSeq !== undefined ? { parentEventSeq } : {}),
    eventTs: ts,
  } as unknown as ServerMessage;
  // On-disk envelope keeps `ts` separate from the message body so the replay
  // path can reconstruct the original broadcast shape cleanly.
  const line = JSON.stringify({
    seq,
    ts,
    ...(parentEventSeq !== undefined ? { parentEventSeq } : {}),
    ...body,
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
        console.error(`[arco] workflowStore flush failed for ${buf.wfid.slice(0, 8)}:`, err);
        // Events are lost from disk for this round. The seq gap the client
        // sees on next reconnect triggers the snapshot-only fallback.
        return;
      }
      buf.liveBytes += Buffer.byteLength(chunk);
      // P7.3: seal the live file into compressed segments once it is large.
      // Runs inside this flush chain, so nothing appends meanwhile; new events
      // wait in `pending` and land in the fresh live file.
      const threshold = sealThresholdBytes();
      if (buf.liveBytes >= Math.max(threshold, buf.sealRetryAt)) {
        try {
          const sealed = await sealLiveLog(path.dirname(filePath), threshold);
          if (sealed) buf.liveBytes = sealed.liveBytes;
          // A live file that could not be replaced yet (held open on Windows)
          // is tried again after a little more growth, not on every flush.
          buf.sealRetryAt = sealed && !sealed.liveReplaced ? buf.liveBytes + Math.max(1024, Math.floor(threshold / 4)) : 0;
        } catch (err) {
          console.error(`[arco] sealing the log of ${buf.wfid.slice(0, 8)} failed; it stays a plain file:`, err);
          buf.sealRetryAt = buf.liveBytes + threshold;
        }
      }
    }
  })();
  try {
    await buf.flushInFlight;
  } finally {
    buf.flushInFlight = null;
  }
}

// COMPRESS OLD LOGS (P7.3/P7.5): seal a conversation's live log now, inside
// its flush chain so no append can land between reading and replacing the
// live file. Pending events are written first; events arriving meanwhile
// wait and land in the new live file. Returns null when nothing was sealed.
export async function sealWorkflowLogNow(cwd: string, wfid: string): Promise<SealResult | null> {
  validateWfid(wfid);
  await initWorkflowStore(cwd, wfid);
  const buf = buffers.get(bufferKey(cwd, wfid));
  if (!buf) return null;
  if (buf.readOnly) throw new Error('This conversation log uses a newer storage format.');
  if (buf.flushTimer) { clearTimeout(buf.flushTimer); buf.flushTimer = null; }
  await flushBuffer(buf);
  while (buf.flushInFlight) await buf.flushInFlight;
  let result: SealResult | null = null;
  const run = (async () => {
    result = await sealLiveLog(workflowDir(cwd, wfid), sealThresholdBytes());
    if (result) buf.liveBytes = result.liveBytes;
  })();
  buf.flushInFlight = run;
  try { await run; } finally { if (buf.flushInFlight === run) buf.flushInFlight = null; }
  if (buf.pending.length) await flushBuffer(buf);
  return result;
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
  const sealedFirst = await firstSealedSeq(workflowDir(cwd, wfid)).catch(() => null);
  if (sealedFirst !== null) return sealedFirst;
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
  const out: Array<{ ts: number; message: ServerMessage }> = [];
  for await (const { line, step } of effectiveLines(workflowDir(cwd, wfid), fromSeq)) {
    if (!step || step.seq <= fromSeq) continue;
    let entry: { seq?: number; ts?: number; [k: string]: unknown };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry.seq !== 'number') continue;
    applyStep(entry, step);
    const ts = typeof entry.ts === 'number' ? entry.ts : 0;
    const { ts: _ts, ...rest } = entry;
    void _ts;
    out.push({ ts, message: rest as unknown as ServerMessage });
  }
  return out;
}

// A replayed event in its live wire shape: the envelope `ts` (the time the
// event was written) rides as `eventTs`, as on a live broadcast, so a reload
// shows each chat row at the time of its own first event.
function withEventTs(entry: { ts?: unknown; [k: string]: unknown }): { [k: string]: unknown } {
  const { ts, ...rest } = entry;
  return typeof ts === 'number' ? { ...rest, eventTs: ts } : rest;
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
  const out: ServerMessage[] = [];
  for await (const { line, step } of effectiveLines(workflowDir(cwd, wfid), fromSeq)) {
    if (!step || step.seq <= fromSeq) continue;
    let entry: { seq?: number; ts?: number; [k: string]: unknown };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry.seq !== 'number') continue;
    applyStep(entry, step);
    // `rest` carries seq + original message fields — the wire shape the
    // client expects from a live broadcast. Cast through unknown because
    // ServerMessage is a tagged union and we've stripped nothing essential.
    out.push(withEventTs(entry) as unknown as ServerMessage);
  }
  return out;
}

// Tail-first replay for a newly connected browser bounds the data read and
// starts at a turn boundary so no streaming delta is stranded without a start.
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
  // Live tail, plus the newest sealed segments when the live file is short.
  // A log whose effective numbers drift (see scanSeqs) is read whole, so the
  // numbers match every other reader's.
  const tail = await readLogTail(workflowDir(cwd, wfid), maxBytes);
  if (!tail.truncated || await historyDrift(workflowDir(cwd, wfid))) return { events: await replayEvents(cwd, wfid, 0), truncated: false };
  // The first line is almost certainly cut mid-record (and may start mid
  // UTF-8 sequence) — drop it.
  const lines = tail.text.split('\n').slice(1);
  const parsed: Array<{ type?: string; [k: string]: unknown }> = [];
  // Without drift, the first record of the tail that is higher than every one
  // before it in the tail keeps its number; repeated numbers after it are
  // renumbered as a full read would.
  let step: SeqStep | null = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: { seq?: number; ts?: number; type?: string; [k: string]: unknown };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry.seq !== 'number') continue;
    if (!step) step = seqStepper(entry.seq - 1);
    applyStep(entry, step(entry.seq));
    parsed.push(withEventTs(entry));
  }
  const boundary = parsed.findIndex((e) => e.type === 'user_message_echo');
  const events = (boundary >= 0 ? parsed.slice(boundary) : parsed) as unknown as ServerMessage[];
  return { events, truncated: true };
}

// Stream events.jsonl and return only events whose `type` is in `types`,
// JSON-parsing just the lines that textually mention one of them. For the
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
  {
    for await (const { line, step } of effectiveLines(workflowDir(cwd, wfid))) {
      if (!step || !needles.some((n) => line.includes(n))) continue;
      let entry: { seq?: number; ts?: number; type?: string; [k: string]: unknown };
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof entry.seq !== 'number' || !entry.type || !types.includes(entry.type)) continue;
      applyStep(entry, step);
      const { ts: _ts, ...rest } = entry;
      void _ts;
      const event = rest as unknown as ServerMessage;
      if (visit) visit(event);
      else out.push(event);
    }
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
  const parsed: ServerMessage[] = [];
  for await (const { line, step } of effectiveLines(workflowDir(cwd, wfid))) {
    if (!step) continue;
    if (Number.isFinite(beforeSeq) && step.seq >= beforeSeq) continue;
    let entry: { seq?: number; ts?: number; [k: string]: unknown };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry.seq !== 'number') continue;
    applyStep(entry, step);
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
