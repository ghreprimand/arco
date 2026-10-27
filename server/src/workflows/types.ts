import type { WebSocket } from 'ws';
import type { FSWatcher } from 'fs';
import type { WorkflowConfig, PreviewHistoryEntry, ProviderName, ModelName, EffortLevel, ToolPosture, ServerMessage } from '@arco/shared';
import type { WorkerManager } from '../workers/WorkerManager.js';
import type { PrimaryConfig } from '../primitives/seedWorker.js';
import type { SessionJsonlEntry } from '../sessionJsonl.js';
import type { CalibrationState } from '../contextCalibrator.js';
import type { PrimaryBackgroundTracker } from '../primaryBackgroundTracker.js';

export interface Session {
  id: string;
  workflowIds: Set<string>;
  // docs/PROTOCOL_CLUSTER.md - cluster ids this WS has subscribed to.
  // Populated on `cluster_subscribe`, cleared on `cluster_unsubscribe` and
  // `ws.on('close')`. broadcastCluster fans out to every WS whose set
  // contains the target clusterId. Decoupled from the per-workflow observer
  // pattern because cluster events fire even when no member tab is open
  // in this client (e.g. operator only has the cluster tab visible).
  clusterIds: Set<string>;
  // 2026-05-11 — bookkeeping for the "cluster subscribe also observes each
  // member workflow" path. Per-cluster set of workflowIds whose `observers`
  // set we added this WS to *because* of the cluster subscription. On
  // unsubscribe we remove the WS from these workflows' observers WITHOUT
  // touching observer adds from other sources (explicit tab subscribe via
  // rehydrate, member of a different cluster the same WS subscribed to).
  // Per-cluster scoping handles the "same workflow lives in two clusters
  // the same WS subscribed to" case — though createCluster's no-cross-
  // cluster fence makes that unreachable today, the bookkeeping stays
  // robust if the fence ever loosens.
  clusterObserved: Map<string, Set<string>>;
}

// Phase 2 Lite: WorkflowState is per-tab mutable state. `primarySessionId`
// pins provider continuation state across turns — Claude: pre-minted UUID
// passed as --session-id/--resume; Codex: captured from thread.started init
// event; Antigravity: opaque cascade id. Gemini/Ollama primaries have no
// native-session concept in this phase.
export interface WorkflowState {
  config: WorkflowConfig;
  busy: boolean;
  manager: WorkerManager;
  primary: PrimaryConfig;
  primarySessionId?: string;
  // Owned by the user-message loop; interrupt only its worker, never reviewers
  // or compaction. Keep the claim until cancellation has actually settled.
  primaryTurn?: { token: number; workerId?: string; holdSteer: boolean; interruption?: Promise<boolean | void> };
  computerResetting?: boolean;
  // Background activity waits through the full Computer turn/reset boundary.
  computerSettled?: boolean;
  // Incognito Chat transcript held only for this server lifetime. The
  // broadcast chokepoints compact streaming text into this array; stateless
  // providers replay it each turn without touching events.jsonl.
  incognitoEvents?: ServerMessage[];
  // Short reconnect grace after the last browser observer disconnects. If no
  // client reclaims the incognito tab, the server tears it down from memory.
  incognitoCleanupTimer?: NodeJS.Timeout;
  // Set when this state's config was reconstructed from meta.json (eager boot
  // registration / on-demand cluster_member_rehydrate) rather than from a
  // client's full config. meta can't carry client-only fields (advanced /
  // fastMode / allowedProviders / skipPermissions), so this is a placeholder the
  // client's `rehydrate_workflows` upgrades on reconnect — see the `existing`
  // branch of handleRehydrateWorkflows. Cleared on that upgrade.
  bootMaterialized?: boolean;
  // In-flight handoff, set for the duration of a rotation so handoff_cancel can
  // abort the reflection/summarizer worker. Cleared when the handoff settles.
  activeHandoff?: { handoffId: string; artifactName: string; abort: () => void };
  // Phase 4 — mid-turn operator queue. Two kinds: 'steer' is "do this now /
  // change direction"; 'follow-up' is "after the current task lands." Both
  // kinds drain post-turn for every provider in Phase 4 — visible/rebindable
  // is the scope here. Phases 5–7 turn on real mid-turn delivery for 'steer'
  // per provider (Codex app-server, Ollama/llama.cpp loop hook, Native
  // Claude). Replaces the pre-Phase-4 `pendingInterjections[]` (single
  // array; same on-disk attachments-survive-drain semantics from
  // docs/CLIENT.md Fix 4).
  //
  // Each enqueue / drain / cancel broadcasts a `queue_update` (persisted to
  // events.jsonl) so a reconnect's replay reconstructs the visible queue.
  queue: { steering: QueueItem[]; followUp: QueueItem[] };
  // All client WebSockets observing this workflow. Multi-valued so two
  // browser windows pointed at the same workflow both receive live events;
  // added on `create_workflow` / `rehydrate_workflows` / `spawn_from_here`,
  // removed on `ws.on('close')`. Broadcasts always persist to events.jsonl
  // first, then fan out to whichever members of the set are still open.
  observers: Set<WebSocket>;
  // Phase 1 context robustness — dispose fn for the active Claude session
  // JSONL file watcher. Null when provider != claude or no session yet.
  sessionWatcher?: (() => void) | null;
  // Tail-first hydration — raw JSONL entries that predate the initial emit
  // window. Popped in page-sized chunks as `load_earlier_messages` requests
  // arrive from the client. Empty once every entry has been emitted OR when
  // the watcher hasn't run yet.
  pendingEarlierEntries?: SessionJsonlEntry[];
  // Phase 3 — per-tab auto-handoff state. Mirrors WorkflowConfig.autoHandoff
  // with defaults when absent.
  autoHandoff: {
    enabled: boolean;
    warnAt: number;
    autoAt: number;
    warnFired: boolean;
    autoFired: boolean;
    // WP5 — mirrors config.autoHandoff.mode/summarizer. Left undefined when
    // unset; the resolution (global default, provider-resumable fallback)
    // happens at fire time in maybeAutoHandoff, not here.
    mode?: 'original-worker' | 'fresh-summarizer';
    summarizer?: { provider: ProviderName; model?: ModelName; effort?: EffortLevel };
  };
  // §2.1 — per-tab auto-fold state (Claude Native). foldAt is the
  // effective-window budget % (from the §2.3 meter) at which an in-place Fold
  // fires; it sits BELOW autoHandoff.warnAt so a fold is attempted before a
  // handoff is recommended. Off by default (enabled false / absent). The
  // config + ConfigTab toggle + fired-flag bookkeeping land with §2.1; §2.3
  // only reads foldAt to report fold-threshold crossings on the budget meter.
  autoFold?: {
    enabled: boolean;
    foldAt: number;
    tailBudget?: number;
    foldFired?: boolean;
    foldIneffectiveCount?: number;
  };
  // Phase 2 pty calibration — per-session calibration state (Claude only).
  // Absent until first successful calibration; falls back to global constants.
  calibration?: CalibrationState;
  // Set to a cancel function while a calibration pty is running. Cleared
  // when calibration completes or is cancelled. Primary turns call this on
  // start to ensure calibration never runs concurrently with a turn.
  cancelCalibration?: () => void;
  // Estimated context % from the most recently settled turn; used for
  // zone-crossing detection in maybeCalibrate.
  lastContextPercent: number;
  // 2026-07-18 — the last full context_usage numbers (the SAME data the
  // desktop CTX chip renders: raw tokens / window / percent). Stashed at the
  // broadcast chokepoints in server/broadcast.ts so every provider's emit path
  // feeds it; the hub link renders the phone CTX line from this instead of
  // re-deriving a percent (which had per-provider scale bugs).
  lastContextUsage?: { tokens: number; window: number; percent: number };
  // §2.3 — most recent effective-window budget pct (Claude Native). Distinct
  // from lastContextPercent (raw window): this is used/(window−reservedOutput),
  // the usable-input-pressure signal the §2.1 auto-fold trigger reads. Absent
  // until the first Native turn settles with a count_tokens reading.
  lastContextBudgetPct?: number;
  // §4.1 — session-local tool posture (full/coding/chat/review). Runtime-only,
  // NEVER persisted to meta.json: a reload returns to 'full'. Set by the
  // set_tool_posture WS message; read in handleUserMessage and threaded to the
  // Native worker. Absent ⇒ 'full' (no filtering).
  toolPosture?: ToolPosture;
  // NATIVE_COMPACTION_PLAN Phase 2 — fired flags for the between-turn auto
  // context-fill compaction (Native only). Same bounded-once-per-settled-turn
  // semantics as autoHandoff.warnFired/autoFired: set on fire, reset when
  // context drops back below the warn threshold (after a compaction the seed +
  // kept tail starts well below the ceiling). Absent ⇒ treated as both false.
  autoCompactWarnFired?: boolean;
  autoCompactFired?: boolean;
  // Concurrency guard — timestamp (epoch ms) of the most recent entry the
  // JSONL watcher saw with an entrypoint other than 'sdk-cli'. That means
  // a native `claude --resume <id>` terminal is also writing to the same
  // session file. If set and recent, handleUserMessage refuses to start
  // a turn (two concurrent writers corrupt session state).
  lastForeignWriteAt?: number;
  // Debounce for the concurrent-session warning so a TUI dumping several
  // events (permission-mode + file-history-snapshot + a user turn) only
  // produces one chat notice per active episode.
  lastForeignWarnAt?: number;
  // Long-running children the primary CLI spawned (typically Bash tool calls
  // with `run_in_background: true`). Lazily created on first mid-turn spawn;
  // disposed when the workflow is removed.
  bgTracker?: PrimaryBackgroundTracker;
  // Mirrors WorkflowMeta.disableRssGuard. Populated from meta.json on load
  // and forwarded to runPrimaryTurn so the per-worker tree-RSS kill is
  // skipped for this workflow. Operator opt-in for known-huge workloads.
  disableRssGuard?: boolean;
  // Active plan id for this tab. Mirrors WorkflowMeta.planId. Source of truth
  // for the per-turn header injection. Detached → undefined. Title/body are
  // re-read from disk at injection time; we don't cache them here so an
  // operator edit between turns is always picked up fresh.
  planId?: string;
  // Operator-bound dev-server port for the Preview tab. Source of truth for
  // the in-server proxy at /api/preview/<workflowId>/. Mirrors
  // WorkflowMeta.preview; loaded from disk on hydrate, written back on every
  // set_preview_port / clear_preview_port.
  preview?: { port: number; framework?: string; manual: boolean };
  // Mirror of WorkflowMeta.previewHistory for in-memory broadcast. Loaded on
  // hydrate, mutated through appendPreviewHistory, written back on every
  // bind via persistPreviewMeta.
  previewHistory: PreviewHistoryEntry[];
  // WP3 — operator-armed one-shot "force compaction on next turn" for Ollama.
  // The manual COMPACT button sets this (mirrored into the provider-side
  // ollamaForceCompact registry the worker actually reads); it's a visible
  // marker of the armed state for the workflow. Ollama's worker is stateless
  // per turn, so immediate in-place compaction isn't possible — the cut runs at
  // the front of the next run(). Single-turn; not persisted to disk.
  ollamaForceCompactNextTurn?: boolean;
  // Operator-initiated plan-mode entry. Set by the
  // `enter_plan_mode_request` WS handler (send-time-fire from the composer's
  // inline toggle); consumed by the next user-message turn dispatch when
  // the resolved transport is Claude Native, then cleared. If the upcoming
  // turn isn't Claude Native, the dispatcher silently clears the flag
  // without arming. Single-turn — never persisted to disk.
  pendingPlanModeEntry?: boolean;
}

// Phase 4 — internal queue entry. Carries attachments (preserved across
// drain since docs/CLIENT.md Fix 4) and clientMessageId (used for
// per-item cancel and queue-strip [×]). The wire `queue_update` snapshot
// re-projects to QueueEntry (content + clientMessageId + interrupt intent).
export interface QueueItem {
  interrupt?: boolean;
  pickedSkills?: Array<{ scope: 'project' | 'global'; slug: string }>;
  content: string;
  attachments?: string[];
  clientMessageId?: string;
  // docs/ARCHITECTURE.md - expanded `@`-context-refs for this
  // queued message. The echo + the wire snapshot use `content` (the raw
  // `@file:x.ts` text the operator typed); this block is appended to the
  // MODEL prompt only, when the item drains. Undefined when the message had
  // no refs. Kept separate from `content` so the transcript stays compact.
  expandedContext?: string;
}

// 2026-05-12 — per-cwd handoff serialization. Two cluster members sharing a
// cwd would otherwise race to read git state + prepend DEVLOG.md, observing
// each other's mid-handoff writes and producing duplicate / re-ordered
// DEVLOG entries. Each handoff appends to this chain; the next handoff in
// the same cwd waits for the prior promise before starting. Cleared when
// the chain tail resolves (so unused cwds don't leak Promise objects).
export interface CwdHandoffSlot {
  promise: Promise<void>;
  resolve: () => void;
  workflowId: string;
  handoffId?: string;
  startedAt: number;
  cancelled?: boolean;
}

// Extract renderable entries from a raw Claude session JSONL line. A single
// line can produce 0..N entries: assistant messages often contain a text
// block plus one or more tool_use blocks, and we want each to show up
// in chat as its own row (text as a bubble, tool_use as a compact pill).
// Returns [] for tool_result / summary / other entries that don't render.
export type SessionEntryPayload = import('@arco/shared').SessionEntryMessage['entry'];

// Plans-directory watcher. One FSWatcher per cwd; reference-counted by the
// number of in-memory workflows currently attached to a plan in that cwd.
// We watch the directory rather than individual files so creates/deletes by
// the agent are picked up too. Reconcile is debounced 200ms to coalesce the
// two writes from atomicWrite (.tmp → rename) and to ride out partial-edit
// flickers from non-atomic writers (the agent's Edit tool).
//
// The skip-flag dance keeps the operator's REST-PATCH path from
// double-broadcasting plan_attached: PATCH already broadcasts on its own,
// then the watcher fires on the .md write — we mark the planId as
// "skip-once" before writing and the watcher consumes the flag.
export interface PlansWatcher {
  watcher: FSWatcher;
  refCount: number;
  pending: Set<string>;
  timer: NodeJS.Timeout | null;
  skipNext: Set<string>;
}
