// DD3 — per-realpath file-mutation queue (BORROWED_IMPROVEMENTS_EXECUTION.md Phase 3).
//
// THE BUG THIS FIXES: in a cluster, N Native members share ONE cwd. Two members
// (or two Task children of one member) can issue an Edit/Write to the SAME file
// concurrently. Each tool does a read-modify-write (Edit reads the file, splices,
// writes back; Write stats then overwrites). Interleave two RMWs on one file and
// the second write clobbers the first member's change with no error and an
// unchanged-looking result — a silent lost write.
//
// THE FIX: serialize mutations per real file path. Keyed by realpath() so two
// paths that resolve to the same file via a symlink collapse to one queue. The
// queue Map is MODULE-LEVEL on purpose: every Native worker in this process
// shares it, so members of one cluster (same process) serialize against each
// other — not just one worker against itself. Distinct files keep running in
// parallel (separate keys, separate tails).
//
// NOT proper-lockfile: that's a cross-PROCESS lock (lockfiles on disk, heavier,
// stale-lock recovery). DD3 is in-process only — CLI claude edits in a child
// process and is out of scope (its tools live in the spawned `claude` binary,
// not here). Native is the only transport whose Edit/Write run in THIS process,
// so an in-process Map is both sufficient and the right weight.
//
// SHAPE: withFileMutationLock(absPath, fn) chains fn after the current tail for
// that key, then becomes the new tail. The tail is released in `finally` ONLY if
// it's still the current tail — so a fast key that drains fully removes its Map
// entry (no unbounded growth) while a key with a waiter keeps its chain intact.
//
// REGISTRATION RACE: resolveKey() is async (realpath touches disk). Two
// concurrent calls for the same NEW path would each await realpath, each read an
// empty tail, and each run in parallel — the very lost-write we're preventing.
// So the enqueue critical section (key resolution + tail read + tail write) is
// itself serialized through `registrationTail`. That serialization covers ONLY
// the enqueue, not fn execution — distinct files still run concurrently.

import { promises as fs } from 'node:fs';
import { dirname, basename, join, resolve } from 'node:path';

// key (realpath) → tail promise of the in-flight mutation chain for that file.
const queue = new Map<string, Promise<void>>();

// Serializes the enqueue critical section across all callers (see header).
let registrationTail: Promise<void> = Promise.resolve();

// Resolve a stable dedupe key. realpath() collapses symlinks so two aliases of
// one file share a queue. A new file (ENOENT) has no realpath yet — fall back to
// realpath(parent dir)+basename so a write into a symlinked directory still
// collapses correctly, and to the plain resolved path if even the parent can't
// be resolved (brand-new nested path; mkdir happens inside fn).
async function resolveKey(absPath: string): Promise<string> {
  const abs = resolve(absPath);
  try {
    return await fs.realpath(abs);
  } catch {
    try {
      return join(await fs.realpath(dirname(abs)), basename(abs));
    } catch {
      return abs;
    }
  }
}

// Run `fn` (a file read-modify-write) under the per-realpath lock for `absPath`.
// `onWait` fires exactly once, before fn is queued, IFF another mutation for the
// same key is already in flight — the caller uses it to emit file_mutation_queued
// (we only want the event when a write actually had to wait, not on every write).
export function withFileMutationLock<T>(
  absPath: string,
  fn: () => Promise<T>,
  onWait?: () => void,
): Promise<T> {
  // Claim the next registration slot synchronously: replace registrationTail
  // with a gate that resolves only once THIS call's enqueue completes. The next
  // caller's enqueue therefore can't interleave with ours.
  let releaseRegistration!: () => void;
  const registrationGate = new Promise<void>((res) => { releaseRegistration = res; });
  const prevRegistration = registrationTail;
  registrationTail = registrationGate;

  return (async (): Promise<T> => {
    await prevRegistration; // wait our turn to register (enqueue is serialized)
    let run: Promise<T>;
    try {
      const key = await resolveKey(absPath);
      const prev = queue.get(key);
      if (prev) onWait?.(); // a mutation for this file is already running → we wait
      const prevSettled = prev ?? Promise.resolve();
      // Chain off the previous tail regardless of how it settled (a failed
      // mutation must not wedge the next one). fn's own outcome is returned to
      // the caller via `run`; the stored tail swallows errors so the chain lives.
      run = prevSettled.then(fn);
      const tail = run.then(() => undefined, () => undefined);
      queue.set(key, tail);
      // Release the Map entry when this tail drains — but only if no later
      // mutation has replaced us as the current tail (else we'd evict a live
      // chain). Keeps the Map from growing unbounded across many one-off writes.
      void tail.finally(() => { if (queue.get(key) === tail) queue.delete(key); });
    } finally {
      releaseRegistration(); // enqueue done — let the next caller register
    }
    return run;
  })();
}

// Test-only: drain + clear module state between scenarios.
export async function __resetFileMutationQueueForTests(): Promise<void> {
  await Promise.allSettled([...queue.values()]);
  queue.clear();
  registrationTail = Promise.resolve();
}
