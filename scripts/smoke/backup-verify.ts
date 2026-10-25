// ARCHON_OPS_PLAN.md §F2 — backup verify smoke (no live server, no real ~/.archon).
//
// Builds a known-good archive in memory over a small fixture file list (the same
// pure writeArchive/buildManifest path the snapshot smoke uses), then asserts:
//   • a PRISTINE archive passes verify (ok: true, no problems);
//   • each TAMPERED / INCOMPLETE case FAILS with a clear, meaningful reason:
//       (a) bad magic / non-gzip bytes
//       (b) truncated buffer
//       (c) manifest fileCount/totalBytes that don't match the entries
//       (d) manifest declares a path that isn't present (missing file)
//       (e) an entry present but not declared in the manifest (smuggled file)
//       (f) unknown / forged format
//
// (c)-(f) are hand-built with writeArchive + a deliberately-wrong manifest and/or
// doctored file list — that's exactly what verify exists to catch before F3.
//
// Run: npm run smoke:backup-verify   (no :3001 needed)

import { gzipSync } from 'node:zlib';

import { step, assert, assertEq, summary } from './lib.js';
import type { BackupManifest } from '../backup/manifest.js';
import { buildManifest, type WalkResult } from '../backup/manifest.js';
import { writeArchive, type ArchiveFile } from '../backup/archive.js';
import { verifyArchive } from '../backup/verify.js';

const FIXED_VERSION = '9.9.9-fixture';
const FIXED_CREATED_AT = '2026-01-02T03:04:05.000Z';

// A small captured-file fixture (paths that classify as real categories so
// buildManifest enumerates them into the right category lists).
const FIXTURE_FILES: ArchiveFile[] = [
  { relPath: 'settings.json', bytes: Buffer.from('{"enabledProviders":{"claude":true}}', 'utf8') },
  { relPath: 'templates.json', bytes: Buffer.from('{"templates":[]}', 'utf8') },
  { relPath: 'skills/demo/SKILL.md', bytes: Buffer.from('# demo skill', 'utf8') },
  { relPath: 'workflows/meta.json', bytes: Buffer.from('{}', 'utf8') },
];

// Build a truthful manifest over the fixture (no fs — feed a synthetic WalkResult).
function buildGoodManifest(files: ArchiveFile[]): BackupManifest {
  const walk: WalkResult = {
    files: files.map((f) => ({ relPath: f.relPath, bytes: f.bytes })),
    skipped: [],
    redactions: [],
  };
  return buildManifest({
    archonVersion: FIXED_VERSION,
    createdAt: FIXED_CREATED_AT,
    sourceRoot: '~/.archon',
    walk,
  });
}

// Assert a verify result FAILED and that at least one problem matches a pattern,
// proving the reason is meaningful (not just an opaque failure).
function assertFailsWith(buf: Buffer, pattern: RegExp, label: string): void {
  const { ok, problems } = verifyArchive(buf);
  assert(!ok, `${label}: verify must FAIL`);
  assert(problems.length > 0, `${label}: must report at least one problem`);
  assert(
    problems.some((p) => pattern.test(p)),
    `${label}: a problem must match ${pattern} (got: ${JSON.stringify(problems)})`,
  );
}

async function main(): Promise<void> {
  const goodManifest = buildGoodManifest(FIXTURE_FILES);
  const goodArchive = writeArchive(goodManifest, FIXTURE_FILES);

  await step('pristine archive passes verify', () => {
    const { ok, problems } = verifyArchive(goodArchive);
    assert(ok, `pristine archive must pass (problems: ${JSON.stringify(problems)})`);
    assertEq(problems.length, 0, 'no problems on a clean archive');
  });

  await step('(a) bad magic / non-gzip bytes → FAIL', () => {
    assertFailsWith(Buffer.from('this is not a gzip stream at all'), /unreadable/i, 'non-gzip');
    // Valid gzip, but the inner payload has the wrong magic header.
    const wrongMagic = gzipSync(Buffer.concat([Buffer.from('NOTARCH1'), Buffer.alloc(8)]));
    assertFailsWith(wrongMagic, /unreadable|magic/i, 'bad magic');
  });

  await step('(b) truncated buffer → FAIL', () => {
    // Chop the gzip stream in half — gunzip / frame bounds must reject it.
    const truncated = goodArchive.subarray(0, Math.floor(goodArchive.length / 2));
    assertFailsWith(truncated, /unreadable/i, 'truncated');
  });

  await step('(c) fileCount / totalBytes mismatch → FAIL', () => {
    const badCount: BackupManifest = { ...goodManifest, fileCount: goodManifest.fileCount + 5 };
    assertFailsWith(writeArchive(badCount, FIXTURE_FILES), /fileCount mismatch/i, 'bad fileCount');

    const badBytes: BackupManifest = { ...goodManifest, totalBytes: goodManifest.totalBytes + 999 };
    assertFailsWith(writeArchive(badBytes, FIXTURE_FILES), /totalBytes mismatch/i, 'bad totalBytes');
  });

  await step('(d) manifest declares a path with no entry (missing file) → FAIL', () => {
    // Add a phantom path to a category but DON'T put it in the file list.
    const phantom: BackupManifest = {
      ...goodManifest,
      categories: {
        ...goodManifest.categories,
        templates: [...goodManifest.categories.templates, 'templates-PHANTOM.json'],
      },
      // Keep fileCount honest to the file list so the failure is the missing-file
      // check, not a count mismatch (verify reports all problems, but we want to
      // prove THIS specific cross-check fires).
    };
    assertFailsWith(
      writeArchive(phantom, FIXTURE_FILES),
      /declared path missing from archive/i,
      'declared-but-missing',
    );
  });

  await step('(e) entry present but undeclared (smuggled file) → FAIL', () => {
    // Add a real entry that the manifest's categories never list.
    const smuggled: ArchiveFile[] = [
      ...FIXTURE_FILES,
      { relPath: 'skills/demo/SMUGGLED.md', bytes: Buffer.from('surprise', 'utf8') },
    ];
    // Manifest still describes only the original 4 files.
    assertFailsWith(
      writeArchive(goodManifest, smuggled),
      /undeclared file in archive/i,
      'smuggled-entry',
    );
  });

  await step('(f) unknown / forged format → FAIL', () => {
    const forged = { ...goodManifest, format: 'evil-format/9' } as unknown as BackupManifest;
    assertFailsWith(writeArchive(forged, FIXTURE_FILES), /unknown manifest format/i, 'forged format');
  });

  await step('(g) missing required manifest field → FAIL', () => {
    // Drop archonVersion to prove the field-presence checks bite.
    const noVersion = { ...goodManifest } as Partial<BackupManifest>;
    delete noVersion.archonVersion;
    assertFailsWith(
      writeArchive(noVersion as BackupManifest, FIXTURE_FILES),
      /archonVersion/i,
      'missing archonVersion',
    );
  });

  await step('all problems collected (not fail-fast)', () => {
    // An archive that is wrong in two independent ways must report BOTH.
    const doublyBad: BackupManifest = {
      ...goodManifest,
      format: 'evil-format/9' as BackupManifest['format'],
      totalBytes: goodManifest.totalBytes + 1,
    };
    const { ok, problems } = verifyArchive(writeArchive(doublyBad, FIXTURE_FILES));
    assert(!ok, 'doubly-bad archive fails');
    assert(problems.some((p) => /format/i.test(p)), 'format problem reported');
    assert(problems.some((p) => /totalBytes/i.test(p)), 'totalBytes problem reported');
  });

  summary('backup-verify');
}

void main();
