// ── Media scratch storage (Part N2) ──
//
// Arco-managed disk area where IMPORTED media (browser blobs / drag-dropped
// files / a remote operator's upload) is staged so ffmpeg — which reads files,
// not object URLs — can act on it. This is what makes "import any file and it
// just works" true: the client POSTs the bytes here, gets back an absolute
// path, and feeds that straight into a media op.
//
// ── Four-question test (CLAUDE.md) ──
//   1. Operator-initiated — only the explicit POST /api/media/scratch (an Import
//      / drag-drop in the studio) writes here. No agent, timer, or hook does.
//   2. Bounded — a per-upload byte cap, a total-scratch size cap (oldest entries
//      evicted), and a TTL reaper keep it from filling the disk. The basename is
//      sanitized + confined to a fresh per-upload subdir.
//   3. Visible — the staged path is returned to the operator and shown in the
//      op result; a media op against it broadcasts media_op_result as usual.
//   4. Reversible — scratch is disposable: the reaper clears it on TTL, and the
//      operator can delete ~/.arco/media-scratch/ at any time with no loss.
//
// ── Fences (the director reads this file too) ──
//   • The upload target is ALWAYS inside a fresh ~/.arco/media-scratch/<id>/
//     subdir under a sanitized basename — never an operator-chosen path. So an
//     upload can't escape the scratch root no matter what `?name=` contains.
//   • `isWithinScratch` is the read-side gate the media-op resolver consults:
//     a scratch path is allowed REGARDLESS of the mediaUnconfined setting,
//     because the operator put the file there through this very endpoint. It is
//     a pure path-containment check (no symlink following needed — we wrote the
//     bytes ourselves, so the file is a regular file under the root).

import { promises as fs, createWriteStream } from 'fs';
import { randomUUID } from 'crypto';
import path from 'path';
import { homedir } from 'os';
import type { Readable } from 'stream';
import { arcoHome } from '../arcoHome.js';

// The scratch root. A sibling of settings.json / clusters / skills under
// ~/.arco, so it's already an Arco-owned tree the operator knows about.
export const SCRATCH_ROOT = path.join(arcoHome(), 'media-scratch');

// Per-upload byte cap. Video can be large, so this is generous; it exists to
// stop a runaway / hostile upload from filling the disk, not to be tight.
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024; // 4 GiB

// Total scratch budget. When exceeded after an upload, the oldest entries are
// evicted (LRU by mtime) until we're back under. The newest upload is never
// the one evicted (we reap BEFORE returning, and it's the most recent mtime).
const MAX_TOTAL_BYTES = 16 * 1024 * 1024 * 1024; // 16 GiB

// Time-to-live. Entries whose directory mtime is older than this are reaped on
// the next upload (and at startup). 24h is long enough to round-trip a session,
// short enough that the dir doesn't accrete indefinitely.
const TTL_MS = 24 * 60 * 60 * 1000;

// ── PURE: basename sanitizer ─────────────────────────────────────────────────
// Reject anything that could escape the per-upload dir or smuggle a flag. The
// caller has already chosen the (fresh, confined) directory; this guards the
// `?name=` the operator's browser sent. Returns a bare basename or null.
export function sanitizeScratchBasename(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const raw = name.trim();
  if (!raw || raw.length > 255) return null;
  if (raw.includes('\0')) return null;
  if (raw.includes('/') || raw.includes('\\')) return null;
  if (raw === '.' || raw === '..' || raw.includes('..')) return null;
  if (raw.startsWith('-')) return null; // can't be read as a flag
  return raw;
}

// ── PURE: is this absolute path inside the scratch root? ─────────────────────
// The read-side gate. A scratch path is allowed regardless of mediaUnconfined.
export function isWithinScratch(abs: string): boolean {
  const root = path.resolve(SCRATCH_ROOT);
  const rel = path.relative(root, path.resolve(abs));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function ensureRoot(): Promise<void> {
  await fs.mkdir(SCRATCH_ROOT, { recursive: true });
}

// Create a fresh per-upload subdir and return its id + absolute path.
async function createEntryDir(): Promise<{ id: string; dir: string }> {
  await ensureRoot();
  const id = randomUUID();
  const dir = path.join(SCRATCH_ROOT, id);
  await fs.mkdir(dir, { recursive: true });
  return { id, dir };
}

export interface ScratchUploadResult {
  path: string;     // absolute on-disk path (feed back as MediaOpRequest.path)
  basename: string; // sanitized basename the bytes were written under
  bytes: number;
}

// A typed error so the route can branch on `code`.
export class ScratchError extends Error {
  code: 'bad-name' | 'too-large' | 'write-failed';
  constructor(code: ScratchError['code'], message: string) {
    super(message);
    this.name = 'ScratchError';
    this.code = code;
  }
}

// Stream an upload body into a fresh scratch entry. The basename is sanitized;
// the target dir is freshly created (so the write can't escape). Enforces the
// per-upload byte cap mid-stream (kills the write + cleans up on overflow), and
// reaps stale / over-budget entries afterwards. `signal` aborts the write (the
// route wires req-close → abort) and removes the partial entry.
export async function saveScratchUpload(
  body: Readable,
  name: unknown,
  signal?: AbortSignal,
): Promise<ScratchUploadResult> {
  const basename = sanitizeScratchBasename(name);
  if (!basename) throw new ScratchError('bad-name', 'a safe ?name= basename is required');

  const { dir } = await createEntryDir();
  const target = path.join(dir, basename);

  let bytes = 0;
  let overflowed = false;
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(target);
    const cleanupReject = (err: Error) => {
      try { out.destroy(); } catch { /* already gone */ }
      reject(err);
    };
    if (signal) {
      if (signal.aborted) return cleanupReject(new ScratchError('write-failed', 'upload aborted'));
      signal.addEventListener('abort', () => cleanupReject(new ScratchError('write-failed', 'upload aborted')), { once: true });
    }
    body.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_UPLOAD_BYTES) {
        overflowed = true;
        body.destroy();
        cleanupReject(new ScratchError('too-large', `upload exceeds the ${MAX_UPLOAD_BYTES} byte cap`));
      }
    });
    body.on('error', (err) => cleanupReject(new ScratchError('write-failed', err instanceof Error ? err.message : String(err))));
    out.on('error', (err) => cleanupReject(new ScratchError('write-failed', err instanceof Error ? err.message : String(err))));
    out.on('finish', () => resolve());
    body.pipe(out);
  }).catch(async (err) => {
    // Any failure (overflow / abort / write error): remove the whole entry dir.
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  });

  if (overflowed) {
    // Defensive — the promise already rejected, but never return a partial.
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw new ScratchError('too-large', 'upload exceeded the byte cap');
  }

  // Best-effort housekeeping; never fail the upload over a reap error.
  await reapScratch().catch(() => {});

  return { path: target, basename, bytes };
}

// Reap stale (TTL) and over-budget (total cap, oldest-first) entries. Best-
// effort: a missing root / a racing delete is non-fatal. Safe to call at
// startup and after every upload.
export async function reapScratch(): Promise<void> {
  let ids: string[];
  try {
    ids = await fs.readdir(SCRATCH_ROOT);
  } catch {
    return; // root doesn't exist yet → nothing to reap
  }
  const now = Date.now();
  interface Entry { dir: string; mtimeMs: number; size: number }
  const entries: Entry[] = [];
  for (const id of ids) {
    const dir = path.join(SCRATCH_ROOT, id);
    try {
      const st = await fs.stat(dir);
      if (!st.isDirectory()) continue;
      // TTL: drop anything older than the window outright.
      if (now - st.mtimeMs > TTL_MS) {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      entries.push({ dir, mtimeMs: st.mtimeMs, size: await dirSize(dir) });
    } catch {
      // Racing delete / unreadable — skip.
    }
  }
  // Total-size cap: evict oldest until under budget.
  let total = entries.reduce((n, e) => n + e.size, 0);
  if (total <= MAX_TOTAL_BYTES) return;
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
  for (const e of entries) {
    if (total <= MAX_TOTAL_BYTES) break;
    await fs.rm(e.dir, { recursive: true, force: true }).catch(() => {});
    total -= e.size;
  }
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  try {
    for (const name of await fs.readdir(dir)) {
      try {
        const st = await fs.stat(path.join(dir, name));
        if (st.isFile()) total += st.size;
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return total;
}
