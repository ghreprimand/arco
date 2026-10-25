// ARCO_OPS_PLAN.md §F3 — safe restore: verify-first, manual regular-file
// extraction, conservative refusal on anything suspicious.
//
// SECURITY MODEL. The F1 archive format (archive.ts) can ONLY represent regular
// files ({relPath, bytes}) — there is nowhere on the wire to encode a symlink
// target, a hardlink, or a special-file type — so the dangerous-ENTRY class is
// gone by construction, and readArchive ALREADY rejects an unsafe relPath
// (leading `/` or any `..` segment) on read. Restore's job is therefore guarding
// the TARGET tree, not the archive entries:
//
//   1. Symlink in the TARGET. The archive can't carry one, but the destination
//      might ALREADY contain a symlinked directory (attacker-planted, or a
//      pre-existing `~/.arco` symlink). Writing `foo/bar` where `foo` is a
//      symlink to `/etc` escapes the root. applyRestore lstat()s EVERY
//      intermediate path component and REFUSES to descend through any that is a
//      symlink (records the entry rejected; never follows it).
//   2. Traversal past the segment checks. Defense in depth on top of readArchive:
//      re-reject absolute / `..` / empty / `.` relPaths, AND compute the resolved
//      absolute target and assert it stays strictly within resolve(targetRoot) +
//      separator (normalized-prefix check) — a relPath that survives naive
//      segment checks but still resolves outside the root is rejected here.
//   3. Overwriting live files. We open with the `wx` flag (O_CREAT|O_EXCL): an
//      already-present file makes the write fail with EEXIST → recorded as
//      skippedExisting, NEVER clobbered.
//   4. Resource exhaustion. A per-run cap on file COUNT and total BYTES. Exceeding
//      either ABORTS the whole restore (planRestore returns `aborted`, nothing is
//      applied) — no partial extraction.
//   5. Non-destructive default. Restore NEVER writes into the live ~/.arco by
//      default. The CLI requires --into <DIR> (or a fresh staging dir) and
//      default-refuses a target that is or is inside the live Arco home unless
//      an explicit --force-into-live escape is given. (That refusal lives in the
//      CLI, which knows the live home; planRestore/applyRestore are home-agnostic
//      and operate purely on the targetRoot they're handed.)
//
// SPLIT. planRestore is PURE (Buffer + targetRoot string → plan; NO fs): it runs
// verifyArchive, readArchive, the path-string + traversal-prefix checks, and the
// caps. applyRestore is the ONLY side-effecting function: per planned file it
// lstat()s each intermediate component (symlink → reject), mkdirs real dirs, and
// writes with `wx`. A single bad entry is recorded and skipped, never thrown —
// but a verify failure or cap breach from planRestore means NOTHING is applied.
//
// Cross-platform: node:fs + node:path only. No deps, no subprocess. lstat and the
// `wx` open flag are portable across Linux/macOS/Windows.

import { lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';

import { readArchive, type ArchiveFile } from './archive.js';
import { verifyArchive } from './verify.js';

// Resource caps. Generous enough for a real snapshot (a few thousand small
// files), tight enough that a maliciously-inflated manifest can't make restore
// write an unbounded amount. Exceeding EITHER aborts the WHOLE run (no partial
// extraction) so the operator never ends up with a half-restored tree.
export const MAX_FILES = 50_000;
export const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

// One file we INTEND to write. `target` is the resolved absolute path under
// targetRoot, pre-validated by planRestore (path-safe + within-root).
export interface PlannedFile {
  relPath: string;
  target: string;
  bytes: Buffer;
}

export interface RejectedEntry {
  relPath: string;
  reason: string;
}

export interface RestorePlan {
  // Files that passed every PURE check and are eligible to write. applyRestore
  // still re-checks each one against the live fs (symlink components, EEXIST).
  write: PlannedFile[];
  // Entries refused by a path-safety / traversal check (PURE). applyRestore
  // appends its own fs-discovered rejections (symlink components) to this list.
  rejected: RejectedEntry[];
  // Pre-existing targets skipped (never overwritten). Filled by applyRestore.
  skippedExisting: string[];
  // verifyArchive problems, if any. Non-empty ⇒ nothing is applied.
  problems: string[];
  // Set iff a cap was breached (or verify failed). Non-undefined ⇒ the whole
  // restore is aborted; applyRestore writes nothing.
  aborted?: string;
}

export interface RestoreResult {
  written: string[];
  skippedExisting: string[];
  rejected: RejectedEntry[];
}

// Re-validate an archive-relative path string. readArchive already rejects these
// on read; we re-check here so the invariant is LOCAL to restore (if readArchive
// ever reads more leniently, this still bites). Returns a reason, or null if safe.
function unsafeRelReason(relPath: string): string | null {
  if (relPath === '' || relPath === '.') return 'empty or "." path';
  if (isAbsolute(relPath) || relPath.startsWith('/')) return 'absolute path';
  // Split on BOTH separators — a Windows-style `..\\x` must not slip past a
  // POSIX-only `.includes('..')` segment check.
  const segs = relPath.split(/[/\\]/);
  if (segs.some((s) => s === '..')) return 'contains a ".." segment';
  if (segs.some((s) => s === '')) return 'contains an empty segment';
  return null;
}

// PURE. Verify the archive, then build the write plan with every path-safety +
// traversal + cap check applied. No fs access — existence and symlink-component
// checks (which need the live tree) are applyRestore's job.
export function planRestore(gz: Buffer, targetRoot: string): RestorePlan {
  const plan: RestorePlan = { write: [], rejected: [], skippedExisting: [], problems: [] };

  // ── 1. MANDATORY verify-first gate. A tampered / truncated / incomplete ──
  // archive must never reach extraction. Any problem aborts the whole restore.
  const v = verifyArchive(gz);
  if (!v.ok) {
    plan.problems = v.problems;
    plan.aborted = `archive failed verification (${v.problems.length} problem(s)) — nothing restored`;
    return plan;
  }

  // verify passed, so readArchive cannot throw here; guard anyway.
  let files: ArchiveFile[];
  try {
    files = readArchive(gz).files;
  } catch (err) {
    plan.problems = [`archive unreadable after verify: ${(err as Error).message}`];
    plan.aborted = 'archive unreadable — nothing restored';
    return plan;
  }

  // ── 2. Caps (count + bytes). Breaching EITHER aborts the whole run. Check ──
  // the declared entry set BEFORE building targets so an inflated archive can't
  // even start extracting.
  if (files.length > MAX_FILES) {
    plan.aborted = `file count ${files.length} exceeds cap ${MAX_FILES} — nothing restored`;
    return plan;
  }
  const totalBytes = files.reduce((sum, f) => sum + f.bytes.length, 0);
  if (totalBytes > MAX_TOTAL_BYTES) {
    plan.aborted = `total bytes ${totalBytes} exceeds cap ${MAX_TOTAL_BYTES} — nothing restored`;
    return plan;
  }

  // ── 3. Per-entry path safety + traversal-prefix check (PURE). ──
  const rootAbs = resolve(targetRoot);
  // The boundary every target must stay strictly inside: rootAbs + separator.
  // (rootAbs itself is a dir, never a write target.)
  const rootPrefix = rootAbs.endsWith(sep) ? rootAbs : rootAbs + sep;

  for (const f of files) {
    const reason = unsafeRelReason(f.relPath);
    if (reason) {
      plan.rejected.push({ relPath: f.relPath, reason });
      continue;
    }
    // Resolve under the root and assert the result is strictly within rootPrefix.
    // resolve() collapses any residual `.`/`..` and normalizes separators, so a
    // path that survived the segment check but still escapes is caught here.
    const target = resolve(rootAbs, f.relPath);
    if (target !== rootAbs && !target.startsWith(rootPrefix)) {
      plan.rejected.push({
        relPath: f.relPath,
        reason: `resolves outside target root (${target})`,
      });
      continue;
    }
    if (target === rootAbs) {
      // A relPath that resolves to the root dir itself is not a file we can write.
      plan.rejected.push({ relPath: f.relPath, reason: 'resolves to the target root itself' });
      continue;
    }
    plan.write.push({ relPath: f.relPath, target, bytes: f.bytes });
  }

  return plan;
}

// The ONLY side-effecting function. For each planned file: lstat every
// intermediate path component under targetRoot — REFUSE if any is a symlink (do
// not follow it); create missing REAL directories; write bytes with the `wx`
// flag so an existing file is SKIPPED (recorded), never overwritten. A single bad
// entry is recorded and skipped — never thrown. If planRestore aborted (verify
// failure / cap breach), NOTHING is written.
export function applyRestore(plan: RestorePlan, targetRoot: string): RestoreResult {
  const result: RestoreResult = {
    written: [],
    skippedExisting: [...plan.skippedExisting],
    rejected: [...plan.rejected],
  };

  // Verify failure / cap breach ⇒ no partial extraction.
  if (plan.aborted) return result;

  const rootAbs = resolve(targetRoot);

  for (const file of plan.write) {
    // Walk every intermediate component between rootAbs and the file's parent.
    // If ANY existing component is a symlink, refuse the entry — descending
    // through it could escape the root (e.g. linkdir -> /etc). We lstat (NOT
    // stat) so the symlink itself is seen, not its target.
    const relParts = file.relPath.split(/[/\\]/).filter((p) => p !== '');
    // relParts includes the filename; the directory components are all but last.
    const dirParts = relParts.slice(0, -1);

    let cur = rootAbs;
    let descendBlocked: string | null = null;
    const dirsToMake: string[] = [];
    for (const part of dirParts) {
      cur = resolve(cur, part);
      let st;
      try {
        st = lstatSync(cur); // lstat: see the symlink, don't follow it
      } catch {
        // Component does not exist yet — we'll mkdir it (as a REAL dir) below.
        dirsToMake.push(cur);
        continue;
      }
      if (st.isSymbolicLink()) {
        descendBlocked = `path component "${part}" is a symlink (refusing to descend)`;
        break;
      }
      if (!st.isDirectory()) {
        // A regular file / special node sits where we need a directory — refuse
        // rather than clobber or follow.
        descendBlocked = `path component "${part}" exists and is not a directory`;
        break;
      }
    }
    if (descendBlocked) {
      result.rejected.push({ relPath: file.relPath, reason: descendBlocked });
      continue;
    }

    // Create the missing real directories (recursive handles parents in order).
    try {
      for (const dir of dirsToMake) mkdirSync(dir, { recursive: true });
    } catch (err) {
      result.rejected.push({
        relPath: file.relPath,
        reason: `mkdir failed: ${(err as Error).message}`,
      });
      continue;
    }

    // Write with `wx` = O_CREAT | O_EXCL: fail (EEXIST) if the target exists, so
    // a live file is NEVER overwritten — it's recorded as skipped instead.
    try {
      writeFileSync(file.target, file.bytes, { flag: 'wx' });
      result.written.push(file.relPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        result.skippedExisting.push(file.relPath);
      } else {
        result.rejected.push({
          relPath: file.relPath,
          reason: `write failed (${code ?? 'unknown'}): ${(err as Error).message}`,
        });
      }
    }
  }

  return result;
}
