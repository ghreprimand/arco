// One atomic-write primitive for every JSON/text store in the server.
//
// Before this module, ~20 call sites hand-rolled `write tmp -> rename`, 11 of
// them via byte-identical private `atomicWrite` helpers. They shared three
// defects (Odysseus delta audit, 2026-08-30 — docs/PERSISTENCE.md § Atomic
// writes):
//
//   1. NO fsync. `rename` is atomic for the directory entry, but the bytes may
//      still be in the page cache. A crash between write and flush can leave a
//      ZERO-LENGTH file where a good one used to be — the real data-loss mode,
//      and the reason this matters for meta.json / trust.json / settings.json.
//   2. Temp names keyed on `${pid}` (or `${pid}.${Date.now()}`). Two writes to
//      one target inside the same millisecond of the same long-lived process
//      collide. `randomUUID()` removes the window rather than narrowing it.
//   3. No cleanup. A failed serialize / write / rename orphaned the temp file
//      next to the target forever.
//
// Deliberately NOT fsyncing the parent directory. That would only make the
// *rename* itself crash-durable; without it a crash can lose the update, but
// the previous good file survives intact. Losing an update is safe — a torn or
// empty file is not — so the file fsync is the one that earns its syscall.
//
// NOT for `events.jsonl`. That log is append-only through workflowStore.ts and
// must never be rewritten through here (docs/GOTCHAS.md § Persistence).

import { promises as fs } from 'fs';
import {
  mkdirSync, openSync, writeFileSync, fsyncSync, closeSync,
  chmodSync, renameSync, rmSync,
} from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

// On Windows a rename over a file that another handle has open (a reader, a
// virus scanner, the indexer, or a concurrent writer's own rename) fails with
// EPERM, EACCES or EBUSY for a short moment. Retry those with a short backoff,
// bounded to about five seconds, before giving up; other platforms rename
// over open files and never take this path.
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_RETRY_LIMIT_MS = 5_000;
const isWindows = process.platform === 'win32';
const retryable = (e: unknown): boolean => isWindows && RENAME_RETRY_CODES.has((e as NodeJS.ErrnoException)?.code ?? '');

async function renameWithRetry(from: string, to: string): Promise<void> {
  const started = Date.now();
  for (let delay = 5; ; delay = Math.min(delay * 2, 100)) {
    try { await fs.rename(from, to); return; } catch (e) {
      if (!retryable(e) || Date.now() - started > RENAME_RETRY_LIMIT_MS) throw e;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

function renameWithRetrySync(from: string, to: string): void {
  const started = Date.now();
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let delay = 5; ; delay = Math.min(delay * 2, 100)) {
    try { renameSync(from, to); return; } catch (e) {
      if (!retryable(e) || Date.now() - started > RENAME_RETRY_LIMIT_MS) throw e;
      Atomics.wait(pause, 0, 0, delay);
    }
  }
}

export interface AtomicWriteOptions {
  /**
   * `'durable'` (default) fsyncs the temp file before the rename — use for any
   * store whose loss or truncation would corrupt operator state.
   *
   * `'advisory'` skips the fsync for hot, best-effort telemetry whose loss is
   * harmless (recentFilesLedger, skillUsage). Those callers already swallow
   * write failures; paying an fsync per write buys them nothing.
   */
  durability?: 'durable' | 'advisory';
  /** File mode for the temp file, re-applied after rename (secrets: 0o600). */
  mode?: number;
  /** Skip the recursive mkdir of the parent directory. Default false. */
  skipMkdir?: boolean;
}

/**
 * Write `contents` to `filePath` atomically: a uniquely-named temp file in the
 * same directory is written, flushed, then renamed over the target. The temp is
 * removed on every failure path.
 *
 * Same-directory temp placement is load-bearing — `rename` is only atomic
 * within a filesystem, so a temp in `os.tmpdir()` would silently degrade to a
 * copy on a separate mount.
 */
export async function atomicWriteFile(
  filePath: string,
  contents: string | Buffer,
  opts: AtomicWriteOptions = {},
): Promise<void> {
  const { durability = 'durable', mode, skipMkdir = false } = opts;
  if (!skipMkdir) await fs.mkdir(path.dirname(filePath), { recursive: true });

  const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const fh = await fs.open(tmp, 'w', mode);
    try {
      await fh.writeFile(contents, typeof contents === 'string' ? 'utf8' : undefined);
      if (durability === 'durable') await fh.sync();
    } finally {
      await fh.close();
    }
    // `open` honours the process umask, so an explicit chmod is needed to
    // guarantee 0600 on a secrets file.
    if (mode !== undefined) await fs.chmod(tmp, mode).catch(() => undefined);
    await renameWithRetry(tmp, filePath);
    // Some filesystems drop the mode on a cross-device move.
    if (mode !== undefined) await fs.chmod(filePath, mode).catch(() => undefined);
  } finally {
    // No-op after a successful rename (the temp name no longer exists).
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Read-modify-write serialization
// ---------------------------------------------------------------------------

// Unique temp names stop two writers from colliding on the rename. They do NOT
// stop two READERS from loading the same old state and last-writer-wins
// dropping one mutation — a real race for `patchSettings()` (two ConfigTab
// toggles in flight, or two browser tabs) and for trust decisions.
//
// This is an in-process chain per key, mirroring the one skillUsage.ts already
// grew for the same reason. It does NOT coordinate across processes; Arco
// runs one server, and a hand-edit racing the server was already unserialized.
// The tail of each key's queue. Entries are dropped once the queue drains, so
// a long-lived process doesn't accumulate one settled promise per file touched.
const tails = new Map<string, Promise<unknown>>();

/**
 * Run `fn` with exclusive access to `key` relative to other `withFileLock`
 * calls on the same key. Rejections propagate to the caller without wedging
 * the queue for whoever is waiting behind.
 */
export function withFileLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve();
  // Run whether the predecessor resolved or rejected — one failed mutation
  // must not strand every later write on the same key.
  const run = prev.then(fn, fn);
  const tail = run.then(() => undefined, () => undefined);
  tails.set(key, tail);
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return run;
}

// ---------------------------------------------------------------------------
// Synchronous variant
// ---------------------------------------------------------------------------

// The PID registries (workers/pidRegistry.ts, terminal/ptyPidRegistry.ts) write
// from the shutdown path, where an async write would not finish before the
// process exits. They keep their sync shape and get the same guarantees here.
// Everything else should use the async `atomicWriteFile`.

/** Sync twin of {@link atomicWriteFile}. Same contract, same temp cleanup. */
export function atomicWriteFileSync(
  filePath: string,
  contents: string | Buffer,
  opts: AtomicWriteOptions = {},
): void {
  const { durability = 'durable', mode, skipMkdir = false } = opts;
  if (!skipMkdir) mkdirSync(path.dirname(filePath), { recursive: true });

  const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(tmp, 'w', mode);
    try {
      writeFileSync(fd, contents);
      if (durability === 'durable') fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (mode !== undefined) { try { chmodSync(tmp, mode); } catch { /* best-effort */ } }
    renameWithRetrySync(tmp, filePath);
    if (mode !== undefined) { try { chmodSync(filePath, mode); } catch { /* best-effort */ } }
  } finally {
    try { rmSync(tmp, { force: true }); } catch { /* already renamed away */ }
  }
}
