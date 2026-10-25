import type { GhPullFile } from './types';

// Workbench Expansion I4 — GitHub-patch → unified-diff reconstruction (PURE).
//
// THE GOTCHA: GitHub's `files[].patch` is BARE HUNKS — it starts straight at
// `@@ … @@` with no `diff --git a/… b/…`, no `--- a/…`, no `+++ b/…` header.
// react-diff-view's parseDiff needs those headers to associate a filename and
// an add/delete/rename type, so feeding it the raw patch yields a file with no
// path. We reconstruct a minimal git-style header per file before parsing:
//
//   diff --git a/<old> b/<new>
//   --- a/<old>      (or /dev/null when status === 'added')
//   +++ b/<new>      (or /dev/null when status === 'removed')
//   <patch>
//
// where <old> = previous_filename ?? filename (renames carry previous_filename),
// <new> = filename. Files with NO `patch` (binary / oversized) are EXCLUDED —
// they have no hunks to render; the UI shows a "binary or too large" row with a
// link instead. Kept pure (no React / no DOM) so the smoke can unit-test it and
// both the PR files view and the commit-detail view reuse the same logic.

function oldPath(f: GhPullFile): string {
  return f.previous_filename ?? f.filename;
}

// Reconstruct a single file's unified diff with a synthetic git header.
// Returns null when the file has no inline patch (caller renders a fallback).
export function ghFileToUnifiedDiff(f: GhPullFile): string | null {
  if (!f.patch) return null;
  const oldP = oldPath(f);
  const newP = f.filename;
  const minus = f.status === 'added' ? '--- /dev/null' : `--- a/${oldP}`;
  const plus = f.status === 'removed' ? '+++ /dev/null' : `+++ b/${newP}`;
  // Trim any trailing newline from the patch so we control line joins; the
  // header lines precede the bare hunks GitHub gave us.
  const patch = f.patch.replace(/\n$/, '');
  return [`diff --git a/${oldP} b/${newP}`, minus, plus, patch].join('\n');
}

// Concatenate the reconstructed per-file diffs into one unified-diff string
// suitable for DiffView's `patch` prop. Files without a patch are dropped.
export function ghFilesToUnifiedDiff(files: GhPullFile[]): string {
  return files
    .map(ghFileToUnifiedDiff)
    .filter((d): d is string => d !== null)
    .join('\n');
}

// The subset of files that have no inline patch (binary / oversized) — the UI
// renders a small notice row for these rather than feeding them to DiffView.
export function ghFilesWithoutPatch(files: GhPullFile[]): GhPullFile[] {
  return files.filter((f) => !f.patch);
}
