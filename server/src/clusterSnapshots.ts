// Cluster snapshots — full, restorable captures of a LIVE cluster.
//
// A snapshot is heavier than a preset (clusterPresets.ts): where a preset
// stores only per-member CONFIG (project-agnostic, flat JSON), a snapshot
// captures the entire cluster state PLUS every member's complete conversation
// history (meta.json + events.jsonl). So it gets its own on-disk directory
// tree rather than a single shared JSON file:
//
//   ~/.archon/cluster-snapshots/<snapshotId>/
//     manifest.json                       full ClusterState + per-member
//                                          resolved config + plan body + meta
//     members/<oldWfid>/meta.json         copy of the member's WorkflowMeta
//     members/<oldWfid>/events.jsonl      copy of the member's event log
//
// Restore is FORK semantics (mirrors spawn-from-here): a brand-new clusterId +
// brand-new member workflowIds are minted — the original cluster may still be
// open, and reusing ids would collide in the in-memory registry + on-disk
// store. Every embedded workflowId in the copied meta.json + every events.jsonl
// line is rewritten old→new so the client routes the replayed events to the
// right member after restore.
//
// The mailbox is transient (drain destroys the file; see clusterMailbox.ts) so
// it is intentionally NOT captured or restored.
//
// Name rules mirror clusterPresets: trimmed, non-empty, ≤64 chars, unique
// case-insensitive across the snapshot set unless the operator confirms an
// id-pinned replacement.
//
// Save builds a complete hidden sibling directory, then renames it into place.
// Confirmed replacement first renames the old directory to a hidden backup, so
// an incomplete capture can never replace the last good snapshot.

import { promises as fs } from 'fs';
import path from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import type { ClusterMemberAccessMode, ClusterSnapshotSummary, ProviderName, ModelName, EffortLevel, WorkflowConfig } from '@archon/shared';
import * as clusterStore from './clusterStore.js';
import { readMeta, writeMeta, type WorkflowMeta, WFID_PATTERN } from './workflowMeta.js';
import { flushWorkflowBuffer, forgetWorkflowBuffer, initWorkflowStore } from './workflowStore.js';
import { readClusterPlan } from './clusterPlanBridge.js';
import { rememberCwd } from './crashRecovery.js';
import { atomicWriteFile } from './atomicFile.js';
import { archonHome } from './archonHome.js';

const NAME_MAX = 64;
const MAX_SNAPSHOTS = 100;
// Per-member events.jsonl cap. Save reads the whole log into a string and
// restore builds a rewritten copy of it, so an unbounded log could OOM the
// server (and take every live worker down with it). 512 MB is far above any
// real transcript (typical logs are single-digit MB) while still bounding the
// blast radius. Exceeding it fails the save with a clear error rather than
// risking the process.
const MAX_MEMBER_EVENTS_BYTES = 512 * 1024 * 1024;

function snapshotsRoot(): string {
  return path.join(archonHome(), 'cluster-snapshots');
}

function snapshotDir(snapshotId: string): string {
  return path.join(snapshotsRoot(), snapshotId);
}

function manifestPath(snapshotId: string): string {
  return path.join(snapshotDir(snapshotId), 'manifest.json');
}

function memberDir(snapshotId: string, oldWfid: string): string {
  return path.join(snapshotDir(snapshotId), 'members', oldWfid);
}

export class SnapshotValidationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export class SnapshotConflictError extends SnapshotValidationError {
  readonly existing: ClusterSnapshotSummary;
  constructor(existing: ClusterSnapshotSummary) {
    super('duplicate_name', `snapshot named "${existing.name}" already exists`);
    this.existing = existing;
  }
}

// Per-member resolved config captured in the manifest. New snapshots use the
// portable WorkflowConfig as restore authority; copied meta.json remains the
// backward-compatible source for older snapshots and owns transcript/session
// metadata. The duplicated summary fields keep the manifest easy to inspect.
export interface SnapshotMemberConfig {
  oldWorkflowId: string;
  name: string;
  provider: ProviderName;
  model: ModelName;
  effort: EffortLevel;
  providerAccountRef?: string;
  role?: string;
  tier?: string;
  focus?: string;
  accessMode?: ClusterMemberAccessMode;
  // New snapshots carry the complete durable operator configuration, including
  // client-only fields meta.json cannot reconstruct (advanced/fast mode,
  // permission posture, provider allowlist, fallbacks). Restore sanitizes
  // machine-bound cwd/cluster fields. Optional for schema-v1 back-compat.
  workflowConfig?: WorkflowConfig;
}

// schemaVersion 1 — bump when the manifest shape changes in a way restore
// needs to branch on.
export interface SnapshotManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  createdAt: string;
  sourceCwd: string;
  memberCount: number;
  // Full ClusterState as it was at save time (roles/tiers/focus/dispatcher/
  // plan id all included). On restore the member id arrays inside this are
  // remapped old→new; everything else is reattached as-is.
  clusterState: clusterStore.ClusterState;
  members: SnapshotMemberConfig[];
  // The attached plan's markdown body, captured by value. Restore always mints
  // a FRESH per-cwd plan from this body (never reuses clusterState.planId — see
  // restoreSnapshot), so the body is the authoritative plan record. Absent when
  // the cluster had no plan attached.
  planBody?: string;
}

interface SnapshotFileSummary {
  manifest: SnapshotManifest;
}

function validateName(name: unknown): string {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed) throw new SnapshotValidationError('invalid_name', 'name must be non-empty after trim');
  if (trimmed.length > NAME_MAX) throw new SnapshotValidationError('invalid_name', `name exceeds ${NAME_MAX} chars`);
  return trimmed;
}

function toSummary(m: SnapshotManifest): ClusterSnapshotSummary {
  return {
    id: m.id,
    name: m.name,
    createdAt: m.createdAt,
    memberCount: m.memberCount,
    sourceCwd: m.sourceCwd,
  };
}

async function readManifest(snapshotId: string): Promise<SnapshotManifest | null> {
  try {
    const raw = await fs.readFile(manifestPath(snapshotId), 'utf8');
    const parsed = JSON.parse(raw) as SnapshotManifest;
    if (!parsed || parsed.schemaVersion !== 1 || typeof parsed.id !== 'string') return null;
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export interface PortableSnapshotFile {
  relPath: string;
  bytes: Buffer;
}

// Materialize one snapshot as regular files for the portable bundle layer.
// The bundle owns framing/integrity; this module remains the authority on the
// snapshot directory shape.
export async function readSnapshotFiles(snapshotId: string): Promise<PortableSnapshotFile[]> {
  const manifest = await readManifest(snapshotId);
  if (!manifest) {
    throw new SnapshotValidationError('unknown_snapshot', `unknown snapshot ${snapshotId.slice(0, 8)}`);
  }
  const files: PortableSnapshotFile[] = [{
    relPath: 'manifest.json',
    bytes: await fs.readFile(manifestPath(snapshotId)),
  }];
  for (const member of manifest.members) {
    if (!WFID_PATTERN.test(member.oldWorkflowId)) {
      throw new SnapshotValidationError('invalid_member', `snapshot member ${member.oldWorkflowId} is invalid`);
    }
    for (const name of ['meta.json', 'events.jsonl'] as const) {
      const relPath = `members/${member.oldWorkflowId}/${name}`;
      const bytes = await fs.readFile(path.join(memberDir(snapshotId, member.oldWorkflowId), name));
      files.push({ relPath, bytes });
    }
  }
  return files;
}

function importedName(base: string, existing: SnapshotManifest[]): string {
  const used = new Set(existing.map((m) => m.name.trim().toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let n = 2; n <= 999; n++) {
    const suffix = ` (${n})`;
    const candidate = `${base.slice(0, NAME_MAX - suffix.length)}${suffix}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  throw new SnapshotValidationError('duplicate_name', `too many snapshots named "${base}"`);
}

// Import a verified regular-file bundle into the local snapshot store. Always
// mint a new local snapshot id; cloud/file imports are copies and must never
// collide with an existing local artifact.
export async function importSnapshotFiles(files: PortableSnapshotFile[]): Promise<ClusterSnapshotSummary> {
  const byPath = new Map(files.map((f) => [f.relPath, f.bytes]));
  const manifestBytes = byPath.get('manifest.json');
  if (!manifestBytes) throw new SnapshotValidationError('invalid_bundle', 'bundle has no manifest.json');
  let source: SnapshotManifest;
  try {
    source = JSON.parse(manifestBytes.toString('utf8')) as SnapshotManifest;
  } catch {
    throw new SnapshotValidationError('invalid_bundle', 'bundle manifest is not valid JSON');
  }
  if (source.schemaVersion !== 1 || !Array.isArray(source.members) || source.members.length < 2) {
    throw new SnapshotValidationError('invalid_bundle', 'unsupported or incomplete cluster snapshot manifest');
  }
  const existing = await readAllManifests();
  if (existing.length >= MAX_SNAPSHOTS) {
    throw new SnapshotValidationError('too_many', `snapshot count exceeds cap of ${MAX_SNAPSHOTS}`);
  }
  const snapshotId = randomUUID();
  const name = importedName(validateName(source.name), existing);
  const expected = new Set<string>(['manifest.json']);
  for (const member of source.members) {
    if (!WFID_PATTERN.test(member.oldWorkflowId)) {
      throw new SnapshotValidationError('invalid_member', `bundle member ${member.oldWorkflowId} is invalid`);
    }
    expected.add(`members/${member.oldWorkflowId}/meta.json`);
    expected.add(`members/${member.oldWorkflowId}/events.jsonl`);
  }
  if (files.some((f) => !expected.has(f.relPath)) || [...expected].some((p) => !byPath.has(p))) {
    throw new SnapshotValidationError('invalid_bundle', 'bundle file set does not match its manifest');
  }
  const manifest: SnapshotManifest = {
    ...source,
    id: snapshotId,
    name,
    memberCount: source.members.length,
  };
  const tempDir = `${snapshotDir(snapshotId)}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.mkdir(tempDir, { recursive: true });
    await fs.writeFile(path.join(tempDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    for (const member of manifest.members) {
      const dest = path.join(tempDir, 'members', member.oldWorkflowId);
      await fs.mkdir(dest, { recursive: true });
      await fs.writeFile(path.join(dest, 'meta.json'), byPath.get(`members/${member.oldWorkflowId}/meta.json`)!);
      await fs.writeFile(path.join(dest, 'events.jsonl'), byPath.get(`members/${member.oldWorkflowId}/events.jsonl`)!);
    }
    await fs.mkdir(snapshotsRoot(), { recursive: true });
    await fs.rename(tempDir, snapshotDir(snapshotId));
  } catch (err) {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  return toSummary(manifest);
}

// Read every manifest under the snapshots root. Skips unreadable / malformed
// dirs (a half-written snapshot during a crash) rather than failing the list.
async function readAllManifests(): Promise<SnapshotManifest[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(snapshotsRoot());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: SnapshotManifest[] = [];
  for (const id of entries) {
    // Save/replace staging and backup directories are intentionally hidden.
    // Never expose a half-committed replacement through the list surface.
    if (id.startsWith('.') || id.endsWith('.tmp')) continue;
    let m: SnapshotManifest | null = null;
    try {
      m = await readManifest(id);
    } catch { /* skip unreadable */ }
    if (m) out.push(m);
  }
  return out;
}

// ── List ──────────────────────────────────────────────────────────────────

export async function listSnapshots(): Promise<ClusterSnapshotSummary[]> {
  const manifests = await readAllManifests();
  // Newest-first, matching the preset list convention.
  manifests.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return manifests.map(toSummary);
}

// ── Save ──────────────────────────────────────────────────────────────────

export interface SaveSnapshotInput {
  clusterId: string;
  name: string;
  memberConfigs?: Record<string, WorkflowConfig>;
  replaceSnapshotId?: string;
}

function portableWorkflowConfig(input: WorkflowConfig): WorkflowConfig {
  const config = structuredClone(input);
  // Creation tokens, provider-resume pointers, and remote-control arming are
  // runtime/machine state, not portable worker settings. Excluding them from
  // the artifact is safer than merely ignoring them during restore.
  delete config.researchSpawnToken;
  delete config.templateSpawnToken;
  delete config.resumeSessionId;
  delete config.resumeWorkflowId;
  delete config.remoteEnabled;
  delete config.remoteGatesEnabled;
  return config;
}

function portableWorkflowMeta(input: WorkflowMeta): WorkflowMeta {
  const meta = structuredClone(input);
  // Provider-native sessions live outside Archon and are not included in the
  // bundle. Carrying their ids across machines makes the restored fork attempt
  // to resume a rollout that cannot exist there (`thread/resume: no rollout
  // found` for Codex). Sanitize both when saving new artifacts and when
  // restoring old artifacts created before this fence existed.
  meta.cliSessions = [];
  return meta;
}

// Snapshot the live cluster. Reads the in-memory/on-disk ClusterState, flushes
// each member's event buffer (so the copy captures the latest events), then
// copies each member's meta.json + events.jsonl into the snapshot dir.
export async function saveSnapshot(input: SaveSnapshotInput): Promise<ClusterSnapshotSummary> {
  const name = validateName(input.name);

  const cluster = await clusterStore.readCluster(input.clusterId);
  if (!cluster) {
    throw new SnapshotValidationError('unknown_cluster', `unknown cluster ${input.clusterId.slice(0, 8)}`);
  }

  // Case-insensitive duplicate-name fence (mirrors clusterPresets). Replacement
  // requires the exact id returned by the conflict response; a bare boolean
  // would make a stale client capable of overwriting a different snapshot that
  // acquired this name between list and confirmation.
  const existing = await readAllManifests();
  const lower = name.toLowerCase();
  const duplicate = existing.find((m) => m.name.trim().toLowerCase() === lower);
  if (duplicate && input.replaceSnapshotId !== duplicate.id) {
    throw new SnapshotConflictError(toSummary(duplicate));
  }
  if (!duplicate && input.replaceSnapshotId) {
    throw new SnapshotValidationError(
      'replace_target_missing',
      'the snapshot selected for replacement no longer exists under that name — refresh and try again',
    );
  }
  if (!duplicate && existing.length >= MAX_SNAPSHOTS) {
    throw new SnapshotValidationError('too_many', `snapshot count exceeds cap of ${MAX_SNAPSHOTS}`);
  }

  const cwd = cluster.cwd;
  const snapshotId = duplicate?.id ?? randomUUID();
  const finalDir = snapshotDir(snapshotId);
  const tempDir = path.join(snapshotsRoot(), `.${snapshotId}.${process.pid}.${Date.now()}.tmp`);
  const backupDir = path.join(snapshotsRoot(), `.${snapshotId}.${process.pid}.${Date.now()}.backup`);

  try {
    await fs.mkdir(tempDir, { recursive: true });
    const members: SnapshotMemberConfig[] = [];
    for (const oldWfid of cluster.members) {
      if (!WFID_PATTERN.test(oldWfid)) {
        throw new SnapshotValidationError('invalid_member', `member ${oldWfid} has an invalid workflowId shape`);
      }
      // Flush the in-memory event buffer BEFORE copying events.jsonl so the
      // copy includes events still sitting on the 100ms debounce timer.
      await flushWorkflowBuffer(cwd, oldWfid).catch(() => { /* best-effort */ });

      const meta = await readMeta(cwd, oldWfid);
      if (!meta) {
        throw new SnapshotValidationError('member_meta_missing', `member ${oldWfid.slice(0, 8)} has no meta.json on disk`);
      }

      const destDir = path.join(tempDir, 'members', oldWfid);
      await fs.mkdir(destDir, { recursive: true });
      await fs.writeFile(
        path.join(destDir, 'meta.json'),
        JSON.stringify(portableWorkflowMeta(meta), null, 2) + '\n',
        'utf8',
      );
      const srcEvents = path.join(cwd, '.archon', 'workflows', oldWfid, 'events.jsonl');
      let eventsText = '';
      try {
        const st = await fs.stat(srcEvents);
        if (st.size > MAX_MEMBER_EVENTS_BYTES) {
          throw new SnapshotValidationError(
            'member_log_too_large',
            `member ${oldWfid.slice(0, 8)} events.jsonl is ${Math.round(st.size / (1024 * 1024))}MB, over the ${MAX_MEMBER_EVENTS_BYTES / (1024 * 1024)}MB snapshot cap`,
          );
        }
        eventsText = await fs.readFile(srcEvents, 'utf8');
      } catch (err) {
        if (err instanceof SnapshotValidationError) throw err;
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      await fs.writeFile(path.join(destDir, 'events.jsonl'), eventsText, 'utf8');

      members.push({
        oldWorkflowId: oldWfid,
        name: meta.name,
        provider: meta.primaryProvider,
        model: meta.primaryModel,
        effort: meta.primaryEffort,
        ...(meta.providerAccountRef ? { providerAccountRef: meta.providerAccountRef } : {}),
        ...(cluster.memberRoles?.[oldWfid] ? { role: cluster.memberRoles[oldWfid] } : {}),
        ...(cluster.memberTiers?.[oldWfid] ? { tier: cluster.memberTiers[oldWfid] } : {}),
        ...(cluster.memberFocuses?.[oldWfid] ? { focus: cluster.memberFocuses[oldWfid] } : {}),
        ...(cluster.memberAccessModes?.[oldWfid] ? { accessMode: cluster.memberAccessModes[oldWfid] } : {}),
        ...(input.memberConfigs?.[oldWfid]
          ? { workflowConfig: portableWorkflowConfig(input.memberConfigs[oldWfid]) }
          : {}),
      });
    }

    let planBody: string | undefined;
    if (cluster.planId) {
      const plan = await readClusterPlan(input.clusterId).catch(() => null);
      planBody = plan?.body ?? undefined;
    }
    const manifest: SnapshotManifest = {
      schemaVersion: 1,
      id: snapshotId,
      name,
      createdAt: new Date().toISOString(),
      sourceCwd: cwd,
      memberCount: members.length,
      clusterState: cluster,
      members,
      ...(planBody ? { planBody } : {}),
    };
    await fs.writeFile(path.join(tempDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

    if (duplicate) {
      // Build the complete replacement beside the live copy. Only after every
      // member + manifest succeeds do we atomically hide the old directory and
      // put the new one at the same id. A failed build leaves the old snapshot
      // byte-for-byte untouched.
      await fs.rename(finalDir, backupDir);
      try {
        await fs.rename(tempDir, finalDir);
      } catch (err) {
        await fs.rename(backupDir, finalDir).catch(() => {});
        throw err;
      }
      await fs.rm(backupDir, { recursive: true, force: true }).catch((err) => {
        console.warn(`[archon] snapshot replacement backup cleanup failed (${snapshotId.slice(0, 8)}):`, err);
      });
    } else {
      await fs.rename(tempDir, finalDir);
    }
    return toSummary(manifest);
  } catch (err) {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

// ── Restore ─────────────────────────────────────────────────────────────────

export interface RestoredMember {
  oldWorkflowId: string;
  newWorkflowId: string;
  meta: WorkflowMeta;       // the rewritten meta (workflowId already new)
  config?: WorkflowConfig;  // complete captured config when saved by new builds
}

export interface RestoreSnapshotResult {
  cluster: clusterStore.ClusterState;
  members: RestoredMember[];
  targetCwd: string;
  // The cwd the snapshot was taken in. The handler compares it to targetCwd
  // to decide provider-session resume wiring (claude CLI sessions are keyed
  // by cwd on disk, so cross-cwd resume would fail).
  sourceCwd: string;
  // Captured plan body (if any) so the caller can re-attach the plan in the
  // target cwd via the normal plan path. Absent when the snapshot had no plan.
  planBody?: string;
}

// Rewrite every embedded workflowId in an events.jsonl body old→new. Each line
// is `{ seq, ts, parentEventSeq?, ...ServerMessage }`; the ServerMessage's
// `workflowId` field (and, defensively, any other field whose value is exactly
// the old id) is swapped. We rewrite by exact-string replacement on the parsed
// value rather than a blind text replace so an id appearing inside free-form
// text (e.g. an assistant message that happens to quote the id) is left alone.
function rewriteEventsLine(line: string, idMap: Map<string, string>): string {
  const trimmed = line.trim();
  if (!trimmed) return line;
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    // Malformed line — leave it verbatim so we don't silently drop history.
    return line;
  }
  const remapped = remapWorkflowIds(entry, idMap);
  return JSON.stringify(remapped);
}

// Swap any top-level OR nested string value that exactly equals a known old id.
// ServerMessages embed workflowId at the top level; peer events also carry
// from/to/sender id fields. A recursive remap keeps every routing id consistent
// without enumerating each message type.
function remapWorkflowIds(value: unknown, idMap: Map<string, string>): unknown {
  if (typeof value === 'string') {
    return idMap.get(value) ?? value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => remapWorkflowIds(v, idMap));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = remapWorkflowIds(v, idMap);
    }
    return out;
  }
  return value;
}

// Truncate an events.jsonl body to its last N turns. A "turn" is delimited by a
// `primary_turn_started` event (one per turn). "Last N turns" = keep all events
// from the Nth-from-last `primary_turn_started` line through end-of-file.
//
// !turns / turns <= 0 ⇒ unchanged (restore ALL). Fewer than `turns` markers ⇒
// unchanged. Malformed lines are skipped while scanning for markers but kept
// verbatim when slicing if they fall inside the retained range, so we never
// silently drop history. Trailing-newline shape is preserved by slicing the raw
// split array and re-joining.
export function truncateToLastNTurns(eventsText: string, turns: number | undefined): string {
  if (!turns || turns <= 0) return eventsText;
  const lines = eventsText.split('\n');
  const markerIdxs: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed) as { type?: unknown };
      if (entry.type === 'primary_turn_started') markerIdxs.push(i);
    } catch {
      // Malformed line — skip when scanning; it'll still be kept verbatim if it
      // lands inside the retained slice below.
    }
  }
  if (markerIdxs.length <= turns) return eventsText;
  const startIdx = markerIdxs[markerIdxs.length - turns];
  return lines.slice(startIdx).join('\n');
}

// Compact a restored events.jsonl to replay weight. A live turn is recorded at
// streaming granularity — token-ish text deltas, started/completed tool pairs,
// per-call counters, per-file diagnostics. Replaying a restore at that
// granularity floods the client (one WS message + one store update each): the
// 2026-06-12 incident replayed ~42k events per restore, the tab stalled for
// minutes, missed heartbeats, and reconnect-looped under the SYNCING overlay.
// None of that granularity is information once the turn is history, so the
// restored copy drops it:
//
//  1. Adjacent `primary_text` sharing (workflowId, phase) merge into one event
//     with the concatenated text — the client itself coalesces replayed text
//     into one bubble, so delta boundaries are invisible anyway. (~89% of a
//     real log: 41,922 of 46,936 events.)
//  2. `primary_tool_use` with status 'started'/'in_progress' drops when the
//     same call (toolUseId) settles later in the log — the settled
//     'completed'/'failed' event is the historical record (carries
//     output/exitCode), and the client appends one activity row per event, so
//     the transient rows were pure duplicates. A call that never settled
//     (cancelled turn) keeps its 'started' row as the only record of it.
//  3. `primary_tool_counter` keeps only the last per workflowId — the client
//     handler is last-write-wins (setToolCallsSinceCompact).
//  4. `diagnostics` keeps only the last per (workflowId, file) — the client
//     handler replaces the per-file entry wholesale (setDiagnostics).
//  5. `task_ledger_snapshot` keeps only the last per workflowId — each one is
//     a full copy of the cwd's task ledger (~200 KB on a real project), and a
//     busy cluster re-broadcasts it on every mutation. The 2026-06-12 restore
//     of a 4-member odytty snapshot carried 163 of them = 31.4 MB of 58.9 MB
//     total; one member alone shipped 110 copies (22.7 MB of its 23.5 MB log).
//     The client handler replaces the ledger wholesale, so only the last is
//     state — and even that is belt-and-braces (the server re-broadcasts the
//     live ledger on task_ledger_list / mutation anyway).
//  6. `primary_tool_use` input/output strings truncate to 16 KB (middle-cut,
//     mirroring the client's MAX_TOOL_INPUT_STRING_BYTES_CLIENT cap). The
//     client truncates these for display and persistence regardless, so whale
//     tool results (full-file Reads, build logs) are dead weight on the wire
//     and in the restored log. Native replay-from-events for provider context
//     skips tool events entirely (workerHelpers pair-flush), so this loses
//     nothing the model would have seen either.
//  7. `primary_tool_use` keeps only the last 300 rows per workflowId (after
//     rule 2 settles-dedupe). The client hard-caps chat at 500 messages and
//     the activity feed at 500 entries (memoryTrim.ts), so a tool-heavy tab's
//     thousands of historical tool cards are ingested and immediately trimmed
//     — one real member carried 4,492 tool rows (9.5 MB) of which the client
//     could display at most a few hundred. Provider context is unaffected
//     (rule 6's note applies).
//
// Dropped lines do NOT break a text run (they never render, so merging across
// them preserves visible order). The merged text line keeps the FIRST delta's
// ts + parentEventSeq (backward chain intact) and the LAST delta's seq — seqs
// stay monotonic, and both the initWorkflowStore tail-scan and the client's
// lastSeq tracking read the run's head seq. Malformed lines are kept verbatim
// and break the current run.
// Rule 6 helper — middle-truncate the input/output strings of a replayed
// primary_tool_use event at 16 KB each (the client's per-string display cap).
// Returns the mutated event when something was cut, null when the line can be
// passed through verbatim (avoids re-stringifying the common small case).
const TOOL_STRING_CAP = 16 * 1024;
// Rule 7 — newest tool rows kept per workflow. Sized below the client's chat
// (500) and activity (500) caps so nothing kept here is guaranteed-trimmed.
const TOOL_ROWS_KEPT = 300;
function capToolEventStrings(ev: Record<string, unknown>): Record<string, unknown> | null {
  let changed = false;
  for (const field of ['input', 'output'] as const) {
    const v = ev[field];
    if (typeof v === 'string' && v.length > TOOL_STRING_CAP) {
      const notice = `\n[truncated at cluster-snapshot restore; ${v.length} chars originally]\n`;
      const keep = TOOL_STRING_CAP - notice.length;
      ev[field] = v.slice(0, Math.ceil(keep / 2)) + notice + v.slice(v.length - Math.floor(keep / 2));
      changed = true;
    }
  }
  return changed ? ev : null;
}

export function compactRestoredEvents(eventsText: string): string {
  const lines = eventsText.split('\n');
  type Parsed = { line: string; ev: Record<string, unknown> | null };
  const parsed: Parsed[] = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return { line, ev: null };
    try { return { line, ev: JSON.parse(trimmed) as Record<string, unknown> }; }
    catch { return { line, ev: null }; }
  });

  // Pass 1 — find the last counter per workflowId, the last diagnostics per
  // (workflowId, file), and which tool calls settle; earlier counter/diag
  // events are superseded state, not history.
  const lastCounterIdx = new Map<unknown, number>();
  const lastDiagIdx = new Map<string, number>();
  const lastLedgerIdx = new Map<string, number>();
  const settledToolUseIds = new Set<unknown>();
  parsed.forEach(({ ev }, i) => {
    if (!ev) return;
    if (ev.type === 'primary_tool_counter') lastCounterIdx.set(ev.workflowId, i);
    if (ev.type === 'task_ledger_snapshot') lastLedgerIdx.set(`${String(ev.workflowId)}::${String(ev.boardKey ?? 'project')}`, i);
    if (ev.type === 'diagnostics') lastDiagIdx.set(`${String(ev.workflowId)}::${String(ev.file)}`, i);
    // Call identity: Codex mints a FRESH toolUseId per status event (started
    // and completed carry different ones) — its stable key is itemId. Native
    // keeps toolUseId stable. Prefer itemId, fall back to toolUseId.
    if (ev.type === 'primary_tool_use' && (ev.status === 'completed' || ev.status === 'failed')) {
      const key = ev.itemId ?? ev.toolUseId;
      if (key) settledToolUseIds.add(key);
    }
  });

  // Pass 1.5 — rule 7. Of the tool rows that survive rule 2 (settled rows +
  // never-settled starts), keep only the newest TOOL_ROWS_KEPT per workflowId.
  // Needs settledToolUseIds complete, hence a separate walk.
  const survivingToolIdxs = new Map<unknown, number[]>();
  parsed.forEach(({ ev }, i) => {
    if (!ev || ev.type !== 'primary_tool_use') return;
    const transient = (ev.status === 'started' || ev.status === 'in_progress') &&
      settledToolUseIds.has(ev.itemId ?? ev.toolUseId);
    if (transient) return; // rule 2 drops it anyway
    const list = survivingToolIdxs.get(ev.workflowId) ?? [];
    list.push(i);
    survivingToolIdxs.set(ev.workflowId, list);
  });
  const keepToolIdx = new Set<number>();
  for (const list of survivingToolIdxs.values()) {
    for (const i of list.slice(-TOOL_ROWS_KEPT)) keepToolIdx.add(i);
  }

  const out: string[] = [];
  let run: { ev: Record<string, unknown>; texts: string[] } | null = null;
  const flush = () => {
    if (!run) return;
    run.ev.text = run.texts.join('');
    out.push(JSON.stringify(run.ev));
    run = null;
  };
  parsed.forEach(({ line, ev }, i) => {
    if (!ev) {
      // Blank or malformed — keep verbatim (never silently drop history we
      // can't read), and break the run since we can't see past it.
      flush(); out.push(line); return;
    }
    // Rules 2 + 7 — keepToolIdx already encodes both: transient rows whose
    // call settles later were excluded in pass 1.5, and survivors beyond the
    // newest TOOL_ROWS_KEPT per workflow fell off the slice.
    if (ev.type === 'primary_tool_use' && !keepToolIdx.has(i)) return;
    if (ev.type === 'primary_tool_counter' && lastCounterIdx.get(ev.workflowId) !== i) return;
    if (ev.type === 'task_ledger_snapshot' && lastLedgerIdx.get(`${String(ev.workflowId)}::${String(ev.boardKey ?? 'project')}`) !== i) return;
    if (ev.type === 'diagnostics' && lastDiagIdx.get(`${String(ev.workflowId)}::${String(ev.file)}`) !== i) return;
    if (ev.type === 'primary_tool_use') {
      flush();
      const capped = capToolEventStrings(ev);
      out.push(capped ? JSON.stringify(capped) : line);
      return;
    }
    if (ev.type !== 'primary_text' || typeof ev.text !== 'string') {
      flush(); out.push(line); return;
    }
    if (run && run.ev.phase === ev.phase && run.ev.workflowId === ev.workflowId) {
      run.texts.push(ev.text);
      run.ev.seq = ev.seq;
    } else {
      flush();
      run = { ev, texts: [ev.text] };
    }
  });
  flush();
  return out.join('\n');
}

// Restore a snapshot into a fresh cluster. Pure on-disk + clusterStore work:
// mints new ids, writes the new workflow dirs (meta + events with ids
// rewritten), rememberCwd, registers the cluster + reattaches roles/tiers/
// focus/dispatcher/plan. Does NOT touch the in-memory `workflows` registry or
// broadcast — the WS handler does that so this module stays dependency-light
// (mirrors how clusterStore is a pure persistence layer).
//
// `turnsPerMember` (optional) truncates each member's restored history to its
// last N turns — see truncateToLastNTurns. Omitted / 0 / negative ⇒ full
// history. This bounds both the on-disk copy and the handler's over-the-wire
// replay so a real multi-thousand-event log doesn't swamp the client before
// cluster_created lands.
export async function restoreSnapshot(snapshotId: string, targetCwdInput?: string, turnsPerMember?: number): Promise<RestoreSnapshotResult> {
  const manifest = await readManifest(snapshotId);
  if (!manifest) {
    throw new SnapshotValidationError('unknown_snapshot', `unknown snapshot ${snapshotId.slice(0, 8)}`);
  }
  const targetCwd = (typeof targetCwdInput === 'string' && targetCwdInput.trim().length > 0)
    ? targetCwdInput.trim()
    : manifest.sourceCwd;
  if (!targetCwd) {
    throw new SnapshotValidationError('invalid_target', 'no target cwd (snapshot has no sourceCwd and none was provided)');
  }

  const oldIds = manifest.members.map((m) => m.oldWorkflowId);
  if (oldIds.length < 2) {
    throw new SnapshotValidationError('too_few_members', 'snapshot has fewer than 2 members; cannot restore a cluster');
  }

  // Mint new ids up front and build the old→new map so events.jsonl rewrites
  // remap cross-member references (peer_message_sent.to, etc.) too.
  const idMap = new Map<string, string>();
  for (const oldId of oldIds) idMap.set(oldId, randomUUID());

  // Register the cluster BEFORE writing member event logs so its new clusterId
  // can be folded into the idMap — the recursive remap then swaps the embedded
  // OLD clusterId (in cluster_member_nudged etc.) to the new one in every
  // replayed line. Members are brand-new ids, so the no-cross-cluster fence
  // passes; createCluster only mints the clusterId + writes cluster meta and
  // does NOT require the member workflow dirs to exist yet.
  const newMemberIds = oldIds.map((oldId) => idMap.get(oldId)!);
  const cluster = await clusterStore.createCluster({ cwd: targetCwd, memberWorkflowIds: newMemberIds });
  idMap.set(manifest.clusterState.clusterId, cluster.clusterId);

  const restoredMembers: RestoredMember[] = [];
  for (const member of manifest.members) {
    const oldId = member.oldWorkflowId;
    const newId = idMap.get(oldId)!;
    const srcDir = memberDir(snapshotId, oldId);

    // Read the captured meta, rewrite workflowId + cwd, write to the new dir.
    let meta: WorkflowMeta;
    try {
      const raw = await fs.readFile(path.join(srcDir, 'meta.json'), 'utf8');
      meta = portableWorkflowMeta(JSON.parse(raw) as WorkflowMeta);
    } catch {
      throw new SnapshotValidationError('member_copy_missing', `snapshot member ${oldId.slice(0, 8)} meta copy is missing`);
    }
    meta.workflowId = newId;
    meta.cwd = targetCwd;

    // Rewrite + write events.jsonl with every embedded id remapped FIRST, so
    // the subsequent initWorkflowStore tail-scan recovers the right head seq.
    let eventsText = '';
    try {
      eventsText = await fs.readFile(path.join(srcDir, 'events.jsonl'), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    // Truncate to the operator-chosen last-N turns FIRST so both the on-disk copy
    // and the handler's downstream replay are small + clean, then compact the
    // streaming-granularity events — applied even on restore-ALL, since a
    // full-fidelity delta replay is exactly what flooded the client
    // (2026-06-12 SYNCING loop).
    eventsText = compactRestoredEvents(truncateToLastNTurns(eventsText, turnsPerMember));
    const rewritten = eventsText
      .split('\n')
      .map((line) => (line.trim() ? rewriteEventsLine(line, idMap) : line))
      .join('\n');
    const destEvents = path.join(targetCwd, '.archon', 'workflows', newId, 'events.jsonl');
    await fs.mkdir(path.dirname(destEvents), { recursive: true });
    // Atomic (tmp+rename) so a crash/disk-full mid-write can't leave a truncated
    // events.jsonl that the tail-scan below would then mis-seq.
    await atomicWriteFile(destEvents, rewritten);
    await writeMeta(targetCwd, meta);
    // init AFTER the events file is on disk: the tail-scan recovers the head
    // seq so the next live event on this restored member continues the
    // sequence instead of re-using seq 1 and duplicating on disk. forget first
    // in case a stale buffer exists for this (cwd, wfid) — minted ids make a
    // collision astronomically unlikely, but the forget keeps it deterministic.
    forgetWorkflowBuffer(targetCwd, newId);
    await initWorkflowStore(targetCwd, newId);

    restoredMembers.push({
      oldWorkflowId: oldId,
      newWorkflowId: newId,
      meta,
      ...(member.workflowConfig ? { config: structuredClone(member.workflowConfig) } : {}),
    });
  }

  // Make the restored workflows discoverable by crash-recovery on next boot.
  await rememberCwd(targetCwd).catch(() => { /* best-effort */ });

  // Reattach name + per-member roles/tiers/focus (remapped to new ids). The
  // cluster itself was registered up front (above) so its new clusterId could be
  // remapped into the replayed events.
  const src = manifest.clusterState;
  if (src.name && src.name.trim().length > 0) {
    await clusterStore.renameCluster(cluster.clusterId, src.name).catch(() => { /* best-effort */ });
  }
  for (const member of manifest.members) {
    const newId = idMap.get(member.oldWorkflowId)!;
    if (member.role) await clusterStore.setMemberRole(cluster.clusterId, newId, member.role).catch(() => { /* best-effort */ });
    if (member.tier && clusterStore.isMemberTier(member.tier)) {
      await clusterStore.setMemberTier(cluster.clusterId, newId, member.tier).catch(() => { /* best-effort */ });
    }
    if (member.focus) await clusterStore.setMemberFocus(cluster.clusterId, newId, member.focus).catch(() => { /* best-effort */ });
    if (member.accessMode) {
      await clusterStore.setMemberAccessMode(cluster.clusterId, newId, member.accessMode).catch(() => { /* best-effort */ });
    }
  }
  // Reattach dispatcher settings (no member-id remap needed except armedBy,
  // which we drop on restore — a fresh cluster is disarmed by default and the
  // operator re-arms; carrying a stale armedByWorkflowId would dangle).
  if (src.dispatcher) {
    await clusterStore.updateTaskDispatcherSettings(cluster.clusterId, {
      ...(typeof src.dispatcher.intervalMs === 'number' ? { intervalMs: src.dispatcher.intervalMs } : {}),
      ...(typeof src.dispatcher.maxTasksPerSweep === 'number' ? { maxTasksPerSweep: src.dispatcher.maxTasksPerSweep } : {}),
      ...(typeof src.dispatcher.maxConcurrentRuns === 'number' ? { maxConcurrentRuns: src.dispatcher.maxConcurrentRuns } : {}),
      ...(typeof src.dispatcher.autoWorktree === 'boolean' ? { autoWorktree: src.dispatcher.autoWorktree } : {}),
    }).catch(() => { /* best-effort */ });
  }
  // Passive cluster configuration is portable. Runtime arming is not:
  // idle-nudger, auto-turn, dispatcher enabled, REMOTE, and remote gates stay
  // OFF on every restore so importing a cluster cannot start work or expose it.
  await clusterStore.setEfficiency(
    cluster.clusterId,
    src.efficiencyLevel ?? 'thorough',
    src.efficiencyAddendum ?? '',
  ).catch(() => { /* best-effort */ });
  await clusterStore.setProgressTracking(
    cluster.clusterId,
    src.progressTracking ?? 'both',
  ).catch(() => { /* best-effort */ });
  await clusterStore.setTaskBoardMode(
    cluster.clusterId,
    clusterStore.normalizeTaskBoardMode(src),
  ).catch(() => { /* best-effort */ });
  // Deliberately do NOT reattach src.planId. Plans are keyed by (cwd, planId)
  // with the body at <cwd>/.archon/plans/<planId>.md, so reusing the id would
  // make this restored fork SHARE one mutable plan file with the original
  // cluster (same-cwd restore) — edits in one would bleed into the other — or,
  // on restore into a different cwd, point at a plan that doesn't exist there.
  // The restore handler mints a FRESH per-cwd plan from manifest.planBody
  // instead, so the fork owns an independent copy.

  const finalCluster = (await clusterStore.readCluster(cluster.clusterId)) ?? cluster;

  return {
    cluster: finalCluster,
    members: restoredMembers,
    targetCwd,
    sourceCwd: manifest.sourceCwd,
    ...(manifest.planBody ? { planBody: manifest.planBody } : {}),
  };
}

// ── Delete ──────────────────────────────────────────────────────────────────

// Returns true when a snapshot dir was found + removed; false when absent.
export async function deleteSnapshot(snapshotId: string): Promise<boolean> {
  if (!snapshotId || typeof snapshotId !== 'string') return false;
  // Guard against path traversal — snapshotId is a minted UUID; reject anything
  // that isn't UUID-ish before touching the filesystem.
  if (!/^[a-zA-Z0-9-]{1,64}$/.test(snapshotId)) return false;
  const dir = snapshotDir(snapshotId);
  try {
    await fs.access(manifestPath(snapshotId));
  } catch {
    return false;
  }
  await fs.rm(dir, { recursive: true, force: true });
  return true;
}
