import { publishActivity } from './voice/activityBus.js';
// docs/PROTOCOL_CLUSTER.md - substrate cluster store.
//
// One ClusterState per cluster, persisted to ~/.arco/clusters/<id>/meta.json.
// Member workflows learn their clusterId via getClusterIdForWorkflow(); the
// Native worker's tool registration gates on this lookup. Hard fences (plan
// §6.2): no nested clusters; no cross-cluster messaging — both enforced at
// createCluster()'s validation site.
//
// Atomic writes via proper-lockfile (already a dep). Files survive server
// restart; the in-memory map is rebuilt lazily as createCluster / readCluster
// touch the on-disk record.

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { dropCache as dropPlanCache } from './clusterPlanStore.js';
import {
  clusterDirectorProblem,
  isClusterDirector,
  isAutoCompactionPolicy,
  type AutoCompactionPolicy,
  MEMBER_TIERS,
  MEMBER_FOCUS_MAX,
  CLUSTER_EFFICIENCY_ADDENDUM_MAX,
  normalizeClusterRoleText,
  isClusterEfficiencyLevel,
  isClusterTaskBoardMode,
  isClusterProgressMode,
  CLUSTER_PROGRESS_DEFAULT,
  CLUSTER_EFFICIENCY_CREATE_DEFAULT,
  CLUSTER_MESSAGE_GUARD_CREATE_DEFAULT,
  isClusterMessageGuard,
  resolveClusterMessageGuard,
  type ClusterMessageGuard,
  type ClusterCreationSettings,
  type ClusterDispatcherSettingsPatch,
  type ClusterDispatcherState,
  type ClusterEfficiencyLevel,
  type ClusterMemberAccessMode,
  type ClusterProgressMode,
  type ClusterTaskBoardMode,
  type MemberTier,
  isMemberTier,
  isClusterMemberAccessMode,
} from '@arco/shared';
import { atomicWriteFile, withFileLock } from './atomicFile.js';
import { arcoHome } from './arcoHome.js';

const ARCO_HOME = arcoHome();
const CLUSTERS_DIR = join(ARCO_HOME, 'clusters');

export interface ClusterState {
  autoCompaction?: AutoCompactionPolicy;
  clusterId: string;
  cwd: string;
  members: string[]; // member workflowIds
  createdAt: string; // ISO
  schemaVersion: 1;
  // Slice 6a — operator-set display name. Persisted only when an operator
  // explicitly renamed (empty/absent → client derives `<basename(cwd)> ·
  // <short-id>`). Length ≤64.
  name?: string;
  // Phase 2.6 — operator-set role hint per member (≤120 chars). Sparse:
  // members without a hint are simply absent from the map. The Native
  // worker injects `Your role in this cluster: <role>` as a system block
  // only when the member's role is set + non-empty. Cleared by setting an
  // empty / whitespace string. Persisted inside meta.json so it survives
  // server restart.
  memberRoles?: Record<string, string>;
  // 2026-05-11 — operator-set builder-tier hint per member. Sparse map:
  // members without a tier are absent from the map. Three-value enum
  // (`light` / `standard` / `heavy`). Pure metadata — the director (an
  // LLM) sees the tier in peer_list rows and decides routing. NO server-
  // side routing. Persisted alongside `memberRoles` in meta.json.
  memberTiers?: Record<string, MemberTier>;
  // 2026-05-11 — operator-set focus (sub-specialty) per member. Sparse
  // map: members without a focus are absent. Free-form text, clamped to
  // MEMBER_FOCUS_MAX server-side. Pure metadata — exposed via peer_list so
  // the director can disambiguate same-role peers.
  memberFocuses?: Record<string, string>;
  // Per-member information boundary. Sparse: absent ≡ standard. Blind members
  // retain the project cwd but receive only peer_send/peer_read from the
  // cluster surface; isolated members additionally execute in a private
  // scratch cwd under this cluster's durable directory.
  memberAccessModes?: Record<string, Exclude<ClusterMemberAccessMode, 'standard'>>;
  // Phase 5 — operator-armed idle nudger. Default OFF (absent or false).
  // When true, the server detector emits cluster_member_nudged when a
  // member matches the idle+pending predicate. See clusterIdleNudger.ts.
  idleNudgerEnabled?: boolean;
  // Phase 5b — operator-armed auto-turn-on-mailbox. Default OFF (absent or
  // false). When true, the server's clusterAutoTurn detector fires a single
  // primary turn on a recipient when peer_message_sent lands AND the
  // recipient is idle AND the three guards (cooldown / rate cap / chain
  // depth) all pass. Mirrors the idleNudgerEnabled persistence shape so
  // pre-5b meta.json files load cleanly (field absent ≡ OFF).
  autoTurnOnMailboxEnabled?: boolean;
  // docs/TASK_LEDGER.md Stage G - operator-armed task
  // dispatcher daemon. Default OFF when absent. Settings persist when the
  // operator disables the daemon so re-arming keeps their interval/caps.
  dispatcher?: Partial<ClusterDispatcherState>;
  // 2026-06-18 — explicit task board mode. Legacy taskBoardAttached is kept
  // for meta.json compatibility; normalizeTaskBoardMode is the source of
  // truth for behavior.
  taskBoardMode?: ClusterTaskBoardMode;
  taskBoardAttached?: boolean;
  // Unified plan system — one active per-cwd plan attached to this cluster.
  // The body lives under <cwd>/.arco/plans/<planId>.md, matching regular
  // workflows. Older clusters may still have ~/.arco/clusters/<id>/plan.md;
  // the bridge layer migrates that file and sets this field lazily.
  planId?: string;
  // Omitted stored style retains Thorough. Missing guards retain the legacy
  // effective hard cap until an edit pins it independently of the style.
  efficiencyLevel?: ClusterEfficiencyLevel;
  efficiencyAddendum?: string;
  messageGuard?: ClusterMessageGuard;
  // 2026-06-29 — per-cluster progress-tracking mode (plan / board / both).
  // Absent ≡ 'both' (default; members nudged to keep BOTH surfaces current,
  // each half gated on whether the surface exists). Drives the doctrine block
  // via clusterProgress.ts. Persisted only when non-default so pre-feature
  // meta.json stays clean.
  progressTracking?: ClusterProgressMode;
  // R3 (docs/REMOTE_MANAGEMENT.md) - cluster-level remote opt-in.
  // Absent ≡ OFF. When true, the hub link reports this cluster AND all its
  // members (members' individual remoteEnabled flags are ignored while
  // clustered — the one switch covers them, both directions).
  remoteEnabled?: boolean;
  // 2026-07-18 (§9.2 follow-up) — cluster-level SECOND arming for remote DEBAG
  // gate approval. Absent ≡ OFF (gates render read-only on the phone). While
  // clustered, member-level remoteGatesEnabled flags are ignored — this one
  // switch decides for every member, mirroring remoteEnabled's semantics.
  remoteGatesEnabled?: boolean;
}

// Phase 2.6 — operator-set role cap. Free-form text; server clamps the
// length, no further validation. Matches the wire-shape comment in
// shared/src/protocol.ts.
export const MEMBER_ROLE_MAX = 120;

export function clusterDir(clusterId: string): string {
  return join(CLUSTERS_DIR, clusterId);
}

export function clusterMetaPath(clusterId: string): string {
  return join(clusterDir(clusterId), 'meta.json');
}

export function clusterMailboxRoot(clusterId: string): string {
  return join(clusterDir(clusterId), 'mailbox');
}

export function isolatedWorkspaceFor(clusterId: string, workflowId: string): string {
  return join(clusterDir(clusterId), 'isolates', workflowId, 'workspace');
}

const cache = new Map<string, ClusterState>();
// workflowId → clusterId. Populated on createCluster + on lazy readCluster
// hit. Members can only be in one cluster at a time (plan §2 — no
// cross-cluster messaging; no nested clusters).
const memberIndex = new Map<string, string>();

function rebuildIndexFor(state: ClusterState): void {
  cache.set(state.clusterId, state);
  for (const m of state.members) memberIndex.set(m, state.clusterId);
  publishActivity({ kind: 'cluster_changed', clusterId: state.clusterId, name: state.name });
}

async function ensureClustersDir(): Promise<void> {
  await fs.mkdir(CLUSTERS_DIR, { recursive: true });
}

export class ClusterValidationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export async function createCluster(opts: {
  cwd: string;
  memberWorkflowIds: string[];
} & ClusterCreationSettings): Promise<ClusterState> {
  const cwd = opts.cwd;
  const members = [...new Set(opts.memberWorkflowIds)];
  if (!cwd || typeof cwd !== 'string') {
    throw new ClusterValidationError('invalid_cwd', 'cwd is required');
  }
  if (members.length < 2) {
    throw new ClusterValidationError('too_few_members', 'a cluster requires at least 2 members');
  }
  // Hard fence (plan §6.2): no depth-2 clusters; no cross-cluster membership.
  for (const wfid of members) {
    const existing = memberIndex.get(wfid);
    if (existing) {
      throw new ClusterValidationError(
        'member_already_in_cluster',
        `workflow ${wfid} is already a member of cluster ${existing}; nested or cross-cluster membership is rejected`,
      );
    }
  }
  if ((opts.efficiencyAddendum !== undefined && typeof opts.efficiencyAddendum !== 'string') ||
      (opts.efficiencyLevel !== undefined && !isClusterEfficiencyLevel(opts.efficiencyLevel)) ||
      (opts.messageGuard !== undefined && !isClusterMessageGuard(opts.messageGuard)) ||
      (opts.taskBoardMode !== undefined && !isClusterTaskBoardMode(opts.taskBoardMode)) ||
      (opts.progressTracking !== undefined && !isClusterProgressMode(opts.progressTracking))) {
    throw new ClusterValidationError('invalid_settings', 'Invalid cluster creation settings');
  }
  await ensureClustersDir();
  const clusterId = randomUUID();
  const state: ClusterState = {
    clusterId,
    cwd,
    members,
    createdAt: new Date().toISOString(),
    schemaVersion: 1,
    efficiencyLevel: opts.efficiencyLevel ?? CLUSTER_EFFICIENCY_CREATE_DEFAULT,
    efficiencyAddendum: opts.efficiencyAddendum?.trim().slice(0, CLUSTER_EFFICIENCY_ADDENDUM_MAX) || undefined,
    messageGuard: { ...(opts.messageGuard ?? CLUSTER_MESSAGE_GUARD_CREATE_DEFAULT) },
    progressTracking: opts.progressTracking ?? 'both',
    taskBoardMode: opts.taskBoardMode ?? 'cluster',
    taskBoardAttached: opts.taskBoardMode !== 'none',
  };
  await fs.mkdir(clusterDir(clusterId), { recursive: true });
  await fs.mkdir(clusterMailboxRoot(clusterId), { recursive: true });
  await writeMetaAtomic(state);
  rebuildIndexFor(state);
  return state;
}

// In-process read-modify-write serialization for cluster meta.json. Every
// setter reads the cached state, spreads a change, and writes the whole object
// back — without this, two concurrent setters both start from the same state
// and the later write drops the earlier change (removeMember racing a role
// change resurrected the removed member). proper-lockfile inside
// writeMetaAtomic only serializes the WRITE, not the read→write window.
// Lock order: meta lock → mailbox lock (replaceMember / removeMember). Never
// call a locked setter from inside another — use the *Unlocked twin.
function withClusterMetaLock<T>(clusterId: string, fn: () => Promise<T>): Promise<T> {
  return withFileLock(clusterMetaPath(clusterId), fn);
}

async function writeMetaAtomic(state: ClusterState): Promise<void> {
  const path = clusterMetaPath(state.clusterId);
  // proper-lockfile needs the file to exist before lock(); seed an empty
  // file first if absent.
  try { await fs.access(path); }
  catch { await fs.writeFile(path, ''); }
  const release = await lockfile.lock(path, { retries: { retries: 5, minTimeout: 25, maxTimeout: 250 } });
  try {
    // proper-lockfile serializes writers ACROSS processes; the atomic write
    // stops a crash mid-write from truncating cluster meta to nothing. The
    // two are complementary — neither substitutes for the other. Safe to
    // combine: proper-lockfile's sentinel is a sibling `<path>.lock` dir, so
    // replacing the target's inode does not disturb the held lock.
    await atomicWriteFile(path, JSON.stringify(state, null, 2));
  } finally {
    await release();
  }
}

export async function readCluster(clusterId: string): Promise<ClusterState | null> {
  if (cache.has(clusterId)) return cache.get(clusterId)!;
  try {
    const raw = await fs.readFile(clusterMetaPath(clusterId), 'utf8');
    // An EMPTY file is the seed artifact, not corruption: writeMetaAtomic has
    // to touch the path before proper-lockfile can lock it, so a crash in that
    // window leaves a zero-byte meta. Treat it as absent, exactly like ENOENT.
    // Malformed-but-non-empty JSON still throws — that is real corruption and
    // should surface loudly rather than silently discarding a cluster.
    if (raw.trim().length === 0) return null;
    const parsed = JSON.parse(raw) as ClusterState;
    rebuildIndexFor(parsed);
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

// Boot-time full scan of ~/.arco/clusters. `readCluster` (and thus
// `listKnownClusterIds`, the idle-nudger, and auto-turn) fills lazily — the
// cache is empty right after a restart, so nothing sees the on-disk clusters
// until some client subscribes. This eagerly reads every cluster's meta.json
// via `readCluster`, which both parses it AND warms `cache` + `memberIndex`
// (so `getClusterIdForWorkflow` resolves — the gate for peer-tool wiring on a
// member's first post-restart turn). Failure-isolated per cluster: a corrupt
// meta.json is logged + skipped, never aborts the scan. Honors dynamic
// membership by construction — it reads the live persisted `members[]`.
export async function loadAllClustersFromDisk(): Promise<ClusterState[]> {
  await ensureClustersDir();
  let ids: string[];
  try {
    ids = await fs.readdir(CLUSTERS_DIR);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: ClusterState[] = [];
  for (const id of ids) {
    try {
      const state = await readCluster(id); // parses meta.json + warms cache/memberIndex
      if (state) out.push(state);
    } catch (err) {
      console.warn(`[arco] cluster load skipped for ${id}:`, err instanceof Error ? err.message : err);
    }
  }
  return out;
}

export async function deleteCluster(clusterId: string): Promise<void> {
  await withClusterMetaLock(clusterId, () => deleteClusterUnlocked(clusterId));
}

async function deleteClusterUnlocked(clusterId: string): Promise<void> {
  const state = await readCluster(clusterId);
  if (!state) return;
  cache.delete(clusterId);
  dropPlanCache(clusterId);
  for (const m of state.members) {
    if (memberIndex.get(m) === clusterId) memberIndex.delete(m);
  }
  // Remove the cluster directory entirely (mailbox files + meta.json + the
  // Phase 2.6 plan.md). The members keep working as plain workflows; their
  // next turn sees no clusterId and the peer tools / plan-block / role-block
  // disappear (worker.ts gates on the WorkerConfig fields). Plan §6.2
  // reversibility.
  await fs.rm(clusterDir(clusterId), { recursive: true, force: true });
  publishActivity({ kind: 'cluster_changed', clusterId });
}

export function getClusterIdForWorkflow(workflowId: string): string | undefined {
  return memberIndex.get(workflowId);
}

// Slice 6a — operator renamed a cluster. Empty/whitespace-only `name` clears
// the override (the client falls back to the `<basename(cwd)> · <short-id>`
// derived default). Length cap matches the wire-shape comment in protocol.ts.
export async function renameCluster(clusterId: string, name: string): Promise<ClusterState | null> {
  return withClusterMetaLock(clusterId, async () => {
    const state = await readCluster(clusterId);
    if (!state) return null;
    const trimmed = name.trim();
    const next: ClusterState = trimmed.length === 0
      ? { ...state, name: undefined }
      : { ...state, name: trimmed.slice(0, 64) };
    await writeMetaAtomic(next);
    rebuildIndexFor(next);
    return next;
  });
}

// Slice 6a — operator detached a member from the cluster. Empties the
// member's mailbox dir (no peer messages should land in a workflow that's
// no longer a cluster member). Caller is responsible for tearing down the
// workflow itself (the operator's × click is also a workflow close in the
// 6a UX). If detaching would drop the cluster below 2 members, the cluster
// is deleted instead — clusters require ≥2 members per createCluster's
// invariant.
export async function removeMember(
  clusterId: string,
  workflowId: string,
): Promise<{ clusterDeleted: boolean; remaining: string[] }> {
  return withClusterMetaLock(clusterId, async () => {
    const state = await readCluster(clusterId);
    if (!state) return { clusterDeleted: false, remaining: [] };
    if (!state.members.includes(workflowId)) {
      return { clusterDeleted: false, remaining: state.members };
    }
    const remaining = state.members.filter((m) => m !== workflowId);
    if (memberIndex.get(workflowId) === clusterId) memberIndex.delete(workflowId);
    // Wipe the leaving member's mailbox dir; pending peer messages lose their
    // recipient context and don't make sense to keep.
    // Under the mailbox lock (meta → mailbox, same order as replaceMember) so an
    // in-flight enqueue can't recreate the departed recipient's dir after rm.
    await withFileLock(clusterMailboxRoot(clusterId), () =>
      fs.rm(join(clusterMailboxRoot(clusterId), workflowId), { recursive: true, force: true }));
    if (remaining.length < 2) {
      // Sub-2 cluster is invalid — collapse it. The other member(s) get the
      // same downgrade-to-plain-workflow shape as deleteCluster.
      // Unlocked twin: we already hold this cluster's meta lock.
      await deleteClusterUnlocked(clusterId);
      return { clusterDeleted: true, remaining };
    }
    const next: ClusterState = { ...state, members: remaining };
    await writeMetaAtomic(next);
    rebuildIndexFor(next);
    return { clusterDeleted: false, remaining };
  });
}

// Phase 2.5 B2 / 2.5b — operator added a workflow to an existing cluster
// (right-click "Add to existing cluster…" or SPAWN-into-cluster). Server
// caller is responsible for validating cwd match + Native-only fence;
// clusterStore only enforces structural invariants (workflow not already in
// any cluster; cluster exists). Emits no events — caller broadcasts
// cluster_member_added + cluster_state after the write.
export async function addMember(
  clusterId: string,
  workflowId: string,
): Promise<ClusterState | null> {
  return withClusterMetaLock(clusterId, async () => {
    const state = await readCluster(clusterId);
    if (!state) return null;
    if (state.members.includes(workflowId)) return state;
    const existing = memberIndex.get(workflowId);
    if (existing && existing !== clusterId) {
      throw new ClusterValidationError(
        'member_already_in_cluster',
        `workflow ${workflowId} is already a member of cluster ${existing}; cross-cluster membership is rejected`,
      );
    }
    const next: ClusterState = { ...state, members: [...state.members, workflowId] };
    await writeMetaAtomic(next);
    rebuildIndexFor(next);
    return next;
  });
}

export function getMemberAccessMode(clusterId: string, workflowId: string): ClusterMemberAccessMode {
  return cache.get(clusterId)?.memberAccessModes?.[workflowId] ?? 'standard';
}

export async function setMemberAccessMode(
  clusterId: string,
  workflowId: string,
  mode: ClusterMemberAccessMode,
): Promise<ClusterState | null> {
  return withClusterMetaLock(clusterId, async () => {
    const state = await readCluster(clusterId);
    if (!state || !state.members.includes(workflowId) || !isClusterMemberAccessMode(mode)) return null;
    const nextModes = { ...(state.memberAccessModes ?? {}) };
    if (mode === 'standard') delete nextModes[workflowId];
    else nextModes[workflowId] = mode;
    const next: ClusterState = Object.keys(nextModes).length === 0
      ? { ...state, memberAccessModes: undefined }
      : { ...state, memberAccessModes: nextModes };
    if (mode === 'isolated') {
      await fs.mkdir(isolatedWorkspaceFor(clusterId, workflowId), { recursive: true, mode: 0o700 });
    }
    await writeMetaAtomic(next);
    rebuildIndexFor(next);
    return next;
  });
}

function remapSparse<T>(
  source: Record<string, T> | undefined,
  oldWorkflowId: string,
  newWorkflowId: string,
): Record<string, T> | undefined {
  if (!source) return undefined;
  const next = { ...source };
  if (oldWorkflowId in next) {
    next[newWorkflowId] = next[oldWorkflowId];
    delete next[oldWorkflowId];
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

async function reassignPendingMailbox(
  clusterId: string,
  oldWorkflowId: string,
  newWorkflowId: string,
): Promise<void> {
  const root = clusterMailboxRoot(clusterId);
  const oldDir = join(root, oldWorkflowId);
  const newDir = join(root, newWorkflowId);
  let names: string[];
  try {
    names = (await fs.readdir(oldDir)).filter((name) => name.endsWith('.json')).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  await fs.mkdir(newDir, { recursive: true });
  for (const name of names) {
    const oldPath = join(oldDir, name);
    const newPath = join(newDir, name);
    const raw = await fs.readFile(oldPath, 'utf8');
    let body = raw;
    try {
      const message = JSON.parse(raw) as Record<string, unknown>;
      message.toWorkflowId = newWorkflowId;
      body = JSON.stringify(message, null, 2);
    } catch {
      // Preserve even a malformed pending file. The normal mailbox reader will
      // ignore it, but replacement must never turn cleanup into silent loss.
    }
    await atomicWriteFile(newPath, body);
    await fs.unlink(oldPath);
  }
  await fs.rm(oldDir, { recursive: true, force: true });
}

// Atomic cluster-slot replacement. The caller creates the fresh workflow and
// validates its config first; the meta write preserves member order and remaps
// every member-scoped setting without ever collapsing a 2-member cluster.
// Pending inbound mail follows the slot to the replacement workflow.
export async function replaceMember(
  clusterId: string,
  oldWorkflowId: string,
  newWorkflowId: string,
  accessMode?: ClusterMemberAccessMode,
): Promise<ClusterState | null> {
  return withClusterMetaLock(clusterId, async () => {
    const state = await readCluster(clusterId);
    if (!state || !state.members.includes(oldWorkflowId)) return null;
    if (state.members.includes(newWorkflowId)) {
      throw new ClusterValidationError('replacement_already_member', `workflow ${newWorkflowId} is already in this cluster`);
    }
    const existing = memberIndex.get(newWorkflowId);
    if (existing) {
      throw new ClusterValidationError('member_already_in_cluster', `workflow ${newWorkflowId} is already in cluster ${existing}`);
    }
    const inheritedMode = state.memberAccessModes?.[oldWorkflowId] ?? 'standard';
    const nextMode = accessMode ?? inheritedMode;
    if (!isClusterMemberAccessMode(nextMode)) {
      throw new ClusterValidationError('invalid_access_mode', `unknown member access mode ${String(nextMode)}`);
    }
    const nextMembers = state.members.map((id) => id === oldWorkflowId ? newWorkflowId : id);
    const nextModes = remapSparse(state.memberAccessModes, oldWorkflowId, newWorkflowId) ?? {};
    if (nextMode === 'standard') delete nextModes[newWorkflowId];
    else nextModes[newWorkflowId] = nextMode;
    const next: ClusterState = {
      ...state,
      members: nextMembers,
      memberRoles: remapSparse(state.memberRoles, oldWorkflowId, newWorkflowId),
      memberTiers: remapSparse(state.memberTiers, oldWorkflowId, newWorkflowId),
      memberFocuses: remapSparse(state.memberFocuses, oldWorkflowId, newWorkflowId),
      memberAccessModes: Object.keys(nextModes).length > 0 ? nextModes : undefined,
    };
    if (nextMode === 'isolated') {
      await fs.mkdir(isolatedWorkspaceFor(clusterId, newWorkflowId), { recursive: true, mode: 0o700 });
    }
    // Serialize against enqueue/drain/discard so a send already in flight either
    // lands before the move and follows the slot, or revalidates after the move
    // and cannot recreate the departed recipient directory.
    await withFileLock(clusterMailboxRoot(clusterId), async () => {
      await writeMetaAtomic(next);
      if (memberIndex.get(oldWorkflowId) === clusterId) memberIndex.delete(oldWorkflowId);
      rebuildIndexFor(next);
      await reassignPendingMailbox(clusterId, oldWorkflowId, newWorkflowId);
    });
    return next;
  });
}

export function getMembers(clusterId: string): string[] | undefined {
  return cache.get(clusterId)?.members;
}

export function getPlanId(clusterId: string): string | undefined {
  return cache.get(clusterId)?.planId;
}

export async function setPlanId(clusterId: string, planId: string): Promise<ClusterState | null> {
  return withClusterMetaLock(clusterId, async () => {
    const state = await readCluster(clusterId);
    if (!state) return null;
    const next: ClusterState = { ...state, planId };
    await writeMetaAtomic(next);
    rebuildIndexFor(next);
    return next;
  });
}

export async function clearPlanId(clusterId: string): Promise<ClusterState | null> {
  return withClusterMetaLock(clusterId, async () => {
    const state = await readCluster(clusterId);
    if (!state) return null;
    const next: ClusterState = { ...state, planId: undefined };
    await writeMetaAtomic(next);
    rebuildIndexFor(next);
    return next;
  });
}

// Resolve a peer reference (full workflowId OR 8-char prefix per plan §0)
// to a member of the given cluster. Returns undefined if the prefix is
// ambiguous (matches >1 member) or the resolved id is not a cluster member.
export function resolvePeer(clusterId: string, peerRef: string): string | undefined {
  const members = getMembers(clusterId);
  if (!members) return undefined;
  if (members.includes(peerRef)) return peerRef;
  const matches = members.filter((m) => m.startsWith(peerRef));
  return matches.length === 1 ? matches[0] : undefined;
}

// MASTER_REFACTOR §3.3 F5 (2026-05-11) — operator-editable display name.
// `rename_workflow` writes `wf.config.name` server-side; this resolver lets
// modules without direct access to the workflow registry (clusterStore /
// clusterPeerOps) surface the operator-set name. Index.ts installs the
// resolver at startup with a callback that consults `workflows.get(wfid)`.
// Falls back to the wfid 8-char prefix when the resolver is missing, the
// workflow is unknown, or the name is empty.
let workflowNameResolver: ((workflowId: string) => string | undefined) | null = null;
export function setWorkflowNameResolver(fn: (workflowId: string) => string | undefined): void {
  workflowNameResolver = fn;
}
export function displayNameFor(workflowId: string): string {
  const name = workflowNameResolver?.(workflowId)?.trim();
  return name && name.length > 0 ? name : workflowId.slice(0, 8);
}

// Phase 2.6 — read a member's role hint synchronously (in-memory cache
// lookup). Returns undefined when the cluster isn't known, the workflow
// isn't a member, or no role is set. Called per-turn by handleUserMessage
// to thread the role into WorkerConfig.clusterRole. Trim is applied at
// write time so callers don't have to.
export function getMemberRole(clusterId: string, workflowId: string): string | undefined {
  const state = cache.get(clusterId);
  if (!state) return undefined;
  if (!state.members.includes(workflowId)) return undefined;
  const role = state.memberRoles?.[workflowId];
  if (!role || role.length === 0) return undefined;
  const normalized = normalizeClusterRoleText(role);
  return normalized.length > 0 ? normalized : undefined;
}

// Phase 2.6 — operator edited a member's role from the cluster Members
// sub-tab. Empty / whitespace clears the field (the next turn sees no
// role block). Length clamps to MEMBER_ROLE_MAX. Returns the updated
// state, or null when the cluster is unknown / the workflow isn't a
// member.
export async function setMemberRole(
  clusterId: string,
  workflowId: string,
  role: string,
  options: { restoringSnapshot?: boolean } = {},
): Promise<ClusterState | null> {
  return withClusterMetaLock(clusterId, async () => {
    const state = await readCluster(clusterId);
    if (!state) return null;
    if (!state.members.includes(workflowId)) return null;
    const trimmed = normalizeClusterRoleText(role).slice(0, MEMBER_ROLE_MAX);
    if (!options.restoringSnapshot && isClusterDirector(trimmed) && !isClusterDirector(state.memberRoles?.[workflowId])) {
      const problem = clusterDirectorProblem([...state.members.filter((id) => id !== workflowId).map((id) => state.memberRoles?.[id]), trimmed]);
      if (problem) throw new ClusterValidationError('multiple_directors', problem);
    }
    const nextRoles: Record<string, string> = { ...(state.memberRoles ?? {}) };
    if (trimmed.length === 0) {
      delete nextRoles[workflowId];
    } else {
      nextRoles[workflowId] = trimmed;
    }
    const next: ClusterState = Object.keys(nextRoles).length === 0
      ? { ...state, memberRoles: undefined }
      : { ...state, memberRoles: nextRoles };
    await writeMetaAtomic(next);
    rebuildIndexFor(next);
    return next;
  });
}

// 2026-05-11 — synchronous tier lookup for peer_list emission. Returns
// undefined when the cluster isn't cached, the workflow isn't a member,
// or no tier is set. Pure metadata; consumers must NOT use this to make
// routing decisions server-side (see CLAUDE.md four-question test —
// hard fence on orchestrator LLM routing).
export function tierFor(workflowId: string): MemberTier | undefined {
  const clusterId = memberIndex.get(workflowId);
  if (!clusterId) return undefined;
  const state = cache.get(clusterId);
  if (!state) return undefined;
  return state.memberTiers?.[workflowId];
}

// 2026-05-11 — operator edited a member's tier from the Members sub-tab.
// `null` clears. Unknown strings reject (returns null). Mirrors
// setMemberRole's persistence path. Returns the updated state, or null
// when the cluster is unknown / workflow not a member / invalid tier.
export async function setMemberTier(
  clusterId: string,
  workflowId: string,
  tier: MemberTier | null,
): Promise<ClusterState | null> {
  return withClusterMetaLock(clusterId, async () => {
    if (tier !== null && !isMemberTier(tier)) return null;
    const state = await readCluster(clusterId);
    if (!state) return null;
    if (!state.members.includes(workflowId)) return null;
    const nextTiers: Record<string, MemberTier> = { ...(state.memberTiers ?? {}) };
    if (tier === null) {
      delete nextTiers[workflowId];
    } else {
      nextTiers[workflowId] = tier;
    }
    const next: ClusterState = Object.keys(nextTiers).length === 0
      ? { ...state, memberTiers: undefined }
      : { ...state, memberTiers: nextTiers };
    await writeMetaAtomic(next);
    rebuildIndexFor(next);
    return next;
  });
}

// Re-export the canonical tier list + guard so callers (index.ts, peer
// ops) don't have to import twice.
export { MEMBER_TIERS, isMemberTier };
export type { MemberTier };
// 2026-06-15 — re-export so modules that already import * as clusterStore
// (broadcast.ts, clusterHandlers.ts) reach the efficiency type without a
// second @arco/shared import.
export type { ClusterEfficiencyLevel };
export type { ClusterProgressMode };

export function focusFor(workflowId: string): string | undefined {
  const clusterId = memberIndex.get(workflowId);
  if (!clusterId) return undefined;
  const state = cache.get(clusterId);
  if (!state) return undefined;
  return state.memberFocuses?.[workflowId];
}

// 2026-05-11 — operator edited a member's focus from the Members sub-tab,
// the WorkflowCreator member-row editor, or a preset apply. `null` (or an
// empty string after trim) clears. Server clamps to MEMBER_FOCUS_MAX.
export async function setMemberFocus(
  clusterId: string,
  workflowId: string,
  focus: string | null,
): Promise<ClusterState | null> {
  return withClusterMetaLock(clusterId, async () => {
    const state = await readCluster(clusterId);
    if (!state) return null;
    if (!state.members.includes(workflowId)) return null;
    const nextFocuses: Record<string, string> = { ...(state.memberFocuses ?? {}) };
    const trimmed = focus === null ? '' : focus.trim().slice(0, MEMBER_FOCUS_MAX);
    if (trimmed.length === 0) {
      delete nextFocuses[workflowId];
    } else {
      nextFocuses[workflowId] = trimmed;
    }
    const next: ClusterState = Object.keys(nextFocuses).length === 0
      ? { ...state, memberFocuses: undefined }
      : { ...state, memberFocuses: nextFocuses };
    await writeMetaAtomic(next);
    rebuildIndexFor(next);
    return next;
  });
}

// Phase 5 — operator toggled the idle-nudger from the cluster header chip.
// Returns the updated state, or null when the cluster is unknown.
export async function setIdleNudgerEnabled(
  clusterId: string,
  enabled: boolean,
): Promise<ClusterState | null> {
  return withClusterMetaLock(clusterId, async () => {
    const state = await readCluster(clusterId);
    if (!state) return null;
    const next: ClusterState = enabled
      ? { ...state, idleNudgerEnabled: true }
      : { ...state, idleNudgerEnabled: undefined };
    await writeMetaAtomic(next);
    rebuildIndexFor(next);
    return next;
  });
}

// Phase 5 — synchronous in-memory read for the idle-nudger detector's
// per-tick gate. Returns false when the cluster is unknown or not cached.
export function isIdleNudgerEnabled(clusterId: string): boolean {
  return cache.get(clusterId)?.idleNudgerEnabled === true;
}

// R3 (docs/REMOTE_MANAGEMENT.md) - cluster-level remote opt-in. ONE
// switch covers the whole cluster: while clustered, member workflows'
// individual `remoteEnabled` flags are ignored (a member flag flipped before
// joining must not leak the cluster). Default OFF like every remote surface.
export async function setRemoteEnabled(
  clusterId: string,
  enabled: boolean,
): Promise<ClusterState | null> {
  return withClusterMetaLock(clusterId, async () => {
    const state = await readCluster(clusterId);
    if (!state) return null;
    const next: ClusterState = enabled
      ? { ...state, remoteEnabled: true }
      : { ...state, remoteEnabled: undefined };
    await writeMetaAtomic(next);
    rebuildIndexFor(next);
    return next;
  });
}

// Sync gate for the hub link's snapshot filter + action re-validation.
export function isClusterRemoteEnabled(clusterId: string): boolean {
  return cache.get(clusterId)?.remoteEnabled === true;
}

// 2026-07-18 — cluster-level gates arming (one switch for all members).
export async function setRemoteGatesEnabled(
  clusterId: string,
  enabled: boolean,
): Promise<ClusterState | null> {
  return withClusterMetaLock(clusterId, async () => {
    const state = await readCluster(clusterId);
    if (!state) return null;
    const next: ClusterState = enabled
      ? { ...state, remoteGatesEnabled: true }
      : { ...state, remoteGatesEnabled: undefined };
    await writeMetaAtomic(next);
    rebuildIndexFor(next);
    return next;
  });
}

export function isClusterGatesRemoteEnabled(clusterId: string): boolean {
  return cache.get(clusterId)?.remoteGatesEnabled === true;
}

// R3 — sync full-state read from the warm cache (boot runs
// loadAllClustersFromDisk, so post-boot misses mean "no such cluster"). The
// hub link uses this for member badges + summary assembly without an await.
export function getClusterCached(clusterId: string): ClusterState | null {
  return cache.get(clusterId) ?? null;
}

// 2026-07-17 — operator drag-reordered the member grid (ClusterTab). The
// proposed order must be an exact permutation of the CURRENT members — a
// stale drag from an old snapshot can neither drop nor duplicate a member.
// Display-only state: nothing routes on members[] order, every renderer just
// maps it, so persisting the permutation reorders the desktop grid, the
// right-panel lists, and the phone console's member cards alike.
export async function setMemberOrder(
  clusterId: string,
  orderedIds: string[],
): Promise<ClusterState | null> {
  return withClusterMetaLock(clusterId, async () => {
    const state = await readCluster(clusterId);
    if (!state) return null;
    if (orderedIds.length !== state.members.length) return null;
    const current = new Set(state.members);
    if (new Set(orderedIds).size !== orderedIds.length) return null;
    if (orderedIds.some((id) => !current.has(id))) return null;
    const next: ClusterState = { ...state, members: [...orderedIds] };
    await writeMetaAtomic(next);
    rebuildIndexFor(next);
    return next;
  });
}

// 2026-06-15 — synchronous in-memory reads for the efficiency level + addendum.
// Called per-turn by handleUserMessage (doctrine + mailbox-notice variant) and
// by clusterPeerOps (peer-send budget). Returns the default level when the
// cluster is unknown / not cached / unset, so every caller can treat the
// result as authoritative without a fallback branch.
export function getEfficiencyLevel(clusterId: string): ClusterEfficiencyLevel {
  const level = cache.get(clusterId)?.efficiencyLevel;
  return level && isClusterEfficiencyLevel(level) ? level : 'thorough';
}

export function getMessageGuard(clusterId: string): ClusterMessageGuard {
  return resolveClusterMessageGuard(cache.get(clusterId) ?? {});
}

export function getEfficiencyAddendum(clusterId: string): string | undefined {
  const note = cache.get(clusterId)?.efficiencyAddendum;
  return note && note.length > 0 ? note : undefined;
}

export function getAutoCompaction(clusterId: string): AutoCompactionPolicy | undefined {
  const policy = cache.get(clusterId)?.autoCompaction;
  return policy === undefined ? undefined : isAutoCompactionPolicy(policy) ? policy : { enabled: false, thresholdPercent: 80 };
}

export async function setAutoCompaction(clusterId: string, policy: AutoCompactionPolicy | null): Promise<ClusterState | null> {
  return (await setAutoCompactionWithChange(clusterId, policy))?.state ?? null;
}

export async function setAutoCompactionWithChange(clusterId: string, policy: AutoCompactionPolicy | null): Promise<{ state: ClusterState; changed: boolean } | null> {
  if (policy !== null && !isAutoCompactionPolicy(policy)) return null;
  return withClusterMetaLock(clusterId, async () => {
    const state = await readCluster(clusterId);
    if (!state) return null;
    const current = state.autoCompaction;
    if (current?.enabled === policy?.enabled && current?.thresholdPercent === policy?.thresholdPercent) return { state, changed: false };
    const next = { ...state, autoCompaction: policy === null ? undefined : { ...policy } };
    await writeMetaAtomic(next);
    rebuildIndexFor(next);
    return { state: next, changed: true };
  });
}

// 2026-06-15 — operator set the cluster's efficiency level (and optional
// doctrine addendum) from the ClusterRightPanel chip or the WorkflowCreator.
// Rejects unknown levels (returns null). `addendum === undefined` keeps the
// current addendum; an empty / whitespace string clears it. 'thorough' with
// no addendum drops both fields so meta.json stays clean (absent ≡ thorough).
export async function setEfficiency(
  clusterId: string,
  level: ClusterEfficiencyLevel,
  addendum?: string,
  messageGuard?: ClusterMessageGuard,
): Promise<ClusterState | null> {
  return withClusterMetaLock(clusterId, async () => {
    if (!isClusterEfficiencyLevel(level) || (messageGuard !== undefined && !isClusterMessageGuard(messageGuard))) return null;
    const state = await readCluster(clusterId);
    if (!state) return null;
    const nextAddendum =
      addendum === undefined
        ? state.efficiencyAddendum
        : addendum.trim().slice(0, CLUSTER_EFFICIENCY_ADDENDUM_MAX) || undefined;
    const next: ClusterState = {
      ...state,
      // Pin a legacy cap before changing its style or NOTE.
      messageGuard: messageGuard ? { ...messageGuard } : resolveClusterMessageGuard(state),
      efficiencyLevel: level === 'thorough' ? undefined : level,
      efficiencyAddendum: nextAddendum,
    };
    await writeMetaAtomic(next);
    rebuildIndexFor(next);
    return next;
  });
}

// 2026-06-29 — synchronous in-memory read for the progress-tracking mode.
// Called per-turn by handleUserMessage to build the doctrine. Returns the
// default ('both') when the cluster is unknown / not cached / unset, so every
// caller treats the result as authoritative without a fallback branch.
export function getProgressTracking(clusterId: string): ClusterProgressMode {
  const mode = cache.get(clusterId)?.progressTracking;
  return mode && isClusterProgressMode(mode) ? mode : CLUSTER_PROGRESS_DEFAULT;
}

// 2026-06-29 — operator set the cluster's progress-tracking mode from the
// ClusterRightPanel chip. Rejects unknown modes (returns null). Drops the field
// when it equals the default so meta.json stays clean (absent ≡ 'both').
export async function setProgressTracking(
  clusterId: string,
  mode: ClusterProgressMode,
): Promise<ClusterState | null> {
  return withClusterMetaLock(clusterId, async () => {
    if (!isClusterProgressMode(mode)) return null;
    const state = await readCluster(clusterId);
    if (!state) return null;
    const next: ClusterState = {
      ...state,
      progressTracking: mode === CLUSTER_PROGRESS_DEFAULT ? undefined : mode,
    };
    await writeMetaAtomic(next);
    rebuildIndexFor(next);
    return next;
  });
}

// Phase 5b — operator toggled the auto-turn-on-mailbox arming from the
// cluster header chip. Mirror of setIdleNudgerEnabled — same on-disk shape,
// same "absent ≡ OFF" persistence convention so pre-5b meta.json reads land
// disarmed by default. Returns the updated state, or null when the cluster
// is unknown.
export async function setAutoTurnOnMailbox(
  clusterId: string,
  enabled: boolean,
): Promise<ClusterState | null> {
  return withClusterMetaLock(clusterId, async () => {
    const state = await readCluster(clusterId);
    if (!state) return null;
    const next: ClusterState = enabled
      ? { ...state, autoTurnOnMailboxEnabled: true }
      : { ...state, autoTurnOnMailboxEnabled: undefined };
    await writeMetaAtomic(next);
    rebuildIndexFor(next);
    return next;
  });
}

// Phase 5b — synchronous in-memory read for the auto-turn detector's per-
// event gate (fires on every peer_message_sent broadcast, so the hot path
// must avoid an await). Mirrors isIdleNudgerEnabled.
export function isAutoTurnOnMailboxEnabled(clusterId: string): boolean {
  return cache.get(clusterId)?.autoTurnOnMailboxEnabled === true;
}

export const TASK_DISPATCHER_DEFAULT_INTERVAL_MS = (() => {
  const raw = process.env.ARCO_TASK_DISPATCHER_DEFAULT_INTERVAL_MS;
  if (!raw) return 10000;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 1000 ? parsed : 10000;
})();
export const TASK_DISPATCHER_MIN_INTERVAL_MS = (() => {
  const raw = process.env.ARCO_TASK_DISPATCHER_MIN_INTERVAL_MS;
  if (!raw) return 1000;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 100 ? parsed : 1000;
})();
export const TASK_DISPATCHER_MAX_INTERVAL_MS = 10 * 60 * 1000;
export const TASK_DISPATCHER_DEFAULT_MAX_TASKS_PER_SWEEP = 4;
export const TASK_DISPATCHER_DEFAULT_MAX_CONCURRENT_RUNS = 8;

function clampPositiveInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : (typeof value === 'string' ? parseInt(value, 10) : NaN);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

export function normalizeTaskDispatcherSettings(input?: Partial<ClusterDispatcherState>): ClusterDispatcherState {
  return {
    enabled: input?.enabled === true,
    intervalMs: clampPositiveInt(
      input?.intervalMs,
      TASK_DISPATCHER_DEFAULT_INTERVAL_MS,
      TASK_DISPATCHER_MIN_INTERVAL_MS,
      TASK_DISPATCHER_MAX_INTERVAL_MS,
    ),
    maxTasksPerSweep: clampPositiveInt(input?.maxTasksPerSweep, TASK_DISPATCHER_DEFAULT_MAX_TASKS_PER_SWEEP, 1, 100),
    maxConcurrentRuns: clampPositiveInt(input?.maxConcurrentRuns, TASK_DISPATCHER_DEFAULT_MAX_CONCURRENT_RUNS, 1, 500),
    autoWorktree: input?.autoWorktree === true,
    ...(typeof input?.armedByWorkflowId === 'string' && input.armedByWorkflowId.length > 0 ? { armedByWorkflowId: input.armedByWorkflowId } : {}),
    ...(typeof input?.updatedAt === 'number' && Number.isFinite(input.updatedAt) ? { updatedAt: input.updatedAt } : {}),
  };
}

export function taskDispatcherSettingsFor(clusterId: string): ClusterDispatcherState {
  return normalizeTaskDispatcherSettings(cache.get(clusterId)?.dispatcher);
}

export function isTaskDispatcherEnabled(clusterId: string): boolean {
  return taskDispatcherSettingsFor(clusterId).enabled;
}

export function isTaskBoardAttached(clusterId: string): boolean {
  const state = cache.get(clusterId);
  if (!state) return false;
  return normalizeTaskBoardMode(state) !== 'none';
}

export function normalizeTaskBoardMode(state: Pick<ClusterState, 'taskBoardMode' | 'taskBoardAttached'>): ClusterTaskBoardMode {
  if (isClusterTaskBoardMode(state.taskBoardMode)) return state.taskBoardMode;
  return state.taskBoardAttached === false ? 'none' : 'project';
}

export function taskBoardKeyForCluster(clusterId: string, mode?: ClusterTaskBoardMode): string | undefined {
  return mode === 'cluster' ? `cluster:${clusterId}` : undefined;
}

export function taskBoardKeyForState(state: Pick<ClusterState, 'clusterId' | 'taskBoardMode' | 'taskBoardAttached'>): string | undefined {
  return taskBoardKeyForCluster(state.clusterId, normalizeTaskBoardMode(state));
}

export function isTaskBoardEnabledForState(state: Pick<ClusterState, 'taskBoardMode' | 'taskBoardAttached'>): boolean {
  return normalizeTaskBoardMode(state) !== 'none';
}

export async function setTaskBoardMode(
  clusterId: string,
  mode: ClusterTaskBoardMode,
): Promise<ClusterState | null> {
  return withClusterMetaLock(clusterId, async () => {
    if (!isClusterTaskBoardMode(mode)) return null;
    const state = await readCluster(clusterId);
    if (!state) return null;
    const current = normalizeTaskDispatcherSettings(state.dispatcher);
    const next: ClusterState = {
      ...state,
      taskBoardMode: mode,
      taskBoardAttached: mode !== 'none',
      // Disabling the board must also disarm the dispatcher; otherwise the
      // cluster would keep consuming tasks from a surface the operator hid.
      ...(mode === 'none' && current.enabled
        ? { dispatcher: { ...current, enabled: false, updatedAt: Date.now() } }
        : {}),
    };
    await writeMetaAtomic(next);
    rebuildIndexFor(next);
    return next;
  });
}

export async function setTaskBoardAttached(
  clusterId: string,
  attached: boolean,
): Promise<ClusterState | null> {
  return setTaskBoardMode(clusterId, attached === true ? 'project' : 'none');
}

export async function setTaskDispatcherEnabled(
  clusterId: string,
  enabled: boolean,
  armedByWorkflowId?: string,
): Promise<ClusterState | null> {
  return withClusterMetaLock(clusterId, async () => {
    const state = await readCluster(clusterId);
    if (!state) return null;
    if (enabled === true && !isTaskBoardEnabledForState(state)) return null;
    if (armedByWorkflowId !== undefined && !state.members.includes(armedByWorkflowId)) return null;
    const current = normalizeTaskDispatcherSettings(state.dispatcher);
    const next: ClusterState = {
      ...state,
      dispatcher: {
        ...current,
        enabled: enabled === true,
        ...(enabled === true && armedByWorkflowId ? { armedByWorkflowId } : {}),
        updatedAt: Date.now(),
      },
    };
    await writeMetaAtomic(next);
    rebuildIndexFor(next);
    return next;
  });
}

export async function updateTaskDispatcherSettings(
  clusterId: string,
  patch: ClusterDispatcherSettingsPatch,
  updatedByWorkflowId?: string,
): Promise<ClusterState | null> {
  return withClusterMetaLock(clusterId, async () => {
    const state = await readCluster(clusterId);
    if (!state) return null;
    if (updatedByWorkflowId !== undefined && !state.members.includes(updatedByWorkflowId)) return null;
    const current = normalizeTaskDispatcherSettings(state.dispatcher);
    const nextSettings = normalizeTaskDispatcherSettings({
      ...current,
      ...(patch.intervalMs !== undefined ? { intervalMs: patch.intervalMs } : {}),
      ...(patch.maxTasksPerSweep !== undefined ? { maxTasksPerSweep: patch.maxTasksPerSweep } : {}),
      ...(patch.maxConcurrentRuns !== undefined ? { maxConcurrentRuns: patch.maxConcurrentRuns } : {}),
      ...(patch.autoWorktree !== undefined ? { autoWorktree: patch.autoWorktree } : {}),
      ...(updatedByWorkflowId && current.enabled ? { armedByWorkflowId: current.armedByWorkflowId ?? updatedByWorkflowId } : {}),
      updatedAt: Date.now(),
    });
    const next: ClusterState = { ...state, dispatcher: nextSettings };
    await writeMetaAtomic(next);
    rebuildIndexFor(next);
    return next;
  });
}

// Phase 5 — list all in-memory cluster IDs. The idle-nudger detector
// iterates this to find clusters with idleNudgerEnabled === true. Clusters
// not yet hit by readCluster won't appear; the trade-off is acceptable
// because the detector only nudges live clusters (a never-touched cluster
// has no observers).
export function listKnownClusterIds(): string[] {
  return Array.from(cache.keys());
}

// Test/debug surface — dump in-memory state. Not used by the WS surface.
export function _peekCache(): { clusters: ClusterState[]; memberIndex: Record<string, string> } {
  return {
    clusters: Array.from(cache.values()),
    memberIndex: Object.fromEntries(memberIndex.entries()),
  };
}
