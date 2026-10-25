// ARCO_OPS_PLAN.md §F2 — pure archive verifier (verify-BEFORE-restore gate).
//
// `verifyArchive(gz)` is the F3 safety gate: it validates a backup archive
// against its OWN manifest before any restore touches the filesystem. The
// principle (plan §F2): a restore must never act on an archive whose bytes don't
// match the contract it ships with. F3 extraction trusts the manifest's category
// lists; verify is what makes that trust earned.
//
// readArchive (archive.ts) already enforces the STRUCTURAL invariants — valid
// gzip, correct magic, in-bounds frame lengths (truncation throws), parseable
// manifest JSON, and safe relPaths (no leading `/` or `..`). verify wraps it so
// those throws become FAILURES (problems[]), not exceptions that escape: a
// corrupt / truncated / bad-magic / unsafe-path archive is a verify failure the
// operator can read, not a stack trace.
//
// On TOP of structure, verify cross-checks the manifest against the actual
// entries — the part readArchive can't know about:
//   • format is the expected 'arco-backup/1' (unknown/forged format → fail).
//   • required manifest fields are present + well-typed.
//   • every actual file entry is DECLARED in manifest.categories (no smuggled
//     file), and every DECLARED path is present as an entry (no missing file).
//   • fileCount matches the actual entry count.
//   • totalBytes matches the summed entry byte lengths.
//
// PURE: Buffer in → result out. No fs, no clock, no random. Collects ALL
// problems (does NOT fail-fast) — the operator wants the full list in one pass.

import type { BackupCategory, BackupManifest } from './manifest.js';
import { readArchive, type ArchiveFile } from './archive.js';

const EXPECTED_FORMAT = 'arco-backup/1';

// The category keys the manifest must enumerate (mirrors BackupManifest.categories).
const CATEGORY_KEYS: BackupCategory[] = [
  'globalSettings',
  'workflows',
  'clusters',
  'templates',
  'skills',
  'recall',
  'knowledge',
];

export interface VerifyResult {
  ok: boolean;
  problems: string[];
}

// Validate an archive against its own manifest. Never throws for a bad archive —
// turns structural errors and contract mismatches into `problems`.
export function verifyArchive(gz: Buffer): VerifyResult {
  const problems: string[] = [];

  // ── 1. Structure (delegated to readArchive; its throws become problems). ──
  let manifest: BackupManifest;
  let files: ArchiveFile[];
  try {
    const r = readArchive(gz);
    manifest = r.manifest;
    files = r.files;
  } catch (err) {
    // Corrupt / truncated / bad-magic / unsafe-path / unparseable-manifest — all
    // surface here as a single readable failure. Nothing more we can check.
    return { ok: false, problems: [`archive unreadable: ${(err as Error).message}`] };
  }

  // ── 2. Manifest must be an object before we probe fields. ──
  if (manifest === null || typeof manifest !== 'object') {
    return { ok: false, problems: ['manifest is not a JSON object'] };
  }

  // ── 3. format tag. An unknown/forged format means we can't trust anything. ──
  if (manifest.format !== EXPECTED_FORMAT) {
    problems.push(
      `unknown manifest format: expected "${EXPECTED_FORMAT}", got ${JSON.stringify(manifest.format)}`,
    );
  }

  // ── 4. Required fields present + well-typed. ──
  if (typeof manifest.arcoVersion !== 'string') {
    problems.push('manifest field "arcoVersion" missing or not a string');
  }
  if (typeof manifest.createdAt !== 'string') {
    problems.push('manifest field "createdAt" missing or not a string');
  }
  if (typeof manifest.sourceRoot !== 'string') {
    problems.push('manifest field "sourceRoot" missing or not a string');
  }
  if (typeof manifest.fileCount !== 'number') {
    problems.push('manifest field "fileCount" missing or not a number');
  }
  if (typeof manifest.totalBytes !== 'number') {
    problems.push('manifest field "totalBytes" missing or not a number');
  }
  if (!Array.isArray(manifest.skipped)) {
    problems.push('manifest field "skipped" missing or not an array');
  }
  if (!Array.isArray(manifest.redactions)) {
    problems.push('manifest field "redactions" missing or not an array');
  }

  // ── 5. categories: must be an object with array-of-string values. ──
  const categories = manifest.categories;
  const declaredPaths: string[] = [];
  let categoriesOk = true;
  if (categories === null || typeof categories !== 'object') {
    problems.push('manifest field "categories" missing or not an object');
    categoriesOk = false;
  } else {
    for (const key of CATEGORY_KEYS) {
      const list = (categories as Record<string, unknown>)[key];
      if (!Array.isArray(list)) {
        problems.push(`manifest categories."${key}" missing or not an array`);
        categoriesOk = false;
        continue;
      }
      for (const p of list) {
        if (typeof p !== 'string') {
          problems.push(`manifest categories."${key}" contains a non-string path`);
          categoriesOk = false;
          continue;
        }
        declaredPaths.push(p);
      }
    }
  }

  // ── 6. Defense in depth: re-assert no entry relPath is unsafe. readArchive ──
  // already throws on these, but if it ever reads more leniently this keeps the
  // invariant local to verify (the F3 extraction contract).
  for (const f of files) {
    if (f.relPath.startsWith('/') || f.relPath.split('/').includes('..')) {
      problems.push(`unsafe entry path in archive: ${JSON.stringify(f.relPath)}`);
    }
  }

  // ── 7. Cross-check declared paths ↔ actual entries (only if categories sane). ──
  const actualPaths = files.map((f) => f.relPath);
  if (categoriesOk) {
    const declaredSet = new Set(declaredPaths);
    const actualSet = new Set(actualPaths);

    // Every actual entry must be declared — no smuggled/undeclared file.
    for (const p of actualPaths) {
      if (!declaredSet.has(p)) {
        problems.push(`undeclared file in archive (not in manifest categories): ${p}`);
      }
    }
    // Every declared path must exist as an entry — no missing file.
    for (const p of declaredPaths) {
      if (!actualSet.has(p)) {
        problems.push(`declared path missing from archive (in manifest, no entry): ${p}`);
      }
    }
  }

  // ── 8. fileCount must match the actual entry count. ──
  if (typeof manifest.fileCount === 'number' && manifest.fileCount !== files.length) {
    problems.push(
      `fileCount mismatch: manifest says ${manifest.fileCount}, archive has ${files.length} entr(y/ies)`,
    );
  }

  // ── 9. totalBytes must match the summed entry byte lengths. ──
  const actualBytes = files.reduce((sum, f) => sum + f.bytes.length, 0);
  if (typeof manifest.totalBytes === 'number' && manifest.totalBytes !== actualBytes) {
    problems.push(
      `totalBytes mismatch: manifest says ${manifest.totalBytes}, archive entries sum to ${actualBytes}`,
    );
  }

  return { ok: problems.length === 0, problems };
}
