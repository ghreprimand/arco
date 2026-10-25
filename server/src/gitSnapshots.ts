// Workbench Expansion A2 — Shadow-git checkpoint store.
//
// Snapshots the working tree BEFORE a file-mutating operator turn so the
// operator can undo-the-agent independent of their real git history. This is
// pure operator infrastructure: the model never sees a checkpoint, there is
// no tool, and nothing here is ever folded into a system prompt.
//
// `git.ts` stays the read-only status module. All snapshot/write logic lives
// here so the two never tangle.
//
// Mechanism (repo-backed): we never touch the user's index, HEAD, or staging.
// A unique scratch index under the OS temp dir is fed to a `git add -A`
// via the `GIT_INDEX_FILE` env var, then `write-tree` materialises the tree
// and `commit-tree` wraps it in a parentless commit stored at
// `refs/archon/<wfid>/<seq>`. The user's `git status` is byte-identical
// before and after — see scripts/smoke/checkpoints.ts for the assertion.
//
// Non-git workspaces fall back to a SHADOW git repo (bare, at
// `~/.archon/checkpoints/<cwd-hash>/git`) driven with --git-dir/--work-tree so
// the feature works everywhere without ever leaving a .git in the user's
// directory. See the fallback section below for the size-cap scope rules.
//
// GOTCHAS invariant: the snapshot path must NEVER run a bare `git add` (which
// would mutate the user's real index). Always pass GIT_INDEX_FILE, and always
// use execFile with an argv array (no shell string interpolation).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { atomicWriteFile } from './atomicFile.js';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 15_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;
// Retained checkpoints per workflow. Oldest beyond this are pruned after each
// snapshot so a long session can't grow refs/archon unbounded.
const MAX_CHECKPOINTS_PER_WORKFLOW = 50;

export interface CreateCheckpointArgs {
  cwd: string;
  workflowId: string;
  // The workflow event seq this checkpoint guards. Used verbatim as the ref
  // suffix, so one turn maps to exactly one checkpoint.
  seq: number;
  // Optional operator-facing label. Defaults to `before turn <seq>`.
  label?: string;
}

export interface CheckpointResult {
  // Git ref (`refs/archon/<wfid>/<seq>`) — same format on both backends (the
  // shadow store keeps its refs in the per-cwd shadow repo).
  ref: string;
  // Tracked + untracked files captured in the snapshot.
  fileCount: number;
  // Epoch ms the snapshot was taken.
  ts: number;
  // Which store backed this checkpoint. 'shadow-git' = the non-git-cwd
  // fallback repo under ~/.archon/checkpoints/<cwd-hash>/git.
  backend: 'git' | 'shadow-git';
  label: string;
  // Shadow backend only: regular files excluded from the snapshot for
  // exceeding the per-file size cap (models/videos — out of checkpoint scope).
  skippedLargeFiles?: number;
}

async function runGit(
  cwd: string,
  args: string[],
  extraEnv?: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string };
    const code = typeof e.code === 'number' ? e.code : 1;
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? e.message ?? '', code };
  }
}

async function isGitRepo(cwd: string): Promise<{ isRepo: boolean; gitDir: string | null }> {
  const inside = await runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
    return { isRepo: false, gitDir: null };
  }
  // Resolve the absolute git dir so worktrees / submodules / `.git` files all
  // work; we pass it explicitly to every subsequent call.
  const dir = await runGit(cwd, ['rev-parse', '--absolute-git-dir']);
  if (dir.code !== 0) return { isRepo: false, gitDir: null };
  return { isRepo: true, gitDir: dir.stdout.trim() };
}

function validateWfid(wfid: string): void {
  // Refs are filesystem paths under .git/refs — reject anything that could
  // escape the namespace. Workflow ids are UUIDs in practice.
  if (!/^[A-Za-z0-9._-]+$/.test(wfid)) {
    throw new Error(`gitSnapshots: invalid workflowId "${wfid}"`);
  }
}

function refFor(workflowId: string, seq: number): string {
  return `refs/archon/${workflowId}/${seq}`;
}

// Count files in a tree object (recursive). Used for the fileCount surfaced to
// the operator. `-r` recurses, one line per blob.
async function countTreeFiles(cwd: string, gitDir: string, treeish: string): Promise<number> {
  const out = await runGit(cwd, ['--git-dir', gitDir, 'ls-tree', '-r', '--name-only', treeish]);
  if (out.code !== 0) return 0;
  return out.stdout.split('\n').filter((l) => l.trim().length > 0).length;
}

// Prune oldest refs beyond the cap. Refs sort lexically by their numeric seq
// suffix; we delete the lowest seqs first. Best-effort — pruning failure never
// fails a snapshot.
async function pruneOldCheckpoints(
  cwd: string,
  gitDir: string,
  workflowId: string,
  metadataRoot?: string,
): Promise<void> {
  const prefix = `refs/archon/${workflowId}/`;
  const listed = await runGit(cwd, [
    '--git-dir', gitDir,
    'for-each-ref', '--format=%(refname)', prefix,
  ]);
  if (listed.code !== 0) return;
  const refs = listed.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  if (refs.length <= MAX_CHECKPOINTS_PER_WORKFLOW) return;
  // Sort by numeric seq suffix ascending; oldest first.
  refs.sort((a, b) => {
    const an = Number(a.slice(prefix.length));
    const bn = Number(b.slice(prefix.length));
    return (Number.isFinite(an) ? an : 0) - (Number.isFinite(bn) ? bn : 0);
  });
  const toDelete = refs.slice(0, refs.length - MAX_CHECKPOINTS_PER_WORKFLOW);
  for (const ref of toDelete) {
    const deleted = await runGit(cwd, ['--git-dir', gitDir, 'update-ref', '-d', ref]);
    if (deleted.code === 0 && metadataRoot) {
      const seq = ref.slice(prefix.length);
      await fs.rm(path.join(metadataRoot, `${workflowId}.${seq}.skipped.json`), { force: true }).catch(() => {});
    }
  }
}

async function createGitCheckpoint(
  args: CreateCheckpointArgs,
  gitDir: string,
): Promise<CheckpointResult | null> {
  const { cwd, workflowId, seq } = args;
  const label = args.label ?? `before turn ${seq}`;
  const ts = Date.now();

  // Separate, per-operation index so the user's staging area is never touched
  // and simultaneous workflows in one cwd cannot contend on one .lock file.
  // Keep it OUTSIDE the worktree: otherwise a concurrent snapshot can stage
  // another operation's scratch file when .archon is not globally ignored.
  const snapIndex = path.join(
    tmpdir(),
    `archon-snapshot-${cwdHash(cwd)}-${process.pid}-${randomUUID()}.index`,
  );
  // Start the separate index from the current HEAD tree when HEAD exists, so
  // `add -A` only has to record the working-tree delta (cheaper, and matches
  // what the operator would see). On an unborn HEAD (fresh repo, no commits)
  // skip the read-tree and let add -A build the index from scratch.
  const snapEnv: NodeJS.ProcessEnv = { GIT_INDEX_FILE: snapIndex };
  const headExists = (await runGit(cwd, ['--git-dir', gitDir, 'rev-parse', '--verify', 'HEAD'])).code === 0;

  try {
    if (headExists) {
      const readTree = await runGit(cwd, ['--git-dir', gitDir, 'read-tree', 'HEAD'], snapEnv);
      if (readTree.code !== 0) {
        console.error(`[archon] gitSnapshots read-tree failed: ${readTree.stderr.trim()}`);
        return null;
      }
    }
    // Stage the whole working tree into the SEPARATE index (never the user's).
    const add = await runGit(cwd, ['--git-dir', gitDir, 'add', '-A'], snapEnv);
    if (add.code !== 0) {
      console.error(`[archon] gitSnapshots add -A failed: ${add.stderr.trim()}`);
      return null;
    }
    const writeTree = await runGit(cwd, ['--git-dir', gitDir, 'write-tree'], snapEnv);
    if (writeTree.code !== 0) {
      console.error(`[archon] gitSnapshots write-tree failed: ${writeTree.stderr.trim()}`);
      return null;
    }
    const tree = writeTree.stdout.trim();
    if (!tree) return null;

    // Parentless commit — checkpoints form a flat per-workflow series, not a
    // chain off the user's history. Identity is fixed so we don't depend on
    // (or pollute) the user's git config. Message carries the label + seq.
    const commitEnv: NodeJS.ProcessEnv = {
      ...snapEnv,
      GIT_AUTHOR_NAME: 'archon-checkpoint',
      GIT_AUTHOR_EMAIL: 'checkpoint@archon.local',
      GIT_COMMITTER_NAME: 'archon-checkpoint',
      GIT_COMMITTER_EMAIL: 'checkpoint@archon.local',
    };
    const commit = await runGit(
      cwd,
      ['--git-dir', gitDir, 'commit-tree', tree, '-m', `archon checkpoint: ${label} (seq ${seq})`],
      commitEnv,
    );
    if (commit.code !== 0) {
      console.error(`[archon] gitSnapshots commit-tree failed: ${commit.stderr.trim()}`);
      return null;
    }
    const sha = commit.stdout.trim();
    if (!sha) return null;

    const ref = refFor(workflowId, seq);
    const update = await runGit(cwd, ['--git-dir', gitDir, 'update-ref', ref, sha]);
    if (update.code !== 0) {
      console.error(`[archon] gitSnapshots update-ref failed: ${update.stderr.trim()}`);
      return null;
    }

    const fileCount = await countTreeFiles(cwd, gitDir, tree);
    await pruneOldCheckpoints(cwd, gitDir, workflowId).catch(() => {});

    return { ref, fileCount, ts, backend: 'git', label };
  } finally {
    // Clean up the separate index; harmless if it's already gone.
    await fs.rm(snapIndex, { force: true }).catch(() => {});
  }
}

// ── Non-git fallback: shadow git store ──
//
// A bare repo per non-git cwd at `~/.archon/checkpoints/<cwd-hash>/git`,
// driven with `--git-dir`/`--work-tree` (the dotfiles pattern) so nothing ever
// lands in the user's directory — it stays non-git from their point of view.
//
// Replaces the original tar-per-turn fallback (2026-08-19): a tar copied the
// ENTIRE cwd every operator turn with zero sharing between snapshots — a
// 318 GB ComfyUI cwd accrued 302 GB of timeout-truncated partial tars in an
// afternoon, twice — and a plain tar could never delete files-created-after
// on revert. The shadow repo is content-addressed (an unchanged file costs
// nothing after its first snapshot) and reverts with real git tree semantics.
// Legacy `<wfid>.<seq>.tar` files in the same store stay readable by revert.
//
// Scope rule (load-bearing): regular files over the per-file cap are SKIPPED.
// Agents mutate configs/scripts/text; multi-GB models and videos are inert
// ballast no per-turn snapshot scheme can afford to copy. Each ref gets a
// skipped-path manifest: target-skipped paths stay out of the revert seed even
// if they later shrink, while a currently capped path overlapping the target
// aborts the revert before any write. Capped files are never collateral. A
// total cap on the included
// bytes backstops pathological many-small-file trees; over it the snapshot is
// skipped entirely (null = "no checkpoint this turn"). Overrides:
// ARCHON_CHECKPOINT_FILE_CAP_BYTES / ARCHON_CHECKPOINT_TOTAL_CAP_BYTES
// (0 disables either). Caps apply only to this fallback, never to real repos.
const DEFAULT_FILE_CAP_BYTES = 32 * 1024 * 1024; // 32 MiB per file
const DEFAULT_TOTAL_CAP_BYTES = 1024 * 1024 * 1024; // 1 GiB included total
// `git add` re-hashes every listed file (the object store dedupes writes, not
// hashing), so give staging more room than GIT_TIMEOUT_MS; the caps bound it.
const STAGE_TIMEOUT_MS = 60_000;

function envCap(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
const fileCapBytes = (): number => envCap('ARCHON_CHECKPOINT_FILE_CAP_BYTES', DEFAULT_FILE_CAP_BYTES);
const totalCapBytes = (): number => envCap('ARCHON_CHECKPOINT_TOTAL_CAP_BYTES', DEFAULT_TOTAL_CAP_BYTES);

function cwdHash(cwd: string): string {
  return createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 16);
}

// Per-cwd checkpoint store root: holds the shadow repo (`git/`) and any legacy
// tar checkpoints from the pre-shadow fallback.
export function checkpointStoreRoot(cwd: string): string {
  return path.join(homedir(), '.archon', 'checkpoints', cwdHash(cwd));
}

function shadowGitDir(cwd: string): string {
  return path.join(checkpointStoreRoot(cwd), 'git');
}

interface SnapshotWalk {
  // cwd-relative POSIX paths a snapshot covers, sorted for determinism.
  files: string[];
  // Regular files excluded for exceeding the per-file cap. Paths are retained
  // so a later revert can keep the checkpoint's out-of-scope files untouched
  // even if their sizes have changed since capture.
  skippedLargePaths: string[];
  // True when the included total crossed the total cap (walk early-exits;
  // `files` is partial and must not be snapshotted).
  exceededTotal: boolean;
}

// Enumerate what a shadow snapshot covers. Skips the top-level .archon (our
// own workflow-state dir) and every `.git` at ANY depth — git refuses .git
// pathspecs, and a nested repo's internals aren't operator content (its
// working files ARE included). Symlinks are included (git stores the link
// itself, so they cost nothing and never count against the caps).
async function collectSnapshotFiles(
  root: string,
  fileCap: number,
  totalCap: number,
): Promise<SnapshotWalk> {
  const files: string[] = [];
  const skippedLargePaths: string[] = [];
  let total = 0;
  const stack = [''];
  while (stack.length > 0) {
    const rel = stack.pop()!;
    const abs = rel ? path.join(root, rel) : root;
    const entries = await fs.readdir(abs, { withFileTypes: true }).catch(() => []);
    for (const ent of entries) {
      if (ent.name === '.git') continue;
      if (rel === '' && ent.name === '.archon') continue;
      const relPath = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        stack.push(relPath);
      } else if (ent.isSymbolicLink()) {
        files.push(relPath);
      } else if (ent.isFile()) {
        const st = await fs.lstat(path.join(root, relPath)).catch(() => null);
        if (!st) continue;
        if (fileCap > 0 && st.size > fileCap) {
          skippedLargePaths.push(relPath);
          continue;
        }
        total += st.size;
        if (totalCap > 0 && total > totalCap) {
          return { files, skippedLargePaths, exceededTotal: true };
        }
        files.push(relPath);
      }
    }
  }
  files.sort();
  skippedLargePaths.sort();
  return { files, skippedLargePaths, exceededTotal: false };
}

// Init the shadow repo on first use. Bare — it must never have its own
// checkout; every worktree op passes --work-tree=<cwd> explicitly.
async function ensureShadowRepo(cwd: string): Promise<string | null> {
  const gitDir = shadowGitDir(cwd);
  const exists = await fs.access(path.join(gitDir, 'HEAD')).then(() => true, () => false);
  if (exists) return gitDir;
  await fs.mkdir(gitDir, { recursive: true });
  const init = await runGit(cwd, ['init', '-q', '--bare', gitDir]);
  if (init.code !== 0) {
    // Another workflow may have won the first-use race after our access check.
    const initialized = await fs.access(path.join(gitDir, 'HEAD')).then(() => true, () => false);
    if (initialized) return gitDir;
    console.error(`[archon] gitSnapshots shadow init failed: ${init.stderr.trim()}`);
    return null;
  }
  return gitDir;
}

// Stage an explicit file list into GIT_INDEX_FILE via --pathspec-from-file
// (NUL-separated temp file — immune to argv length limits on big trees).
// `-f` is load-bearing: a non-git cwd may contain .gitignore files (nested
// projects), and without force `git add` REFUSES ignored paths and fails the
// whole staging — ignore rules are the project's business, not the snapshot's.
// A file deleted between walk and add fails the staging (unmatched pathspec);
// that's an acceptable best-effort miss — the next turn snapshots again.
async function stagePathspecs(
  cwd: string,
  gitDir: string,
  indexFile: string,
  files: string[],
): Promise<boolean> {
  if (files.length === 0) return true; // empty tree is a valid snapshot
  const pathspecFile = path.join(gitDir, `pathspec-${process.pid}-${randomUUID()}.tmp`);
  await fs.writeFile(pathspecFile, files.join('\0') + '\0');
  try {
    await execFileAsync(
      'git',
      [
        '--git-dir', gitDir, '--work-tree', cwd,
        'add', '-f', '--pathspec-from-file', pathspecFile, '--pathspec-file-nul',
      ],
      {
        cwd,
        timeout: STAGE_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        env: { ...process.env, GIT_INDEX_FILE: indexFile },
      },
    );
    return true;
  } catch (err) {
    console.error(`[archon] gitSnapshots shadow staging failed: ${(err as Error).message}`);
    return false;
  } finally {
    await fs.rm(pathspecFile, { force: true }).catch(() => {});
  }
}

interface SkippedManifest {
  version: 1;
  paths: string[];
}

function skippedManifestPath(cwd: string, workflowId: string, seq: number): string {
  return path.join(checkpointStoreRoot(cwd), `${workflowId}.${seq}.skipped.json`);
}

// Persist the exact out-of-scope paths alongside each shadow ref. Size alone
// is not stable across time: a skipped model can later shrink, or an included
// config can later grow. The manifest keeps rewind semantics tied to capture.
async function writeSkippedManifest(
  cwd: string,
  workflowId: string,
  seq: number,
  paths: string[],
): Promise<void> {
  const manifest: SkippedManifest = { version: 1, paths };
  await atomicWriteFile(skippedManifestPath(cwd, workflowId, seq), JSON.stringify(manifest));
}

async function readSkippedManifest(cwd: string, workflowId: string, seq: number): Promise<string[] | null> {
  let raw: string;
  try {
    raw = await fs.readFile(skippedManifestPath(cwd, workflowId, seq), 'utf8');
  } catch (err) {
    // Legacy shadow refs predate manifests. Other read failures are unsafe to
    // guess through because the file defines what rewind must preserve.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<SkippedManifest>;
    if (parsed.version !== 1 || !Array.isArray(parsed.paths)) return null;
    return parsed.paths.filter((item): item is string => typeof item === 'string');
  } catch {
    return null;
  }
}

async function listTreePaths(cwd: string, gitDir: string, tree: string): Promise<string[] | null> {
  const out = await runGit(cwd, ['--git-dir', gitDir, 'ls-tree', '-r', '-z', '--name-only', tree]);
  if (out.code !== 0) return null;
  return out.stdout.split('\0').filter(Boolean);
}

// File-vs-directory type changes matter too, so overlap includes descendants
// in either direction rather than only exact pathname equality.
function pathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

async function createShadowGitCheckpoint(args: CreateCheckpointArgs): Promise<CheckpointResult | null> {
  const { cwd, workflowId, seq } = args;
  const label = args.label ?? `before turn ${seq}`;
  const ts = Date.now();

  const walk = await collectSnapshotFiles(cwd, fileCapBytes(), totalCapBytes());
  if (walk.exceededTotal) {
    console.error(
      `[archon] [${workflowId.slice(0, 8)}] gitSnapshots: shadow snapshot skipped — ` +
        `${cwd} exceeds the included-total cap (ARCHON_CHECKPOINT_TOTAL_CAP_BYTES)`,
    );
    return null;
  }

  const gitDir = await ensureShadowRepo(cwd);
  if (!gitDir) return null;

  // Index lives inside the shadow gitdir — outside the user's tree, and safe
  // here (unlike the revert path) because snapshotting never runs `-u`.
  // Per-operation naming prevents same-cwd workflows from sharing a lock.
  const snapIndex = path.join(gitDir, `snap-${process.pid}-${randomUUID()}.index`);
  const env: NodeJS.ProcessEnv = { GIT_INDEX_FILE: snapIndex };
  try {
    if (!(await stagePathspecs(cwd, gitDir, snapIndex, walk.files))) return null;

    const writeTree = await runGit(cwd, ['--git-dir', gitDir, 'write-tree'], env);
    if (writeTree.code !== 0) {
      console.error(`[archon] gitSnapshots shadow write-tree failed: ${writeTree.stderr.trim()}`);
      return null;
    }
    const tree = writeTree.stdout.trim();
    if (!tree) return null;

    const commitEnv: NodeJS.ProcessEnv = {
      ...env,
      GIT_AUTHOR_NAME: 'archon-checkpoint',
      GIT_AUTHOR_EMAIL: 'checkpoint@archon.local',
      GIT_COMMITTER_NAME: 'archon-checkpoint',
      GIT_COMMITTER_EMAIL: 'checkpoint@archon.local',
    };
    const commit = await runGit(
      cwd,
      ['--git-dir', gitDir, 'commit-tree', tree, '-m', `archon checkpoint: ${label} (seq ${seq})`],
      commitEnv,
    );
    if (commit.code !== 0) {
      console.error(`[archon] gitSnapshots shadow commit-tree failed: ${commit.stderr.trim()}`);
      return null;
    }
    const sha = commit.stdout.trim();
    if (!sha) return null;

    const ref = refFor(workflowId, seq);
    await writeSkippedManifest(cwd, workflowId, seq, walk.skippedLargePaths);
    const update = await runGit(cwd, ['--git-dir', gitDir, 'update-ref', ref, sha]);
    if (update.code !== 0) {
      await fs.rm(skippedManifestPath(cwd, workflowId, seq), { force: true }).catch(() => {});
      console.error(`[archon] gitSnapshots shadow update-ref failed: ${update.stderr.trim()}`);
      return null;
    }

    await pruneOldCheckpoints(cwd, gitDir, workflowId, checkpointStoreRoot(cwd)).catch(() => {});
    // Best-effort repack so pruned checkpoints' objects don't pile up loose.
    await runGit(cwd, ['--git-dir', gitDir, 'gc', '--auto', '-q']).catch(() => {});

    return {
      ref,
      fileCount: walk.files.length,
      ts,
      backend: 'shadow-git',
      label,
      ...(walk.skippedLargePaths.length > 0 ? { skippedLargeFiles: walk.skippedLargePaths.length } : {}),
    };
  } finally {
    await fs.rm(snapIndex, { force: true }).catch(() => {});
  }
}

// Snapshot the working tree before a turn that may write. Returns null when
// the snapshot was skipped (no cwd) or failed — callers treat null as
// "no checkpoint this turn" and carry on; a failed snapshot must never block
// an operator turn.
export async function createCheckpoint(args: CreateCheckpointArgs): Promise<CheckpointResult | null> {
  const { cwd, workflowId } = args;
  if (!cwd) return null;
  validateWfid(workflowId);

  try {
    const { isRepo, gitDir } = await isGitRepo(cwd);
    if (isRepo && gitDir) {
      return await createGitCheckpoint(args, gitDir);
    }
    return await createShadowGitCheckpoint(args);
  } catch (err) {
    console.error(`[archon] [${workflowId.slice(0, 8)}] createCheckpoint failed:`, err);
    return null;
  }
}

// ── Revert (Workbench Expansion A4) ──
//
// Restore the working tree to a previously-captured checkpoint. The cardinal
// rule mirrors createCheckpoint: never move the user's HEAD or current branch,
// and never mutate their real staging index in a surprising way.
//
// Safety model: the operator-facing handler ALWAYS takes a fresh "pre-revert"
// checkpoint of the live working tree first (so the revert is itself undoable),
// then calls this. We re-assert that contract here defensively but the handler
// owns the snapshot+abort-on-failure flow.
//
// Faithfulness: a real revert must make the working tree MATCH the checkpoint
// tree exactly — including DELETING files that were created after the
// checkpoint. A restore that only overwrites/adds isn't a revert. We achieve
// this with a SEPARATE index file (never the user's): `read-tree -u --reset`
// the checkpoint tree into that scratch index, which both writes every tree
// entry into the working tree AND removes working-tree files that the scratch
// index was tracking but the tree no longer has. To make "removes files added
// after" work for files git wasn't already tracking in the scratch index, we
// first seed the scratch index from the LIVE working tree (HEAD + `add -A`),
// so every currently-present file is tracked there; the subsequent
// `read-tree -u --reset <tree>` then deletes the ones absent from the target
// tree. This is the documented index semantics: the user's REAL index/HEAD are
// untouched; the working tree ends matching the checkpoint tree; the scratch
// index is discarded. The user's `git status` afterward reflects the restored
// tree vs their unchanged HEAD (i.e. it shows the revert as uncommitted
// working-tree changes, which is exactly what an operator wants to review).

export interface RevertCheckpointArgs {
  cwd: string;
  workflowId: string;
  // The checkpoint identifier. For git backends this is the seq (we build the
  // ref ourselves so a caller can't inject an arbitrary ref); for the tar
  // fallback it's also the seq.
  seq: number;
}

export interface RevertResult {
  // How many files the restored tree contains (git) / the tar held (tar).
  fileCount: number;
  backend: 'git' | 'tar';
  // The ref/tarName actually restored from.
  restoredFrom: string;
  // Set on the tar path: full faithfulness (delete files-added-after) was not
  // achievable; see the tar branch comment.
  limitation?: string;
}

// Resolve a checkpoint ref's tree, rejecting refs that don't exist (e.g.
// pruned by GC). Returns the tree sha or null.
async function resolveCheckpointTree(cwd: string, gitDir: string, ref: string): Promise<string | null> {
  const out = await runGit(cwd, ['--git-dir', gitDir, 'rev-parse', '--verify', '--quiet', `${ref}^{tree}`]);
  if (out.code !== 0) return null;
  const tree = out.stdout.trim();
  return tree || null;
}

async function revertGitCheckpoint(
  cwd: string,
  gitDir: string,
  workflowId: string,
  seq: number,
): Promise<RevertResult | null> {
  const ref = refFor(workflowId, seq);
  const tree = await resolveCheckpointTree(cwd, gitDir, ref);
  if (!tree) {
    console.error(`[archon] gitSnapshots revert: checkpoint ${ref} not found (pruned?)`);
    return null;
  }

  // Scratch index — NEVER the user's. CRUCIAL: it must live OUTSIDE the working
  // tree. `read-tree -u --reset` sweeps working-tree files (and now-empty dirs)
  // absent from the target tree; an index under cwd/.archon would get deleted
  // mid-operation ("unable to write new index file"). The OS temp dir sidesteps
  // that. (The snapshot path keeps its index under .archon because it never
  // runs `-u`, so no worktree sweep happens there.)
  const revertIndex = path.join(
    tmpdir(),
    `archon-revert-${cwdHash(cwd)}-${workflowId}-${seq}-${randomUUID()}.index`,
  );
  const env: NodeJS.ProcessEnv = { GIT_INDEX_FILE: revertIndex };

  try {
    await fs.rm(revertIndex, { force: true }).catch(() => {});

    // Seed the scratch index from the LIVE working tree so every currently
    // present file (tracked + untracked) is registered there. `read-tree -u
    // --reset <target>` will then delete the ones absent from the target tree
    // — that's what makes "files created after the checkpoint are removed"
    // work. HEAD seeds tracked files; `add -A` folds in untracked + deletions.
    //
    // Exclude .archon (live workflow state — our own dir) and .git from the
    // seed so a revert never sweeps them even if a project failed to gitignore
    // .archon. Checkpoint trees normally don't contain .archon anyway (it's
    // gitignored in a project cwd), so the target tree won't re-create it.
    const headExists = (await runGit(cwd, ['--git-dir', gitDir, 'rev-parse', '--verify', 'HEAD'], env)).code === 0;
    if (headExists) {
      const rt = await runGit(cwd, ['--git-dir', gitDir, 'read-tree', 'HEAD'], env);
      if (rt.code !== 0) {
        console.error(`[archon] gitSnapshots revert seed read-tree failed: ${rt.stderr.trim()}`);
        return null;
      }
    }
    // NOTE: this used to be `add -A -- ':!.archon' ':!.git'`, but an
    // exclude-only pathspec makes git treat matched-but-IGNORED dirs as
    // explicitly requested — with a global `**/.archon/` ignore rule (the operator's
    // ~/.config/git/ignore) the add REFUSED (.archon "ignored by one of your
    // .gitignore files") and every revert in a repo containing .archon failed
    // (found 2026-08-19). Plain `add -A` skips ignored files silently; the
    // follow-up `rm --cached` then drops .archon from the seed where a project
    // does NOT ignore it. Both must succeed — a seeded .archon would be swept
    // from the working tree by `read-tree -u --reset` (it's absent from every
    // checkpoint tree).
    const add = await runGit(cwd, ['--git-dir', gitDir, 'add', '-A'], env);
    if (add.code !== 0) {
      console.error(`[archon] gitSnapshots revert seed add -A failed: ${add.stderr.trim()}`);
      return null;
    }
    const drop = await runGit(
      cwd,
      ['--git-dir', gitDir, 'rm', '--cached', '-r', '-q', '--ignore-unmatch', '--', '.archon'],
      env,
    );
    if (drop.code !== 0) {
      console.error(`[archon] gitSnapshots revert seed .archon drop failed: ${drop.stderr.trim()}`);
      return null;
    }

    // The load-bearing call: update the working tree to match the checkpoint
    // tree, removing tracked-in-scratch-index files that the target tree lacks.
    // `-u` writes files out; `--reset` permits overwriting/removing local
    // changes (this IS a destructive revert — the handler already took the
    // safety snapshot). Operates against the scratch index only.
    const restore = await runGit(cwd, ['--git-dir', gitDir, 'read-tree', '-u', '--reset', tree], env);
    if (restore.code !== 0) {
      console.error(`[archon] gitSnapshots revert read-tree -u --reset failed: ${restore.stderr.trim()}`);
      return null;
    }

    const fileCount = await countTreeFiles(cwd, gitDir, tree);
    return { fileCount, backend: 'git', restoredFrom: ref };
  } finally {
    await fs.rm(revertIndex, { force: true }).catch(() => {});
  }
}

// Legacy reader: pre-2026-08-19 non-git checkpoints are tar archives in the
// same store. Kept so old checkpoint markers on the HISTORY timeline stay
// revertible; nothing creates new tars.
async function revertTarCheckpoint(
  cwd: string,
  workflowId: string,
  seq: number,
): Promise<RevertResult | null> {
  const root = checkpointStoreRoot(cwd);
  const tarName = `${workflowId}.${seq}.tar`;
  const tarPath = path.join(root, tarName);
  try {
    await fs.access(tarPath);
  } catch {
    console.error(`[archon] gitSnapshots revert: tar checkpoint ${tarName} not found (pruned?)`);
    return null;
  }

  // Faithfulness on the tar path: we can OVERWRITE the working tree with the
  // archived contents, but reliably DELETING files created after the snapshot
  // is not feasible from a plain tar without a tracked manifest of "what
  // existed then" vs "what exists now" — and the non-git cwd has no index to
  // diff against. We extract over the cwd (additive/overwrite) and surface the
  // limitation to the operator. The safety snapshot (taken by the handler
  // before this runs) still makes the action reversible, so the operator can
  // undo if the residual files matter.
  const extract = await execFileAsync(
    'tar',
    ['-xf', tarPath, '-C', cwd],
    { timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER },
  ).then(
    () => ({ ok: true as const }),
    (err: NodeJS.ErrnoException) => ({ ok: false as const, err }),
  );
  if (!extract.ok) {
    console.error('[archon] gitSnapshots revert tar extract failed:', extract.err?.message ?? extract.err);
    return null;
  }

  let fileCount = 0;
  const list = await execFileAsync('tar', ['-tf', tarPath], { maxBuffer: GIT_MAX_BUFFER }).catch(() => null);
  if (list) {
    fileCount = list.stdout.split('\n').filter((l) => l.trim().length > 0 && !l.endsWith('/')).length;
  }

  return {
    fileCount,
    backend: 'tar',
    restoredFrom: tarName,
    limitation: 'tar fallback overwrites/restores archived files but does not delete files created after the checkpoint',
  };
}

// Shadow-store revert: same faithful tree-restore as the real-repo path (files
// created after the checkpoint ARE deleted), against the per-cwd shadow repo.
// The scratch index is seeded from the current capped walk plus the target
// ref's skipped-path manifest. This is load-bearing: seeding an out-of-scope
// path would make `read-tree -u --reset` DELETE it, while restoring over a
// currently capped path would destroy bytes the safety snapshot cannot hold.
async function revertShadowGitCheckpoint(
  cwd: string,
  workflowId: string,
  seq: number,
): Promise<RevertResult | null> {
  const gitDir = shadowGitDir(cwd);
  const hasShadow = await fs.access(path.join(gitDir, 'HEAD')).then(() => true, () => false);
  const ref = refFor(workflowId, seq);
  const tree = hasShadow ? await resolveCheckpointTree(cwd, gitDir, ref) : null;
  if (!tree) {
    // Not in the shadow store — try the legacy tar reader before giving up.
    return revertTarCheckpoint(cwd, workflowId, seq);
  }

  // Scratch index OUTSIDE the working tree — same rule as the real-repo revert
  // (`read-tree -u` sweeps worktree files absent from the target tree).
  const revertIndex = path.join(
    tmpdir(),
    `archon-revert-${cwdHash(cwd)}-${workflowId}-${seq}-${randomUUID()}.index`,
  );
  const env: NodeJS.ProcessEnv = { GIT_INDEX_FILE: revertIndex };

  try {
    await fs.rm(revertIndex, { force: true }).catch(() => {});

    const walk = await collectSnapshotFiles(cwd, fileCapBytes(), totalCapBytes());
    if (walk.exceededTotal) {
      console.error('[archon] gitSnapshots shadow revert aborted: working tree exceeds the included-total cap');
      return null;
    }

    const targetPaths = await listTreePaths(cwd, gitDir, tree);
    if (!targetPaths) return null;
    // Never overwrite a file that is currently over cap. If the target tree
    // contains that path, the safe action is to abort: neither the target nor
    // the handler's safety snapshot can recover the current large bytes.
    const unsafeCurrent = walk.skippedLargePaths.filter((skipped) =>
      targetPaths.some((targetPath) => pathsOverlap(skipped, targetPath)));
    if (unsafeCurrent.length > 0) {
      console.error(
        `[archon] gitSnapshots shadow revert aborted: ${unsafeCurrent.length} currently capped path(s) overlap the target tree`,
      );
      return null;
    }

    // Paths skipped when the target was captured remain out of scope even if
    // they are small now; omitting them from the seed prevents read-tree from
    // deleting them merely because they are absent from the checkpoint tree.
    const targetSkipped = await readSkippedManifest(cwd, workflowId, seq);
    if (!targetSkipped) {
      console.error('[archon] gitSnapshots shadow revert aborted: skipped-path manifest is unreadable');
      return null;
    }
    const seedFiles = walk.files.filter((file) =>
      !targetSkipped.some((skipped) => pathsOverlap(file, skipped)));
    if (!(await stagePathspecs(cwd, gitDir, revertIndex, seedFiles))) return null;

    const restore = await runGit(
      cwd,
      ['--git-dir', gitDir, '--work-tree', cwd, 'read-tree', '-u', '--reset', tree],
      env,
    );
    if (restore.code !== 0) {
      console.error(`[archon] gitSnapshots shadow revert read-tree -u --reset failed: ${restore.stderr.trim()}`);
      return null;
    }

    const fileCount = await countTreeFiles(cwd, gitDir, tree);
    return {
      fileCount,
      backend: 'git',
      restoredFrom: ref,
    };
  } finally {
    await fs.rm(revertIndex, { force: true }).catch(() => {});
  }
}

// Restore the working tree to a checkpoint. Returns null if the checkpoint
// could not be found (pruned) or the restore failed — the caller treats null
// as "revert failed, do not emit success". The caller MUST take a safety
// snapshot first (see RevertResult doc).
export async function revertToCheckpoint(args: RevertCheckpointArgs): Promise<RevertResult | null> {
  const { cwd, workflowId, seq } = args;
  if (!cwd) return null;
  validateWfid(workflowId);
  if (!Number.isFinite(seq) || seq < 0) {
    throw new Error(`gitSnapshots: invalid revert seq "${seq}"`);
  }

  try {
    const { isRepo, gitDir } = await isGitRepo(cwd);
    if (isRepo && gitDir) {
      return await revertGitCheckpoint(cwd, gitDir, workflowId, seq);
    }
    return await revertShadowGitCheckpoint(cwd, workflowId, seq);
  } catch (err) {
    console.error(`[archon] [${workflowId.slice(0, 8)}] revertToCheckpoint failed:`, err);
    return null;
  }
}
