import { retiredProviderReason } from '@arco/shared';
// Slot 9 — per-workflow identity + session ledger (meta.json).
//
// Lives at <cwd>/.arco/workflows/<wfid>/meta.json alongside Slot 5's
// events.jsonl and Slot 7's build-log.md. Decouples Arco workflow identity
// from provider CLI session IDs so a workflow can span compactions (new
// Claude session) and cross-provider resumes (Claude → Codex).
// See docs/PERSISTENCE.md
//
// Invariants:
//   - All reads / writes scope to <cwd>/.arco/workflows/<wfid>/ (path-
//     escape defense matches memory.ts + buildLog.ts).
//   - Writes are atomic (tmp + rename). Same pattern as sibling modules.
//   - Read-modify-write goes through updateMeta(), which holds withFileLock on
//     the meta path for the whole read→mutate→write. The old "turn is the only
//     writer, nothing races" assumption was false: fire-and-forget writers
//     (setResolvedModelId, CONFIG toggles, plan-watcher detach) raced the turn
//     and last-writer-wins dropped a field. writeMeta stays a blind write for
//     create/seed paths that don't read first.

import { promises as fs } from 'fs';
import path from 'path';
import type { ProviderName, ModelName, EffortLevel, WorkflowMetaSummary, SessionHistoryEntry, PreviewHistoryEntry, SessionInfo, McpWorkflowAllow, GenesisSeed, WorkflowConfig, ArcoSkillRef } from '@arco/shared';
import { getRecallIndex } from './recall/index.js';
import { upsertSessionIndexFromMeta } from './workflows/sessionIndex.js';
import { atomicWriteFile, withFileLock } from './atomicFile.js';

const WFID_PATTERN = /^[a-zA-Z0-9-]{1,64}$/;

export function workflowDir(cwd: string, wfid: string): string {
  return path.join(cwd, '.arco', 'workflows', wfid);
}

export { WFID_PATTERN };

function metaPath(cwd: string, wfid: string): string {
  return path.join(workflowDir(cwd, wfid), 'meta.json');
}

function validateWfid(wfid: string): void {
  if (!WFID_PATTERN.test(wfid)) {
    throw new Error(`workflowMeta: invalid wfid ${JSON.stringify(wfid)}`);
  }
}

export interface WorkflowCliSession {
  provider: ProviderName;
  sessionId: string;
  createdAt: number;
  providerAccountRef?: string;
}

// Bump when the meta.json + events.jsonl on-disk shape changes in a way
// readers need to know about. Phase 0 introduced `parentEventSeq` stamping;
// pre-Phase-0 workflows are schemaVersion 1 (or absent — treated as 1) and
// have no parentEventSeq on disk. Migration is lazy-on-read: any meta.json
// without `schemaVersion` is loaded as v1; on next writeMeta we stamp v2.
// No events get rewritten — replay infers parent links from seq order on v1.
export const CURRENT_SCHEMA_VERSION = 2;

export interface WorkflowMeta {
  workflowId: string;
  name: string;
  cwd: string;
  kind?: 'workflow' | 'chat';
  createdAt: number;
  lastActiveAt: number;
  // Chat/Past Chats subtitle. Updated with the newest operator turn; capped
  // and flattened before persistence so the global list never reads JSONL.
  lastUserPreview?: string;
  primaryProvider: ProviderName;
  primaryModel: ModelName;
  primaryEffort: EffortLevel;
  providerAccountRef?: string;
  // See CURRENT_SCHEMA_VERSION above. Optional on read for back-compat with
  // pre-Phase-0 meta.json files (treated as 1); always set on write.
  schemaVersion?: number;
  // Append-only ledger of every CLI session bound to this workflow. Newest
  // entry last.
  cliSessions: WorkflowCliSession[];
  // Phase 6 Lite — session rotations archived by Handoff land here. Not the
  // same as `cliSessions[]`: a session can appear in both (it was live at
  // some point, then later archived). The history entry carries the handoff
  // artifact link + a turn-count snapshot so the Handoffs tab can show a
  // compact summary without rescanning events.jsonl.
  history?: SessionHistoryEntry[];
  operator: string;
  lastEventSeq: number | null;
  lastTranscriptSeq: number | null;
  compactedAt: number | null;
  autoHandoff?: { enabled: boolean; warnAt: number; autoAt: number; mode?: 'original-worker' | 'fresh-summarizer'; summarizer?: { provider: ProviderName; model?: ModelName; effort?: EffortLevel } };
  // §2.1 — per-tab auto-fold config (Claude Native). Persisted so the operator's
  // arming survives a server restart.
  autoFold?: { enabled: boolean; foldAt: number; tailBudget?: number };
  // Phase 6e — per-tab Codex transport override, persisted so a server
  // restart restores the operator's chosen transport. Falls through to the
  // settings cascade when absent. Only meaningful for primaryProvider='codex'.
  codexTransport?: 'exec' | 'appserver';
  codexContextPolicy?: 'max' | 'standard';
  // Phase 7a — per-tab Claude transport override. Same persistence shape
  // as codexTransport above; only meaningful for primaryProvider='claude'.
  claudeTransport?: 'cli' | 'native';
  // Opus-5 plan Phase 2 — the concrete model id Anthropic last echoed for an
  // ALIAS tab ('opus' / 'opus[1m]'), so a restarted Native worker resolves
  // catalog capabilities from the concrete id on turn 1. Only consulted when
  // primaryModel is still an alias (a pin to a concrete id ignores it); the
  // alias itself stays in primaryModel so auto-tracking is preserved.
  resolvedModelId?: string;
  // docs/PROVIDERS.md - sticky ultracode mode (default off). Survives restart so
  // a tab left in ultracode resumes there. Only meaningful for provider='claude'.
  ultracode?: boolean;
  // Per-tab Claude Native web_search/web_fetch per-turn budget (server-tool
  // max_uses). Absent ⇒ server default (15). Native-only.
  webSearchMaxUses?: number;
  // Chat-only web access. Absent ⇒ the chatWebArmed() default (on for a saved
  // Chat). Only written for kind==='chat' meta.
  chatWebAccess?: boolean;
  // docs/VOICE.md - this Chat is the Computer voice operator.
  voiceOperator?: boolean;
  computerContext?: import('@arco/shared').ComputerContextState;
  // Phase 7c-followup — per-tab opt-in to Anthropic's server-managed
  // compaction (`compact_20260112`). Only meaningful when the tab is on
  // Native transport AND the active model exposes the capability.
  claudeNativeCompact?: boolean;
  // Set when the operator explicitly opted back into server-side compaction
  // after the default flipped off. Legacy `claudeNativeCompact: true` values
  // without this marker are migrated off before the next Native turn.
  claudeNativeCompactUserSetAt?: number;
  // Claude Native debug override: force the interleaved-thinking beta even
  // for adaptive-thinking models. Default absent/false.
  claudeNativeForceInterleavedThinkingBeta?: boolean;
  // Adaptive-thinking display for Claude Native ('omitted' default when
  // absent; 'summarized' streams thinking into the Activity tab).
  claudeNativeThinkingDisplay?: 'omitted' | 'summarized' | 'updates';
  // NATIVE_COMPACTION_PLAN Phase 3 — per-tab opt-in to auto-continue after a
  // Native compaction. Default false (manual resume). Persists across restart.
  nativeCompactAutoContinue?: boolean;
  // docs/PROVIDERS.md - per-tab opt-in for the auto-threshold
  // ctx_action emission. Persists across server restart; honored only on
  // Claude Native turns (CLI/Codex don't surface the tool-call counter).
  efficiencyAutoCompact?: 'off' | 'conservative' | 'aggressive';
  // docs/PROVIDERS.md - per-tab Native tool-result filter mode.
  // `off` (default for now), `conservative`, `aggressive`. Persists across
  // server restart; honored only on Claude Native turns.
  efficiencyToolFilter?: 'off' | 'conservative' | 'aggressive';
  // docs/PROVIDERS.md - per-tab fact-force first-edit gate.
  // `off` by default / `on` by explicit operator opt-in. An absent field on
  // rehydrate also resolves off. Honored only on Claude Native turns.
  efficiencyFactForce?: 'on' | 'off';
  // Per-tab config-protection write-gate. `on` (default for all tabs —
  // safety gate) / `off` (operator relaxed it for this workflow). Absent
  // on rehydrate ⇒ gate stays ON. Honored only on Claude Native turns.
  efficiencyConfigProtection?: 'on' | 'off';
  // docs/PROVIDERS.md - per-tab opt-in sandbox tools.
  // `off` (default) / `on`. Persists across server restart; honored
  // only on Claude Native turns. The per-tab sandbox.db lives next to
  // this meta.json and is unlinked when remove_workflow tears the tab
  // down (or the operator clicks Clear DB in the CONFIG tab).
  efficiencySandbox?: 'off' | 'on';
  // docs/PROVIDERS.md - per-tab operator-armed durable review gate. `off` (default)
  // / `on`. Persists across server restart; honored only on Claude Native
  // turns. Absent on rehydrate ⇒ gate OFF (opting in is always explicit).
  reviewSafeMode?: 'off' | 'on';
  // docs/PROVIDERS.md - per-tab output-style picker.
  // `normal` (default), `lite`, `terse`. Persists across server restart;
  // honored by Claude Native, Codex app-server turns. Renamed
  // `caveman` → `terse` 2026-05-10; legacy `caveman` values are
  // auto-aliased to `terse` on the rehydrate path in handleCreateWorkflow.
  outputStyle?: 'normal' | 'lite' | 'terse' | 'caveman';
  // docs/GOTCHAS.md - per-tab operator-set persistent north-star (short
  // free-text objective). Persists across server restart; injected as a stable
  // system block every turn on every transport that folds clusterPlan. Absent
  // on rehydrate ⇒ no north-star (byte-identical to pre-feature behavior). Cap
  // GOAL_MAX_BYTES = 2048 (enforced at write time). Cleared by setting empty.
  goal?: string;
  // Durable tab-level skill pins. Bodies stay in their SKILL.md files and are
  // re-resolved at turn start so skill edits apply without rewriting meta.
  pinnedSkills?: ArcoSkillRef[];
  // REMOTE_MANAGEMENT.md §1.4 — per-workflow hub opt-in (`REMOTE CONTINUATION`).
  // Default OFF: absent/false ⇒ this workflow is not reported to the management
  // hub, remote actions are rejected, and it produces no phone notifications.
  // Persists across server restart so the opt-in survives a rehydrate.
  remoteEnabled?: boolean;
  // Managed bake-off attempt provenance. Used only to inherit the SOURCE
  // checkout's DD7 trust decision without writing a new trust entry.
  managedWorktreeSourceCwd?: string;
  // R1 — second arming for remote DEBAG gate resolution (§9.2 of
  // docs/REMOTE_MANAGEMENT.md). Absent/false => gates render read-only on
  // the phone console and routed gate_resolve actions are rejected.
  remoteGatesEnabled?: boolean;
  // docs/PROVIDERS.md - operator-attached `codebase-memory-mcp`
  // per tab. Phase F ships UX wiring only; the actual `--mcp-config`
  // write-in at CLI spawn time is deferred (lands after Cluster 3's
  // `mcpConfigWriter`). Until then `attached` is the operator's intent bit
  // and `lastIndexedAt` / `fileCount` are populated by the one-shot
  // re-index endpoint.
  codebaseMemory?: {
    attached: boolean;
    indexPath?: string;
    lastIndexedAt?: number;
    fileCount?: number;
  };
  // Last successful context calibration for this workflow's current CLI
  // session. Ephemeral `wf.calibration` in memory is seeded from this on
  // rehydrate so the ground-truth ratio survives server restarts — without
  // it, every restart drops back to the default bytes/token heuristic until
  // the next zone crossing, which on a resumed mid-range session might be
  // never (e.g. stuck at 34% with no zone below). `zonesCalibrated` is NOT
  // persisted: on restart we re-enter zones fresh so calibration can refresh
  // against the newer session state.
  calibration?: { ratio: number; overhead: number; lastGroundTruth?: number };
  // Plan attached to this workflow, if any. Plans live at
  // <cwd>/.arco/plans/<planId>.md (see planStore.ts) and are explicitly
  // attached — never auto-bound by cwd, since one folder may host multiple
  // independent project plans. `planLastSeenUpdatedAt` snapshots the plan's
  // updatedAt at the last turn that injected it; if the operator edits the
  // plan body between turns, the next turn injects a "plan was edited"
  // refresh so the agent notices the change.
  planId?: string;
  planLastSeenUpdatedAt?: number;
  // Per-workflow opt-out for the tree-RSS kill in WorkerManager. Set to true
  // only for workflows running legitimate high-memory workloads (kernel
  // compiles, big LTO links, multi-GB dataset scans) where the operator has
  // explicitly accepted the risk of a runaway eating system RAM. Only the
  // tree-RSS kill is skipped — 5MB worker-output cap + cancel-time
  // process-tree kill still apply. Honored only for primary turns; reviewers
  // and handoff reflections always run under the global cap.
  disableRssGuard?: boolean;
  // Preview tab — operator-bound dev-server port for this workflow. Iframe
  // src is /api/preview/<workflowId>/, served by the in-server proxy that
  // forwards to 127.0.0.1:<port>. Persisted so a reconnect/restart restores
  // the iframe without re-typing.
  preview?: { port: number; framework?: string; manual: boolean };
  // History of recent preview binds for this workflow — most-recent-first,
  // capped at 5. Drives the click-to-rebind pills in the PREVIEW tab header.
  // Consecutive same-port binds dedupe to a timestamp refresh rather than
  // pushing a duplicate entry.
  previewHistory?: PreviewHistoryEntry[];
  // Phase 7b — set when this workflow was minted by a Task tool call from
  // another workflow's Native worker. Lets the client filter parented
  // children out of the top tab strip until the operator promotes them.
  // Persisted so a server restart restores the parent/child relationship.
  parentWorkflowId?: string;
  // docs/ARCHITECTURE.md - per-tab MCP allowlist. One entry per registry
  // server the operator has interacted with for THIS tab: `enabled` is the
  // per-tab server toggle; `allowedDangerousTools` is the explicit tick-list
  // of dangerous tools opted back in; `tools` caches the last-probed list so
  // the `--disallowedTools` computation at turn time is deterministic without
  // a per-spawn probe. Keyed by serverId; the global server def lives in
  // ~/.arco/mcp/registry.json. Absent ⇒ no MCP servers wired for this tab.
  mcpAllow?: McpWorkflowAllow[];
  // docs/GENESIS.md - mirror of the workflow's genesis
  // seed, written once the from-nothing genesis is scaffolded and a cwd exists
  // (before that there is no meta.json — the seed lives only on the client-
  // persisted WorkflowConfig). Lets a scaffolded genesis project resume with its
  // seed intact for an in-workflow Creative-mode follow-up (M3). Absent on
  // ordinary workflows.
  genesisSeed?: GenesisSeed;
  // docs/PROVIDERS.md - per-tab Ollama generation-param preset blob.
  // Persisted so the operator's num_ctx / keep_alive / num_gpu / temperature
  // (+ pre-wired extensions) survive reload + server restart. Only meaningful
  // for primaryProvider='ollama'. Merged through the typed allowlist boundary
  // at request-build time (num_ctx trusted-only).
  ollamaParams?: Record<string, unknown>;
  // docs/PERSISTENCE.md - mutable head pointer over the immutable events.jsonl
  // log. ABSENT means "head is the physical file tail" → byte-identical to
  // pre-Phase-9 behavior (this is the load-bearing no-regression invariant).
  // When set, branch-aware replay walks the lineage from this seq (following
  // `leaf_move` redirect events) instead of flat seq order. Rides atomic
  // writeMeta so the head survives a server restart. Abandoned branches are
  // never deleted — they stay byte-identical on disk.
  leafSeq?: number;
}

// Reconstruct a WorkflowConfig from persisted meta.json. The canonical config
// normally lives in the CLIENT's localStorage and rides `rehydrate_workflows`;
// this is the SERVER-side reconstruction for the case where no connected client
// holds it — eager boot-time cluster-member registration and the on-demand
// `cluster_member_rehydrate` handler. It carries every TURN-RELEVANT persisted
// field (NOT just provider/model/effort) so a reconstructed member runs its next
// turn on the CORRECT transport + toggles: dropping `claudeTransport` alone would
// silently run a Native member on CLI, `codexTransport` an appserver member on
// exec, etc. Client-only fields absent from meta (`advanced`, `fastMode`,
// `allowedProviders`, `skipPermissions`) cannot be recovered — `skipPermissions`
// defaults `true` (the cluster-member default) and the rest reset. `caveman`
// output-style is aliased to `terse` (the config type dropped the legacy value).
export function workflowConfigFromMeta(meta: WorkflowMeta, cwd: string): WorkflowConfig {
  return {
    ...(meta.kind === 'chat' ? { kind: 'chat' as const } : {}),
    name: meta.name,
    workingDirectory: cwd,
    // Preserve the default-claude invariant (undefined ≡ claude).
    primaryProvider: meta.primaryProvider === 'claude' ? undefined : meta.primaryProvider,
    primaryModel: meta.primaryModel,
    primaryEffort: meta.primaryEffort,
    skipPermissions: true,
    ...(meta.providerAccountRef ? { providerAccountRef: meta.providerAccountRef } : {}),
    // — transport overrides (HIGH: dropping these runs the WRONG transport) —
    ...(meta.claudeTransport ? { claudeTransport: meta.claudeTransport } : {}),
    ...(meta.codexTransport ? { codexTransport: meta.codexTransport } : {}),
    ...(meta.codexContextPolicy ? { codexContextPolicy: meta.codexContextPolicy } : {}),
    ...(meta.ultracode === true ? { ultracode: true } : {}),
    // — behavior / steering —
    ...(meta.goal && meta.goal.trim() ? { goal: meta.goal } : {}),
    ...(meta.pinnedSkills?.length ? { pinnedSkills: meta.pinnedSkills.map((s) => ({ ...s })) } : {}),
    ...(meta.outputStyle ? { outputStyle: meta.outputStyle === 'caveman' ? 'terse' : meta.outputStyle } : {}),
    ...(typeof meta.webSearchMaxUses === 'number' ? { webSearchMaxUses: meta.webSearchMaxUses } : {}),
    ...(typeof meta.chatWebAccess === 'boolean' ? { chatWebAccess: meta.chatWebAccess } : {}),
    ...(meta.voiceOperator === true ? { voiceOperator: true } : {}),
    ...(meta.computerContext ? { computerContext: meta.computerContext } : {}),
    ...(meta.ollamaParams ? { ollamaParams: meta.ollamaParams } : {}),
    ...(meta.remoteEnabled ? { remoteEnabled: true } : {}),
    ...(meta.managedWorktreeSourceCwd ? { managedWorktreeSourceCwd: meta.managedWorktreeSourceCwd } : {}),
    ...(meta.remoteGatesEnabled ? { remoteGatesEnabled: true } : {}),
    ...(meta.codebaseMemory ? { codebaseMemory: meta.codebaseMemory } : {}),
    ...(meta.genesisSeed ? { genesisSeed: meta.genesisSeed } : {}),
    // — Native gates / toggles (Native-only; inert on other providers) —
    ...(meta.claudeNativeCompact !== undefined ? { claudeNativeCompact: meta.claudeNativeCompact } : {}),
    ...(meta.claudeNativeThinkingDisplay ? { claudeNativeThinkingDisplay: meta.claudeNativeThinkingDisplay } : {}),
    ...(meta.claudeNativeForceInterleavedThinkingBeta ? { claudeNativeForceInterleavedThinkingBeta: true } : {}),
    ...(meta.nativeCompactAutoContinue ? { nativeCompactAutoContinue: true } : {}),
    ...(meta.efficiencyAutoCompact ? { efficiencyAutoCompact: meta.efficiencyAutoCompact } : {}),
    ...(meta.efficiencyToolFilter ? { efficiencyToolFilter: meta.efficiencyToolFilter } : {}),
    ...(meta.efficiencyFactForce ? { efficiencyFactForce: meta.efficiencyFactForce } : {}),
    ...(meta.efficiencyConfigProtection ? { efficiencyConfigProtection: meta.efficiencyConfigProtection } : {}),
    ...(meta.efficiencySandbox ? { efficiencySandbox: meta.efficiencySandbox } : {}),
    ...(meta.reviewSafeMode ? { reviewSafeMode: meta.reviewSafeMode } : {}),
    ...(meta.autoFold ? { autoFold: meta.autoFold } : {}),
    ...(meta.autoHandoff ? { autoHandoff: meta.autoHandoff } : {}),
  };
}

export async function readMeta(cwd: string, wfid: string): Promise<WorkflowMeta | null> {
  if (!cwd) return null;
  validateWfid(wfid);
  try {
    const raw = await fs.readFile(metaPath(cwd, wfid), 'utf8');
    const parsed = JSON.parse(raw) as WorkflowMeta & {
      orchestratorProvider?: ProviderName;
      orchestratorModel?: ModelName;
      orchestratorEffort?: EffortLevel;
    };
    // Phase 8 compatibility shim — pre-rename meta.json files stored the
    // primary config under `orchestrator*` keys. Fold them into the new
    // shape so the rest of the server sees a uniform type.
    if (parsed.primaryProvider === undefined && parsed.orchestratorProvider) {
      parsed.primaryProvider = parsed.orchestratorProvider;
    }
    if (parsed.primaryModel === undefined && parsed.orchestratorModel) {
      parsed.primaryModel = parsed.orchestratorModel;
    }
    if (parsed.primaryEffort === undefined && parsed.orchestratorEffort) {
      parsed.primaryEffort = parsed.orchestratorEffort;
    }
    delete parsed.orchestratorProvider;
    delete parsed.orchestratorModel;
    delete parsed.orchestratorEffort;
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function writeMeta(cwd: string, meta: WorkflowMeta): Promise<void> {
  if (!cwd) return;
  validateWfid(meta.workflowId);
  // Stamp the current schema version on every write. Pre-Phase-0 metas
  // missing the field get bumped lazily here on their next write.
  if (meta.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    meta.schemaVersion = CURRENT_SCHEMA_VERSION;
  }
  await atomicWriteFile(metaPath(cwd, meta.workflowId), JSON.stringify(meta, null, 2) + '\n');
  // Workbench Expansion §F1 — keep the machine-global Recall index current as
  // workflows run. FAILURE-ISOLATED: a recall hiccup must never break a real
  // workflow's meta write, so the upsert is fired-and-logged, never awaited
  // into the meta-write result. recall.db is a rebuildable projection anyway.
  getRecallIndex().upsertFromMeta(meta).catch((err) => {
    console.error('[arco] recall index upsert failed:', err);
  });
  // docs/ARCHITECTURE.md - keep the project-local session index current after
  // every turn. Same FAILURE-ISOLATED contract as the recall upsert above: the
  // session index is a rebuildable projection, so a hiccup must never break the
  // meta write. Fired-and-logged, never awaited.
  if (meta.kind !== 'chat') {
    upsertSessionIndexFromMeta(meta)
      // Opt-in utility-model title (settings.ollama.utility.titles). Chained
      // AFTER the upsert so the entry exists; dynamic import keeps ollama.ts
      // out of this module's static graph. Self-gating + never throws.
      .then(() => import('./workflows/modelTitles.js'))
      .then((m) => m.maybeGenerateModelTitle(meta))
      .catch((err) => {
        console.error('[arco] session index upsert failed:', err);
      });
  }
}

/**
 * Read-modify-write meta.json under `withFileLock(metaPath)`. `mutate` edits the
 * meta in place (return void) or returns a replacement; return `false` to skip
 * the write (nothing changed). Resolves to the persisted meta, or null when no
 * meta.json exists (mutate is not called).
 *
 * Re-entrancy: `mutate` must NOT call updateMeta (or any helper built on it)
 * for the same workflow — the inner call queues behind the outer lock, which
 * is waiting on the inner call. Plain writeMeta inside mutate is unnecessary
 * (the result is written for you) and would race the locked write.
 */
export async function updateMeta(
  cwd: string,
  wfid: string,
  mutate: (meta: WorkflowMeta) => WorkflowMeta | void | false | Promise<WorkflowMeta | void | false>,
): Promise<WorkflowMeta | null> {
  if (!cwd) return null;
  validateWfid(wfid);
  return withFileLock(metaPath(cwd, wfid), async () => {
    const meta = await readMeta(cwd, wfid);
    if (!meta) return null;
    const result = await mutate(meta);
    if (result === false) return meta;
    const next = result ?? meta;
    await writeMeta(cwd, next);
    return next;
  });
}

// Ensure a meta.json exists — write one from `seed` if missing. Used by the
// rehydrate path so pre-Slot-9 workflows (no meta.json on disk) get one
// lazily the next time their client reconnects.
export async function ensureMeta(cwd: string, seed: WorkflowMeta): Promise<WorkflowMeta> {
  if (!cwd) return seed;
  validateWfid(seed.workflowId);
  // Locked so a check-then-seed can't clobber an updateMeta landing between.
  return withFileLock(metaPath(cwd, seed.workflowId), async () => {
    const existing = await readMeta(cwd, seed.workflowId);
    if (existing) return existing;
    await writeMeta(cwd, seed);
    return seed;
  });
}

// Opus-5 plan Phase 2 — persist the served model behind an alias tab. Called
// fire-and-forget from the Native worker when the echoed model changes; a
// failed write only costs the turn-1-after-restart capability upgrade.
export async function setResolvedModelId(cwd: string, wfid: string, resolvedModelId: string): Promise<void> {
  await updateMeta(cwd, wfid, (meta) => {
    if (meta.resolvedModelId === resolvedModelId) return false;
    meta.resolvedModelId = resolvedModelId;
  });
}

export async function touchLastActive(cwd: string, wfid: string): Promise<void> {
  await updateMeta(cwd, wfid, (meta) => {
    meta.lastActiveAt = Date.now();
  });
}

export async function appendCliSession(
  cwd: string,
  wfid: string,
  session: WorkflowCliSession,
): Promise<void> {
  await updateMeta(cwd, wfid, (meta) => {
    const last = meta.cliSessions[meta.cliSessions.length - 1];
    if (!last || last.sessionId !== session.sessionId || last.provider !== session.provider) {
      meta.cliSessions.push(session);
    }
    meta.lastActiveAt = session.createdAt;
  });
}

// Reconcile the latest CLI session id after a turn completes. Codex supplies
// its server thread id on first-turn init, after workflow metadata is created
// with Arco's placeholder id. Update that provider's latest entry in place
// rather than appending a second row; when the ids already match, only refresh
// lastActiveAt. This keeps resume lookup aligned with the live CLI session
// after initial binding or session rotation.
export async function reconcileLatestCliSession(
  cwd: string,
  wfid: string,
  provider: ProviderName,
  liveSessionId: string,
  providerAccountRef?: string,
): Promise<void> {
  if (!cwd || !liveSessionId) return;
  await updateMeta(cwd, wfid, (meta) => {
    // Find the latest entry for this provider (not strictly the last overall —
    // a cross-provider workflow might have interleaved entries).
    let latestIdx = -1;
    for (let i = meta.cliSessions.length - 1; i >= 0; i--) {
      if (meta.cliSessions[i].provider === provider) { latestIdx = i; break; }
    }
    const now = Date.now();
    if (latestIdx === -1) {
      meta.cliSessions.push({ provider, sessionId: liveSessionId, createdAt: now, ...(providerAccountRef ? { providerAccountRef } : {}) });
    } else if (meta.cliSessions[latestIdx].sessionId !== liveSessionId) {
      meta.cliSessions[latestIdx] = { provider, sessionId: liveSessionId, createdAt: meta.cliSessions[latestIdx].createdAt, ...(providerAccountRef ? { providerAccountRef } : {}) };
    } else if (providerAccountRef && meta.cliSessions[latestIdx].providerAccountRef !== providerAccountRef) {
      meta.cliSessions[latestIdx].providerAccountRef = providerAccountRef;
    }
    meta.lastActiveAt = now;
  });
}

// Most recent CLI session for the given provider, or null if the workflow
// never ran on that provider. Used by the resume handler to decide native-
// resume vs bootstrap.
export function latestCliSessionFor(meta: WorkflowMeta, provider: ProviderName): WorkflowCliSession | null {
  for (let i = meta.cliSessions.length - 1; i >= 0; i--) {
    if (meta.cliSessions[i].provider === provider) return meta.cliSessions[i];
  }
  return null;
}

export function arcoInternalSessionInfoForMeta(meta: WorkflowMeta): SessionInfo | null {
  if (meta.primaryProvider !== 'claude' && meta.primaryProvider !== 'ollama' && !retiredProviderReason(meta.primaryProvider)) return null;
  if (meta.primaryProvider === 'claude' && latestCliSessionFor(meta, 'claude')) return null;
  return {
    sessionId: meta.workflowId,
    cwd: meta.cwd,
    name: meta.name,
    startedAt: meta.lastActiveAt || meta.createdAt,
    provider: meta.primaryProvider,
    arcoWorkflowId: meta.workflowId,
    arcoName: meta.name,
    arcoInternal: true,
  };
}

// Phase 6 Lite — append a session-rotation entry to `meta.history[]`. The
// session remains in `cliSessions[]` too (the ledger is append-only); this
// records the archive marker + handoff artifact link.
export async function appendHistoryEntry(
  cwd: string,
  wfid: string,
  entry: SessionHistoryEntry,
): Promise<void> {
  await updateMeta(cwd, wfid, (meta) => {
    meta.history = meta.history ?? [];
    meta.history.push(entry);
    meta.lastActiveAt = Date.now();
  });
}

export async function clearProviderCliSessions(
  cwd: string,
  wfid: string,
  provider: ProviderName,
): Promise<void> {
  await updateMeta(cwd, wfid, (meta) => {
    meta.cliSessions = meta.cliSessions.filter((s) => s.provider !== provider);
    meta.lastActiveAt = Date.now();
  });
}

// docs/ARCHITECTURE.md - set one server's per-tab allowlist entry. Replaces
// the entry for `serverId` (or appends it) with the operator's per-tab enable
// + dangerous-tool ticks. `tools` (optional) refreshes the cached probe list
// used to compute `--disallowedTools` deterministically at turn time; pass it
// when a fresh probe is available, omit to preserve the existing cache.
// Returns the updated allowlist, or null if the workflow meta is missing.
export async function setMcpAllow(
  cwd: string,
  wfid: string,
  entry: McpWorkflowAllow,
): Promise<McpWorkflowAllow[] | null> {
  const updated = await updateMeta(cwd, wfid, (meta) => {
    const list = meta.mcpAllow ?? [];
    const idx = list.findIndex((a) => a.serverId === entry.serverId);
    const merged: McpWorkflowAllow = {
      serverId: entry.serverId,
      enabled: entry.enabled,
      allowedDangerousTools: entry.allowedDangerousTools,
      // DD11b — preserve the existing disable-list when the caller omits it (a
      // dangerous-tick edit shouldn't clobber the disabled set, and vice versa).
      disabledTools: entry.disabledTools ?? (idx >= 0 ? list[idx].disabledTools : undefined),
      // Preserve an existing cached tool list when the caller didn't supply one.
      tools: entry.tools ?? (idx >= 0 ? list[idx].tools : undefined),
    };
    if (idx >= 0) list[idx] = merged;
    else list.push(merged);
    meta.mcpAllow = list;
  });
  return updated ? (updated.mcpAllow ?? []) : null;
}

// Refresh just the cached probe `tools` for a server on a workflow (after a
// probe), without changing the enable/tick state. No-op if the server has no
// allowlist entry yet (probe-before-enable is fine — the cache is only used
// once the operator enables the server).
export async function setMcpProbedTools(
  cwd: string,
  wfid: string,
  serverId: string,
  tools: McpWorkflowAllow['tools'],
): Promise<void> {
  await updateMeta(cwd, wfid, (meta) => {
    const entry = meta.mcpAllow?.find((a) => a.serverId === serverId);
    if (!entry) return false;
    entry.tools = tools;
  });
}

// GET /api/workflows?path=<cwd> handler. Mirrors /api/sessions?path= —
// empty list when the directory doesn't exist; unreadable entries skipped.
export async function listWorkflowMetas(cwd: string): Promise<WorkflowMetaSummary[]> {
  if (!cwd) return [];
  const workflowsDir = path.join(cwd, '.arco', 'workflows');
  let entries: string[];
  try {
    entries = await fs.readdir(workflowsDir);
  } catch {
    return [];
  }
  const out: WorkflowMetaSummary[] = [];
  for (const name of entries) {
    if (!WFID_PATTERN.test(name)) continue;
    let meta: WorkflowMeta | null;
    try {
      meta = await readMeta(cwd, name);
    } catch {
      continue;
    }
    if (!meta) continue;
    const lastClaude = latestCliSessionFor(meta, 'claude');
    out.push({
      workflowId: meta.workflowId,
      name: meta.name,
      cwd: meta.cwd,
      createdAt: meta.createdAt,
      lastActiveAt: meta.lastActiveAt,
      primaryProvider: meta.primaryProvider,
      primaryModel: meta.primaryModel,
      primaryEffort: meta.primaryEffort,
      ...(lastClaude ? { lastClaudeSessionId: lastClaude.sessionId } : {}),
    });
  }
  out.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  return out;
}
