#!/usr/bin/env -S npx tsx
// docs/ARCHITECTURE.md F3 - `arco backup snapshot` + `verify` + `restore`.
//
// Produces a single-file, dependency-free archive of Arco's VALUABLE state
// under ~/.arco plus a truthful manifest stating exactly what it captured and
// what it intentionally skipped (secrets, regenerable caches, transient runtime
// state). The archive format is regular-files-only by construction — see
// scripts/backup/archive.ts for why (F3 restore safety).
//
// This file is the side-effecting shell: it resolves the Arco home + version,
// calls the PURE walk + manifest + writer in scripts/backup/, and writes the
// resulting Buffer to disk. The smoke (scripts/smoke/backup-snapshot.ts) imports
// the pure functions directly with a fake home + fixed clock/version, so all the
// interesting logic is tested WITHOUT a live ~/.arco.
//
// Cross-platform: POSIX paths, node:os/node:path/node:fs only — no shell, no tar.
// Subprocess safety: this command shells out to NOTHING.
//
// Subcommands:
//   snapshot [--out FILE]   write a snapshot archive (default: ~/.arco/backups/
//                           arco-backup-<ISO>.arcobk). --help prints usage.
//   verify <FILE>           validate an archive against its own manifest BEFORE
//                           any restore (F3 gate). Exits non-zero on failure.
//   restore <FILE> --into DIR
//                           verify-first, then manually extract regular files
//                           into DIR (NON-DESTRUCTIVE: never the live home by
//                           default; never overwrites; refuses symlink target
//                           components + traversal; caps file count/bytes).

import '../server/src/envAliases.js'; // upstream-prefixed variables fill unset ARCO_* names
import { existsSync } from 'node:fs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { walkArcoHome, buildManifest } from './backup/manifest.js';
import { writeArchive, readArchive } from './backup/archive.js';
import { verifyArchive } from './backup/verify.js';
import { planRestore, applyRestore, MAX_FILES, MAX_TOTAL_BYTES } from './backup/restore.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Arco home — honors ARCO_HOME (used by tests/tooling) else ~/.arco.
function arcoHome(): string {
  const env = process.env.ARCO_HOME && process.env.ARCO_HOME.trim();
  return env ? env : join(homedir(), '.arco');
}

// Running Arco version from the root package.json (mirrors supportBundle.ts).
async function arcoVersion(): Promise<string> {
  try {
    const pkg = JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      version?: string;
    };
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

// Collapse a home-rooted absolute path to "~/…" so the manifest doesn't leak the
// operator's username in sourceRoot (mirrors the A2 redactPaths philosophy).
function redactHome(p: string): string {
  const home = homedir();
  return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

interface SnapshotArgs {
  out?: string;
  help: boolean;
  unknown: string[];
}

function parseSnapshotArgs(argv: string[]): SnapshotArgs {
  const out: SnapshotArgs = { help: false, unknown: [] };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--help' || tok === '-h') out.help = true;
    else if (tok === '--out' || tok === '-o') out.out = argv[++i];
    else out.unknown.push(tok);
  }
  return out;
}

function snapshotUsage(): void {
  console.log(
    [
      'Usage: arco backup snapshot [--out FILE]',
      '',
      'Write a dependency-free, regular-files-only snapshot of Arco state',
      `under ${redactHome(arcoHome())} plus a truthful manifest.`,
      '',
      'Captures:  globalSettings, workflows, clusters, templates, skills, recall, knowledge',
      'Skips:     auth tokens / provider-accounts (secret), logs & model blobs',
      '           (large/volatile), caches (regenerable), cluster mailboxes (transient).',
      'Redacts:   secret-shaped fields in settings.json.',
      '',
      'Options:',
      '  -o, --out FILE   output path (default: <arco-home>/backups/arco-backup-<ISO>.arcobk)',
      '  -h, --help       show this help',
      '',
      'verify (F2) and restore (F3) land in later phases — see docs/BACKUP.md.',
    ].join('\n'),
  );
}

async function doSnapshot(argv: string[]): Promise<number> {
  const args = parseSnapshotArgs(argv);
  if (args.help) {
    snapshotUsage();
    return 0;
  }
  if (args.unknown.length > 0) {
    console.error(`[arco backup] unrecognized argument(s): ${args.unknown.join(' ')}`);
    snapshotUsage();
    return 2;
  }

  const home = arcoHome();
  const createdAt = new Date().toISOString();
  const [version, walk] = await Promise.all([arcoVersion(), walkArcoHome(home)]);

  const manifest = buildManifest({
    arcoVersion: version,
    createdAt,
    sourceRoot: redactHome(home),
    walk,
  });
  const buf = writeArchive(manifest, walk.files);

  // Default output under <home>/backups so a snapshot is self-locating; the dir
  // is created if absent. A snapshot of ~/.arco written INTO ~/.arco/backups
  // is fine — backups/ isn't a captured category (skipped as 'unknown'), so a
  // later snapshot won't recursively swallow prior ones.
  const outPath = args.out
    ? resolve(args.out)
    : join(home, 'backups', `arco-backup-${createdAt.replace(/[:.]/g, '-')}.arcobk`);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, buf);

  console.log(`[arco backup] wrote ${redactHome(outPath)}`);
  console.log(
    `[arco backup] ${manifest.fileCount} file(s), ${manifest.totalBytes} bytes captured; ` +
      `${manifest.skipped.length} entr(y/ies) skipped; ${manifest.redactions.length} redaction(s).`,
  );
  return 0;
}

// ── verify ───────────────────────────────────────────────────────────────────

interface VerifyArgs {
  file?: string;
  help: boolean;
  unknown: string[];
}

function parseVerifyArgs(argv: string[]): VerifyArgs {
  const out: VerifyArgs = { help: false, unknown: [] };
  for (const tok of argv) {
    if (tok === '--help' || tok === '-h') out.help = true;
    else if (out.file === undefined && !tok.startsWith('-')) out.file = tok;
    else out.unknown.push(tok);
  }
  return out;
}

function verifyUsage(): void {
  console.log(
    [
      'Usage: arco backup verify <FILE>',
      '',
      'Validate a backup archive against its OWN manifest BEFORE any restore.',
      'This is the mandatory gate before `restore` (F3): a tampered, truncated, or',
      'incomplete archive fails here with a clear reason and never reaches restore.',
      '',
      'Checks:  valid gzip + ARCOBK01 magic + in-bounds frames (structure);',
      '         format == "arco-backup/1"; required manifest fields present;',
      '         every archive entry is declared in manifest categories and every',
      '         declared path is present (no smuggled or missing file);',
      '         fileCount and totalBytes match the actual entries; no unsafe path.',
      '',
      'Exit:    0 = OK (archive matches its manifest); 1 = FAIL (problems printed).',
      '',
      'Options:',
      '  -h, --help   show this help',
    ].join('\n'),
  );
}

async function doVerify(argv: string[]): Promise<number> {
  const args = parseVerifyArgs(argv);
  if (args.help) {
    verifyUsage();
    return 0;
  }
  if (args.unknown.length > 0) {
    console.error(`[arco backup] unrecognized argument(s): ${args.unknown.join(' ')}`);
    verifyUsage();
    return 2;
  }
  if (!args.file) {
    console.error('[arco backup] verify requires an archive file path');
    verifyUsage();
    return 2;
  }

  const filePath = resolve(args.file);
  let buf: Buffer;
  try {
    buf = await readFile(filePath);
  } catch (err) {
    console.error(`[arco backup] cannot read ${redactHome(filePath)}: ${(err as Error).message}`);
    return 2;
  }

  const { ok, problems } = verifyArchive(buf);
  if (ok) {
    // Re-read the manifest for the one-line summary (verifyArchive proved it sound).
    const { manifest } = readArchive(buf);
    console.log(`OK  ${redactHome(filePath)}`);
    console.log(
      `[arco backup] verified: ${manifest.fileCount} file(s), ` +
        `arcoVersion ${manifest.arcoVersion}, created ${manifest.createdAt}.`,
    );
    return 0;
  }

  console.error(`FAIL  ${redactHome(filePath)} — ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  return 1;
}

// ── restore ───────────────────────────────────────────────────────────────────

interface RestoreArgs {
  file?: string;
  into?: string;
  forceIntoLive: boolean;
  help: boolean;
  unknown: string[];
}

function parseRestoreArgs(argv: string[]): RestoreArgs {
  const out: RestoreArgs = { forceIntoLive: false, help: false, unknown: [] };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--help' || tok === '-h') out.help = true;
    else if (tok === '--into') out.into = argv[++i];
    else if (tok === '--force-into-live') out.forceIntoLive = true;
    else if (out.file === undefined && !tok.startsWith('-')) out.file = tok;
    else out.unknown.push(tok);
  }
  return out;
}

function restoreUsage(): void {
  console.log(
    [
      'Usage: arco backup restore <FILE> --into <DIR> [--force-into-live]',
      '',
      'Verify-first, then manually extract the archive\'s REGULAR FILES into DIR.',
      'NON-DESTRUCTIVE BY DESIGN — restore never touches the live Arco home by',
      'default; you inspect DIR and move files yourself.',
      '',
      'Safety guards (all conservative — when in doubt, the entry is REFUSED):',
      '  1. verify-first  — runs `verify` and refuses the WHOLE restore on any problem.',
      '  2. symlink-safe  — refuses to descend through any target path component that',
      '                     is a symlink (lstat per component); never follows it.',
      '  3. traversal     — re-rejects absolute / ".." / empty relPaths AND any path',
      '                     that resolves outside DIR (normalized-prefix check).',
      '  4. never-clobber — writes with O_EXCL (`wx`); an existing file is SKIPPED.',
      `  5. caps          — aborts the whole run if > ${MAX_FILES} files or`,
      `                     > ${MAX_TOTAL_BYTES} bytes (no partial extraction).`,
      '',
      'Options:',
      '  --into DIR           REQUIRED. Target directory; must NOT already exist',
      '                       (created fresh) so restore can\'t merge into a live tree.',
      '  --force-into-live    Override the refusal when DIR is (or is inside) the live',
      '                       Arco home. Discouraged; the default refuses.',
      '  -h, --help           show this help',
      '',
      'Exit:    0 = restored (some entries may be skipped/rejected, printed);',
      '         1 = refused (verify failed / cap breach / unsafe target / had',
      '             rejections); 2 = usage error.',
    ].join('\n'),
  );
}

// True iff `target` is the live Arco home or lives inside it (so restoring
// there would mutate live state — refused unless --force-into-live).
function isInsideLiveHome(target: string): boolean {
  const home = resolve(arcoHome());
  const t = resolve(target);
  if (t === home) return true;
  const prefix = home.endsWith(sep) ? home : home + sep;
  return t.startsWith(prefix);
}

async function doRestore(argv: string[]): Promise<number> {
  const args = parseRestoreArgs(argv);
  if (args.help) {
    restoreUsage();
    return 0;
  }
  if (args.unknown.length > 0) {
    console.error(`[arco backup] unrecognized argument(s): ${args.unknown.join(' ')}`);
    restoreUsage();
    return 2;
  }
  if (!args.file) {
    console.error('[arco backup] restore requires an archive file path');
    restoreUsage();
    return 2;
  }
  if (!args.into) {
    console.error('[arco backup] restore requires --into <DIR> (non-destructive: never the live home by default)');
    restoreUsage();
    return 2;
  }

  const targetRoot = resolve(args.into);

  // Non-destructive default: refuse the live Arco home unless explicitly forced.
  if (isInsideLiveHome(targetRoot) && !args.forceIntoLive) {
    console.error(
      `[arco backup] refusing to restore into the live Arco home (${redactHome(targetRoot)}).`,
    );
    console.error(
      '[arco backup] restore is non-destructive by design — choose a fresh --into DIR and move files',
    );
    console.error('[arco backup] yourself, or pass --force-into-live to override (discouraged).');
    return 1;
  }

  // The target must NOT already exist — a fresh dir means restore can't silently
  // merge into (or partially overwrite) a live tree. applyRestore also never
  // overwrites (wx), but refusing a pre-existing root is the louder, earlier gate.
  if (existsSync(targetRoot)) {
    console.error(`[arco backup] --into target already exists: ${redactHome(targetRoot)}`);
    console.error('[arco backup] choose a fresh directory so restore cannot merge into existing files.');
    return 1;
  }

  const filePath = resolve(args.file);
  let buf: Buffer;
  try {
    buf = await readFile(filePath);
  } catch (err) {
    console.error(`[arco backup] cannot read ${redactHome(filePath)}: ${(err as Error).message}`);
    return 2;
  }

  // PURE plan: verify-first + path-safety + caps. Nothing has touched the fs yet.
  const plan = planRestore(buf, targetRoot);
  if (plan.aborted) {
    console.error(`[arco backup] restore ABORTED: ${plan.aborted}`);
    for (const p of plan.problems) console.error(`  - ${p}`);
    return 1;
  }

  // Effecting apply: per-entry symlink-component refusal + wx writes.
  await mkdir(targetRoot, { recursive: true });
  const result = applyRestore(plan, targetRoot);

  console.log(`[arco backup] restored into ${redactHome(targetRoot)}`);
  console.log(
    `[arco backup] ${result.written.length} written, ` +
      `${result.skippedExisting.length} skipped (already existed), ` +
      `${result.rejected.length} rejected.`,
  );
  for (const s of result.skippedExisting) console.log(`  skip   ${s} (exists)`);
  for (const r of result.rejected) console.error(`  reject ${r.relPath} — ${r.reason}`);

  // Any rejection is surfaced as a non-zero exit so an operator scripting restore
  // notices a partially-applied result rather than assuming a clean run.
  return result.rejected.length > 0 ? 1 : 0;
}

function topUsage(): void {
  console.error(
    [
      'Usage: arco backup <command> [options]',
      '',
      'Commands:',
      '  snapshot                       write a state snapshot archive + manifest',
      '  verify <FILE>                  validate an archive against its manifest (pre-restore gate)',
      '  restore <FILE> --into <DIR>    verify-first, safe regular-file extraction (non-destructive)',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  let code: number;
  switch (command) {
    case 'snapshot':
      code = await doSnapshot(rest);
      break;
    case 'verify':
      code = await doVerify(rest);
      break;
    case 'restore':
      code = await doRestore(rest);
      break;
    case undefined:
    case '--help':
    case '-h':
      topUsage();
      code = command === undefined ? 2 : 0;
      break;
    default:
      console.error(`[arco backup] unknown command: ${command}`);
      topUsage();
      code = 2;
  }
  process.exit(code);
}

// Only run when invoked as a script (not when something imports a symbol).
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  void main();
}
