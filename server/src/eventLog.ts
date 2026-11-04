// Sealed, compressed log segments (P7.3, docs/STORAGE_PLAN.md).
//
// A conversation folder holds the live log `events.jsonl` (plain NDJSON,
// appended by workflowStore) and, once it has grown past the seal threshold,
// sealed segments `events.<firstSeq>-<lastSeq>.jsonl.br`: Brotli-compressed
// records, sequence numbers zero-padded to 12 digits so name order is sequence
// order. Every reader goes through this module and sees one history: segments
// in order, then the live file, each record once.
//
// Sealing never loses a record. Segments are written to a temporary file,
// flushed, renamed and read back before the live file is replaced, and the
// newest sealed record is copied into the new live file so that a release
// which reads only `events.jsonl` still continues the sequence. Readers skip
// any live record at or below the newest sealed sequence number, which also
// covers a seal interrupted between writing segments and replacing the live
// file.

import { promises as fs, createReadStream, closeSync, fstatSync, openSync, readFileSync, readSync, readdirSync, constants as fsConstants } from 'node:fs';
import { createInterface } from 'node:readline';
import { brotliCompress, brotliDecompressSync, createBrotliDecompress, constants as zc } from 'node:zlib';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import { renameWithRetry } from './atomicFile.js';

const compress = promisify(brotliCompress);

export const LIVE_LOG = 'events.jsonl';
export const FORMAT_FILE = 'log-format.json';
// Format 2 = sealed segments. A release that knows only format 1 (plain log)
// refuses nothing; a later release that finds a format above the one it knows
// must refuse to write.
export const LOG_FORMAT = 2;
const SEGMENT_RE = /^events\.(\d{12})-(\d{12})\.jsonl\.br$/;
const SEGMENT_TMP_RE = /^events\.\d{12}-\d{12}\.jsonl\.br\.[0-9a-f-]+\.tmp$/;
const LIVE_TMP_RE = /^events\.jsonl\.[0-9a-f-]+\.tmp$/;
const SEQ_RE = /^\{"seq":(\d+)[,}]/;

export const DEFAULT_SEAL_BYTES = 16 * 1024 * 1024;
export function sealThresholdBytes(): number {
  const raw = Number(process.env.ARCO_EVENT_SEGMENT_BYTES);
  return Number.isFinite(raw) && raw >= 1024 ? Math.floor(raw) : DEFAULT_SEAL_BYTES;
}

export interface Segment { name: string; file: string; firstSeq: number; lastSeq: number }

function pad(n: number): string { return String(n).padStart(12, '0'); }
export function segmentName(firstSeq: number, lastSeq: number): string {
  return `events.${pad(firstSeq)}-${pad(lastSeq)}.jsonl.br`;
}

function parseSegments(dir: string, names: string[]): Segment[] {
  const out: Segment[] = [];
  for (const name of names) {
    const m = SEGMENT_RE.exec(name);
    if (!m) continue;
    out.push({ name, file: path.join(dir, name), firstSeq: Number(m[1]), lastSeq: Number(m[2]) });
  }
  return out.sort((a, b) => a.firstSeq - b.firstSeq || a.lastSeq - b.lastSeq);
}
export async function listSegments(dir: string): Promise<Segment[]> {
  try { return parseSegments(dir, await fs.readdir(dir)); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []; throw err; }
}
export function listSegmentsSync(dir: string): Segment[] {
  try { return parseSegments(dir, readdirSync(dir)); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []; throw err; }
}

// Sequence number of a record line without a full parse when the line has the
// writer's shape (`{"seq":N,...`); falls back to JSON for anything else.
export function lineSeq(line: string): number | null {
  const m = SEQ_RE.exec(line);
  if (m) return Number(m[1]);
  try {
    const v = JSON.parse(line) as { seq?: unknown };
    return typeof v.seq === 'number' ? v.seq : null;
  } catch { return null; }
}

export class SegmentReadError extends Error {
  constructor(readonly file: string, cause: unknown) {
    super(`Sealed log segment ${path.basename(file)} could not be read`);
    this.cause = cause;
  }
}
function reportUnreadable(err: unknown): void {
  console.error(`[arco] ${err instanceof Error ? err.message : String(err)}; skipping it, the rest of the history stays readable`);
}

async function* segmentLines(seg: Segment): AsyncGenerator<string> {
  const input = createReadStream(seg.file);
  const rl = createInterface({ input: input.pipe(createBrotliDecompress()), crlfDelay: Infinity });
  try {
    for await (const line of rl) if (line) yield line;
  } catch (err) {
    throw new SegmentReadError(seg.file, err);
  } finally {
    rl.close(); input.destroy();
  }
}

async function openLive(file: string): Promise<FileHandle | null> {
  try { return await fs.open(file, 'r'); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null; throw err; }
}

async function* handleLines(fh: FileHandle): AsyncGenerator<string> {
  const input = fh.createReadStream({ autoClose: false });
  const rl = createInterface({ input, crlfDelay: Infinity });
  try { for await (const line of rl) if (line) yield line; }
  finally { rl.close(); input.destroy(); }
}

async function* liveLines(file: string): AsyncGenerator<string> {
  const fh = await openLive(file);
  if (!fh) return;
  try { yield* handleLines(fh); } finally { await fh.close(); }
}

// Every record line in sequence order: sealed segments, then the live file.
// `fromSeq` skips whole segments that end at or before it (callers still
// filter individual lines, as they did on the plain log). An unreadable
// segment is reported and skipped; its records show as a gap.
//
// A seal can finish while this runs. The live file is opened (and so pinned)
// before the segment list is read a second time: whichever live file is
// pinned, every record not in a listed segment is in it, and records already
// sealed are skipped by sequence number.
export async function* readLogLines(dir: string, opts: { fromSeq?: number } = {}): AsyncGenerator<string> {
  const fromSeq = opts.fromSeq ?? 0;
  const done = new Set<string>();
  let sealedThrough = 0;
  async function* drainSegments(): AsyncGenerator<string> {
    for (const seg of await listSegments(dir)) {
      if (done.has(seg.name)) continue;
      done.add(seg.name);
      sealedThrough = Math.max(sealedThrough, seg.lastSeq);
      if (seg.lastSeq <= fromSeq) continue;
      try { for await (const line of segmentLines(seg)) yield line; }
      catch (err) { if (err instanceof SegmentReadError) reportUnreadable(err); else throw err; }
    }
  }
  yield* drainSegments();
  const fh = await openLive(path.join(dir, LIVE_LOG));
  try {
    yield* drainSegments();
    if (!fh) return;
    for await (const line of handleLines(fh)) {
      if (sealedThrough > 0) { const seq = lineSeq(line); if (seq !== null && seq <= sealedThrough) continue; }
      yield line;
    }
  } finally { await fh?.close(); }
}

// The whole history as one NDJSON text (each record once, newline-terminated).
// Same memory profile as reading a plain log with readFile.
export async function readLogText(dir: string): Promise<string> {
  const parts: string[] = [];
  for await (const line of readLogLines(dir)) parts.push(line);
  return parts.length ? parts.join('\n') + '\n' : '';
}

function decompressSegmentSync(seg: Segment): string {
  try { return brotliDecompressSync(readFileSync(seg.file)).toString('utf8'); }
  catch (err) { throw new SegmentReadError(seg.file, err); }
}

function liveTextSync(file: string): { text: string; size: number } {
  try { const text = readFileSync(file, 'utf8'); return { text, size: Buffer.byteLength(text) }; }
  catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { text: '', size: 0 }; throw err; }
}

function dropSealed(text: string, sealedThrough: number): string {
  if (!sealedThrough || !text) return text;
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line) { i++; continue; }
    const seq = lineSeq(line);
    if (seq !== null && seq <= sealedThrough) { i++; continue; }
    break;
  }
  return lines.slice(i).join('\n');
}

export function readLogTextSync(dir: string): string {
  const segments = listSegmentsSync(dir);
  let out = '', sealedThrough = 0;
  for (const seg of segments) {
    sealedThrough = Math.max(sealedThrough, seg.lastSeq);
    try { out += decompressSegmentSync(seg); } catch (err) { reportUnreadable(err); }
  }
  return out + dropSealed(liveTextSync(path.join(dir, LIVE_LOG)).text, sealedThrough);
}

// The last `maxBytes` of the history, possibly starting mid-record (callers
// drop the first line when `truncated`, as they did on the plain log). Reads
// only the live file's tail when it is long enough; otherwise prepends the
// newest segments. The live file is pinned before segments are listed (see
// readLogLines).
export async function readLogTail(dir: string, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const fh = await openLive(path.join(dir, LIVE_LOG));
  let live = '';
  try {
    if (fh) {
      const size = (await fh.stat()).size;
      if (size >= maxBytes) {
        const buf = Buffer.alloc(maxBytes);
        const { bytesRead } = await fh.read(buf, 0, maxBytes, size - maxBytes);
        return { text: buf.subarray(0, bytesRead).toString('utf8'), truncated: true };
      }
      const buf = Buffer.alloc(size);
      const { bytesRead } = await fh.read(buf, 0, size, 0);
      live = buf.subarray(0, bytesRead).toString('utf8');
    }
  } finally { await fh?.close(); }
  const segments = await listSegments(dir);
  const sealedThrough = segments.length ? segments[segments.length - 1].lastSeq : 0;
  let text = dropSealed(live, sealedThrough);
  let i = segments.length - 1;
  while (i >= 0 && Buffer.byteLength(text) < maxBytes) {
    try { text = (await segmentText(segments[i])) + text; }
    catch (err) { if (!(err instanceof SegmentReadError)) throw err; reportUnreadable(err); break; }
    i--;
  }
  return clipTail(text, maxBytes, i >= 0);
}

function clipTail(text: string, maxBytes: number, more: boolean): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > maxBytes) return { text: bytes.subarray(bytes.length - maxBytes).toString('utf8'), truncated: true };
  return { text, truncated: more };
}

async function segmentText(seg: Segment): Promise<string> {
  const parts: string[] = [];
  for await (const line of segmentLines(seg)) parts.push(line);
  return parts.length ? parts.join('\n') + '\n' : '';
}

export function readLogTailSync(dir: string, maxBytes: number): { text: string; truncated: boolean } {
  const file = path.join(dir, LIVE_LOG);
  let fd = -1;
  try { fd = openSync(file, fsConstants.O_RDONLY); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
  let live = '';
  if (fd >= 0) {
    try {
      const size = fstatSync(fd).size;
      const want = Math.min(size, maxBytes);
      const buf = Buffer.alloc(want);
      const n = readSync(fd, buf, 0, want, size - want);
      if (size >= maxBytes) return { text: buf.subarray(0, n).toString('utf8'), truncated: true };
      live = buf.subarray(0, n).toString('utf8');
    } finally { closeSync(fd); }
  }
  const segments = listSegmentsSync(dir);
  const sealedThrough = segments.length ? segments[segments.length - 1].lastSeq : 0;
  let text = dropSealed(live, sealedThrough);
  let i = segments.length - 1;
  while (i >= 0 && Buffer.byteLength(text) < maxBytes) {
    try { text = decompressSegmentSync(segments[i]) + text; } catch (err) { reportUnreadable(err); break; }
    i--;
  }
  return clipTail(text, maxBytes, i >= 0);
}

// The first `maxBytes` of the history (synchronous; for head readers such as
// session titles). Decompresses at most the oldest segments needed.
export function readLogHeadSync(dir: string, maxBytes: number): string {
  const segments = listSegmentsSync(dir);
  let text = '';
  for (const seg of segments) {
    try { text += decompressSegmentSync(seg); } catch (err) { reportUnreadable(err); }
    if (Buffer.byteLength(text) >= maxBytes) return Buffer.from(text).subarray(0, maxBytes).toString('utf8');
  }
  const sealedThrough = segments.length ? segments[segments.length - 1].lastSeq : 0;
  const file = path.join(dir, LIVE_LOG);
  let live = '';
  let fd = -1;
  try { fd = openSync(file, fsConstants.O_RDONLY); } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
  if (fd >= 0) {
    try {
      const want = maxBytes - Buffer.byteLength(text) + 1024 * 1024; // room for the copied sealed record
      const buf = Buffer.alloc(Math.max(0, want));
      const n = readSync(fd, buf, 0, buf.length, 0);
      live = buf.subarray(0, n).toString('utf8');
    } finally { closeSync(fd); }
  }
  text += dropSealed(live, sealedThrough);
  return Buffer.from(text).subarray(0, maxBytes).toString('utf8');
}

// Newest sealed sequence number (0 when nothing is sealed). Read from file
// names only.
export async function sealedThroughSeq(dir: string): Promise<number> {
  const segments = await listSegments(dir);
  return segments.length ? segments[segments.length - 1].lastSeq : 0;
}
export async function firstSealedSeq(dir: string): Promise<number | null> {
  const segments = await listSegments(dir);
  return segments.length ? segments[0].firstSeq : null;
}

export async function readLogFormat(dir: string): Promise<number> {
  try {
    const v = JSON.parse(await fs.readFile(path.join(dir, FORMAT_FILE), 'utf8')) as { format?: unknown };
    return typeof v.format === 'number' ? v.format : 1;
  } catch { return 1; }
}

async function fsyncDir(dir: string): Promise<void> {
  // Directories cannot be opened for fsync on Windows; the rename is still
  // atomic there.
  if (process.platform === 'win32') return;
  const fh = await fs.open(dir, 'r');
  try { await fh.sync(); } finally { await fh.close(); }
}

async function writeDurable(dir: string, finalName: string, data: Buffer | string, tmpName: string): Promise<void> {
  const tmp = path.join(dir, tmpName);
  const fh = await fs.open(tmp, 'wx', 0o600);
  try { await fh.writeFile(data); await fh.sync(); } finally { await fh.close(); }
  // Windows briefly refuses a rename over a file a reader holds open.
  await renameWithRetry(tmp, path.join(dir, finalName));
  await fsyncDir(dir);
}

async function removeLeftovers(dir: string): Promise<void> {
  let names: string[] = [];
  try { names = await fs.readdir(dir); } catch { return; }
  for (const name of names) {
    if (SEGMENT_TMP_RE.test(name) || LIVE_TMP_RE.test(name)) await fs.rm(path.join(dir, name), { force: true });
  }
}

export interface SealResult { segments: string[]; sealedRecords: number; liveBytes: number }

// Seal the live log of one conversation folder. The caller must make sure
// nothing appends to the live file while this runs (workflowStore runs it in
// the conversation's flush chain). Records go into segments of at most
// `segmentBytes` of text each.
export async function sealLiveLog(dir: string, segmentBytes = sealThresholdBytes()): Promise<SealResult | null> {
  const file = path.join(dir, LIVE_LOG);
  try { await fs.lstat(file); } catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null; throw err; }
  if (await readLogFormat(dir) > LOG_FORMAT) throw new Error('This conversation log uses a newer storage format; update Arco to write to it.');
  await removeLeftovers(dir);
  let sealedThrough = await sealedThroughSeq(dir);
  const written: string[] = [];
  let records = 0;
  let chunk: string[] = [], chunkBytes = 0, chunkFirst = 0, chunkLast = 0;
  let lastSealedLine = '';
  // Lines without a sequence number travel with the records around them; any
  // left at the very end stay in the live file.
  let pendingNoSeq: string[] = [];
  const flush = async () => {
    if (!chunk.length) return;
    const text = chunk.join('\n') + '\n';
    const data = await compress(Buffer.from(text, 'utf8'), { params: {
      [zc.BROTLI_PARAM_QUALITY]: 5, [zc.BROTLI_PARAM_LGWIN]: 24, [zc.BROTLI_PARAM_SIZE_HINT]: Buffer.byteLength(text),
    } });
    const name = segmentName(chunkFirst, chunkLast);
    await writeDurable(dir, name, data, `${name}.${randomUUID()}.tmp`);
    // Read the segment back before anything depends on it.
    const back = brotliDecompressSync(await fs.readFile(path.join(dir, name))).toString('utf8');
    if (back !== text) throw new Error(`Sealed log segment ${name} did not read back correctly`);
    written.push(name);
    records += chunk.length;
    lastSealedLine = chunk[chunk.length - 1];
    sealedThrough = chunkLast;
    chunk = []; chunkBytes = 0; chunkFirst = 0; chunkLast = 0;
  };
  for await (const line of liveLines(file)) {
    const seq = lineSeq(line);
    if (seq === null) { pendingNoSeq.push(line); continue; }
    if (seq <= sealedThrough) { pendingNoSeq = []; continue; } // already sealed by an interrupted run
    const add = [...pendingNoSeq, line];
    pendingNoSeq = [];
    const addBytes = add.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0);
    if (chunk.length && chunkBytes + addBytes > segmentBytes) await flush();
    if (!chunk.length) chunkFirst = seq;
    chunk.push(...add); chunkBytes += addBytes; chunkLast = Math.max(chunkLast, seq);
  }
  await flush();
  if (!written.length) return null;
  if (await readLogFormat(dir) < LOG_FORMAT) {
    await writeDurable(dir, FORMAT_FILE, JSON.stringify({ format: LOG_FORMAT }) + '\n', `${FORMAT_FILE}.${randomUUID()}.tmp`);
  }
  const rest = pendingNoSeq.length ? pendingNoSeq.join('\n') + '\n' : '';
  const nextLive = lastSealedLine + '\n' + rest;
  await writeDurable(dir, LIVE_LOG, nextLive, `${LIVE_LOG}.${randomUUID()}.tmp`);
  return { segments: written, sealedRecords: records, liveBytes: Buffer.byteLength(nextLive) };
}

// Write the whole history back to one plain events.jsonl and remove the
// segments and the format marker (operator-run export before a downgrade).
// The plain file is complete and checked before anything is removed.
export async function unsealLog(dir: string): Promise<{ records: number; segments: number } | null> {
  const segments = await listSegments(dir);
  if (!segments.length) return null;
  const parts: string[] = [];
  let last = 0, records = 0;
  for (const seg of segments) {
    for await (const line of segmentLines(seg)) { parts.push(line); records++; const s = lineSeq(line); if (s !== null) last = Math.max(last, s); }
  }
  for await (const line of liveLines(path.join(dir, LIVE_LOG))) {
    const s = lineSeq(line);
    if (s !== null && s <= last) continue;
    parts.push(line); records++; if (s !== null) last = Math.max(last, s);
  }
  const text = parts.join('\n') + '\n';
  await writeDurable(dir, LIVE_LOG, text, `${LIVE_LOG}.${randomUUID()}.tmp`);
  const check = await fs.readFile(path.join(dir, LIVE_LOG), 'utf8');
  if (check !== text) throw new Error('The exported log did not read back correctly; sealed segments were kept.');
  for (const seg of segments) await fs.rm(seg.file, { force: true });
  await fs.rm(path.join(dir, FORMAT_FILE), { force: true });
  return { records, segments: segments.length };
}
