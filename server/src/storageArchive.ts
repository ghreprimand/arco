import { promises as fs, createReadStream, createWriteStream } from 'node:fs';
import { createBrotliCompress, createBrotliDecompress, constants as zc } from 'node:zlib';
import { createHash, randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { STAYING_FILES, holdsKept, isKept, readKeep, withKeepLock } from './keepStore.js';
import { checkedConversationDir, conversationDir, recordStorageAction, StorageActionError, unsafe } from './storageActions.js';
import { renameWithRetry } from './atomicFile.js';
import { ensureProjectStateIgnore } from './projectStateIgnore.js';

// ARCHIVE and restore for closed conversations (P7.5, docs/STORAGE_PLAN.md).
//
// An archive is one Brotli-compressed file, <project>/.arco/archive/<id>.arcoarchive:
//   "ARCO-ARCHIVE 1\n"
//   then per file: one JSON header line {path, size, mode, mtimeMs, sha256}
//   followed by exactly `size` bytes and a newline,
//   and a final line {"end": true, "files": N, "workflowId": id, "archivedAt": ms}.
// The archive is written to a temporary file, read back and checked file by
// file against the original hashes, renamed into place, and only then are the
// archived files removed. Kept items (keep.json) stay in the conversation
// folder and are not archived. Plans are outside conversation folders and
// never involved.

const MAGIC = 'ARCO-ARCHIVE 1\n';
export const ARCHIVE_SUFFIX = '.arcoarchive';

export function archiveDir(cwd: string): string { return path.join(cwd, '.arco', 'archive'); }
export function archivePath(cwd: string, workflowId: string): string {
  conversationDir(cwd, workflowId); // validates the id
  return path.join(archiveDir(cwd), `${workflowId}${ARCHIVE_SUFFIX}`);
}

interface Entry { path: string; size: number; mode: number; mtimeMs: number; sha256: string }

async function hashFile(file: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
}

// Regular files to archive, relative to the conversation folder, '/' paths.
// Links are not followed and not archived (they stay, like kept items).
async function collect(dir: string, kept: Parameters<typeof isKept>[0]): Promise<{ files: Entry[]; skipped: number }> {
  const files: Entry[] = [];
  let skipped = 0;
  const walk = async (rel: string): Promise<void> => {
    const abs = rel ? path.join(dir, ...rel.split('/')) : dir;
    for (const entry of await fs.readdir(abs, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (isKept(kept, childRel)) { skipped++; continue; }
      // The KEEP list and the size-warning record always stay in place, so
      // kept items stay protected after an archive.
      if (!rel && STAYING_FILES.has(entry.name)) { skipped++; continue; }
      const child = path.join(abs, entry.name);
      if (entry.isDirectory()) { await walk(childRel); continue; }
      if (!entry.isFile()) { skipped++; continue; }
      const st = await fs.lstat(child);
      files.push({ path: childRel, size: st.size, mode: st.mode & 0o777, mtimeMs: st.mtimeMs, sha256: await hashFile(child) });
    }
  };
  await walk('');
  return { files, skipped };
}

async function* archiveStream(dir: string, files: Entry[], trailer: Record<string, unknown>): AsyncGenerator<Buffer> {
  yield Buffer.from(MAGIC);
  for (const f of files) {
    yield Buffer.from(JSON.stringify(f) + '\n');
    let written = 0;
    for await (const chunk of createReadStream(path.join(dir, ...f.path.split('/')), { start: 0, end: Math.max(0, f.size - 1) })) {
      if (f.size === 0) break;
      written += (chunk as Buffer).length;
      yield chunk as Buffer;
    }
    if (written !== f.size) throw new Error(`${f.path} changed while it was archived`);
    yield Buffer.from('\n');
  }
  yield Buffer.from(JSON.stringify({ end: true, files: files.length, ...trailer }) + '\n');
}

// Reads an archive and calls `onFile` with each header and its bytes as an
// async iterable pulled straight from the decompressor (one chunk in memory
// at a time). Bytes the callback leaves unread are skipped. Returns the trailer.
async function readArchive(file: string, onFile: (entry: Entry, data: AsyncIterable<Buffer>) => Promise<void>): Promise<Record<string, unknown>> {
  const input = createReadStream(file);
  const source = input.pipe(createBrotliDecompress());
  const it = source[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  let buf: Buffer = Buffer.alloc(0);
  const fill = async (): Promise<boolean> => {
    const next = await it.next();
    if (next.done) return false;
    buf = buf.length ? Buffer.concat([buf, next.value]) : next.value;
    return true;
  };
  const line = async (): Promise<string> => {
    for (;;) {
      const i = buf.indexOf(10);
      if (i >= 0) { const s = buf.subarray(0, i).toString('utf8'); buf = buf.subarray(i + 1); return s; }
      if (buf.length > 1024 * 1024) throw new Error('The archive is damaged.');
      if (!(await fill())) throw new Error('The archive ends early.');
    }
  };
  try {
    if ((await line()) + '\n' !== MAGIC) throw new Error('Not an Arco archive.');
    for (;;) {
      const header = JSON.parse(await line()) as Entry & { end?: boolean };
      if (header.end) return header as unknown as Record<string, unknown>;
      if (typeof header.path !== 'string' || !Number.isSafeInteger(header.size) || header.size < 0) throw new Error('The archive is damaged.');
      let remaining = header.size;
      const next = async (): Promise<Buffer | null> => {
        if (remaining <= 0) return null;
        if (!buf.length && !(await fill())) throw new Error('The archive ends early.');
        const take = buf.subarray(0, Math.min(remaining, buf.length));
        buf = buf.subarray(take.length);
        remaining -= take.length;
        return take;
      };
      const data: AsyncIterable<Buffer> = { [Symbol.asyncIterator]: () => ({ next: async () => { const v = await next(); return v ? { value: v, done: false } : { value: undefined, done: true }; } }) };
      await onFile(header, data);
      while (await next()) { /* skip what the callback did not read */ }
      if (!buf.length && !(await fill())) throw new Error('The archive ends early.');
      if (buf[0] !== 10) throw new Error('The archive is damaged.');
      buf = buf.subarray(1);
    }
  } finally {
    input.destroy(); source.destroy();
  }
}

function safeRel(rel: string): string {
  const parts = rel.split('/');
  if (!rel || parts.some((p) => !p || p === '.' || p === '..') || path.isAbsolute(rel) || rel.includes('\\') || rel.includes('\0')) {
    throw new Error('The archive holds an unsafe path.');
  }
  return rel;
}

export interface ArchiveResult { files: number; originalBytes: number; archiveBytes: number; keptItems: number }

// The project's archive folder is a real folder (or missing), never a link.
async function checkedArchiveDir(cwd: string): Promise<void> {
  try { const st = await fs.lstat(archiveDir(cwd)); if (st.isSymbolicLink() || !st.isDirectory()) throw unsafe(path.join('.arco', 'archive')); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
}

// Every existing part of `rel` below the conversation folder is a real folder
// or file, not a link.
async function noLinkOnPath(dir: string, rel: string): Promise<void> {
  const parts = rel.split('/');
  for (let i = 1; i <= parts.length; i++) {
    const sub = parts.slice(0, i).join('/');
    try { if ((await fs.lstat(path.join(dir, ...parts.slice(0, i)))).isSymbolicLink()) throw unsafe(sub); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; throw err; }
  }
}

export async function archiveConversation(cwd: string, workflowId: string, opts: { open: boolean; busy: boolean; by: 'operator' | 'policy' }): Promise<ArchiveResult> {
  if (opts.open || opts.busy) throw new StorageActionError('open', 'Close the conversation before archiving it.');
  const dir = await checkedConversationDir(cwd, workflowId);
  await checkedArchiveDir(cwd);
  const target = archivePath(cwd, workflowId);
  try { await fs.lstat(target); throw new StorageActionError('exists', 'An archive of this conversation already exists.'); }
  catch (err) { if (err instanceof StorageActionError) throw err; }
  // Hold the KEEP lock from the read through the last removal.
  return withKeepLock(dir, async () => {
    const keep = await readKeep(dir);
    if (!keep.ok) throw new StorageActionError('keep_unreadable', 'The KEEP list of this conversation cannot be read, so nothing was archived.');
    if (isKept(keep.items, '.')) throw new StorageActionError('kept', 'The whole conversation is kept.');
    const { files, skipped } = await collect(dir, keep.items);
    const archivedAt = Date.now();
    ensureProjectStateIgnore(cwd);
    await fs.mkdir(archiveDir(cwd), { recursive: true });
    const tmp = `${target}.${randomUUID()}.tmp`;
    try {
      await pipeline(Readable.from(archiveStream(dir, files, { workflowId, archivedAt })),
        createBrotliCompress({ params: { [zc.BROTLI_PARAM_QUALITY]: 4, [zc.BROTLI_PARAM_LGWIN]: 22 } }),
        createWriteStream(tmp, { flags: 'wx', mode: 0o600 }));
      const fh = await fs.open(tmp, 'r+'); try { await fh.sync(); } finally { await fh.close(); }
      // Read back: every file present with the same size and hash.
      const expected = new Map(files.map((f) => [f.path, f]));
      let seen = 0;
      await readArchive(tmp, async (entry, data) => {
        const h = createHash('sha256'); let size = 0;
        for await (const chunk of data) { h.update(chunk as Buffer); size += (chunk as Buffer).length; }
        const want = expected.get(entry.path);
        if (!want || want.size !== size || want.sha256 !== h.digest('hex')) throw new Error(`${entry.path} did not read back correctly`);
        seen++;
      });
      if (seen !== files.length) throw new Error('The archive is incomplete.');
      await renameWithRetry(tmp, target);
    } catch (err) {
      await fs.rm(tmp, { force: true });
      throw err;
    }
    // Remove what was archived; kept items and links stay. A folder swapped
    // for a link since the walk stops the removal.
    for (const f of files) {
      await noLinkOnPath(dir, f.path);
      await fs.rm(path.join(dir, ...f.path.split('/')), { force: true });
    }
    await pruneEmptyFolders(dir, keep.items);
    const archiveBytes = (await fs.stat(target)).size;
    const originalBytes = files.reduce((n, f) => n + f.size, 0);
    await recordStorageAction(cwd, { action: 'archive', by: opts.by, workflowId, files: files.length, originalBytes, archiveBytes, keptItems: skipped });
    return { files: files.length, originalBytes, archiveBytes, keptItems: skipped };
  });
}

async function pruneEmptyFolders(dir: string, kept: Parameters<typeof isKept>[0]): Promise<void> {
  const prune = async (abs: string, rel: string): Promise<boolean> => {
    let entries;
    try { entries = await fs.readdir(abs, { withFileTypes: true }); } catch { return false; }
    let empty = true;
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory() && !isKept(kept, childRel) && await prune(path.join(abs, e.name), childRel)) continue;
      empty = false;
    }
    if (empty && rel && !holdsKept(kept, rel)) { await fs.rmdir(abs).catch(() => undefined); return true; }
    return empty && !!rel;
  };
  if (await prune(dir, '') ) await fs.rmdir(dir).catch(() => undefined);
}

export interface RestoreResult { files: number; restoredBytes: number }

// Restore into the conversation folder. Refused when any archived file
// already exists there (nothing is overwritten); the archive is removed only
// after every file is written and checked.
export async function restoreConversation(cwd: string, workflowId: string): Promise<RestoreResult> {
  const dir = await checkedConversationDir(cwd, workflowId, { mayBeMissing: true });
  await checkedArchiveDir(cwd);
  const source = archivePath(cwd, workflowId);
  let sourceStat;
  try { sourceStat = await fs.lstat(source); } catch { throw new StorageActionError('not_found', 'No archive of this conversation was found.'); }
  if (!sourceStat.isFile()) throw unsafe(path.relative(cwd, source));
  // A file that already exists (keep.json included) is never overwritten.
  const collisions: string[] = [];
  // First pass: the whole archive reads back with matching hashes, and no
  // file exists yet. Nothing is written before both hold.
  await readArchive(source, async (entry, data) => {
    const rel = safeRel(entry.path);
    const h = createHash('sha256');
    for await (const chunk of data) h.update(chunk);
    if (h.digest('hex') !== entry.sha256) throw new Error(`${rel} is damaged in the archive; nothing was restored`);
    await noLinkOnPath(dir, rel);
    try { await fs.lstat(path.join(dir, ...rel.split('/'))); collisions.push(rel); } catch { /* free */ }
  });
  if (collisions.length) throw new StorageActionError('exists', `The conversation folder already holds ${collisions[0]}; nothing was restored.`);
  let files = 0, restoredBytes = 0;
  await readArchive(source, async (entry, data) => {
    const rel = safeRel(entry.path);
    const dest = path.join(dir, ...rel.split('/'));
    await noLinkOnPath(dir, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await noLinkOnPath(dir, rel);
    const tmp = `${dest}.${randomUUID()}.tmp`;
    const h = createHash('sha256');
    async function* hashed() { for await (const c of data) { h.update(c); yield c; } }
    await pipeline(Readable.from(hashed()), createWriteStream(tmp, { flags: 'wx', mode: entry.mode || 0o600 }));
    if (h.digest('hex') !== entry.sha256) { await fs.rm(tmp, { force: true }); throw new Error(`${rel} did not restore correctly`); }
    await renameWithRetry(tmp, dest);
    await fs.utimes(dest, new Date(entry.mtimeMs), new Date(entry.mtimeMs)).catch(() => undefined);
    files++; restoredBytes += entry.size;
  });
  await fs.rm(source, { force: true });
  await recordStorageAction(cwd, { action: 'restore', workflowId, files, restoredBytes });
  return { files, restoredBytes };
}

export async function listArchives(cwd: string): Promise<Array<{ workflowId: string; bytes: number; archivedAt: number }>> {
  let names: string[] = [];
  try { names = await fs.readdir(archiveDir(cwd)); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!name.endsWith(ARCHIVE_SUFFIX)) continue;
    const workflowId = name.slice(0, -ARCHIVE_SUFFIX.length);
    try { const st = await fs.stat(path.join(archiveDir(cwd), name)); out.push({ workflowId, bytes: st.size, archivedAt: st.mtimeMs }); } catch { /* vanished */ }
  }
  return out;
}
