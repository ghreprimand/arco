// ARCHON_OPS_PLAN.md §F1 — pure capture/skip logic + manifest builder.
//
// This module decides WHAT goes into a backup snapshot and produces the truthful
// manifest that describes it. It is the contract: every regular file in the
// archive is described by exactly one manifest category, and everything the
// walker chose NOT to capture lands in `skipped` with a reason. Nothing is
// silently included or dropped.
//
// Two halves, both pure-ish:
//   • classify() / SKIP rules — a path → {category | skip-reason} decision table,
//     keyed on the POSIX-relative path under the Archon home (~/.archon/...).
//   • walkArchonHome() — the ONE side-effecting function (it reads the fs). It
//     uses fs.lstat (NEVER follows symlinks), records every symlink / socket /
//     fifo / device node as a skip with a reason, and emits regular files only.
//   • buildManifest() — PURE: takes the walk result + INJECTED archonVersion /
//     createdAt and assembles the manifest. The clock/version are parameters so
//     the smoke can pass fixed values and assert determinism; the CLI passes the
//     real version + `new Date().toISOString()`.
//
// SECURITY (mirrors the A2 support-bundle allowlist philosophy): credential /
// token material is never captured. We ALLOWLIST what is safe and skip-and-record
// the rest. Specifically skipped-as-secret: auth.json (Claude Native OAuth) and
// provider-accounts/ (Codex CODEX_HOME credential trees). globalSettings IS
// captured, but secret-shaped top-level fields are redacted to "<redacted>" and
// the redaction is recorded in the manifest (`redactions`).

import { promises as fs } from 'node:fs';
import { join, posix, sep } from 'node:path';

// ── manifest schema ─────────────────────────────────────────────────────────

// One captured-file category. Each maps to a real ~/.archon location (see
// CAPTURE table below). `paths` lists the archive-relative paths that landed in
// this category — so the manifest fully enumerates the archive.
export type BackupCategory =
  | 'globalSettings'
  | 'workflows'
  | 'clusters'
  | 'templates'
  | 'skills'
  | 'recall'
  | 'knowledge';

export interface SkippedEntry {
  // Archive-relative path (POSIX) that was NOT captured.
  path: string;
  // Why — one of: 'secret' (credential/token material), 'regenerable' (cache /
  // derived state), 'transient' (live runtime mailbox/lock), 'special-file'
  // (symlink/socket/fifo/device — non-regular, rejected by construction),
  // 'large-volatile' (logs / model blobs), or 'unknown' (unrecognized path —
  // skipped conservatively).
  reason: string;
}

export interface BackupManifest {
  // Format/version tag so F2/F3 can branch on it.
  format: 'archon-backup/1';
  // INJECTED — the running Archon version (CLI) or a fixed fixture (smoke).
  archonVersion: string;
  // INJECTED — ISO-8601 creation time (CLI: new Date(); smoke: fixed).
  createdAt: string;
  // Absolute source root the snapshot was taken from (redacted to "~" by the
  // CLI; the smoke passes a temp path). Informational.
  sourceRoot: string;
  // Per-category list of archive-relative paths captured into the archive.
  // Every entry here corresponds to exactly one ArchiveFile.
  categories: Record<BackupCategory, string[]>;
  // Everything intentionally not captured, with a reason. The honest other half.
  skipped: SkippedEntry[];
  // Fields scrubbed out of captured files (e.g. settings.json secrets), so the
  // manifest documents the redaction rather than hiding it.
  redactions: { path: string; fields: string[] }[];
  // Total regular-file count + byte total in the archive (cross-check for F2).
  fileCount: number;
  totalBytes: number;
}

// ── capture / skip decision table ───────────────────────────────────────────
//
// Keyed on the FIRST path segment under the Archon home. Conservative: anything
// not explicitly allowlisted is skipped as 'unknown' (better to under-capture
// than to leak something unexamined — plan §F1: "when unsure … skip and record").

// Secret/credential trees — NEVER captured. auth.json holds Claude Native OAuth
// tokens (server/src/providers/claude-native/auth.ts); provider-accounts/ holds
// Codex CODEX_HOME credential trees (server/src/providerAccounts.ts).
const SECRET_SEGMENTS = new Set(['auth.json', 'provider-accounts']);

// Regenerable caches / derived state — skipped (not valuable; restore re-derives).
//   cli-snapshots/  capability probe cache (server/src/capabilities.ts)
//   llamacpp.json   model catalog cache (server/src/llamacppCatalog.ts)
//   models/         downloaded model blobs (server/src/cookbook/install.ts) — huge
//   camoufox-chatgpt-profile/  scraped browser profile (server/src/codexUsage.ts)
//   antigravity-data/  CDP user-data dir (server/src/providers/antigravityManager.ts)
//   checkpoints/    git-snapshot working trees (server/src/gitSnapshots.ts) — large
//   known-cwds.json runtime cwd registry (regenerated as workflows run)
const REGENERABLE_SEGMENTS = new Set([
  'cli-snapshots',
  'llamacpp.json',
  'models',
  'camoufox-chatgpt-profile',
  'antigravity-data',
  'checkpoints',
  'known-cwds.json',
]);

// Large / volatile — logs. Regenerated by the running server; never valuable to
// restore and can be large.
const LARGE_VOLATILE_SEGMENTS = new Set(['logs', 'llamacpp.log']);

// Live runtime substrate — cluster mailboxes are a budgeted file-per-message
// drop box drained on delivery (docs/GOTCHAS.md § Cluster mode). Capturing them
// would resurrect already-delivered or in-flight messages on restore. The rest
// of clusters/ (presets / metadata) IS valuable; only the mailbox/ subtree is
// transient. Handled in classify() by path inspection, not a top segment.

// Result of classifying one path: either a capture category, or a skip reason.
export type Classification =
  | { kind: 'capture'; category: BackupCategory }
  | { kind: 'skip'; reason: string };

// Classify an archive-relative POSIX path (e.g. "settings.json",
// "clusters/abc/mailbox/x.json", "workflows/.../events.jsonl"). Pure.
export function classify(relPath: string): Classification {
  const segs = relPath.split('/').filter(Boolean);
  if (segs.length === 0) return { kind: 'skip', reason: 'unknown' };
  const top = segs[0];

  if (SECRET_SEGMENTS.has(top)) return { kind: 'skip', reason: 'secret' };
  if (REGENERABLE_SEGMENTS.has(top)) return { kind: 'skip', reason: 'regenerable' };
  if (LARGE_VOLATILE_SEGMENTS.has(top)) return { kind: 'skip', reason: 'large-volatile' };

  switch (top) {
    case 'settings.json':
      return { kind: 'capture', category: 'globalSettings' };
    case 'templates.json':
      return { kind: 'capture', category: 'templates' };
    case 'skills':
      return { kind: 'capture', category: 'skills' };
    case 'recall':
      return { kind: 'capture', category: 'recall' };
    case 'knowledge':
      // Global knowledge is per-cwd in practice; a ~/.archon/knowledge tree is
      // unusual but if present it's operator-curated facts → capture.
      return { kind: 'capture', category: 'knowledge' };
    case 'workflows':
      return { kind: 'capture', category: 'workflows' };
    case 'clusters':
    case 'cluster-presets.json': {
      // cluster-presets.json + cluster definitions/plan are valuable; the live
      // mailbox/ drop box under clusters/<id>/ is transient — drained on
      // delivery, so restoring it would replay stale peer messages.
      if (segs.includes('mailbox')) return { kind: 'skip', reason: 'transient' };
      return { kind: 'capture', category: 'clusters' };
    }
    default:
      // Anything we don't recognize is skipped conservatively and recorded, so a
      // future ~/.archon entry is never silently swept in (or silently leaked).
      return { kind: 'skip', reason: 'unknown' };
  }
}

// ── secret-field redaction for globalSettings ───────────────────────────────
//
// settings.json is captured, but a hand-edited file could carry secret-shaped
// top-level fields. We allowlist by SKIPPING known-secret-shaped keys: any
// top-level key whose name matches /token|secret|password|apikey|credential/i is
// replaced with "<redacted>". The shape (provider enables, defaults, theme) is
// preserved. Returns the scrubbed JSON text + the list of redacted field names.
const SECRET_KEY_RE = /token|secret|password|api[-_]?key|credential|bearer/i;

export function redactSettingsJson(raw: string): { text: string; fields: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Unparseable settings — capture verbatim rather than guess; nothing to redact.
    return { text: raw, fields: [] };
  }
  const fields: string[] = [];
  const scrub = (obj: unknown, path: string): unknown => {
    if (Array.isArray(obj)) return obj.map((v, i) => scrub(v, `${path}[${i}]`));
    if (obj && typeof obj === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        if (SECRET_KEY_RE.test(k)) {
          fields.push(path ? `${path}.${k}` : k);
          out[k] = '<redacted>';
        } else {
          out[k] = scrub(v, path ? `${path}.${k}` : k);
        }
      }
      return out;
    }
    return obj;
  };
  const scrubbed = scrub(parsed, '');
  return { text: JSON.stringify(scrubbed, null, 2), fields };
}

// ── filesystem walk (the one side-effecting function) ────────────────────────

export interface WalkedFile {
  relPath: string; // POSIX, relative to the Arco home
  bytes: Buffer;
}

export interface WalkResult {
  files: WalkedFile[];
  skipped: SkippedEntry[];
  redactions: { path: string; fields: string[] }[];
}

// Walk `archonHome` and partition every entry into captured regular files vs
// skipped. Uses lstat and NEVER follows symlinks — a symlink (or socket / fifo /
// block / char device) is recorded as a 'special-file' skip, never traversed and
// never captured (the archive format cannot represent it anyway). globalSettings
// is redacted in-flight. ENOENT on the home → empty result (nothing to back up).
export async function walkArchonHome(archonHome: string): Promise<WalkResult> {
  const files: WalkedFile[] = [];
  const skipped: SkippedEntry[] = [];
  const redactions: { path: string; fields: string[] }[] = [];

  let topLevel: string[];
  try {
    topLevel = await fs.readdir(archonHome);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { files, skipped, redactions };
    throw err;
  }

  const toPosix = (p: string) => (sep === '/' ? p : p.split(sep).join('/'));

  // Recurse one absolute path. `rel` is its POSIX path under the home.
  const visit = async (abs: string, rel: string): Promise<void> => {
    let st;
    try {
      st = await fs.lstat(abs); // lstat: do NOT follow symlinks
    } catch {
      return; // raced deletion — skip silently
    }

    if (st.isSymbolicLink()) {
      skipped.push({ path: rel, reason: 'special-file' });
      return;
    }
    if (!st.isFile() && !st.isDirectory()) {
      // socket / fifo / block / char device — non-regular, not representable.
      skipped.push({ path: rel, reason: 'special-file' });
      return;
    }

    if (st.isDirectory()) {
      // Decide on the directory itself so we don't even descend into a skipped
      // subtree (avoids reading secret/large trees). A directory classified as
      // capture is descended; a skip is recorded once at the dir level.
      const cls = classify(rel);
      if (cls.kind === 'skip') {
        skipped.push({ path: `${rel}/`, reason: cls.reason });
        return;
      }
      const entries = await fs.readdir(abs);
      // Stable order → deterministic archive byte layout for the smoke.
      entries.sort();
      for (const name of entries) {
        await visit(join(abs, name), posix.join(rel, toPosix(name)));
      }
      return;
    }

    // Regular file.
    const cls = classify(rel);
    if (cls.kind === 'skip') {
      skipped.push({ path: rel, reason: cls.reason });
      return;
    }
    if (cls.category === 'globalSettings' && rel === 'settings.json') {
      const raw = await fs.readFile(abs, 'utf8');
      const { text, fields } = redactSettingsJson(raw);
      if (fields.length > 0) redactions.push({ path: rel, fields });
      files.push({ relPath: rel, bytes: Buffer.from(text, 'utf8') });
      return;
    }
    files.push({ relPath: rel, bytes: await fs.readFile(abs) });
  };

  topLevel.sort();
  for (const name of topLevel) {
    await visit(join(archonHome, name), toPosix(name));
  }
  return { files, skipped, redactions };
}

// ── manifest assembly (PURE — clock/version injected) ────────────────────────

export interface BuildManifestInput {
  archonVersion: string; // injected
  createdAt: string; // injected ISO-8601
  sourceRoot: string; // informational (CLI redacts to "~")
  walk: WalkResult;
}

// Assemble the truthful manifest from a walk result + injected metadata. The
// category lists are derived from classify() over each captured file, so the
// manifest's categories EXACTLY enumerate the archive's files.
export function buildManifest(input: BuildManifestInput): BackupManifest {
  const categories: Record<BackupCategory, string[]> = {
    globalSettings: [],
    workflows: [],
    clusters: [],
    templates: [],
    skills: [],
    recall: [],
    knowledge: [],
  };
  let totalBytes = 0;
  for (const f of input.walk.files) {
    const cls = classify(f.relPath);
    // A captured file always classifies as capture (walk guarantees it).
    if (cls.kind === 'capture') categories[cls.category].push(f.relPath);
    totalBytes += f.bytes.length;
  }
  for (const list of Object.values(categories)) list.sort();
  const skipped = [...input.walk.skipped].sort((a, b) => a.path.localeCompare(b.path));

  return {
    format: 'archon-backup/1',
    archonVersion: input.archonVersion,
    createdAt: input.createdAt,
    sourceRoot: input.sourceRoot,
    categories,
    skipped,
    redactions: input.walk.redactions,
    fileCount: input.walk.files.length,
    totalBytes,
  };
}
