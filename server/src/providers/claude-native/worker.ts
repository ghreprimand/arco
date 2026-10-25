import { replayEventsWithTs } from '../../workflowStore.js';
import { computerToolDefinitions, executeComputerTool } from '../../voice/toolDefinitions.js';
// Phase 7a — long-lived per-workflow Claude Native worker.
//
// Lifecycle: per workflow (cached in workersByWorkflow). Holds the
// messages array and SDK client across operator turns; the agent loop
// runs in Arco's process so the Phase 5 steer-drain hook fires
// between tool-result append and the next API round-trip.
//
// Cancel: AbortController.abort() on the SDK fetch + on the per-turn
// tool-execution chain. No subprocess to killProcessTree.

import { EventEmitter } from 'events';
import { promises as fs, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import type { WorkerConfig, ServerMessage } from '@arco/shared';
import { supportsClaudeAdaptiveThinking, isClaudeModelAlias, enforcesPreservedThinking, supportsMidConversationSystemMessages, supportsMidConversationToolChanges } from '@arco/shared';
import { ensureLiveTokens, forceRefreshTokens, markClaudeAuthProblem, ClaudeNativeNoAuthError } from './oauth.js';
import { resolveTrustStatus } from '../../projectTrust.js';
import { discoverHooks, fireHooks, firstBlocking, parseHookOutput, type HookConfig } from './hooks.js';
import { checkConfigProtection, checkFactForceFirstEdit, checkPartialReadFullWrite, checkHardlineCommand } from './pretoolGuards.js';
import { evaluateGate, gateOutcome } from './gateReview.js';
import { recordPendingGate, clearPendingGate, readGateStore, hasStandingApproval, addStandingApproval } from './gateStore.js';
import { getCachedModelCapabilities, getCatalog, hasCatalogCache, resolveClaudeAliasFromCatalog } from './catalog.js';
import { filterToolResult } from './filterToolResult.js';
import { planTurnSpill, toolEvictEnabled, turnToolTokenBudget, type EvictableResult } from './toolResultEviction.js';
import { outputHash } from '../outputSignature.js';
import { resolveRateLimitWait, classifyRateLimit } from './rateLimit.js';
import { ToolLoopGuard, hashArgs, toolLoopGuardMode, describeToolLoop } from './toolLoopGuard.js';
import { filterToolDefsByPosture } from './toolPosture.js';
import { resolveFilterPack } from './filterConfigs/index.js';
import { outputStyleAddendum } from './outputStyle.js';
import { goalBlock } from '../goalBlock.js';
import { BLIND_CLUSTER_DOCTRINE } from '../../clusterAccessDoctrine.js';
import { getPeerToolDefinitions, isPeerTool, executePeerTool } from './peerTools.js';
import { registryToolDefs, parseRegistryToolName, isRegistryToolAllowed, isRegistryToolReadOnly } from './registryTools.js';
import { connectServer, type McpSession } from '../../mcp/client.js';
import { getSandboxToolDefinitions, isSandboxTool, executeSandboxTool } from './sandboxTools.js';
import { buildMessagesFromReplayEvents, replayMessagesWithResumePolicy, compactSummarySeed, type ClaudeResumeMessage } from './resumeSummary.js';
import { readMeta, setResolvedModelId } from '../../workflowMeta.js';
import { lspManager } from '../../lsp/client.js';
import { isClaudeServerToolDef, isServerToolResultType, pruneServerToolEvidenceAfterTurn, stripDanglingServerToolResults } from './retainedContext.js';
import { gzipSync } from 'node:zlib';
import {
  executeNativeTool,
  getNativeToolDefinitions,
  MAX_TOOL_OUTPUT_BYTES,
  type NativeToolContext,
  type ShellRegistry,
  type Todo,
} from './tools.js';
// Phase P0 — leaf helpers extracted to keep this file under the 2000-line cap.
import {
  buildThinkingParams,
  chooseMaxTokens,
  lookupCtx,
  shouldSendInterleavedThinkingBeta,
} from './modelParams.js';
import {
  isRecord,
  CLAUDE_CODE_SERVER_TOOLS,
  buildChatWebTools,
  buildClaudeServerTools,
  buildContextManagementEditsForRequest,
  shouldSendCompactBeta,
  summarizeCompactionIterations,
  shouldContinueNativeToolLoop,
  stripTrailingThinkingFromContent,
  orphanToolUseIds,
  fullListOrphanToolUseIds,
  buildUserMessageContent,
  describeSkippedImages,
  repairImageBlock,
  type SkippedImage,
  type ToolUseBlock,
  type AnyContentBlock,
  type ClaudeNativeToolDef,
  type Role,
  type MessageParam,
} from './contentBlocks.js';
import {
  replayMessagesFromEvents,
  mergeUsage,
  applyUsageDelta,
  truncateOutput,
  planParserAdvisories,
  projectCompactSummaryMessages,
  projectKeptTail,
  projectKeptTailByTokens,
  sleepWithSignal,
} from './workerHelpers.js';
import { buildFoldDigest } from './foldDigest.js';
import { CLAUDE_CLI_USER_AGENT } from './wireFingerprint.js';
// FABLE_51_APPEND_ONLY_PLAN.md — frozen-prefix helpers (pure; unit-tested).
import {
  BETA_MID_CONVERSATION_TOOL_CHANGES,
  BETA_SYSTEM_CLEAR_AT,
  BETA_THINKING_BINDING_CONTROLS,
  BETA_THINKING_DISPLAY_UPDATES,
  appendTextToLastUserMessage,
  buildPrefixUpdateMessage,
  buildToolChangeBlocks,
  buildTurnNoticeMessage,
  diffSystemBlocks,
  diffToolSets,
  isArcoSystemMessage,
  isPrefixFeatureRejection,
  isThinkingBindingError,
  markDeferred,
  popTrailingSystemMessages,
  removeArcoSystemMessages,
  renderSystemDelta,
  sortToolDefs,
  stripAllThinkingBlocks,
  summarizeInputTransformations,
  toolKey,
  toWireMessages,
  type SystemBlock,
  type ToolDefLike,
} from './appendOnlyPrefix.js';
import { resolveThinkingDisplay } from './modelParams.js';
import {
  SERVER_FOLD_BETA,
  activeToolKeysAfterServerFold,
  buildServerFoldRequest,
  chooseServerFoldCut,
  classifyServerFoldError,
  consumeServerFoldStream,
  countTurnStarts,
  demoteLeadingServerFoldBlock,
  hasLeadingServerFoldBlock,
  historyHasThresholdCompactionBlock,
  serverFoldMissingReason,
  serverFoldSeed,
  supportsServerFold,
  type ServerFoldFailureKind,
  type ServerFoldUsage,
} from './serverFold.js';

// Re-export the public helpers/types that previously lived in this file so
// external importers (index.ts, *.test.ts) keep their `from './worker.js'`
// paths working unchanged after the P0 carve-out.
export {
  shouldSendInterleavedThinkingBeta,
  buildContextManagementEditsForRequest,
  shouldSendCompactBeta,
  shouldContinueNativeToolLoop,
  stripTrailingThinkingFromContent,
  orphanToolUseIds,
  replayMessagesFromEvents,
};
export { adaptiveMaxTokensForModel, buildThinkingParams, chooseMaxTokens, lookupCtx } from './modelParams.js';
import { THINKING_ONLY_PLACEHOLDER } from './contentBlocks.js';
export { THINKING_ONLY_PLACEHOLDER };
export type { ToolUseBlock };

const FORCED_FIRST_BLOCK = "You are Claude Code, Anthropic's official CLI for Claude.";

// Operator-triggered in-place compaction (compactInPlace). The summarizer
// system rides behind FORCED_FIRST_BLOCK; the instruction is the trailing user
// message. Tuned to mirror Claude Code CLI's `/compact`: a dense continuation
// brief, not chatty prose. Bounded output so the summary itself stays small.
const COMPACT_SUMMARY_MAX_TOKENS = 8192;
// NATIVE_COMPACTION_PLAN Phase 2 — keep-last-N verbatim tail for compactInPlace.
// After summarizing the older prefix, the last few user/assistant messages are
// kept verbatim (projected to the clean resume shape) so the freshly-active
// working set survives the fold — the structural answer to "don't strip out the
// thing the model is working on." 6 ≈ the last ~3 user/assistant pairs, mirroring
// Ollama's keep-tail intent (ARCO_OLLAMA_COMPACT_KEEP_LAST default 10, but
// Native pairs carry more per message). Tunable via env for the smoke test and
// for operators who want a longer/shorter retained tail.
const COMPACT_KEEP_LAST_MESSAGES = (() => {
  const env = process.env.ARCO_CLAUDE_NATIVE_COMPACT_KEEP_LAST;
  if (env) {
    const n = parseInt(env, 10);
    if (Number.isFinite(n) && n >= 0 && n <= 100) return n;
  }
  return 6;
})();
const COMPACT_SUMMARIZER_SYSTEM = [
  'You are compacting the conversation above to free up context.',
  'Your summary will REPLACE the full transcript — afterwards you continue the',
  'work with only this summary as context, so it must be self-contained.',
].join(' ');
const COMPACT_SUMMARIZER_PROMPT = [
  'Summarize our entire conversation so far into a dense continuation brief that',
  'will replace the full history. Capture everything needed to keep working with',
  'no loss of momentum:',
  '',
  '- The user\'s goals and any explicit instructions, decisions, preferences,',
  '  constraints, or boundaries still in effect — preserve their exact wording',
  '  where that wording matters',
  '- Approaches considered, attempted, or set aside, and why',
  '- Key decisions made and the reasoning behind them',
  '- Current state: what is done, what is in progress, what comes next',
  '- Concrete details that are expensive to rediscover — file paths, function and',
  '  symbol names, commands, config values, IDs, error messages',
  '- Open questions, blockers, or things to verify',
  '',
  'Write it as a brief to your future self. Output ONLY the summary — no preamble,',
  'no sign-off, no "here is the summary".',
].join('\n');
// Hard cap on assistant tool-loop iterations within a single operator turn.
// CLI is unbounded; we keep a ceiling purely as a runaway-loop safety net so
// a stuck model can't burn tokens indefinitely on a multi-tab Arco. 1000 is
// well above any real workload (sweeping refactors top out in the low
// hundreds) but catches pathological loops within a few minutes. Override via
// ARCO_CLAUDE_NATIVE_MAX_TOOL_TURNS up to 10000.
const MAX_TOOL_TURNS = (() => {
  const env = process.env.ARCO_CLAUDE_NATIVE_MAX_TOOL_TURNS;
  if (env) {
    const n = parseInt(env, 10);
    if (Number.isFinite(n) && n > 0 && n <= 10000) return n;
  }
  return 1000;
})();
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [15_000, 30_000, 60_000];
const AUTH_FAILURE_LOUD_THRESHOLD = 3;

// Opus-5 plan Phase 3 — Anthropic's structured refusal detail. Present on the
// response only when stop_reason === 'refusal', and even then can be null;
// `explanation` is not guaranteed. Never regex-detect refusals from text —
// stop_reason is the structured ground truth (CLAUDE.md § Non-goals).
interface StopDetails {
  type?: string;
  category?: string | null;
  explanation?: string | null;
}

interface WorkerOpts {
  workflowId: string;
  config: WorkerConfig;
  // Phase 7b — set true on a Task-spawned child to remove `Task` from its
  // tool registry (depth-1 cap). Default false.
  taskDisabled?: boolean;
}

// Phase 7b — Task tool spawns a child workflow whose final reply lands as
// the Task tool result. The worker delegates the actual spawn / lifecycle
// management to a server-level handler (registered via setTaskHandler) so
// the worker stays free of WorkflowState / WS knowledge.
export interface TaskSpawnArgs {
  parentWorkflowId: string;
  description: string;
  prompt: string;
  subagentType?: string;
  model?: string;
}
export interface TaskSpawnHandle {
  taskId: string;
  childWorkflowId: string;
  // Resolves with the child's final assistant text when the child settles.
  // Rejects with AbortError when cancelled.
  finalText: Promise<string>;
  // Read the child's accumulated text (cap 64 KB tail). settled flag tells
  // TaskOutput whether to label `[in-flight]` or `[settled]`.
  read: () => { output: string; settled: boolean };
  cancel: () => void;
}
export type TaskSpawnHandler = (args: TaskSpawnArgs) => Promise<TaskSpawnHandle>;

// Phase 7b — plan-mode broadcast hook. Server wires this to plan_set /
// plan_exited workflow-scoped broadcasts (and creates / attaches a real
// plan file under .arco/plans/ so the PLAN tab renders the body).
export interface PlanBroadcast {
  set: (plan: string) => Promise<void>;
  exited: (summary: string | undefined) => Promise<void>;
}

interface PendingQuestion {
  id: string;
  // R1 (REMOTE_CLUSTER_CONTROL_PLAN.md §4.1) — the question text + options are
  // kept on the park so the remote console can render the decision without
  // parsing the [ASK:…] system_notice back out of events.jsonl.
  text: string;
  options?: string[];
  resolve: (reply: string) => void;
  reject: (err: Error) => void;
}

// DEBAG (docs/DEBAG_PLAN.md) — a parked review gate awaiting an operator
// decision. Keyed by the tool_use id. Mirrors PendingQuestion's resolve/reject
// shape; the resolve carries the decision and (sub-phase 3) the edited args.
interface PendingGate {
  gateId: string;
  toolName: string;
  // R1 — decision context carried on the live park for the remote console
  // (mirrors the gate_required broadcast; argsPreview is bounded, not the
  // full proposedArgs — those stay desktop-only).
  category: string;
  reason: string;
  argsPreview: string;
  resolve: (r: { decision: 'approve' | 'reject'; finalArgs?: Record<string, unknown>; remember?: boolean }) => void;
  reject: (err: Error) => void;
}

export class ClaudeNativeWorker extends EventEmitter {
  readonly workflowId: string;
  private config: WorkerConfig;
  private client: Anthropic | null = null;
  // The Anthropic SDK pins the OAuth token at construction time. When the
  // operator runs RE-LOGIN against a long-lived tab, new tokens land on
  // disk but the cached client still holds the stale token, so every
  // subsequent API call 401s. Tracking the obtainedAt of the tokens used
  // to build the current client lets ensureStarted() detect a mismatch
  // against on-disk tokens and rebuild the client transparently.
  private clientTokenObtainedAt: number | null = null;
  private messages: MessageParam[] = [];
  private hooks: HookConfig = { byEvent: {} };
  private replayed = false;
  private todos: Todo[] = [];
  // H54 — cache-stable workspace facts block (detected verify/build/test cmds +
  // git branch). Probed ONCE per cwd in ensureStarted and cached; included in
  // every buildSystemBlocks. No per-turn volatility ⇒ no prompt-cache break.
  private projectFactsBlock: string | null = null;
  private projectFacts: import('./workspaceFacts.js').ProjectFacts | null = null;
  private factsProbedForCwd: string | null = null;
  private authFailureCount = 0;
  // A1 (REMOTE_CLUSTER_CONTROL_PLAN.md §10.2) — one forced token refresh per
  // turn on a 401. Anthropic revokes access tokens ahead of local expiresAt,
  // so the first 401 tries the refresh chain before surfacing [AUTH:claude];
  // the flag stops a dead chain from looping refresh attempts.
  private forcedAuthRefreshThisTurn = false;
  // Anthropic echoes the served model on every response. Re-emit init
  // with this once per worker so the chat header upgrades from the
  // requested ID to the canonical one served. Subsequent turns suppressed.
  private echoedModelEmitted: string | null = null;
  // Opus-5 plan Phase 2 — the concrete model Anthropic served, used for
  // CAPABILITY lookups only (thinking params, max_tokens, ctx window, catalog
  // ctx-management gating). The REQUEST body keeps config.model so an alias
  // tab stays auto-tracking. `servedModelFor` pins the resolution to the
  // config.model it was observed under, so a live model swap in CONFIG
  // can't be overridden by a stale resolution — capModel() falls back to
  // config.model until the next echo re-resolves.
  // Last broadcast `thinking_dropped_by_api` detail — dedupes the sticky
  // per-request notice (see message_start). Null = no drop last round.
  private lastThinkingDropKey: string | null = null;
  private servedModel: string | null = null;
  private servedModelFor: string | null = null;
  // One catalog warm attempt per worker for alias tabs (see ensureStarted).
  private catalogWarmAttempted = false;
  // Context-management capability lookup is synchronous at request-build time
  // so beta headers and body fields cannot diverge. Warm the catalog right
  // before messages.create; force-refresh at most once per unknown model per
  // worker so a cold/stale cache does not silently disable Claude-Code parity.
  private forcedCatalogRefreshModels = new Set<string>();

  // Per-turn state.
  private inFlight: AbortController | null = null;
  // Text streamed by the CURRENT streamOneRound attempt. A mid-stream
  // overload retry re-generates the whole round, so this partial is retracted
  // (`text_discard`) — otherwise the adapter's _output persisted it followed
  // by the full retry (duplicated text in primary_text).
  private attemptStreamedChars = 0;
  // Per-turn cancel latch. cancel() only aborts inFlight/toolAbort, which are
  // null while ensureStarted() / MCP reconcile / UserPromptSubmit run; the
  // first streamOneRound then made a fresh, un-aborted controller, so a turn
  // cancelled during startup still ran (spent tokens, could edit files).
  private cancelRequested = false;
  private toolAbort: AbortController | null = null;
  private shells: ShellRegistry = {
    byId: new Map(),
    mintId: () => `sh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
  };
  private readSet = new Set<string>();
  // H62 — paths Read with offset/limit this turn (partial reads). A later
  // full-file Write to one warns. Reset per turn alongside readSet.
  private partialReadSet = new Set<string>();
  // H9 — per-turn in-turn tool-loop guard. Reset at the top of runTurn; fed
  // after every dispatched tool call.
  private toolLoopGuard = new ToolLoopGuard();
  private planMode = false;
  // FABLE_51_APPEND_ONLY_PLAN.md §1 — frozen request prefix. Captured on the
  // worker's first messages.create and only ever EXTENDED afterwards; every
  // later change to what buildSystemBlocks()/buildToolDefs() would produce is
  // delivered as an appended `role: 'system'` message instead. `undefined`
  // = not frozen yet (fresh worker, or reset by Fold / Compact / replay).
  private frozenSystem: SystemBlock[] | undefined;
  private frozenTools: ToolDefLike[] | undefined;
  // The system-block set the model has been TOLD about (frozen + every delta
  // already appended). Diffs run against this, not frozenSystem — otherwise a
  // retried request (529 → backoff → same round) would append the same delta
  // twice. Reset together with the freeze.
  private deliveredSystem: SystemBlock[] | undefined;
  // Keys (appendOnlyPrefix.toolKey) currently VISIBLE to the model. The wire
  // array can hold more: deferred declarations not yet surfaced, and tools a
  // tool_removal hid.
  private activeToolKeys = new Set<string>();
  // Count of leading messages the API has already accepted verbatim. Pre-
  // request scrubs (empty blocks, trailing thinking) only walk the tail past
  // this index — anything before it was validated by a successful request and
  // rewriting it would be a prefix edit.
  private sentThrough = 0;
  // Set when Anthropic rejected one of the append-only wire features (org not
  // allowlisted for a beta, model turned out not to support role:'system').
  // Falls back to rebuild-per-request for the rest of the worker's life.
  private prefixThawed = false;
  // One-shot guard for the binding-400 strip-and-retry recovery.
  private bindingStripUsed = false;
  // Phase 7b — Task-disabled flag for child workers (depth-1 cap). Set
  // when constructing the child via WorkerOpts.taskDisabled.
  private taskDisabled = false;
  // External hook for broadcasting todo changes (worker → workflow events).
  // Set on construction and never mutated.
  private todosBroadcast: (todos: Todo[]) => void = () => { /* no-op */ };
  // Phase 7b hooks. Wired by ClaudeNativeProvider after construction.
  private planBroadcast: PlanBroadcast | null = null;
  private taskHandler: TaskSpawnHandler | null = null;
  // EFFICIENCY_PLAN.md Phase B/D — generic workflow-scoped event sink for
  // hook_rewrote_input / tool_gate_triggered / ctx_action. Wired by
  // ClaudeNativeProvider; no-op when absent (e.g. tests).
  private workflowEventBroadcast: (msg: ServerMessage) => void = () => { /* no-op */ };
  // Cluster-scoped event broadcaster. Wired by ClaudeNativeProvider when
  // the worker belongs to a cluster (config.clusterId set). Used only by
  // the `cluster_plan_tick` peer tool today; defaults to a no-op for non-
  // cluster workers so the tool falls back to the workflow-scoped sink.
  private clusterEventBroadcast: (msg: ServerMessage) => void = () => { /* no-op */ };
  // EFFICIENCY_PLAN.md Phase 6b.2 — running count of tool calls since the
  // last threshold emission. Increments per dispatched tool; resets when
  // the threshold is crossed (so the next emission fires after the
  // configured interval, not on every tool call past the first threshold).
  // Phase D §8b: also forwarded on every `tool_use` event so the composer
  // chip can read the worker-authoritative value instead of recounting
  // events. Worker rebuild (handoff_complete → disposeProviderResources)
  // is the implicit reset on the handoff path.
  private toolCallCountSinceCompact = 0;
  // EFFICIENCY_PLAN.md Phase D §8a — paths edited this turn. Reset at the
  // top of `runTurn` so each operator turn re-opens the fact-force gate.
  // `checkFactForceFirstEdit` populates this set during dispatch.
  private filesEditedThisTurn = new Set<string>();
  // EFFICIENCY_PLAN.md Phase C — per-turn id used as the gzipped raw-tools
  // artifact filename prefix (`<turnId>-<toolUseId>.txt.gz`). Set at the
  // top of `runTurn`; falls back to 0 for any (defensive) dispatch outside
  // a turn so the filename stays well-formed.
  private currentTurnId = 0;
  // Pending AskUserQuestion. Only one open question per worker at a time;
  // a second AskUserQuestion call returns an [error] tool result without
  // displacing the existing wait.
  private pendingQuestion: PendingQuestion | null = null;
  // DEBAG (docs/DEBAG_PLAN.md) — parked review gates by tool_use id. Multiple
  // can coexist in principle, but sequential tool dispatch means only one is
  // ever parked at a time (the for-loop suspends on the await). The durable
  // record in events.jsonl is the source of truth; this Map is the live handle.
  private pendingGates: Map<string, PendingGate> = new Map();
  // Active Task children. Map entry dropped on dispose; on parent cancel,
  // each child's cancel() runs.
  private tasksByTaskId = new Map<string, TaskSpawnHandle>();
  // ARCO_OPS_PLAN.md §E1 (E1-Native) — open MCP sessions for this worker's
  // operator-allowed registry servers, keyed by `ResolvedMcpServer.key`
  // (`reg-<id8>`). Opened lazily and reconciled at turn start
  // (reconcileMcpSessions): open newly-allowed servers, close newly-removed.
  // Sessions persist across turns (caching is fine; correctness over micro-opt)
  // and MUST be closed on dispose — a leaked stdio child outlives the worker
  // otherwise (load-bearing, docs/GOTCHAS.md § Claude Native transport).
  private mcpSessions = new Map<string, McpSession>();

  constructor(opts: WorkerOpts) {
    super();
    this.workflowId = opts.workflowId;
    this.config = opts.config;
    this.taskDisabled = opts.taskDisabled === true;
  }

  setTodosBroadcast(fn: (todos: Todo[]) => void): void {
    this.todosBroadcast = fn;
  }

  setPlanBroadcast(fn: PlanBroadcast): void {
    this.planBroadcast = fn;
  }

  setTaskHandler(fn: TaskSpawnHandler): void {
    this.taskHandler = fn;
  }

  setWorkflowEventBroadcast(fn: (msg: ServerMessage) => void): void {
    this.workflowEventBroadcast = fn;
  }

  setClusterEventBroadcast(fn: (msg: ServerMessage) => void): void {
    this.clusterEventBroadcast = fn;
  }

  // EFFICIENCY_PLAN.md Phase 6b.2 — fire a ctx_action {trigger:
  // "auto-threshold"} whenever the tool-call counter crosses one of the
  // configured thresholds. "conservative" = first at 75 then every 50;
  // "aggressive" = first at 50 then every 25. Counter resets to 0 each
  // time so the next event fires after the next interval, not on every
  // call past the first threshold. Operator opt-in via
  // WorkflowConfig.efficiencyAutoCompact; default off.
  private maybeEmitAutoThreshold(): void {
    const mode = this.config.efficiencyAutoCompact;
    if (!mode || mode === 'off') return;
    const first = mode === 'aggressive' ? 50 : 75;
    const interval = mode === 'aggressive' ? 25 : 50;
    const n = this.toolCallCountSinceCompact;
    const past = n - first;
    if (n < first) return;
    if (past !== 0 && past % interval !== 0) return;
    this.workflowEventBroadcast({
      type: 'ctx_action',
      workflowId: this.workflowId,
      action: 'compact',
      trigger: 'auto-threshold',
      detail: `${n} tool calls since session/handoff (${mode} threshold)`,
    });
    this.toolCallCountSinceCompact = 0;
    // Phase D §8b — surface the reset so the chip flips to 0 on the next
    // paint. Without this the chip would stay at `n` until the next tool
    // dispatch increments it back to 1, masking the auto-threshold event.
    this.workflowEventBroadcast({
      type: 'primary_tool_counter',
      workflowId: this.workflowId,
      toolCallsSinceCompact: 0,
    });
  }

  // EFFICIENCY_PLAN.md Phase C — gzip a tool's pre-filter raw output to
  // `<cwd>/.arco/workflows/<wfId>/artifacts/raw-tools/<turnId>-<toolUseId>.txt.gz`
  // so the operator can recover what the model didn't see. Returns the
  // workspace-relative path (suitable for the `tool_filtered.rawArtifactPath`
  // wire field). Mkdir-recursive so first-call-of-the-workflow doesn't ENOENT.
  private async persistRawArtifact(toolUseId: string, raw: string): Promise<string> {
    const cwd = this.config.persistenceCwd ?? this.config.cwd ?? process.cwd();
    const dir = join(cwd, '.arco', 'workflows', this.workflowId, 'artifacts', 'raw-tools');
    await fs.mkdir(dir, { recursive: true });
    const turnId = this.currentTurnId.toString(36);
    const safeToolUseId = toolUseId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
    const filename = `${turnId}-${safeToolUseId}.txt.gz`;
    const absPath = join(dir, filename);
    await fs.writeFile(absPath, gzipSync(Buffer.from(raw, 'utf8')));
    return `.arco/workflows/${this.workflowId}/artifacts/raw-tools/${filename}`;
  }

  // §2.2 — per-turn aggregate tool-result eviction. Operator-armed (off by
  // default) because, like the disabled clear_tool_uses beta, it can spill a
  // result the model still needs on the next round — so it only runs when
  // ARCO_TOOL_EVICT is set. Mutates the just-gathered `toolResults` batch in
  // place: the planner picks the largest results to replace with a semantic
  // 1-liner (largest-first) until the batch is back under the turn budget; raw
  // output is gzipped to artifacts/raw-tools/ and a tool_evicted event carries
  // the byte deltas + artifact path. Cache-safe: this batch hasn't been sent
  // yet, so no cache breakpoint exists over it. The §2.1 Fold reuses the same
  // toolResultEviction module for the cross-turn tail eviction.
  private async maybeSpillTurnResults(
    contentBlocks: AnyContentBlock[],
    toolResults: Array<{ type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }>,
  ): Promise<void> {
    if (!toolEvictEnabled()) return;
    if (toolResults.length === 0) return;
    // Pair each result with its tool_use (name + input) for the 1-liner.
    const meta = new Map<string, { name: string; input: string }>();
    for (const b of contentBlocks) {
      if ((b as { type?: string }).type !== 'tool_use') continue;
      const tu = b as unknown as { id: string; name: string; input: unknown };
      let input = '';
      try { input = JSON.stringify(tu.input ?? {}); } catch { input = ''; }
      meta.set(tu.id, { name: tu.name, input });
    }
    const items: EvictableResult[] = toolResults.map((tr) => ({
      toolUseId: tr.tool_use_id,
      toolName: meta.get(tr.tool_use_id)?.name ?? '',
      inputJson: meta.get(tr.tool_use_id)?.input,
      content: tr.content,
      isError: tr.is_error,
    }));
    const plan = planTurnSpill(items, turnToolTokenBudget());
    if (plan.spill.length === 0) return;
    const byId = new Map(toolResults.map((tr) => [tr.tool_use_id, tr]));
    for (const d of plan.spill) {
      const tr = byId.get(d.toolUseId);
      if (!tr) continue;
      const originalBytes = Buffer.byteLength(tr.content, 'utf8');
      let rawArtifactPath: string | undefined;
      try {
        rawArtifactPath = await this.persistRawArtifact(d.toolUseId, tr.content);
      } catch (err) {
        console.warn(`[claude-native:${this.workflowId.slice(0, 8)}] tool-evict raw artifact write failed:`, err);
      }
      tr.content = d.summary;
      this.workflowEventBroadcast({
        type: 'tool_evicted',
        workflowId: this.workflowId,
        toolUseId: d.toolUseId,
        toolName: meta.get(d.toolUseId)?.name ?? '',
        originalBytes,
        filteredBytes: Buffer.byteLength(d.summary, 'utf8'),
        ...(rawArtifactPath ? { rawArtifactPath } : {}),
      });
    }
    console.log(
      `[claude-native:${this.workflowId.slice(0, 8)}] tool-evict: spilled ${plan.spill.length}/${toolResults.length} ` +
      `result(s), ~${plan.savedTokens} tokens reclaimed (budget ${turnToolTokenBudget()})`,
    );
  }

  private emitToolActivity(
    block: ToolUseBlock,
    input: unknown,
    status: 'started' | 'completed' | 'failed',
    output?: string,
  ): void {
    const payload: {
      id: string;
      name: string;
      input: string;
      status: 'started' | 'completed' | 'failed';
      provider: 'claude';
      output?: string;
      outputHash?: string;
    } = {
      id: block.id,
      name: block.name,
      input: typeof input === 'string' ? input : JSON.stringify(input ?? {}),
      status,
      provider: 'claude',
    };
    if (output) {
      payload.output = output.length > 4096
        ? `${output.slice(0, 4096)}\n\n[activity preview truncated]`
        : output;
      // Watchdog instrumentation — hash the FULL output (not the truncated
      // preview) so error-persistence detection compares the whole result.
      payload.outputHash = outputHash(output);
    }
    this.emit('tool_use', payload);
  }

  // H9 — feed one just-dispatched tool call to the in-turn loop guard. Emits a
  // tool_loop_warning event + a system_notice on the FIRST trip for a given
  // (tool, argsHash) this turn. Returns true only when the operator has armed
  // hard-stop (ARCO_TOOL_LOOP_GUARD=stop) and the turn's tool loop should be
  // aborted. Default ('warn') always returns false — visible, non-blocking.
  private checkToolLoop(block: ToolUseBlock, result: { text: string; isError: boolean }): boolean {
    const mode = toolLoopGuardMode();
    if (mode === 'off') return false;
    const v = this.toolLoopGuard.record(block.name, hashArgs(block.input), outputHash(result.text));
    if (!v.firstTrip || v.signal === 'none') return false;
    const stop = mode === 'stop';
    this.workflowEventBroadcast({
      type: 'tool_loop_warning',
      workflowId: this.workflowId,
      toolUseId: block.id,
      toolName: v.toolName,
      argsHash: v.argsHash,
      signal: v.signal,
      repeatCount: v.repeatCount,
      sameOutputCount: v.sameOutputCount,
      mode: stop ? 'stop' : 'warn',
    });
    this.emit('system_notice', describeToolLoop(v, mode));
    return stop;
  }

  // R1 (REMOTE_CLUSTER_CONTROL_PLAN.md §4.1) — read-only snapshot of parked
  // interactions for the hub link's workflow summary. Never exposes resolve
  // handles; args stay a bounded preview. Live-worker view only — a gate
  // orphaned by a server restart lives in the sidecar (gateStore), not here,
  // and is resolvable via the gate_reply orphan path, just not listed.
  getPendingInteractions(): {
    question: { questionId: string; text: string } | null;
    gates: Array<{ gateId: string; toolName: string; category: string; reason: string; argsPreview: string }>;
  } {
    const q = this.pendingQuestion;
    return {
      question: q
        ? {
            questionId: q.id,
            text: q.options?.length ? `${q.text}\nOptions: ${q.options.join(' | ')}` : q.text,
          }
        : null,
      gates: [...this.pendingGates.values()].map((g) => ({
        gateId: g.gateId,
        toolName: g.toolName,
        category: g.category,
        reason: g.reason,
        argsPreview: g.argsPreview,
      })),
    };
  }

  // Server's WS handler routes ask_user_question_reply here.
  resolveQuestion(questionId: string, reply: string): boolean {
    const pending = this.pendingQuestion;
    if (!pending || pending.id !== questionId) return false;
    this.pendingQuestion = null;
    pending.resolve(reply);
    return true;
  }

  // DEBAG (docs/DEBAG_PLAN.md) — server's WS handler routes gate_reply here.
  // Returns false if no matching gate is parked (stale / already-resolved
  // reply), so the caller can log a drop instead of silently succeeding.
  resolveGate(
    gateId: string,
    decision: 'approve' | 'reject',
    finalArgs?: Record<string, unknown>,
    remember?: boolean,
  ): boolean {
    const pending = this.pendingGates.get(gateId);
    if (!pending) return false;
    this.pendingGates.delete(gateId);
    pending.resolve({ decision, finalArgs, remember });
    return true;
  }

  // DEBAG sub-phase 5 — broadcast the current standing-approval set so the
  // CONFIG REVIEW SAFE-MODE list can render it with revoke controls.
  private async broadcastStandingApprovals(cwd: string): Promise<void> {
    const store = await readGateStore(cwd, this.workflowId).catch(() => null);
    this.workflowEventBroadcast({
      type: 'gate_standing',
      workflowId: this.workflowId,
      approvals: (store?.standing ?? []).map((s) => ({
        signature: s.signature,
        toolName: s.toolName,
        approvedAt: s.approvedAt,
        sample: s.sample,
      })),
    });
  }

  updateConfig(next: WorkerConfig): void {
    // Refresh per-turn-variable fields. Stable identity (cwd, model)
    // shouldn't change without a worker tear-down, but
    // appendSystemPrompt rotates per turn (skills manifest, transcript)
    // and effort/model can be live-edited.
    this.config = next;
  }

  // Pre-seed the conversation history before the first runTurn fires.
  // Used by exportContext.ts (Spawn original-worker) to hydrate a fresh
  // child worker with the parent workflow's messages so the reflection
  // turn carries full context. Marks `replayed=true` so ensureStarted
  // doesn't overwrite the seed by reading the child's own (empty) events.
  seedMessages(messages: MessageParam[]): void {
    if (this.replayed) return;
    this.messages = messages.map((m) => ({ ...m }));
    this.resetPrefixFreeze('seed');
    this.replayed = true;
  }

  // ARCO_TEST-only seam for scripts/smoke/native-auto-compact.ts. Force-seeds
  // the in-memory history (even on an already-replayed worker) and marks the
  // worker started so compactInPlace doesn't try to spin up a real Anthropic
  // client. Combined with ARCO_TEST_COMPACT_CANNED_SUMMARY (read in
  // generateCompactSummary), this lets the smoke exercise the REAL auto-compact
  // trigger + keep-tail + native_compacted emission with zero API spend. Throws
  // outside ARCO_TEST so it can never be reached in production.
  __debugSeedForCompactProbe(messages: MessageParam[]): void {
    if (process.env.ARCO_TEST !== '1') {
      throw new Error('__debugSeedForCompactProbe is ARCO_TEST-only');
    }
    this.messages = messages.map((m) => ({ ...m }));
    this.resetPrefixFreeze('seed');
    this.replayed = true;
    this.compactProbeMode = true;
    // Mark "started" so compactInPlace's ensureStarted no-ops against a probe
    // client. The canned-summary path means the client is never actually used.
    if (!this.client) {
      this.client = { messages: { create: async () => { throw new Error('probe client must not call the API'); } } } as unknown as Anthropic;
      this.clientTokenObtainedAt = -1;
    }
  }
  // Set by __debugSeedForCompactProbe; makes ensureStarted/generateCompactSummary
  // short-circuit so the smoke never touches OAuth or the Anthropic API.
  private compactProbeMode = false;

  // Operator-triggered in-place compaction — the in-Arco equivalent of
  // `/compact` in Claude Code CLI. Runs ONE summarization round against the
  // worker's own in-memory history, then REPLACES `messages[]` with a compact
  // summary seed and emits a persisted `native_compacted` marker so the
  // compaction survives restart (replay re-seeds the summary; see
  // resumeSummary.ts). Far cheaper than a handoff: same worker, same tab, no
  // portable doc, no fresh-worker spawn, no transcript re-render — one focused
  // round-trip instead of a full reflection turn plus a Write.
  //
  // Idle-only (the WS handler gates on !wf.busy). Operator-initiated and
  // context-REPLACING (not an autonomous in-loop second summarizer), so it sits
  // in the same eligibility class as Handoff under the four-question test.
  async compactInPlace(): Promise<{ ok: boolean; error?: string; foldedTurns?: number }> {
    try {
      await this.ensureStarted();
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (!this.client) return { ok: false, error: 'worker not started' };
    if (this.inFlight && !this.inFlight.signal.aborted) {
      return { ok: false, error: 'a turn is in flight — wait for it to finish' };
    }
    // Count operator turns currently in history (a rough "folded N turns" for
    // the notice). Each user message is one turn boundary.
    if (this.messages.length === 0) {
      return { ok: false, error: 'nothing to compact yet' };
    }
    // A prior server Fold's signed block → plain summary text (history is
    // being replaced anyway; the prefix freeze resets below).
    demoteLeadingServerFoldBlock(this.messages, (t) => compactSummarySeed(t) as MessageParam[]);
    const foldedTurns = this.messages.filter((m) => m.role === 'user').length;
    // Defense-in-depth: compact rides the same Anthropic constraints as a
    // normal round. A cancelled/interrupted tool loop can leave a trailing
    // assistant(tool_use) with no user(tool_result); normal turns repair that
    // before appending the operator prompt, and compact must do the same before
    // it asks the summarizer to read history.
    const pruned = this.pruneOrphanToolUse();
    if (pruned.droppedAssistantMessages > 0) {
      this.workflowEventBroadcast({
        type: 'ctx_action',
        workflowId: this.workflowId,
        action: 'prune_orphan_tool_use',
        trigger: 'recovery',
        detail: `dropped ${pruned.droppedAssistantMessages} orphan assistant message(s) before compact; unpaired tool_use ids: ${pruned.droppedIds.join(', ')}`,
      });
    }
    // The summarization request also rides the same Anthropic constraints as a
    // normal round (no assistant message ending in a thinking block, no empty
    // text blocks).
    this.scrubEmptyTextContent();
    this.stripTrailingThinkingBlocks();

    // NATIVE_COMPACTION_PLAN Phase 2 — keep the last-N messages verbatim. Project
    // the tail to the clean resume shape (so replay round-trips it byte-for-byte
    // via the SAME compactSummarySeed) and summarize only the OLDER prefix. The
    // prefix is everything before the projected tail; if the projection kept K
    // messages, summarize messages[0 .. len-K). When the whole history fits in
    // the keep-tail there is no older prefix to summarize — fall back to
    // summarizing everything so we still produce a marker (keptTail then empty).
    const keptTail = projectKeptTail(this.messages, COMPACT_KEEP_LAST_MESSAGES);
    const rawPrefix = keptTail.length > 0 && keptTail.length < this.messages.length
      ? this.messages.slice(0, this.messages.length - keptTail.length)
      : this.messages;
    const prefix = projectCompactSummaryMessages(rawPrefix) as MessageParam[];
    const tailForSeed = rawPrefix.length === this.messages.length ? [] : keptTail;
    // NATIVE_COMPACTION_PLAN Phase 3 — fire the pre-compaction marker BEFORE the
    // slow summarization round so the client can flip its "Compacting…" takeover
    // immediately. Fires once here for BOTH the manual COMPACT button and the
    // Phase 2 between-turn auto path (both reach this method). Persisted to
    // events.jsonl; the paired native_compacted (success) or the caller's
    // failure system_notice clears the takeover so it can't get stuck on.
    this.workflowEventBroadcast({
      type: 'native_compacting',
      workflowId: this.workflowId,
      foldedTurns,
    });
    let summary: string;
    try {
      summary = await this.generateCompactSummary(prefix);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (!summary.trim()) return { ok: false, error: 'summary came back empty' };
    // Replace history with the summary seed + kept tail (same shape + same helper
    // resume uses, so a replayed worker lands byte-identical) and reset the
    // auto-compact tool counter — the slate is clean.
    this.messages = compactSummarySeed(summary, tailForSeed) as MessageParam[];
    this.resetPrefixFreeze('compact');
    this.toolCallCountSinceCompact = 0;
    this.readSet.clear();
    this.partialReadSet.clear();
    // Persist the marker (load-bearing for replay) + reset the composer's
    // tool-count chip. `keptTail` rides the event so replay re-appends the SAME
    // verbatim tail via compactSummarySeed.
    this.workflowEventBroadcast({
      type: 'native_compacted',
      workflowId: this.workflowId,
      summary,
      foldedTurns,
      ...(tailForSeed.length > 0 ? { keptTail: tailForSeed } : {}),
    });
    this.workflowEventBroadcast({
      type: 'primary_tool_counter',
      workflowId: this.workflowId,
      toolCallsSinceCompact: 0,
    });
    return { ok: true, foldedTurns };
  }

  // §2.1 — Fold: a deterministic, instant, in-place trim. Unlike compactInPlace
  // (one LLM summarization round) the Fold builds the summary DETERMINISTICALLY
  // from the folded prefix + live todos (no model call, no spend, no latency),
  // keeps a TOKEN-BUDGET verbatim tail (vs compact's fixed keep-last-N), and
  // continues the SAME session. It rides the proven native-compact replay rails:
  // messages[] is replaced with compactSummarySeed(digest, keptTail) and a
  // PERSISTED context_folded marker re-seeds the SAME thing on restart, so the
  // Fold survives a server restart byte-identically (the load-bearing gotcha).
  //
  // Operator-initiated (manual Fold button) or operator-armed (auto-fold
  // threshold) + deterministic + visible (context_folded byte-delta event) +
  // reversible (events.jsonl retains the full transcript) ⇒ passes the
  // four-question test, same eligibility class as Handoff/compact.
  async foldInPlace(opts?: { tailTokenBudget?: number; trigger?: 'operator' | 'auto' }): Promise<{ ok: boolean; error?: string; foldedTurns?: number; byteDelta?: number }> {
    if (this.inFlight && !this.inFlight.signal.aborted) {
      return { ok: false, error: 'a turn is in flight — wait for it to finish' };
    }
    if (this.messages.length === 0) {
      return { ok: false, error: 'nothing to fold yet' };
    }
    const trigger = opts?.trigger ?? 'operator';
    demoteLeadingServerFoldBlock(this.messages, (t) => compactSummarySeed(t) as MessageParam[]);
    // Same Anthropic-shape defenses compactInPlace runs before reshaping history.
    const pruned = this.pruneOrphanToolUse();
    if (pruned.droppedAssistantMessages > 0) {
      this.workflowEventBroadcast({
        type: 'ctx_action',
        workflowId: this.workflowId,
        action: 'prune_orphan_tool_use',
        trigger: 'recovery',
        detail: `dropped ${pruned.droppedAssistantMessages} orphan assistant message(s) before fold; unpaired tool_use ids: ${pruned.droppedIds.join(', ')}`,
      });
    }
    this.scrubEmptyTextContent();
    this.stripTrailingThinkingBlocks();

    const foldedTurns = this.messages.filter((m) => m.role === 'user').length;
    const originalBytes = this.messages.reduce((a, m) => a + Buffer.byteLength(JSON.stringify(m.content ?? ''), 'utf8'), 0);

    // Token-budget tail (~20% of the model window by default). Mirror compact's
    // prefix/tail split: the digest summarizes the older prefix, the tail is
    // kept verbatim. keptTail is the projected clean shape both live + replay
    // feed to compactSummarySeed → byte-identical.
    const win = lookupCtx(this.capModel()) ?? 200_000;
    const tailTokenBudget = opts?.tailTokenBudget ?? Math.round(win * 0.2);
    const keptTail = projectKeptTailByTokens(this.messages, tailTokenBudget);
    const rawPrefix = keptTail.length > 0 && keptTail.length < this.messages.length
      ? this.messages.slice(0, this.messages.length - keptTail.length)
      : this.messages;
    const tailForSeed = rawPrefix.length === this.messages.length ? [] : keptTail;

    const digest = buildFoldDigest(
      rawPrefix as Array<{ role: string; content: unknown }>,
      this.todos,
    );
    if (!digest.trim()) return { ok: false, error: 'fold digest came back empty' };

    const newMessages = compactSummarySeed(digest, tailForSeed) as MessageParam[];
    // §2.1 delta 1 — orphan-free guard across the FULL new list. The clean
    // reseed shape carries no tool blocks, so this is a no-op; it's defense-in-
    // depth (and surfaces a regression loudly) per the 25bffd1 wedge class.
    const orphans = fullListOrphanToolUseIds(newMessages as Array<{ role?: string; content?: unknown }>);
    if (orphans.length > 0) {
      console.warn(`[claude-native:${this.workflowId.slice(0, 8)}] fold produced ${orphans.length} orphan tool_use id(s) — aborting fold to avoid wedging: ${orphans.join(', ')}`);
      return { ok: false, error: `fold would orphan ${orphans.length} tool_use block(s); skipped` };
    }

    const foldedBytes = newMessages.reduce((a, m) => a + Buffer.byteLength(JSON.stringify(m.content ?? ''), 'utf8'), 0);
    const byteDelta = originalBytes - foldedBytes;

    this.messages = newMessages;

    this.resetPrefixFreeze('fold');
    this.toolCallCountSinceCompact = 0;
    this.readSet.clear();
    this.partialReadSet.clear();

    // PERSISTED marker — load-bearing on replay (re-seeds digest + tail via the
    // SAME compactSummarySeed). Carries byte deltas for the operator notice +
    // the §2.1 delta-2 anti-thrash counter.
    this.workflowEventBroadcast({
      type: 'context_folded',
      workflowId: this.workflowId,
      summary: digest,
      foldedTurns,
      trigger,
      originalBytes,
      foldedBytes,
      byteDelta,
      ...(tailForSeed.length > 0 ? { keptTail: tailForSeed } : {}),
    });
    this.workflowEventBroadcast({
      type: 'primary_tool_counter',
      workflowId: this.workflowId,
      toolCallsSinceCompact: 0,
    });
    return { ok: true, foldedTurns, byteDelta };
  }

  // Server Fold — ONE on-demand compaction call (`compact-2026-09-04`,
  // serverFold.ts). The signed block replaces the older turns; the last
  // SERVER_FOLD_KEEP_TURNS turns stay VERBATIM (thinking included). Unlike
  // Fold/compact this does NOT reset the prefix freeze when turns are kept:
  // kept thinking stays valid only while system + tools match the requests
  // that produced it, which is exactly what the freeze guarantees. Deltas that
  // lived in the summarized range are restated on the next request instead.
  //
  // Returns `fallback` on every failure so the caller runs the deterministic
  // Fold (fence B: never fail closed). History is untouched on failure.
  async serverFoldInPlace(): Promise<{
    ok: boolean;
    error?: string;
    fallback?: ServerFoldFailureKind;
    foldedTurns?: number;
    keptTurns?: number;
    byteDelta?: number;
    usage?: ServerFoldUsage;
  }> {
    try {
      await this.ensureStarted();
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), fallback: 'failed' };
    }
    if (!this.client) return { ok: false, error: 'worker not started', fallback: 'failed' };
    if (this.inFlight && !this.inFlight.signal.aborted) {
      return { ok: false, error: 'a turn is in flight — wait for it to finish' };
    }
    if (this.messages.length === 0) return { ok: false, error: 'nothing to fold yet' };
    const model = this.capModel();
    if (!supportsServerFold(model)) {
      return { ok: false, error: `${model} does not support on-demand compaction`, fallback: 'unsupported' };
    }
    // Same Anthropic-shape defenses as compact/fold. The summarization call
    // rejects an assistant turn ending in an unanswered tool call.
    const pruned = this.pruneOrphanToolUse();
    if (pruned.droppedAssistantMessages > 0) {
      this.workflowEventBroadcast({
        type: 'ctx_action',
        workflowId: this.workflowId,
        action: 'prune_orphan_tool_use',
        trigger: 'recovery',
        detail: `dropped ${pruned.droppedAssistantMessages} orphan assistant message(s) before server fold; unpaired tool_use ids: ${pruned.droppedIds.join(', ')}`,
      });
    }
    this.scrubEmptyTextContent();
    this.stripTrailingThinkingBlocks();

    const cut = chooseServerFoldCut(this.messages);
    if (!cut) return { ok: false, error: 'nothing older than the kept turns to fold' };
    const summarized = this.messages.slice(0, cut.cut);
    const kept = this.messages.slice(cut.cut);
    const foldedTurns = countTurnStarts(summarized);

    // Freeze first if nothing went out yet (fresh replay) so the compaction
    // request and every later request share one system/tools snapshot.
    const prefix = this.frozenSystem === undefined || this.frozenTools === undefined
      ? this.resolvePrefixForRequest()
      : this.peekPrefix();
    const effort = this.config.effort ?? 'high';
    const body = buildServerFoldRequest({
      model: this.requestModel(),
      system: prefix.system,
      tools: prefix.tools,
      thinkingParams: buildThinkingParams(model, effort, this.config.claudeNativeThinkingDisplay ?? 'omitted'),
      messages: summarized,
    });
    const beta = this.buildBetaHeader();
    const betaHeader = beta.split(',').includes(SERVER_FOLD_BETA) ? beta : `${beta},${SERVER_FOLD_BETA}`;
    console.log(`[claude-native:${this.workflowId.slice(0, 8)}] → server fold model=${this.requestModel()} summarize=${summarized.length} msg(s) keep=${kept.length} msg(s)/${cut.keptTurns} turn(s) (${cut.tailBytes} B)`);

    const controller = new AbortController();
    this.inFlight = controller;
    let result;
    try {
      const resp = await this.client.messages.create(
        body as unknown as Parameters<Anthropic['messages']['create']>[0],
        { signal: controller.signal, headers: { 'anthropic-beta': betaHeader } },
      );
      result = await consumeServerFoldStream(resp as unknown as AsyncIterable<unknown>);
    } catch (err) {
      const c = classifyServerFoldError(err);
      console.warn(`[claude-native:${this.workflowId.slice(0, 8)}] server fold ${c.kind}: ${c.detail}`);
      return { ok: false, error: c.detail, fallback: c.kind };
    } finally {
      if (this.inFlight === controller) this.inFlight = null;
    }
    if (controller.signal.aborted) return { ok: false, error: 'cancelled' };
    if (result.stopReason !== 'compaction' || !result.block) {
      // Still billed (usage.iterations) — surface it so the spend is visible.
      return { ok: false, error: serverFoldMissingReason(result.stopReason), fallback: 'failed', usage: result.usage };
    }

    const byteLen = (ms: readonly MessageParam[]) => ms.reduce((a, m) => a + Buffer.byteLength(JSON.stringify(m.content ?? ''), 'utf8'), 0);
    const originalBytes = byteLen(this.messages);
    const newMessages = serverFoldSeed(result.block, kept);
    const foldedBytes = byteLen(newMessages);
    this.messages = newMessages;
    if (kept.length === 0) {
      // Nothing bound survives — same restart semantics as Fold/compact.
      this.resetPrefixFreeze('server-fold');
    } else {
      // Keep system/tools frozen (kept thinking depends on it). The summarized
      // range took any appended system/tool deltas with it: mark them
      // undelivered so the next request restates them after the next user
      // turn (docs: never between the block and the kept turns).
      this.deliveredSystem = this.frozenSystem;
      if (this.frozenTools) this.activeToolKeys = activeToolKeysAfterServerFold(this.frozenTools, kept);
      this.sentThrough = this.messages.length;
    }
    this.toolCallCountSinceCompact = 0;
    this.readSet.clear();
    this.partialReadSet.clear();

    // PERSISTED marker — replay reseeds serverFoldSeed(compactionBlock,
    // keptMessages) from these exact fields (byte-identical to live).
    this.workflowEventBroadcast({
      type: 'context_folded',
      workflowId: this.workflowId,
      engine: 'server',
      summary: result.block.content,
      compactionBlock: result.block,
      ...(kept.length > 0 ? { keptMessages: kept } : {}),
      keptTurns: cut.keptTurns,
      foldedTurns,
      trigger: 'operator',
      originalBytes,
      foldedBytes,
      byteDelta: originalBytes - foldedBytes,
      compactionUsage: result.usage,
    });
    this.workflowEventBroadcast({
      type: 'primary_tool_counter',
      workflowId: this.workflowId,
      toolCallsSinceCompact: 0,
    });
    return { ok: true, foldedTurns, keptTurns: cut.keptTurns, byteDelta: originalBytes - foldedBytes, usage: result.usage };
  }

  // One focused, non-agentic summarization round. Reuses the worker's live
  // OAuth client + model; sends the current history plus a "summarize for
  // continuation" instruction with NO tools and NO context-management edits,
  // streaming the text out (we don't surface it as a chat turn). The OAuth
  // endpoint requires the Claude Code identity, so FORCED_FIRST_BLOCK leads the
  // system exactly as on a normal round.
  private async generateCompactSummary(toSummarize: MessageParam[] = this.messages): Promise<string> {
    // ARCO_TEST compact-probe: return a canned summary instead of calling the
    // Anthropic API, so the smoke can exercise the real compactInPlace keep-tail
    // + native_compacted emission without spend. Gated on both the probe flag
    // (set only by __debugSeedForCompactProbe) and ARCO_TEST.
    if (this.compactProbeMode && process.env.ARCO_TEST === '1') {
      return process.env.ARCO_TEST_COMPACT_CANNED_SUMMARY
        ?? 'Canned probe summary: older history folded for the auto-compact smoke.';
    }
    const system = [
      { type: 'text' as const, text: FORCED_FIRST_BLOCK },
      { type: 'text' as const, text: COMPACT_SUMMARIZER_SYSTEM },
    ];
    const messages = [
      ...toSummarize,
      { role: 'user' as const, content: COMPACT_SUMMARIZER_PROMPT },
    ];
    const controller = new AbortController();
    const resp = await this.client!.messages.create({
      model: this.requestModel(),
      max_tokens: COMPACT_SUMMARY_MAX_TOKENS,
      system: system as unknown as string,
      messages: messages as unknown as Parameters<Anthropic['messages']['create']>[0]['messages'],
      stream: true,
    } as Parameters<Anthropic['messages']['create']>[0], {
      signal: controller.signal,
      headers: { 'anthropic-beta': this.buildBetaHeader() },
    });
    let text = '';
    for await (const ev of resp as AsyncIterable<{ type?: string; delta?: { type?: string; text?: string } }>) {
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && typeof ev.delta.text === 'string') {
        text += ev.delta.text;
      }
    }
    return text;
  }

  async ensureStarted(): Promise<void> {
    // ARCO_TEST compact-probe: history is pre-seeded and the summary is
    // canned, so skip the OAuth / client-rebuild path entirely.
    if (this.compactProbeMode) return;
    // Always probe live tokens — if the operator re-logged in since this
    // worker built its client, ensureLiveTokens() returns the fresh set
    // and the obtainedAt mismatch below forces a client rebuild. Cheap:
    // ensureLiveTokens is a single disk read on the happy path.
    const tokens = await ensureLiveTokens();
    // An alias tab can't be dispatched until the alias resolves to a concrete
    // id. Warm the catalog once per worker so the resolution is catalog-backed
    // (newest family member) rather than the static CLAUDE_ALIAS_FALLBACK.
    // Failure is non-fatal — the fallback still yields a real, dispatchable id.
    if (!this.catalogWarmAttempted && isClaudeModelAlias(this.config.model) && !hasCatalogCache()) {
      this.catalogWarmAttempted = true;
      await getCatalog(false).catch((err) => {
        console.warn(`[claude-native:${this.workflowId.slice(0, 8)}] catalog warm for alias '${this.config.model}' failed; using static fallback:`, err instanceof Error ? err.message : err);
      });
    }
    if (this.client && this.clientTokenObtainedAt === tokens.obtainedAt) return;
    const isRebuild = this.client !== null;
    if (isRebuild) {
      console.log(`[claude-native:${this.workflowId.slice(0, 8)}] tokens rotated — rebuilding Anthropic client`);
    }
    this.client = new Anthropic({
      authToken: tokens.accessToken,
      defaultHeaders: this.buildDefaultHeaders(),
      // H10 — our handleApiError ladder is the SINGLE retry path. The SDK's
      // default maxRetries:2 would retry 429/529/500 INTERNALLY before throwing,
      // then our 3-attempt ladder ran on top — compounding to ~6 attempts and
      // minutes of stacked backoff per turn. 0 lets our header-aware ladder own
      // the timing.
      maxRetries: 0,
    } as ConstructorParameters<typeof Anthropic>[0]);
    this.clientTokenObtainedAt = tokens.obtainedAt;
    // Token-rotation rebuilds reuse the existing hooks + replayed state
    // and skip the worker-init emit. Hooks come from CLAUDE.md files,
    // unrelated to auth; replay only ever runs once per worker; 'init'
    // is for first-time wiring on the consumer side.
    if (isRebuild) return;
    this.hooks = await this.discoverTrustedHooks();
    if (!this.replayed) {
      const cwd = this.config.persistenceCwd ?? this.config.cwd;
      if (cwd) {
        try {
          // PHASE_9_FORKS_PLAN.md — if the head was rewound, replay walks the
          // branch from meta.leafSeq instead of the physical tail. Absent ⇒
          // tail ⇒ byte-identical to pre-Phase-9 cold start.
          const meta = await readMeta(cwd, this.workflowId);
          // Opus-5 plan Phase 2 — restore the alias→concrete resolution from a
          // prior session so turn 1 after a restart resolves capabilities from
          // the concrete id. Alias-guarded: a tab pinned to a concrete id (or
          // re-pinned since the resolution was written) ignores the stale value.
          if (meta?.resolvedModelId && isClaudeModelAlias(this.config.model)) {
            this.servedModel = meta.resolvedModelId;
            this.servedModelFor = this.config.model;
          }
          const replay = this.config.voiceOperator
            ? { messages: buildMessagesFromReplayEvents((await replayEventsWithTs(cwd, this.workflowId, 0))
                .filter((e) => meta?.computerContext?.lastResetSeq !== undefined
                  ? (('seq' in e.message && typeof e.message.seq === 'number') ? e.message.seq : 0) > meta.computerContext.lastResetSeq
                  : e.ts > (meta?.computerContext?.lastResetAt ?? 0)).map((e) => e.message) as unknown as Parameters<typeof buildMessagesFromReplayEvents>[0]),
                mode: 'exact', reconstructed: false, summaryThroughSeq: undefined, tailEvents: undefined }
            : await replayMessagesWithResumePolicy(cwd, this.workflowId, undefined, { leafSeq: meta?.leafSeq });
          this.messages = replay.messages as MessageParam[];
          this.resetPrefixFreeze('replay');
          if (replay.reconstructed) {
            // PHASE_9_FORKS_PLAN.md sub-phase 4 — the rewound branch's ancestry
            // had rotated off the size-capped log, so this is a RECONSTRUCTED
            // (lossy) rewind, not a byte-for-byte replay. Surface it loudly
            // rather than silently degrading (hygiene-B). journalctl is the
            // operator's prod log per CLAUDE.md.
            console.warn(`[claude-native:${this.workflowId.slice(0, 8)}] RECONSTRUCTED rewound branch from leafSeq=${meta?.leafSeq} — older ancestry had rotated off events.jsonl; some context is lost`);
          }
          if (this.messages.length > 0) {
            const bytes = JSON.stringify(this.messages).length;
            const detail = replay.mode === 'summary_tail'
              ? `summary through seq ${replay.summaryThroughSeq ?? 'unknown'} + ${replay.tailEvents ?? 0} tail events`
              : replay.mode;
            console.log(`[claude-native:${this.workflowId.slice(0, 8)}] replayed ${this.messages.length} messages (~${bytes} bytes) from events.jsonl using ${detail}`);
          }
        } catch (err) {
          console.warn(`[claude-native:${this.workflowId.slice(0, 8)}] replay failed:`, err);
        }
      }
      this.replayed = true;
    }
    // H54 — probe workspace facts once per cwd (cache-stable). Best-effort: a
    // failure just means no facts block, never a broken turn.
    const factsCwd = this.config.cwd ?? process.cwd();
    if (this.factsProbedForCwd !== factsCwd) {
      try {
        const { probeProjectFacts, renderProjectFactsBlock } = await import('./workspaceFacts.js');
        this.projectFacts = await probeProjectFacts(factsCwd);
        this.projectFactsBlock = renderProjectFactsBlock(this.projectFacts);
        this.factsProbedForCwd = factsCwd;
        if (this.projectFacts.verifyCommands.length > 0) {
          console.log(`[claude-native:${this.workflowId.slice(0, 8)}] workspace facts: ${this.projectFacts.ecosystem.join('+')} verify=[${this.projectFacts.verifyCommands.join(', ')}]`);
        }
      } catch (err) {
        console.warn(`[claude-native:${this.workflowId.slice(0, 8)}] workspace-facts probe failed:`, err);
      }
    }
    console.log(`[claude-native:${this.workflowId.slice(0, 8)}] worker started; messages=${this.messages.length}`);
    // Report the id we'll actually dispatch, not the alias — an alias tab
    // otherwise displays a model name that never reaches Anthropic.
    this.emit('init', { model: this.requestModel(), sessionId: undefined });
  }

  // The concrete model id this worker actually asks Anthropic for. Config
  // stays the operator's pick — including a family alias, so the tab keeps
  // tracking the newest member — but the Messages API has no alias resolution
  // of its own, so an alias MUST be resolved here or the turn 404s with
  // `not_found_error: model: opus` (2026-07-28 incident: every alias tab on
  // Native was dead on turn 1). Resolved per call, not cached: the operator
  // can live-swap the model through updateConfig mid-session.
  private requestModel(): string {
    return resolveClaudeAliasFromCatalog(this.config.model);
  }

  // Opus-5 plan Phase 2 — the model id capability decisions key on. For a
  // pinned concrete id this is always config.model; for an alias tab it is
  // the concrete id Anthropic echoed (or persisted from a prior session),
  // falling back to the catalog's alias resolution before turn 1 lands. Either
  // way it's a concrete id, which is what unlocks catalog-keyed gating
  // (`getCachedModelCapabilities` misses on aliases — they're absent from
  // /v1/models).
  private capModel(): string {
    return this.servedModel !== null && this.servedModelFor === this.config.model
      ? this.servedModel
      : this.requestModel();
  }

  private buildDefaultHeaders(): Record<string, string> {
    // Pi-derived wire fingerprint; the version pin lives in wireFingerprint.ts
    // (bump deliberately — see plan §5/§12 and the history there).
    // The `anthropic-beta` header is also overridden per-request in
    // streamOneRound so context-management betas (currently compact only by
    // default) reflect the live config + current model's catalog capabilities
    // rather than the construct-time snapshot.
    return {
      'anthropic-beta': this.buildBetaHeader(),
      'anthropic-dangerous-direct-browser-access': 'true',
      'user-agent': CLAUDE_CLI_USER_AGENT,
      'x-app': 'cli',
    };
  }

  // Phase 7c-followup — single source of truth for the anthropic-beta
  // header. Returns the standard wire-fingerprint betas plus any
  // context-management betas that are actually active. Do not send
  // clear_thinking / clear_tool_uses by default: on Opus 4.8 research turns,
  // clear_tool_uses can replace fresh web_search results with "Search result
  // was cleared" before the model has integrated them, causing the model to
  // re-search and spiral. compact rides on `compact-2026-01-12`.
  //
  // Gating against the catalog: a model the operator picks but Anthropic
  // hasn't advertised these capabilities for would 400 if we sent the
  // beta. The catalog miss path (cold-start, fetch failure) returns
  // `null` and we conservatively skip — better to leave a feature off
  // than break the turn.
  private buildBetaHeader(): string {
    const parts: string[] = ['claude-code-20250219', 'oauth-2025-04-20'];
    if (shouldSendInterleavedThinkingBeta(this.capModel(), this.config.claudeNativeForceInterleavedThinkingBeta === true)) parts.push('interleaved-thinking-2025-05-14');
    const caps = getCachedModelCapabilities(this.capModel());
    // compact is OFF by default for Native (NATIVE_COMPACTION_PLAN §1); the
    // beta is only attached when WorkflowConfig.claudeNativeCompact is the
    // explicit per-tab/global opt-in true. Once a server compaction block is
    // in history the beta stays on even if the toggle is later cleared — the
    // block is replayed verbatim and is an unknown type without it.
    // A leading on-demand (server Fold) block rules the threshold edit out —
    // the API won't run compact_20260112 on a request carrying a signed block.
    const serverFoldLead = hasLeadingServerFoldBlock(this.messages);
    if (shouldSendCompactBeta(caps, this.config.claudeNativeCompact === true && !serverFoldLead, historyHasThresholdCompactionBlock(this.messages))) {
      parts.push('compact-2026-01-12');
    }
    // Every request that carries the signed server-Fold block needs its beta,
    // or the block reads as an unknown content type (400).
    if (serverFoldLead) parts.push(SERVER_FOLD_BETA);
    // FABLE_51_APPEND_ONLY_PLAN.md — pairs with the request-body fields the
    // frozen-prefix path adds. Each beta only when its feature is actually on
    // the wire, so a model/org that lacks one never sees the header.
    const model = this.capModel();
    if (enforcesPreservedThinking(model)) parts.push(BETA_THINKING_BINDING_CONTROLS);
    if (resolveThinkingDisplay(model, this.config.claudeNativeThinkingDisplay ?? 'omitted') === 'updates') parts.push(BETA_THINKING_DISPLAY_UPDATES);
    if (!this.prefixThawed && supportsMidConversationToolChanges(model) && this.wireHasToolChanges()) parts.push(BETA_MID_CONVERSATION_TOOL_CHANGES);
    return parts.join(',');
  }

  // True once any tool_addition/tool_removal block or deferred declaration is
  // on the wire — the beta must accompany every later request that replays it.
  private wireHasToolChanges(): boolean {
    if (this.frozenTools?.some((t) => t.defer_loading === true)) return true;
    return this.messages.some((m) => isArcoSystemMessage(m) && (m as unknown as { arco?: string }).arco === 'tool_set_change');
  }

  // FABLE_51_APPEND_ONLY_PLAN.md §1.6 — the conversation itself restarted
  // (summary seed, replay from disk, handoff seed): nothing bound survives, so
  // the next request may take a fresh snapshot. Never call this for a config
  // change — that is exactly the edit the freeze exists to absorb.
  private resetPrefixFreeze(reason: string): void {
    if (this.frozenSystem !== undefined || this.frozenTools !== undefined) {
      console.log(`[claude-native:${this.workflowId.slice(0, 8)}] prefix freeze reset (${reason})`);
    }
    this.frozenSystem = undefined;
    this.deliveredSystem = undefined;
    this.frozenTools = undefined;
    this.activeToolKeys = new Set();
    this.sentThrough = 0;
  }

  // FABLE_51_APPEND_ONLY_PLAN.md §1.1–1.2 — the `system` + `tools` that go on
  // the wire for this round, and the `role: 'system'` message (if any) that
  // carries what changed since the freeze. MUTATES worker state: extends the
  // frozen tool array with deferred declarations and updates activeToolKeys.
  // Called once per messages.create attempt; countTokens uses peekPrefix().
  private resolvePrefixForRequest(): { system: SystemBlock[]; tools: ClaudeNativeToolDef[]; notes: string[] } {
    const fresh = this.buildSystemBlocks() as SystemBlock[];
    const freshTools = sortToolDefs(this.buildToolDefs() as unknown as ToolDefLike[]);
    const model = this.capModel();
    const notes: string[] = [];
    if (this.frozenSystem === undefined || this.frozenTools === undefined) {
      this.frozenSystem = fresh;
      this.deliveredSystem = fresh;
      this.frozenTools = freshTools;
      this.activeToolKeys = new Set(freshTools.map(toolKey));
      return { system: fresh, tools: freshTools as unknown as ClaudeNativeToolDef[], notes };
    }
    const canSystem = !this.prefixThawed && supportsMidConversationSystemMessages(model);
    const canTools = !this.prefixThawed && supportsMidConversationToolChanges(model);

    let system = fresh;
    let deltaText: string | null = null;
    // Only append the update when it can legally sit here (directly after a
    // user turn). Every current call site satisfies this; if a future path
    // doesn't, the change simply waits for the next request rather than
    // producing a 400.
    const last = this.messages[this.messages.length - 1] as { role?: string } | undefined;
    const canAppend = last?.role === 'user';
    if (canSystem) {
      const delta = diffSystemBlocks(this.deliveredSystem ?? this.frozenSystem, fresh);
      if (delta.changed && canAppend) {
        deltaText = renderSystemDelta(delta);
        this.deliveredSystem = fresh;
        notes.push(`system Δ +${delta.added.length}/−${delta.removed.length} block(s) → role:system message`);
      } else if (delta.changed) {
        notes.push('system Δ pending (last message is not a user turn)');
      }
      system = this.frozenSystem;
    } else {
      // Status-quo rebuild: the model doesn't take role:'system' (Sonnet 5,
      // Opus 4.7 and older) and doesn't enforce binding, so a changed system
      // costs one cache miss and nothing else.
      this.frozenSystem = fresh;
      this.deliveredSystem = fresh;
    }

    let tools: ToolDefLike[] = freshTools;
    let toolBlocks: ReturnType<typeof buildToolChangeBlocks> = [];
    if (canTools && canAppend) {
      const d = diffToolSets(this.frozenTools, this.activeToolKeys, freshTools);
      const addKeys = [...d.addKeys];
      for (const def of d.declare) {
        // Anthropic server tools carry no `defer_loading` contract; declare
        // them live (a prefix extension the API drops later thinking for —
        // logged, rare: only a posture that re-adds web_search hits it).
        if (isClaudeServerToolDef(def)) {
          this.frozenTools.push(def);
          this.activeToolKeys.add(toolKey(def));
          notes.push(`declared server tool ${toolKey(def)} live (no defer_loading)`);
        } else {
          this.frozenTools.push(markDeferred(def));
          addKeys.push(toolKey(def));
        }
      }
      if (addKeys.length > 0 || d.removeKeys.length > 0) {
        toolBlocks = buildToolChangeBlocks(addKeys, d.removeKeys);
        for (const k of addKeys) this.activeToolKeys.add(k);
        for (const k of d.removeKeys) this.activeToolKeys.delete(k);
        notes.push(`tools Δ +[${addKeys.join(',')}] −[${d.removeKeys.join(',')}] → tool_addition/tool_removal`);
      }
      if (d.definitionChanged.length > 0) {
        notes.push(`ignored definition change on frozen tool(s): ${d.definitionChanged.join(',')}`);
      }
      tools = this.frozenTools;
    } else if (canTools) {
      // Can't append the change message this round — keep the frozen set on
      // the wire (dispatch-time guards still enforce posture / plan mode) and
      // let the next request carry the tool_addition/tool_removal.
      tools = this.frozenTools;
      notes.push('tools Δ pending (last message is not a user turn)');
    } else {
      this.frozenTools = freshTools;
      this.activeToolKeys = new Set(freshTools.map(toolKey));
    }

    const update = buildPrefixUpdateMessage(deltaText, toolBlocks);
    if (update) {
      // Always directly after a user message: runTurn pops trailing system
      // messages before pushing the operator turn, and the tool loop pushes
      // tool_results before the next round, so the last entry is a user turn.
      this.messages.push(update as unknown as MessageParam);
      const bytes = Buffer.byteLength(JSON.stringify(update.content), 'utf8');
      this.workflowEventBroadcast({
        type: 'ctx_action',
        workflowId: this.workflowId,
        action: update.arco === 'tool_set_change' ? 'tool_set_change' : 'system_delta',
        trigger: 'operator',
        detail: `${notes.join('; ')} (${bytes} bytes appended; frozen prefix untouched)`,
      });
    }
    return { system, tools: tools as unknown as ClaudeNativeToolDef[], notes };
  }

  // Non-mutating view of the current wire prefix for countTokens.
  private peekPrefix(): { system: SystemBlock[]; tools: ClaudeNativeToolDef[] } {
    return {
      system: (this.frozenSystem ?? this.buildSystemBlocks()) as SystemBlock[],
      tools: (this.frozenTools ?? sortToolDefs(this.buildToolDefs() as unknown as ToolDefLike[])) as unknown as ClaudeNativeToolDef[],
    };
  }

  // Per-request body fragment that activates context-management edits.
  // The header alone is necessary-but-not-sufficient: Anthropic requires
  // `context_management.edits` on each `messages.create` payload. Returns
  // an empty object when no context-management feature is active so the
  // call site can spread it unconditionally.
  private buildContextManagementBody(): Record<string, unknown> {
    const caps = getCachedModelCapabilities(this.capModel());
    const edits = buildContextManagementEditsForRequest(caps, this.config.claudeNativeCompact === true && !hasLeadingServerFoldBlock(this.messages));
    // Anthropic's server-managed compaction is an edit strategy, not a sibling
    // `context_management.compact` object. Let the model+server pick the
    // trigger threshold (default ~150K tokens per the docs); we don't override
    // unless we have a concrete reason to.
    return edits.length > 0 ? { context_management: { edits } } : {};
  }

  private async hydrateContextManagementCapabilities(): Promise<void> {
    const model = this.capModel();
    if (getCachedModelCapabilities(model)) return;
    await getCatalog(false).catch((err) => {
      console.warn(`[claude-native:${this.workflowId.slice(0, 8)}] catalog warm-up failed:`, err instanceof Error ? err.message : err);
    });
    if (getCachedModelCapabilities(model)) return;
    if (this.forcedCatalogRefreshModels.has(model)) return;
    this.forcedCatalogRefreshModels.add(model);
    await getCatalog(true).catch((err) => {
      console.warn(`[claude-native:${this.workflowId.slice(0, 8)}] catalog force-refresh failed for ${model}:`, err instanceof Error ? err.message : err);
    });
  }

  // CLUSTER_MODE_PLAN.md Phase 1 — peer tools register only when the
  // worker is in a cluster. Plan §6.1d: leaking peer tools into a
  // non-cluster workflow breaks the no-orchestrator invariant (operator
  // hasn't opted that workflow into peer messaging). Gate is strictly
  // `clusterId !== undefined`.
  // ARCO_OPS_PLAN.md §E1 (E1-Native) — reconcile the open MCP sessions
  // against `config.mcpRegistryServers` at turn start. Open newly-allowed
  // servers (lazy connect → cache), close servers the operator removed since
  // the last turn (per-tab disable / global disable / dangerous-tick change
  // that drops the server entirely). Idempotent: an already-open server is
  // left as-is. connectServer never throws — a failed spawn/init yields a
  // closed session that reports errors, so a dead server can't wedge the turn.
  private async reconcileMcpSessions(): Promise<void> {
    const wanted = this.config.mcpRegistryServers ?? [];
    const wantedKeys = new Set(wanted.map((s) => s.key));

    // Close + drop sessions no longer wanted (no leaked children).
    for (const [key, session] of this.mcpSessions) {
      if (!wantedKeys.has(key)) {
        try { session.close(); } catch { /* already gone */ }
        this.mcpSessions.delete(key);
      }
    }

    // Open newly-allowed servers. connectServer takes an McpServerDef shape;
    // ResolvedMcpServer carries the spawn fields (command/args/env) — the rest
    // (id/name/enabled/createdAt) are unused by the spawn path.
    for (const server of wanted) {
      if (this.mcpSessions.has(server.key)) continue;
      const session = await connectServer({
        id: server.key,
        name: server.key,
        command: server.command,
        args: server.args,
        env: server.env ?? {},
        enabled: true,
        createdAt: 0,
      });
      this.mcpSessions.set(server.key, session);
    }
  }

  // Force-close every open MCP session and clear the map. Called from dispose;
  // safe to call repeatedly (close() is idempotent).
  private closeMcpSessions(): void {
    for (const session of this.mcpSessions.values()) {
      try { session.close(); } catch { /* already gone */ }
    }
    this.mcpSessions.clear();
  }

  private buildToolDefs(): ClaudeNativeToolDef[] {
    // Chat has no project toolset. When the operator arms web access the tab
    // gets exactly web_search + web_fetch — no filesystem, no shell, no MCP,
    // no posture filter (there is nothing left for it to filter).
    if (this.config.interactionMode === 'chat') {
      if (this.config.voiceOperator) return computerToolDefinitions().map(({ function: f }) => ({ name: f.name, description: f.description, input_schema: f.parameters })) as ClaudeNativeToolDef[];
      return this.config.chatWebAccess ? buildChatWebTools(this.config.webSearchMaxUses) : [];
    }
    const inCluster = this.config.clusterId !== undefined;
    const isolated = this.config.clusterAccessMode === 'isolated';
    const base = getNativeToolDefinitions({ taskDisabled: this.taskDisabled || inCluster, isolated });
    const extras: ReturnType<typeof getNativeToolDefinitions> = [];
    if (inCluster) {
      extras.push(...getPeerToolDefinitions({
        taskBoardAttached: this.config.clusterTaskBoardAttached === true,
        accessMode: this.config.clusterAccessMode,
      }));
    }
    // §E1 (E1-Native) — append the operator-allowed registry servers' tools.
    // registryToolDefs is the AUTHORITATIVE denylist gate for Native: a
    // dangerous-and-unticked tool is OMITTED here (never advertised), so the
    // model can't call it. Mirrors the cluster peer-tool registration gate.
    const registryDefs = isolated ? [] : registryToolDefs(
      this.config.mcpRegistryServers ?? [],
      this.mcpSessions,
      (note) => console.log(`[claude-native:${this.workflowId.slice(0, 8)}] ${note}`),
      this.planMode, // DD11a — hide non-readonly MCP tools while planning
    );
    if (registryDefs.length > 0) extras.push(...registryDefs);
    // EFFICIENCY_PLAN.md Phase E §9a — sandbox tools are operator-opted-in
    // per tab. Adding them mid-life takes effect on the next turn (tools[]
    // is rebuilt per messages.create), matching the toggle's CONFIG-tab
    // contract. Flipping back to 'off' un-registers the descriptors.
    if (!isolated && (this.config.efficiencySandbox ?? 'off') === 'on') extras.push(...getSandboxToolDefinitions());
    // WORKBENCH_EXPANSION_PLAN.md §B2 — Deep Research threads its `maxRounds`
    // through as `webSearchMaxUses` so the web_search / web_fetch budget is a
    // MECHANICAL hard ceiling, not just a prompt-stated cap. Unset ⇒ default 10.
    const serverTools = this.config.webSearchMaxUses !== undefined
      ? buildClaudeServerTools(this.config.webSearchMaxUses)
      : CLAUDE_CODE_SERVER_TOOLS;
    const all = [...base, ...extras, ...serverTools];
    // §4.1 — posture filter. 'full'/unset is a no-op (returns `all`). A bundle
    // drops its omitted core/server tools (dynamic opt-ins always survive),
    // scrubs dangling "X still available" cross-refs in survivors, and falls
    // back to full if it would empty the set. Re-run per request, so flipping
    // posture re-breaks the cached tools[] breakpoint once, then re-warms.
    const filtered = filterToolDefsByPosture(all as Array<{ name: string; description?: string }>, this.config.toolPosture);
    if (filtered.removed.length > 0 || filtered.fellBackToFull) {
      console.log(
        `[claude-native:${this.workflowId.slice(0, 8)}] posture=${this.config.toolPosture ?? 'full'} ` +
        (filtered.fellBackToFull
          ? '→ empty bundle, fell back to full'
          : `dropped ${filtered.removed.length} tool(s): ${filtered.removed.join(', ')}`),
      );
    }
    return filtered.tools as ClaudeNativeToolDef[];
  }

  private buildSystemBlocks(): Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral'; ttl?: string } }> {
    const blocks: Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral'; ttl?: string } }> = [];
    const isolated = this.config.clusterAccessMode === 'isolated';

    // Block ordering invariant (gotcha-tracked): FORCED_FIRST_BLOCK →
    // north-star → cluster plan → role → efficiency doctrine → delegation
    // contract → sandbox nudge → env note → turn discipline → workspace facts →
    // appendSystemPrompt → systemPrompt → output style.
    // Cache breakpoints are assigned AFTER
    // all blocks are pushed — Anthropic caps requests at 4 blocks with
    // cache_control. Pushing every "stable" block as cached (the old
    // pattern) hits the limit the moment cluster plan + role + sandbox
    // nudge + an operator system prompt are all present, returning
    // 400 invalid_request_error from the API.
    blocks.push({ type: 'text', text: FORCED_FIRST_BLOCK });
    const forcedBlockIdx = 0;

    if (this.config.interactionMode === 'chat') {
      const chatPrompt = this.config.systemPrompt ?? this.config.appendSystemPrompt;
      if (chatPrompt) blocks.push({ type: 'text', text: chatPrompt });
      blocks[forcedBlockIdx].cache_control = { type: 'ephemeral', ttl: '1h' };
      if (blocks.length > 1) blocks[blocks.length - 1].cache_control = { type: 'ephemeral' };
      return blocks;
    }

    // GOAL_NORTHSTAR_PLAN.md — operator-set persistent north-star. Pushed
    // immediately after the identity block and before the cluster plan: it is
    // the most stable per-session block after FORCED_FIRST_BLOCK, so it belongs
    // in the cached prefix. Zero model authority — the block's own trailer
    // forecloses reading it as license to self-drive. Absent / blank ⇒ no block,
    // zero extra input tokens. No dedicated cache breakpoint (only 3 slots) —
    // it rides the plan-boundary breakpoint's cached prefix (or the last-block
    // breakpoint when no plan is set).
    const goalText = goalBlock(this.config.goal);
    if (goalText) {
      blocks.push({ type: 'text', text: goalText });
    }

    let planIdx = -1;
    const planText = this.config.clusterPlan;
    if (planText && planText.trim().length > 0) {
      planIdx = blocks.length;
      blocks.push({ type: 'text', text: `--- Shared cluster plan ---\n${planText}` });
    }

    let roleIdx = -1;
    const roleText = this.config.clusterRole;
    if (roleText && roleText.trim().length > 0) {
      roleIdx = blocks.length;
      blocks.push({ type: 'text', text: `Your role in this cluster: ${roleText.trim()}` });
    }

    // 2026-06-15 — per-cluster efficiency doctrine. Pre-built in turnEngine
    // (canned restraint text for the cluster's efficiency level + optional
    // operator addendum); undefined for the 'thorough' default ⇒ no block.
    // Lands after role + before the delegation contract so the "chunk bigger,
    // don't over-review" framing colours how the contract's "use peer_send to
    // assign work" is read. No dedicated cache breakpoint (only 3 slots; the
    // doctrine is small + rarely changes, and the suffix/role breakpoints
    // already cover it).
    const doctrineText = this.config.clusterEfficiencyDoctrine;
    if (doctrineText && doctrineText.trim().length > 0) {
      blocks.push({ type: 'text', text: doctrineText });
    }

    // 2026-06-29 — per-cluster progress-tracking doctrine (keep the plan and/or
    // board current). Pre-built in turnEngine from the cluster's mode gated on
    // what actually exists; undefined ⇒ no block. Lands right after the
    // efficiency doctrine so "keep both surfaces current" reads alongside the
    // restraint framing, and before the delegation contract.
    const progressDoctrineText = this.config.clusterProgressDoctrine;
    if (progressDoctrineText && progressDoctrineText.trim().length > 0) {
      blocks.push({ type: 'text', text: progressDoctrineText });
    }

    if (this.config.clusterId !== undefined && this.config.clusterAccessMode === 'standard') {
      blocks.push({
        type: 'text',
        text:
          '--- Cluster delegation contract ---\n' +
          'You are already inside an Arco cluster. The operator-assigned workers are your peers. ' +
          'Use peer_list to identify them, peer_send to assign work, and peer_read to receive results. ' +
          'Do not use the Task/subagent tool for cluster delegation unless the operator explicitly asks for Claude Native Task fan-out.',
      });
    }

    // EFFICIENCY_PLAN.md Phase E §9b — soft nudge about the sandbox tools.
    // Lands AFTER plan + role (so they read as a higher-priority framing)
    // and BEFORE the operator's appendSystemPrompt / systemPrompt (so the
    // operator's instructions still win on conflict). Skipped when the
    // toggle is 'off' — no input-token cost when the operator hasn't
    // opted the tab in.
    if (this.config.clusterAccessMode === 'isolated') {
      blocks.push({
        type: 'text',
        text:
          '--- Isolated cluster member ---\n' +
          'You are intentionally blind to the cluster project and its coordination state. Your workspace is a private scratch directory. ' +
          'You may read and write only inside it. You have only peer_send and peer_read for cluster communication. ' +
          'To return files, pass paths inside this workspace as peer_send artifact_paths; Arco copies them into the recipient workspace. ' +
          'Do not infer or request cluster plans, boards, rosters, roles, or project files unless another member explicitly sends the needed material.',
      });
    } else if (this.config.clusterAccessMode === 'blind') {
      blocks.push({
        type: 'text',
        text: BLIND_CLUSTER_DOCTRINE,
      });
    }

    if (!isolated && (this.config.efficiencySandbox ?? 'off') === 'on') {
      blocks.push({
        type: 'text',
        text:
          'You have ctx_execute / ctx_search / ctx_fetch available alongside Read / Bash. Prefer them when:\n' +
          '  - Reading large files where you only need a small section (pipe through head/grep/jq in the script and console.log only the slice).\n' +
          "  - Running shell commands whose output is mostly noise — you can filter inside the script and only print what's relevant.\n" +
          'The full Read / Bash tools remain available — use them when the operator asked for full output, or when the section you need is small. ' +
          'To stash content for later retrieval print lines as `[chunk] <text>` (or open `[chunk]` / close `[/chunk]` for multi-line); each becomes a searchable chunk. ' +
          'Retrieve via ctx_search (BM25) and ctx_fetch (exact id).',
      });
    }
    if (!isolated) blocks.push({
      type: 'text',
      text:
        'You have two execution environments. Use Arco local tools (Read, Bash, Edit, Write, Grep, Glob) for the operator workspace and machine state. ' +
        'The Anthropic code_execution server tool is a separate sandbox; use it only for web_search/web_fetch dynamic filtering or isolated computation that does not require local files/processes.',
    });
    // Turn-completion doctrine. The real Claude Code CLI ships equivalent
    // language in its system prompt; Native's forced-first block is only the
    // one-line identity, so without this Fable/Opus checkpoint mid-task —
    // ending turns with "Continuing now." and idling (GroundTruth
    // incident, 2026-07-01, where the model also silently worked around four
    // dead Task children). Standing block, cache-stable, before the
    // operator's appendSystemPrompt/systemPrompt so operator instructions
    // still win on conflict.
    blocks.push({
      type: 'text',
      text:
        'Turn discipline: the operator is not watching in real time and cannot answer mid-turn. ' +
        'Continue working until the request is complete or you are genuinely blocked on operator input. ' +
        "Never end your turn with a status update, a plan, or a promise of future work ('Continuing now', 'I'll do X next') — " +
        'if your final paragraph describes work you have not done, do that work now instead of ending the turn. ' +
        'If a delegated Task child fails or returns an error or nonsense (e.g. a login error), say so explicitly in your reply and adapt openly — never silently work around a failed delegation. ' +
        // Fable 5.1 rewrites whole files where a targeted edit would do
        // (FABLE_51_APPEND_ONLY_PLAN.md §3); Anthropic's documented one-liner.
        'The number of tokens used to edit files is best minimized, all else being equal. Therefore, when it will not affect the end result, try to surgically edit a file rather than rewrite the entire thing.',
    });
    // H54 — workspace facts (detected verify/build/test commands + git branch).
    // BEFORE appendSystemPrompt/systemPrompt so the operator's instructions
    // still win on conflict. Cache-stable (probed once in ensureStarted).
    if (this.projectFactsBlock) {
      blocks.push({ type: 'text', text: this.projectFactsBlock });
    }
    if (this.config.appendSystemPrompt) {
      blocks.push({ type: 'text', text: this.config.appendSystemPrompt });
    }
    if (this.config.systemPrompt) {
      blocks.push({ type: 'text', text: this.config.systemPrompt });
    }
    // OUTPUT_STYLE_PLAN.md — append after project context so the level's
    // verbatim/auto-clarity rules are read alongside any operator system
    // prompt. `normal` returns null (no block, no extra input tokens).
    const styleText = outputStyleAddendum(this.config.outputStyle);
    if (styleText) {
      blocks.push({ type: 'text', text: styleText });
    }

    // Apply cache_control at strategic explicit breakpoints, in priority
    // order. We reserve one of Anthropic's 4 breakpoint slots for the
    // top-level automatic cache_control on messages.create, which advances
    // through the growing messages[] history during tool loops. That leaves
    // at most 3 block-level breakpoints here.
    //
    //   1. FORCED_FIRST_BLOCK (1h TTL) — essentially static; long-lived
    //      cache pays for itself across hours of operator use.
    //   2. Final block (5min TTL) — caches the whole prefix so repeated
    //      turns with unchanged system blocks reuse it.
    //   3. Cluster-plan boundary (5min) — plan edits invalidate only the
    //      suffix, not the FORCED_FIRST_BLOCK 1h cache.
    //   4. Role boundary (5min) — skipped when automatic caching is on
    //      because role changes are rare and message-history caching is more
    //      valuable for agentic turns.
    //
    // Breakpoints are skipped when the corresponding block is absent or
    // collides with a higher-priority breakpoint (e.g. role IS the last
    // block when nothing else trails it).
    blocks[forcedBlockIdx].cache_control = { type: 'ephemeral', ttl: '1h' };
    let cachedCount = 1;
    const maxExplicitCacheBreakpoints = 3;
    const lastIdx = blocks.length - 1;
    if (lastIdx > forcedBlockIdx && cachedCount < maxExplicitCacheBreakpoints) {
      blocks[lastIdx].cache_control = { type: 'ephemeral' };
      cachedCount++;
    }
    if (planIdx > forcedBlockIdx && planIdx !== lastIdx && cachedCount < maxExplicitCacheBreakpoints) {
      blocks[planIdx].cache_control = { type: 'ephemeral' };
      cachedCount++;
    }
    if (
      roleIdx > forcedBlockIdx &&
      roleIdx !== lastIdx &&
      roleIdx !== planIdx &&
      cachedCount < maxExplicitCacheBreakpoints
    ) {
      blocks[roleIdx].cache_control = { type: 'ephemeral' };
      cachedCount++;
    }

    return blocks;
  }

  // settings.json hooks run arbitrary commands as the operator, so discovery
  // is gated like every other project surface:
  //   • Chat tabs get NONE — they expose no project surface, and an incognito
  //     chat's cwd is os.tmpdir(), where a planted /tmp/.claude/settings.json
  //     UserPromptSubmit hook would receive every incognito prompt.
  //   • Agent tabs get project-level hooks only when DD7 trust is an explicit
  //     'always' (resolveTrustStatus, same raw-decision read as DD10 prompts —
  //     `.claude/settings.json` isn't one of gateProjectResources' triggers).
  //     User-level ~/.claude hooks are the operator's own and always load.
  //     A gate error fails safe (project hooks suppressed).
  // Cached per worker (ensureStarted); a trust grant applies on tab reopen.
  // Managed bake-off worktrees resolve trust on the worktree path (the source
  // cwd isn't on WorkerConfig), so their project hooks stay suppressed.
  private async discoverTrustedHooks(): Promise<HookConfig> {
    if (this.config.interactionMode === 'chat' || this.config.clusterAccessMode === 'isolated') return { byEvent: {} };
    const cwd = this.config.cwd ?? process.cwd();
    let includeProject = false;
    try {
      includeProject = (await resolveTrustStatus(cwd)) === 'always';
    } catch (err) {
      console.error(`[claude-native:${this.workflowId.slice(0, 8)}] project-trust lookup failed; suppressing project hooks:`, err);
    }
    const found = await discoverHooks(cwd, { includeProject });
    if (found.suppressedProjectFiles.length > 0) {
      this.emit('system_notice', `[PROJECT TRUST] Project hooks not loaded (repo not trusted): ${found.suppressedProjectFiles.join(', ')}. Trust the repo, then reopen the tab to enable them.`);
    }
    return { byEvent: found.byEvent };
  }

  // Operator clicks CANCEL / RSS guard / tab close.
  cancel(): void {
    this.cancelRequested = true;
    try { this.inFlight?.abort(); } catch { /* already aborted */ }
    try { this.toolAbort?.abort(); } catch { /* already aborted */ }
    // Reject any awaiting AskUserQuestion so the tool result returns the
    // abort path cleanly rather than orphaning the promise.
    if (this.pendingQuestion) {
      const q = this.pendingQuestion;
      this.pendingQuestion = null;
      try { q.reject(new Error('AbortError: turn cancelled')); } catch { /* ignore */ }
    }
    // DEBAG — reject any parked review gates so the tool loop unwinds cleanly
    // rather than orphaning the promise (mirrors the pendingQuestion drain).
    if (this.pendingGates.size > 0) {
      const gates = Array.from(this.pendingGates.values());
      this.pendingGates.clear();
      for (const g of gates) {
        try { g.reject(new Error('AbortError: turn cancelled')); } catch { /* ignore */ }
      }
    }
    // Cascade cancel to any in-flight Task children.
    for (const handle of this.tasksByTaskId.values()) {
      try { handle.cancel(); } catch { /* already gone */ }
    }
  }

  async dispose(): Promise<void> {
    this.cancel();
    // Kill any leftover background shells.
    for (const reg of this.shells.byId.values()) {
      try { reg.kill(); } catch { /* gone */ }
    }
    this.shells.byId.clear();
    this.tasksByTaskId.clear();
    // §E1 (E1-Native) — force-close every open MCP session. dispose is the sole
    // teardown path (disposeClaudeNativeWorker on tab close + after
    // handoff_complete); a leaked stdio child would otherwise outlive the
    // worker. cancel() above does NOT touch sessions — they persist across
    // operator turns by design — so this is where the children actually die.
    this.closeMcpSessions();
    this.client = null;
    this.messages = [];
    this.replayed = false;
  }

  // Defense-in-depth before every messages.create. Anthropic rejects with
  // `400 invalid_request_error: tool_use ids were found without tool_result
  // blocks immediately after` when the model's prior assistant turn carried
  // `tool_use` blocks and the next user message lacks the paired
  // `tool_result`s. The canonical way this happens: a prior turn was
  // cancelled (operator CANCEL, RSS guard, tab close, `inFlight.abort()`)
  // AFTER the assistant emitted tool_use blocks but BEFORE `runTurn`'s
  // tool-dispatch loop pushed the matching `user(tool_result)` user message
  // (see the `Worker killed` early returns in the tool loop). The trailing
  // orphan assistant message survives in `this.messages`, and the next turn —
  // operator prompt, handoff seed, reflection — appends a string-content
  // user message right after it, tripping Anthropic's pairing check on the
  // very next API round-trip. Replay-on-restart can't produce this state
  // (replayMessagesFromEvents skips tool_use entries entirely), so the
  // mitigation only matters for the in-memory mid-life state.
  //
  // We only handle the trailing-orphan tail case (the only shape our own
  // code paths can generate); a mid-array orphan would require an external
  // mutation that doesn't exist today. Drops are emitted to events.jsonl as
  // a `ctx_action` with `trigger:'recovery'` so transcript review can attribute
  // the mutation — silent context manipulation is a hard fence per
  // docs/GOTCHAS.md.
  private pruneOrphanToolUse(): { droppedAssistantMessages: number; droppedIds: string[] } {
    const droppedIds: string[] = [];
    let dropped = 0;
    while (this.messages.length > 0) {
      const last = this.messages[this.messages.length - 1];
      if (last.role !== 'assistant' || !Array.isArray(last.content)) break;
      // Orphan = an unpaired client tool_use (its tool_result would live in a
      // following user message that can never exist on a trailing assistant)
      // OR an unpaired server_tool_use (web_search / web_fetch) whose
      // *_tool_result belongs in THIS message but didn't stream in before an
      // interrupt/abort. The latter wedges every later messages.create with
      // Anthropic's "found without a corresponding web_search_tool_result"
      // 400, so it must be dropped here too — not just client tool_use.
      const ids = orphanToolUseIds(last.content as Array<{ type?: string; id?: string; tool_use_id?: string }>);
      if (ids.length === 0) break;
      droppedIds.push(...ids);
      this.messages.pop();
      dropped++;
    }
    return { droppedAssistantMessages: dropped, droppedIds };
  }

  // Early-return turn exits (hard stream error, mid-tool abort, iteration cap)
  // skip the normal end-of-turn `pruneServerToolEvidenceAfterTurn` at the
  // bottom of `runTurn`. If the aborted round left an assistant turn ending in
  // a server_tool_use (web_search / web_fetch) without its *_tool_result, that
  // orphan persists in `messages[]` and 400s every later request — the
  // recovery pruner only re-checks at the TOP of the NEXT turn, so a between-
  // turn `countTokens` / auto-compact would still hit it. Scrub on the way out
  // so the orphan never survives the turn. No-op on the normal path (the same
  // prune already ran) — `pruneServerToolEvidenceAfterTurn` removes all
  // server_tool_use blocks regardless of pairing, so unpaired ones go too.
  private scrubServerToolEvidenceOnAbort(turnMessageStart: number): void {
    // The ONLY caller that opts out of latest-assistant protection, and
    // deliberately so. An aborted round leaves a partial assistant message
    // Arco assembled from a truncated stream — not a completed response the
    // API would hold us to — and its dangling `server_tool_use` (no matching
    // result) is itself a guaranteed 400 on the next request. So the edit is
    // mandatory here, where after a *settled* turn it is forbidden. If
    // Anthropic ever objects to this scrub, `isThinkingBindingError` catches
    // it and the worker strips thinking and retries; leaving the orphan in
    // place has no recovery at all.
    const scrub = pruneServerToolEvidenceAfterTurn(
      this.messages as Array<{ role?: string; content?: unknown }>,
      turnMessageStart,
      { protectLatestAssistant: false },
    );
    if (scrub.blocks > 0) {
      console.log(
        `[claude-native:${this.workflowId.slice(0, 8)}] aborted turn: scrubbed ${scrub.blocks} server-tool block(s) ` +
        `(${scrub.bytes} bytes) so an orphan server_tool_use can't wedge the next request`,
      );
    }
  }

  // Anthropic rejects `text` content blocks with an empty string and `image`
  // blocks with empty base64 data. The common text source is an image-only
  // operator turn: older Arco builds appended `[image, {type:'text',
  // text:''}]`. The image source is a 0-byte upload encoded to `data: ''`
  // (2026-08-07 incident — buildImageBlock now guards, but a poisoned block
  // already in messages[] would otherwise 400 every later turn). Scrub just
  // before each API call so live workers recover without a process restart.
  // Same pass repairs over-cap / mistyped image blocks (repairImageBlock):
  // buildImageBlock now refuses them, but one already in history would 400
  // every later request exactly like the empty image did.
  private scrubEmptyTextContent(): { droppedTextBlocks: number; droppedImageBlocks: number; patchedEmptyMessages: number; patchedToolResults: number; replacedOversizedImages: number; retypedImages: number } {
    let droppedTextBlocks = 0;
    let droppedImageBlocks = 0;
    let patchedEmptyMessages = 0;
    let patchedToolResults = 0;
    let replacedOversizedImages = 0;
    let retypedImages = 0;
    const isEmptyImage = (b: Record<string, unknown>): boolean =>
      b.type === 'image' && isRecord(b.source) && b.source.type === 'base64' && b.source.data === '';
    // Returns a replacement text block for an over-cap image, else null
    // (retyping happens in place).
    const repairImage = (b: Record<string, unknown>): AnyContentBlock | null => {
      const r = repairImageBlock(b);
      if (r.action === 'retyped') retypedImages++;
      if (r.action !== 'replace') return null;
      replacedOversizedImages++;
      return { type: 'text', text: r.text };
    };

    // Tail only (FABLE_51_APPEND_ONLY_PLAN.md §1.4): everything before
    // sentThrough was accepted by a successful request as-is.
    for (const msg of this.unsentTail()) {
      if (typeof msg.content === 'string') {
        if (msg.content.length === 0) {
          msg.content = '[empty message omitted by Arco]';
          patchedEmptyMessages++;
        }
        continue;
      }

      const next: AnyContentBlock[] = [];
      for (const block of msg.content as Array<unknown>) {
        if (!isRecord(block)) {
          next.push(block as AnyContentBlock);
          continue;
        }
        if (block.type === 'text' && block.text === '') {
          droppedTextBlocks++;
          continue;
        }
        if (isEmptyImage(block)) {
          droppedImageBlocks++;
          continue;
        }
        const imageReplacement = repairImage(block);
        if (imageReplacement) {
          next.push(imageReplacement);
          continue;
        }
        if (block.type === 'tool_result' && block.content === '') {
          block.content = '(no output)';
          patchedToolResults++;
        } else if (block.type === 'tool_result' && Array.isArray(block.content)) {
          const content = block.content as Array<unknown>;
          const filtered = content.filter((sub) => {
            if (!isRecord(sub)) return true;
            if (sub.type === 'text' && sub.text === '') { droppedTextBlocks++; return false; }
            if (isEmptyImage(sub)) { droppedImageBlocks++; return false; }
            return true;
          }).map((sub) => (isRecord(sub) ? repairImage(sub) ?? sub : sub));
          block.content = filtered.length > 0 ? filtered : '(no output)';
          if (filtered.length === 0) patchedToolResults++;
        }
        next.push(block as AnyContentBlock);
      }

      if (next.length === 0) {
        msg.content = '[empty message omitted by Arco]';
        patchedEmptyMessages++;
      } else if (next.length !== msg.content.length || next.some((b, i) => b !== (msg.content as unknown[])[i])) {
        msg.content = next;
      }
    }

    return { droppedTextBlocks, droppedImageBlocks, patchedEmptyMessages, patchedToolResults, replacedOversizedImages, retypedImages };
  }

  // Anthropic rejects an assistant message whose content array ENDS with a
  // `thinking` / `redacted_thinking` block (`messages.N: The final block in an
  // assistant message cannot be 'thinking'`). With interleaved thinking, Opus
  // 4.8 frequently emits a round whose last streamed block is a thinking block
  // (it reasons after its final tool_use / text, then the response ends). We
  // push round.contentBlocks verbatim into history, so that trailing thinking
  // becomes a landmine: any later resend re-validates the whole history and
  // 400s on that earlier message (observed as `messages.15: …` mid-turn, 3 min
  // into a heavy research turn). Strip the contiguous trailing run of thinking
  // blocks from every assistant message before each request. Thinking blocks
  // that PRECEDE a tool_use / text are kept (with signatures) for reasoning
  // continuity — only the trailing run, which the API forbids keeping anyway,
  // is removed. A pure-thinking message (no other blocks) is replaced with a
  // placeholder text block so it stays valid.
  // Messages not yet validated by a successful request. sentThrough can exceed
  // the length after a trailing pop (orphan prune / system pop) — clamp.
  private unsentTail(): MessageParam[] {
    const from = Math.min(this.sentThrough, this.messages.length);
    return this.messages.slice(from);
  }

  private stripTrailingThinkingBlocks(): { strippedMessages: number; strippedBlocks: number } {
    let strippedMessages = 0;
    let strippedBlocks = 0;
    for (const msg of this.unsentTail()) {
      if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
      const res = stripTrailingThinkingFromContent(msg.content as Array<{ type?: string }>);
      if (res.stripped > 0) {
        msg.content = res.content as unknown as AnyContentBlock[];
        strippedMessages++;
        strippedBlocks += res.stripped;
      }
    }
    return { strippedMessages, strippedBlocks };
  }

  // True (and 'Worker killed' emitted) when cancel() landed while runTurn was
  // awaiting startup work — see cancelRequested.
  private cancelledDuringStartup(): boolean {
    if (!this.cancelRequested) return false;
    this.emit('error', 'Worker killed');
    this.inFlight = null;
    this.toolAbort = null;
    return true;
  }

  // An interrupt during auth/hooks must not silently lose a queued correction.
  turnInputAccepted = false;

  async runTurn(prompt: string): Promise<void> {
    // Reset synchronously, before the first await: the adapter calls runTurn
    // from spawn() and any kill() can only land after this line.
    this.cancelRequested = false;
    this.turnInputAccepted = false;
    try {
      await this.ensureStarted();
    } catch (err) {
      // Pre-flight auth surface: emit the [AUTH:claude] sentinel so the
      // chat renderer offers RE-LOGIN instead of a raw error string.
      if (err instanceof ClaudeNativeNoAuthError) {
        markClaudeAuthProblem('not authenticated'); // A2 — phone banner + notice
        this.emit('system_notice', '[AUTH:claude] Claude Native is not authenticated. Re-login to continue.');
        this.emit('error', 'claude auth required');
        return;
      }
      const detail = err instanceof Error ? err.message : String(err);
      markClaudeAuthProblem(detail); // A2 — pre-flight refresh failure
      this.emit('system_notice', `[AUTH:claude] Claude Native auth failed: ${detail}. Re-login to continue.`);
      this.emit('error', 'claude auth failed');
      return;
    }
    if (this.cancelledDuringStartup()) return;
    // §E1 (E1-Native) — reconcile MCP sessions against the operator's current
    // allowlist BEFORE buildToolDefs runs in the loop below, so the tool defs
    // reflect this turn's allowed servers. Best-effort: a failed reconcile must
    // not abort the turn — the worst case is a server's tools are absent this
    // turn (connectServer itself never throws; this guard covers anything else).
    try {
      await this.reconcileMcpSessions();
    } catch (err) {
      console.warn(`[claude-native:${this.workflowId.slice(0, 8)}] mcp session reconcile failed:`, err);
    }
    if (this.cancelledDuringStartup()) return;

    this.readSet = new Set();
    this.forcedAuthRefreshThisTurn = false; // A1 — one forced refresh per turn
    this.partialReadSet.clear(); // H62 — partial-read tracking re-arms each turn
    // The strip-and-retry recovery for a preserved-thinking 400 re-arms per
    // turn. Within a turn it stays one-shot (retries are bounded by `attempt`),
    // but a worker that self-healed once must not be left defenceless for the
    // rest of its life — that turned a recoverable 400 into a dead tab.
    this.bindingStripUsed = false;
    this.todos = [];
    // EFFICIENCY_PLAN.md Phase D §8a — fact-force gate re-arms every turn.
    // `filesEditedThisTurn` carries cross-tool-call state within one turn
    // only; clearing here is the single load-bearing reset (every
    // operator-initiated turn flows through runTurn). Cancel paths return
    // before mutating this set, so a cancelled turn leaves the prior
    // turn's set in place — defensible because the gate engages on the
    // NEXT operator message regardless.
    this.filesEditedThisTurn.clear();

    // Operator-initiated plan-mode entry. Dispatcher sets this on the
    // upcoming turn's WorkerConfig when the inline composer toggle was
    // armed; we flip the gate here so the first messages.create runs with
    // Write/Edit refused. The model is independently nudged (via
    // appendSystemPrompt) to call EnterPlanMode — when it does, that path
    // overwrites the same flag and drives the plan_set broadcast normally.
    if (this.config.claudeNativePlanModeArmed === true) {
      this.planMode = true;
    }

    // UserPromptSubmit hook fires before the first messages.create.
    const ups = await fireHooks(
      this.hooks,
      'UserPromptSubmit',
      'UserPromptSubmit',
      { prompt, workflow_id: this.workflowId, project_dir: this.config.cwd ?? '' },
      { cwd: this.config.cwd ?? process.cwd(), abortSignal: this.makeAbortSignal('toolAbort'), shells: this.shells, workflowId: this.workflowId },
    );
    const blocked = firstBlocking(ups);
    if (blocked) {
      this.emit('system_notice', `UserPromptSubmit hook blocked turn (exit ${blocked.exitCode}): ${blocked.stderr.trim().slice(0, 500)}`);
      this.emit('error', 'turn aborted by UserPromptSubmit hook');
      return;
    }
    if (this.cancelledDuringStartup()) return;

    // Drop any trailing orphan assistant(tool_use) before appending the
    // operator's user message — see pruneOrphanToolUse for the rationale.
    // Most turns are no-ops; only fires when a prior turn returned
    // mid-tool-dispatch (cancel / abort / fatal). Emit a ctx_action so the
    // operator can see what we removed.
    const pruned = this.pruneOrphanToolUse();
    if (pruned.droppedAssistantMessages > 0) {
      this.workflowEventBroadcast({
        type: 'ctx_action',
        workflowId: this.workflowId,
        action: 'prune_orphan_tool_use',
        trigger: 'recovery',
        detail: `dropped ${pruned.droppedAssistantMessages} orphan assistant message(s) before turn; unpaired tool_use ids: ${pruned.droppedIds.join(', ')}`,
      });
    }

    // Mirror recovery: a `*_tool_result` whose `server_tool_use` is gone 400s
    // every later request just as permanently, and neither orphan detector
    // above looks in that direction. `pruneServerToolEvidenceAfterTurn` no
    // longer produces the shape, so this is a no-op on every healthy turn —
    // it exists so no future path can wedge a worker for good.
    const dangling = stripDanglingServerToolResults(this.messages as Array<{ role?: string; content?: unknown }>);
    if (dangling.blocks > 0) {
      this.workflowEventBroadcast({
        type: 'ctx_action',
        workflowId: this.workflowId,
        action: 'prune_orphan_tool_use',
        trigger: 'recovery',
        detail: `dropped ${dangling.blocks} server-tool result block(s) with no matching server_tool_use before turn; tool_use ids: ${dangling.ids.join(', ')}`,
      });
    }

    // Append the operator's message. Image attachments become first-class
    // image content blocks (Anthropic supports png/jpeg/gif/webp via base64);
    // non-image attachments fold to `[attached file: ...]` text refs.
    // A role:'system' message directly followed by a user message is a 400;
    // trailing ones are only left behind when the round after them never
    // produced an assistant turn (abort / orphan prune). Nothing later is
    // bound to them, and the prefix diff re-appends whatever they carried.
    const poppedSystem = popTrailingSystemMessages(this.messages);
    if (poppedSystem > 0) console.log(`[claude-native:${this.workflowId.slice(0, 8)}] popped ${poppedSystem} trailing role:system message(s) before operator turn`);
    const skippedImages: SkippedImage[] = [];
    this.messages.push({ role: 'user', content: buildUserMessageContent(prompt, this.config.attachments, skippedImages) });
    this.turnInputAccepted = true;
    const skippedNotice = describeSkippedImages(skippedImages);
    if (skippedNotice) this.emit('system_notice', skippedNotice);
    // FABLE_51_APPEND_ONLY_PLAN.md §1.5 — per-turn operator notice (mailbox
    // depth, plan-mode arm). Lives on the user turn, never in `system`, and is
    // never removed: rebuilding it next turn would be a prefix edit.
    if (this.config.turnNotice && this.config.turnNotice.trim().length > 0) {
      appendTextToLastUserMessage(this.messages, this.config.turnNotice.trim());
      this.workflowEventBroadcast({
        type: 'ctx_action',
        workflowId: this.workflowId,
        action: 'turn_notice',
        trigger: 'operator',
        detail: `appended ${Buffer.byteLength(this.config.turnNotice, 'utf8')}-byte per-turn notice to the operator message (kept in history)`,
      });
    }

    const startMs = Date.now();
    this.currentTurnId = startMs;
    // H9 — fresh loop counters for this turn (primary_turn_started boundary).
    this.toolLoopGuard.reset();
    let totalUsage: Record<string, number> | undefined;
    // Track the LATEST round's usage separately. mergeUsage sums across
    // rounds, which is right for billing/output but wrong for context-fill —
    // the size of the prompt the model saw in context is the LAST round's
    // (cache_read + cache_creation + input), not the sum across rounds.
    let lastRoundUsage: Record<string, number> | undefined;
    let stopReason: string | null = null;
    let finalText = '';
    // Opus-5 plan Phase 3 — carry the LAST round's stop_details so the
    // refusal branch below can name the category/explanation.
    let stopDetails: StopDetails | null = null;

    // EFFICIENCY_PLAN.md Phase A — index where this turn's appended messages
    // start, so the end-of-turn telemetry walk only counts blocks added on
    // this turn (not the entire session).
    const turnMessageStart = this.messages.length - 1;

    let iterations = 0;
    while (iterations++ < MAX_TOOL_TURNS) {
      const round = await this.streamOneRound();
      if (!round) {
        // hard error; already emitted
        this.scrubServerToolEvidenceOnAbort(turnMessageStart);
        this.inFlight = null;
        this.toolAbort = null;
        return;
      }
      stopReason = round.stopReason;
      finalText = round.text;
      stopDetails = round.stopDetails ?? null;
      totalUsage = mergeUsage(totalUsage, round.usage);
      if (round.usage) lastRoundUsage = round.usage;

      // Re-emit init with the *echoed* model on the first round-trip so the
      // chat header upgrades from the requested ID to the canonical one
      // Anthropic actually ran. Mirrors the CLI's primary_model surface;
      // WorkerManager's init handler broadcasts worker_model → primary_model.
      if (round.echoedModel && round.echoedModel !== this.echoedModelEmitted) {
        this.echoedModelEmitted = round.echoedModel;
        this.emit('init', { model: round.echoedModel, sessionId: undefined });
        // Opus-5 plan Phase 2 — adopt the echo for capability lookups and,
        // when it differs from the requested id (alias tab), make the
        // resolution durable: a model_resolved event in events.jsonl (the
        // explicit release signal) + meta.resolvedModelId (turn-1 capability
        // fidelity after a restart). Persist is fire-and-forget — a failed
        // write must never break the turn.
        this.servedModel = round.echoedModel;
        this.servedModelFor = this.config.model;
        if (round.echoedModel !== this.config.model) {
          this.workflowEventBroadcast({
            type: 'model_resolved',
            workflowId: this.workflowId,
            requested: this.config.model,
            served: round.echoedModel,
          });
          const metaCwd = this.config.persistenceCwd ?? this.config.cwd;
          if (metaCwd && isClaudeModelAlias(this.config.model)) {
            void setResolvedModelId(metaCwd, this.workflowId, round.echoedModel).catch((err) => {
              console.warn(`[claude-native:${this.workflowId.slice(0, 8)}] resolvedModelId persist failed:`, err instanceof Error ? err.message : err);
            });
          }
        }
      }

      // Push the assistant turn to history (preserves thinking signatures
      // for verifiable reasoning continuity).
      this.messages.push({ role: 'assistant', content: round.contentBlocks });

      // Decide whether to continue the client-tool loop by the WORK Arco
      // itself must do — not by stop_reason alone. Opus 4.8 can return
      // stop_reason 'end_turn' for responses that still carry an unexecuted
      // client tool_use; gating on stop_reason alone abandons the client tool
      // and leaves an orphaned tool_use.
      //
      // Important distinction: Anthropic server tools (web_search / web_fetch)
      // are NOT Arco-dispatched tools. The API executes them internally; per
      // the server-tool contract, their result appears in the same assistant
      // turn. The documented "resend assistant content as-is" path is
      // stop_reason === 'pause_turn'. Do not treat a bare server_tool_use under
      // end_turn as pending work to loop on — that re-feeds the same server-tool
      // call and makes Opus 4.8 over-search instead of settling, which diverges
      // from Claude Code's behavior.
      // Gating on stop_reason alone silently abandons the tools: the model
      // narrates intent, the tool calls show in Activity, but nothing runs
      // (`tools 0B`) and the orphaned client tool_use is pruned next turn.
      if (!shouldContinueNativeToolLoop(round.contentBlocks, stopReason)) break;

      // ── Tool-use round-trip ──
      this.toolAbort = new AbortController();
      const toolResults: Array<{ type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }> = [];
      // Task children run in isolated child workflows with no shared
      // filesystem/process state, so concurrent dispatch is safe and
      // turns "write four docs in parallel" into actual parallelism.
      // Everything else stays sequential — Write/Edit/Bash can have
      // ordering requirements within a turn.
      const taskBlocks: ToolUseBlock[] = [];
      const otherBlocks: ToolUseBlock[] = [];
      for (const block of round.contentBlocks) {
        if (block.type !== 'tool_use') continue;
        if (block.name === 'Task') taskBlocks.push(block);
        else otherBlocks.push(block);
      }
      const taskPromises = taskBlocks.map((block) =>
        this.dispatchTool(block).then((result) => ({ block, result })),
      );
      // H9 — in-turn loop guard. Set when the operator has armed hard-stop and a
      // tool tripped; handled (graceful abort) once this round's results are in.
      let loopStopRequested = false;
      for (const block of otherBlocks) {
        const result = await this.dispatchTool(block);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: truncateOutput(result.text),
          ...(result.isError ? { is_error: true } : {}),
        });
        if (this.checkToolLoop(block, result)) loopStopRequested = true;
        if (this.inFlight?.signal.aborted) {
          this.emit('error', 'Worker killed');
          this.scrubServerToolEvidenceOnAbort(turnMessageStart);
          this.inFlight = null;
          this.toolAbort = null;
          return;
        }
      }
      const taskOutcomes = await Promise.all(taskPromises);
      for (const { block, result } of taskOutcomes) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: truncateOutput(result.text),
          ...(result.isError ? { is_error: true } : {}),
        });
        if (this.checkToolLoop(block, result)) loopStopRequested = true;
      }
      if (this.inFlight?.signal.aborted) {
        this.emit('error', 'Worker killed');
        this.scrubServerToolEvidenceOnAbort(turnMessageStart);
        this.inFlight = null;
        this.toolAbort = null;
        return;
      }
      // Only append a user(tool_result) turn when client tools actually ran.
      // When we continued for `pause_turn`, toolResults may be empty; pushing an
      // empty user message would 400 (and break the resend-as-is contract), so
      // skip it and let the assistant content alone drive the continuation.
      if (toolResults.length > 0) {
        // §2.2 — per-turn aggregate tool-result eviction. Cache-safe: rewrites
        // only THIS round's just-gathered results, before they are ever sent
        // (so no cache breakpoint has formed over them yet). Off unless the
        // operator arms ARCO_TOOL_EVICT — like clear_tool_uses it can spill a
        // result the model still needs. Cross-turn tail eviction lives in Fold.
        await this.maybeSpillTurnResults(round.contentBlocks, toolResults);
        this.messages.push({ role: 'user', content: toolResults as unknown as AnyContentBlock[] });
      }

      // H9 — graceful hard-stop (armed only). The tool_results are appended above
      // (so no assistant tool_use is left orphaned), then we abort the turn the
      // same way the MAX_TOOL_TURNS overflow does. Reversible: the operator just
      // sends the next turn. Default 'warn' mode never sets this.
      if (loopStopRequested) {
        this.emit('error', 'tool-loop guard stopped the turn — a tool looped without progress (ARCO_TOOL_LOOP_GUARD=stop)');
        this.scrubServerToolEvidenceOnAbort(turnMessageStart);
        this.inFlight = null;
        this.toolAbort = null;
        return;
      }

      // Phase 5 hook — same placement as ollama.ts. Drained items become
      // role:'user' messages before the next round-trip. Steer attachments
      // get the same image-block treatment as the operator's first prompt.
      //
      // Only drain after a client tool_result turn. A `pause_turn` round ends
      // the history on an assistant message whose server_tool_use has no result
      // yet; the continuation MUST resend it as the last message. Appending a
      // steer there 400s with "`web_fetch` tool use … found without a
      // corresponding `web_fetch_tool_result`" (2026-09-25 incident). Leaving
      // the steer queued is safe — the next client-tool round drains it, or
      // turnEngine dispatches it as its own turn once this one settles.
      if (toolResults.length === 0) continue;
      const steer = this.config.drainSteer?.() ?? [];
      for (const item of steer) {
        const skippedSteer: SkippedImage[] = [];
        this.messages.push({ role: 'user', content: buildUserMessageContent(item.content, item.attachments, skippedSteer) });
        const steerNotice = describeSkippedImages(skippedSteer);
        if (steerNotice) this.emit('system_notice', steerNotice);
      }
    }

    // Exhausting the iteration cap means the loop never hit the genuine-end
    // `break` above — work was still pending every round. stopReason is no
    // longer the continuation signal (Opus 4.8 mislabels it), so the cap
    // overflow alone is the runaway condition.
    if (iterations > MAX_TOOL_TURNS) {
      // §3.1 — surface the ceiling hit as a structured breaker event BEFORE the
      // bare error, so an operator reviewing events.jsonl sees a 'limit' trip
      // (same surface as the error-persistence breaker) rather than a silent
      // hard-exit. The turn still ends; this is the visible escort.
      this.workflowEventBroadcast({
        type: 'worker_stuck',
        workflowId: this.workflowId,
        escalation: 'limit',
        recommendedAction: 'pause',
        reason: `tool-loop hit the ${MAX_TOOL_TURNS}-iteration ceiling without an end_turn — ending the turn (raise ARCO_CLAUDE_NATIVE_MAX_TOOL_TURNS only if this is a genuine large workload).`,
      });
      this.emit('error', `tool-loop exceeded ${MAX_TOOL_TURNS} iterations without an end_turn`);
      this.scrubServerToolEvidenceOnAbort(turnMessageStart);
      this.inFlight = null;
      this.toolAbort = null;
      return;
    }

    const ctx = lookupCtx(this.capModel());
    // Surface a max_tokens truncation so the operator knows why the chat may
    // be empty or cut off mid-sentence — otherwise the turn just ends silent.
    if (stopReason === 'max_tokens') {
      const cap = chooseMaxTokens(this.capModel(), this.config.effort ?? 'high');
      const noun = finalText.length === 0 ? 'before producing any text' : 'mid-response';
      this.emit('system_notice', `Response truncated at max_tokens (${cap.toLocaleString()}) ${noun}. Try again with lower effort or a tighter prompt.`);
    }
    // The loop stops on this like max_tokens (shouldContinueNativeToolLoop) —
    // any tool_use in the truncated round is not run. Retrying as-is hits the
    // same wall, so point at the context valves instead.
    if (stopReason === 'model_context_window_exceeded') {
      const noun = finalText.length === 0 ? 'before producing any text' : 'mid-response';
      this.emit('system_notice', `Response truncated ${noun}: the context window is full (stop_reason: model_context_window_exceeded). Any pending tool call was not run. Fold or Handoff this tab to free context, then continue.`);
    }
    // Opus-5 plan Phase 3 — a classifier decline is HTTP 200 with
    // stop_reason 'refusal', so errorClassifier never sees it and the turn
    // used to end blank. Surface WHY in chat + a durable primary_refusal
    // event for Activity/transcript review. No pruning needed here: the
    // per-request scrubEmptyTextContent / stripTrailingThinkingBlocks pass in
    // streamOneRound repairs the empty/partial assistant message before the
    // next messages.create ships it.
    if (stopReason === 'refusal') {
      const category = stopDetails?.category ?? null;
      const explanation = stopDetails?.explanation ?? null;
      const hadPartialOutput = finalText.length > 0;
      this.workflowEventBroadcast({
        type: 'primary_refusal',
        workflowId: this.workflowId,
        category,
        explanation,
        hadPartialOutput,
      });
      this.emit('system_notice',
        `Anthropic declined this request (stop_reason: refusal${category ? `, category: ${category}` : ''}).`
        + (explanation ? ` ${explanation}` : '')
        + (hadPartialOutput
          ? ' The partial output above was kept; the decline landed mid-response.'
          : ' No output was produced.')
        + ' Rephrase the request and try again.');
    }
    // EFFICIENCY_PLAN.md Phase A — walk the turn's appended messages and
    // sum thinking + tool_result bytes. Block content can be string or an
    // array of typed blocks (Anthropic SDK shape); guard both.
    let thinkingBytes = 0;
    let toolResultBytes = 0;
    let serverToolResultBytes = 0;
    for (let i = Math.max(0, turnMessageStart); i < this.messages.length; i++) {
      const msg = this.messages[i];
      const content = (msg as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;
      for (const block of content as Array<Record<string, unknown>>) {
        const t = block?.type;
        if (t === 'thinking') {
          const txt = typeof block.thinking === 'string' ? block.thinking : '';
          thinkingBytes += Buffer.byteLength(txt, 'utf8');
        } else if (t === 'tool_result') {
          const c = block.content;
          if (typeof c === 'string') {
            toolResultBytes += Buffer.byteLength(c, 'utf8');
          } else if (Array.isArray(c)) {
            for (const sub of c as Array<Record<string, unknown>>) {
              const txt = typeof sub.text === 'string' ? sub.text : '';
              toolResultBytes += Buffer.byteLength(txt, 'utf8');
            }
          }
        } else if (typeof t === 'string' && isServerToolResultType(t)) {
          // Anthropic server tools return evidence inside the assistant turn.
          // It is not a user-side tool_result, but it still becomes prompt
          // context on the next provider request and explains large CTX jumps.
          serverToolResultBytes += Buffer.byteLength(JSON.stringify(block), 'utf8');
        }
      }
    }
    // FABLE_51_APPEND_ONLY_PLAN.md §1.3 — on binding-enforcing models the
    // turn's own messages are already bound by its later thinking blocks, so
    // the evidence prune would be a prefix edit; keep everything and let
    // Fold / Compact be the pressure valves. Thinking is kept on every model.
    // On every OTHER model the prune still runs, but it leaves the latest
    // assistant message alone — see pruneServerToolEvidenceAfterTurn; editing
    // that one message is what wedged two tabs on 2026-09-05.
    if (!enforcesPreservedThinking(this.capModel())) {
      const prunedServerEvidence = pruneServerToolEvidenceAfterTurn(this.messages as Array<{ role?: string; content?: unknown }>, turnMessageStart);
      if (prunedServerEvidence.blocks > 0) {
        console.log(
          `[claude-native:${this.workflowId.slice(0, 8)}] pruned ${prunedServerEvidence.blocks} server-tool evidence block(s) ` +
          `(${prunedServerEvidence.bytes} bytes) from retained Native history after final answer (thinking kept)`,
        );
      }
    }
    const countedPromptTokens = await this.countCurrentContextTokens();
    const usagePromptTokens = lastRoundUsage
      ? (lastRoundUsage.cache_read_input_tokens ?? 0) +
        (lastRoundUsage.cache_creation_input_tokens ?? 0) +
        (lastRoundUsage.input_tokens ?? 0)
      : undefined;
    const lastPromptTokens = countedPromptTokens ?? usagePromptTokens;

    this.emit('result', {
      text: finalText,
      costUsd: 0,
      durationMs: Date.now() - startMs,
      ...(totalUsage ? { usage: totalUsage } : {}),
      ...(ctx !== undefined ? { modelContextWindow: ctx } : {}),
      ...(typeof lastPromptTokens === 'number' && lastPromptTokens > 0 ? { lastPromptTokens } : {}),
      thinkingBytes,
      toolResultBytes,
      toolResultBytesRaw: toolResultBytes,
      serverToolResultBytes,
    });

    // Stop hook (informational).
    // Clear the per-turn controller before returning to idle. `streamOneRound`
    // installs a fresh AbortController for every provider round; leaving the
    // final successful controller in place made later operator COMPACT clicks
    // look like a live turn even after `wf.busy` had cleared.
    this.inFlight = null;
    this.toolAbort = null;
    void fireHooks(
      this.hooks,
      'Stop',
      'Stop',
      { workflow_id: this.workflowId, stop_reason: stopReason ?? 'unknown' },
      { cwd: this.config.cwd ?? process.cwd(), abortSignal: this.makeAbortSignal('toolAbort'), shells: this.shells, workflowId: this.workflowId },
    ).catch((err) => console.warn(`[claude-native:${this.workflowId.slice(0, 8)}] Stop hook failed:`, err));
    this.toolAbort = null;
  }

  private async countCurrentContextTokens(): Promise<number | undefined> {
    if (!this.client) return undefined;
    try {
      const effort = this.config.effort ?? 'high';
      const thinkingParams = buildThinkingParams(this.capModel(), effort, this.config.claudeNativeThinkingDisplay ?? 'omitted');
      const betaHeader = this.buildBetaHeader();
      const prefix = this.peekPrefix();
      const counted = await this.client.messages.countTokens({
        model: this.requestModel(),
        cache_control: { type: 'ephemeral' },
        system: prefix.system as unknown as string,
        messages: toWireMessages(this.messages) as unknown as Parameters<Anthropic['messages']['countTokens']>[0]['messages'],
        ...(prefix.tools.length > 0 ? {
          tools: prefix.tools.filter((t) => !isClaudeServerToolDef(t)) as unknown as Parameters<Anthropic['messages']['countTokens']>[0]['tools'],
        } : {}),
        ...thinkingParams,
      } as Parameters<Anthropic['messages']['countTokens']>[0], {
        headers: { 'anthropic-beta': betaHeader },
      });
      return counted.input_tokens;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.warn(`[claude-native:${this.workflowId.slice(0, 8)}] count_tokens failed; falling back to response usage: ${detail.slice(0, 300)}`);
      return undefined;
    }
  }

  // One messages.create round-trip with streaming + retry-with-backoff
  // for transient errors. Returns null on hard failure (already emitted).
  private async streamOneRound(): Promise<null | {
    stopReason: string | null;
    text: string;
    contentBlocks: AnyContentBlock[];
    usage?: Record<string, number>;
    echoedModel?: string;
    stopDetails?: StopDetails | null;
  }> {
    let attempt = 0;
    while (true) {
      if (this.cancelRequested) {
        this.emit('error', 'Worker killed');
        return null;
      }
      this.inFlight = new AbortController();
      this.attemptStreamedChars = 0;
      try {
        const effort = this.config.effort ?? 'high';
        const thinkingDisplay = this.config.claudeNativeThinkingDisplay ?? 'omitted';
        const thinkingParams = buildThinkingParams(this.capModel(), effort, thinkingDisplay);
        const maxTokens = chooseMaxTokens(this.capModel(), effort);
        // One-line per round-trip so an operator-driven mid-session swap
        // is visible in server stderr without grepping events.jsonl.
        const thinkingLabel = supportsClaudeAdaptiveThinking(this.capModel())
          ? `adaptive(${effort},${thinkingDisplay})`
          : (thinkingParams.thinking ? `budget(${(thinkingParams.thinking as { budget_tokens?: number }).budget_tokens})` : 'none');
        // Phase 7c-followup — recompute beta header per-request so a
        // live model swap (CONFIG-tab picker → update_primary_config)
        // re-evaluates the model's catalog capabilities before sending.
        // The SDK's defaultHeaders snapshot is overridden via the
        // per-request `headers` option below.
        await this.hydrateContextManagementCapabilities();
        const ctxMgmtBody = this.buildContextManagementBody();
        const ctxMgmtEdits = (ctxMgmtBody.context_management as { edits?: Array<{ type?: string }> } | undefined)?.edits ?? [];
        const ctxMgmtLabel = ctxMgmtBody.context_management
          ? ` ctx_mgmt=${[
              ctxMgmtEdits.some((e) => e.type === 'clear_thinking_20251015' || e.type === 'clear_tool_uses_20250919') ? 'clear' : null,
              ctxMgmtEdits.some((e) => e.type === 'compact_20260112') ? 'compact' : null,
            ].filter(Boolean).join('+')}`
          : '';
        const scrubbed = this.scrubEmptyTextContent();
        if (scrubbed.droppedTextBlocks > 0 || scrubbed.droppedImageBlocks > 0 || scrubbed.patchedEmptyMessages > 0 || scrubbed.patchedToolResults > 0 || scrubbed.replacedOversizedImages > 0 || scrubbed.retypedImages > 0) {
          const imageRepairs = scrubbed.replacedOversizedImages > 0 || scrubbed.retypedImages > 0
            ? `; replaced ${scrubbed.replacedOversizedImages} over-5MB image block(s) with a text placeholder and corrected ${scrubbed.retypedImages} image media_type(s)`
            : '';
          this.workflowEventBroadcast({
            type: 'ctx_action',
            workflowId: this.workflowId,
            action: 'scrub_empty_text_blocks',
            trigger: 'recovery',
            detail: `dropped ${scrubbed.droppedTextBlocks} empty text block(s) and ${scrubbed.droppedImageBlocks} empty image block(s); patched ${scrubbed.patchedEmptyMessages} empty message(s) and ${scrubbed.patchedToolResults} empty tool result(s)${imageRepairs} before Anthropic request`,
          });
        }
        const trimmedThinking = this.stripTrailingThinkingBlocks();
        if (trimmedThinking.strippedBlocks > 0) {
          this.workflowEventBroadcast({
            type: 'ctx_action',
            workflowId: this.workflowId,
            action: 'strip_trailing_thinking',
            trigger: 'recovery',
            detail: `stripped ${trimmedThinking.strippedBlocks} trailing thinking block(s) from ${trimmedThinking.strippedMessages} assistant message(s) — Anthropic rejects an assistant message ending in a thinking block`,
          });
        }
        // Log the configured value alongside the dispatched one so an alias
        // tab's resolution is visible in journalctl without a code read.
        const dispatchModel = this.requestModel();
        const modelLabel = dispatchModel === this.config.model ? dispatchModel : `${this.config.model}→${dispatchModel}`;
        // FABLE_51_APPEND_ONLY_PLAN.md — frozen prefix (+ appended delta
        // message when config changed). Must run AFTER the scrubs above so the
        // appended role:'system' message is never itself scrubbed, and BEFORE
        // the beta header is finalised (a first tool change turns the beta on).
        const prefix = this.resolvePrefixForRequest();
        const betaHeaderFinal = this.buildBetaHeader();
        const wireMessages = toWireMessages(this.messages);
        const wireCount = this.messages.length;
        const prefixLabel = prefix.notes.length > 0 ? ` prefix=[${prefix.notes.join('; ')}]` : (this.prefixThawed ? ' prefix=thawed' : ' prefix=frozen');
        console.log(`[claude-native:${this.workflowId.slice(0, 8)}] → messages.create model=${modelLabel} effort=${effort} thinking=${thinkingLabel} max_tokens=${maxTokens}${ctxMgmtLabel}${prefixLabel}`);
        const resp = await this.client!.messages.create({
          model: dispatchModel,
          max_tokens: maxTokens,
          // Top-level automatic prompt caching moves the cache breakpoint
          // forward through messages[] as the conversation/tool loop grows.
          // Explicit system breakpoints above keep the stable front matter
          // warm; this catches the expensive assistant/tool_result history.
          cache_control: { type: 'ephemeral' },
          system: prefix.system as unknown as string,
          messages: wireMessages as unknown as Parameters<Anthropic['messages']['create']>[0]['messages'],
          ...(prefix.tools.length > 0 ? {
            tools: prefix.tools as unknown as Parameters<Anthropic['messages']['create']>[0]['tools'],
          } : {}),
          stream: true,
          ...thinkingParams,
          ...ctxMgmtBody,
        } as Parameters<Anthropic['messages']['create']>[0], {
          signal: this.inFlight.signal,
          headers: { 'anthropic-beta': betaHeaderFinal },
        });

        const round = await this.consumeStream(resp as AsyncIterable<unknown>);
        // Everything on the wire for this round was accepted verbatim; later
        // scrubs must not revisit it (FABLE_51_APPEND_ONLY_PLAN.md §1.4).
        this.sentThrough = Math.max(this.sentThrough, wireCount);
        return round;
      } catch (err) {
        const handled = await this.handleApiError(err, attempt);
        if (handled === 'retry' && attempt < MAX_RETRY_ATTEMPTS - 1) {
          if (this.attemptStreamedChars > 0) {
            const n = this.attemptStreamedChars;
            this.attemptStreamedChars = 0;
            this.emit('text_discard', n);
            this.emit('system_notice', `Discarded ${n.toLocaleString()} chars of partial output from the interrupted attempt; the retry regenerates the response from the start.`);
          }
          attempt++;
          continue;
        }
        return null;
      }
    }
  }

  private async consumeStream(stream: AsyncIterable<unknown>): Promise<{
    stopReason: string | null;
    text: string;
    contentBlocks: AnyContentBlock[];
    usage?: Record<string, number>;
    echoedModel?: string;
    stopDetails?: StopDetails | null;
  }> {
    const blocks: AnyContentBlock[] = [];
    // Track current tool_use input json accumulation per block index.
    const toolJson = new Map<number, string>();
    let stopReason: string | null = null;
    let usage: Record<string, number> | undefined;
    let allText = '';
    let echoedModel: string | undefined;
    // Opus-5 plan Phase 3 — populated only on stop_reason 'refusal' (and can
    // still be null then); rides message_delta alongside stop_reason.
    let stopDetails: StopDetails | null | undefined;
    // Raw `usage.iterations` (non-numeric, so applyUsageDelta drops it) — the
    // only place a server compaction's summarized-token count is reported.
    let usageIterations: unknown;

    for await (const evRaw of stream) {
      const ev = evRaw as unknown as {
        type: string;
        index?: number;
        content_block?: {
          type: string;
          id?: string;
          name?: string;
          text?: string;
          thinking?: string;
          data?: string;
          input?: unknown;
          caller?: unknown;
          tool_use_id?: string;
          content?: unknown;
          file_id?: string;
          [key: string]: unknown;
        };
        delta?: { type?: string; text?: string; thinking?: string; signature?: string; partial_json?: string; content?: string | null; stop_reason?: string; stop_details?: StopDetails | null };
        message?: { model?: string; usage?: Record<string, number>; stop_details?: StopDetails | null; input_transformations?: unknown };
        usage?: Record<string, number>;
      };
      switch (ev.type) {
        case 'message_start': {
          if (ev.message?.usage) usage = { ...ev.message.usage };
          if (ev.message?.usage && 'iterations' in ev.message.usage) usageIterations = (ev.message.usage as Record<string, unknown>).iterations;
          if (ev.message?.model) echoedModel = ev.message.model;
          if (ev.message?.stop_details !== undefined) stopDetails = ev.message.stop_details;
          // FABLE_51_APPEND_ONLY_PLAN.md §2 — under the binding-controls beta
          // every response says what the API dropped from OUR request. Empty
          // on every round = the harness is append-only; a
          // prefix_binding_mismatch is a bug to chase; model_binding_mismatch
          // right after a model swap is expected.
          const xf = summarizeInputTransformations(ev.message?.input_transformations);
          if (xf) {
            console.log(`[claude-native:${this.workflowId.slice(0, 8)}] input_transformations=${xf.count}${xf.count > 0 ? ` (${xf.detail})` : ''}`);
            // Broadcast only when the dropped set CHANGES. A drop is sticky — the
            // edited message is resent on every round of every later turn — so
            // an unconditional broadcast floods the chat with one identical
            // notice per API request (2026-09-25 incident, after an abort scrub
            // edited a thinking-bearing message). The first occurrence lands in
            // events.jsonl; every repeat is still in the console log above.
            const dropKey = xf.count > 0 ? xf.detail : null;
            const dropChanged = dropKey !== this.lastThinkingDropKey;
            this.lastThinkingDropKey = dropKey;
            if (xf.count > 0 && dropChanged) {
              this.workflowEventBroadcast({
                type: 'ctx_action',
                workflowId: this.workflowId,
                action: 'thinking_dropped_by_api',
                trigger: 'api',
                detail: `Anthropic dropped ${xf.count} thinking block(s) from the request (prefix mismatch: ${xf.prefixMismatch}, model mismatch: ${xf.modelMismatch}): ${xf.detail}`,
              });
            }
          }
          break;
        }
        case 'content_block_start': {
          const idx = ev.index ?? 0;
          const cb = ev.content_block;
          if (!cb) break;
          if (cb.type === 'text') {
            blocks[idx] = { type: 'text', text: '' };
          } else if (cb.type === 'thinking') {
            blocks[idx] = { type: 'thinking', thinking: '' };
          } else if (cb.type === 'redacted_thinking') {
            blocks[idx] = { type: 'redacted_thinking', data: cb.data ?? '' };
          } else if (cb.type === 'tool_use') {
            blocks[idx] = { type: 'tool_use', id: cb.id ?? '', name: cb.name ?? '', input: {} };
            toolJson.set(idx, '');
          } else if (cb.type === 'server_tool_use') {
            blocks[idx] = {
              type: 'server_tool_use',
              id: cb.id ?? '',
              name: cb.name ?? '',
              input: cb.input ?? {},
              ...(cb.caller !== undefined ? { caller: cb.caller } : {}),
            };
            toolJson.set(idx, '');
          } else if (isServerToolResultType(cb.type)) {
            blocks[idx] = { ...cb, type: cb.type };
          } else if (cb.type === 'compaction') {
            // Server compaction summary (see CompactionBlock). Captured in
            // stream order so it goes back verbatim; deliberately NOT emitted
            // as 'text' — the raw summary never reaches the chat transcript.
            blocks[idx] = { ...cb, type: 'compaction', content: typeof cb.content === 'string' ? cb.content : null };
          }
          break;
        }
        case 'content_block_delta': {
          const idx = ev.index ?? 0;
          const delta = ev.delta;
          if (!delta) break;
          const block = blocks[idx];
          if (delta.type === 'text_delta' && delta.text && block?.type === 'text') {
            block.text += delta.text;
            allText += delta.text;
            this.attemptStreamedChars += delta.text.length;
            this.emit('text', delta.text);
          } else if (delta.type === 'thinking_delta' && delta.thinking && block?.type === 'thinking') {
            block.thinking += delta.thinking;
            this.emit('thinking', delta.thinking);
          } else if (delta.type === 'signature_delta' && delta.signature && block?.type === 'thinking') {
            block.signature = delta.signature;
          } else if (delta.type === 'input_json_delta' && delta.partial_json !== undefined && (block?.type === 'tool_use' || block?.type === 'server_tool_use')) {
            toolJson.set(idx, (toolJson.get(idx) ?? '') + delta.partial_json);
          } else if (delta.type === 'compaction_delta' && typeof delta.content === 'string' && block?.type === 'compaction') {
            // Documented as one delta carrying the whole summary; append anyway
            // so a future multi-delta stream can't silently truncate it.
            block.content = (block.content ?? '') + delta.content;
          }
          break;
        }
        case 'content_block_stop': {
          const idx = ev.index ?? 0;
          const block = blocks[idx];
          if (block?.type === 'tool_use') {
            const raw = toolJson.get(idx) ?? '';
            try { block.input = raw ? JSON.parse(raw) : {}; }
            catch { block.input = { _parse_error: raw }; }
            this.emitToolActivity(block, block.input, 'started');
          } else if (block?.type === 'server_tool_use') {
            const raw = toolJson.get(idx) ?? '';
            if (raw) {
              try { block.input = JSON.parse(raw); }
              catch { block.input = { _parse_error: raw }; }
            }
            this.emit('tool_use', { name: block.name, input: typeof block.input === 'string' ? block.input : JSON.stringify(block.input) });
          }
          toolJson.delete(idx);
          break;
        }
        case 'message_delta': {
          if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
          if (ev.delta?.stop_details !== undefined) stopDetails = ev.delta.stop_details;
          // Cumulative per message — overwrite, never sum (applyUsageDelta).
          if (ev.usage) usage = applyUsageDelta(usage, ev.usage);
          if (ev.usage && 'iterations' in ev.usage) usageIterations = (ev.usage as Record<string, unknown>).iterations;
          break;
        }
        case 'message_stop':
        case 'ping':
        default:
          break;
      }
    }

    // Densify blocks (skip undefined slots in case the array isn't contiguous).
    const dense: AnyContentBlock[] = [];
    for (const b of blocks) if (b) dense.push(b);
    this.noticeServerCompaction(dense, usageIterations);
    return { stopReason, text: allText, contentBlocks: dense, usage, echoedModel, stopDetails };
  }

  // One cheap system_notice per compacting response so the operator can see
  // the server replaced earlier context (hygiene B: no silent context
  // manipulation). The summary itself stays out of the transcript.
  private noticeServerCompaction(blocks: readonly AnyContentBlock[], iterations: unknown): void {
    const block = blocks.find((b) => b.type === 'compaction');
    if (!block) return;
    const chars = typeof block.content === 'string' ? block.content.length : 0;
    const it = summarizeCompactionIterations(iterations);
    const detail = it
      ? `summarized ${it.inputTokens.toLocaleString()} earlier tokens into a ${it.outputTokens.toLocaleString()}-token summary`
      : `summarized earlier context into a ${chars.toLocaleString()}-char summary`;
    console.log(`[claude-native:${this.workflowId.slice(0, 8)}] server compaction block received (${chars} chars${it ? `, in=${it.inputTokens} out=${it.outputTokens}` : ''})`);
    this.emit('system_notice', `Server compaction ${detail}; the summary replaces that history on later requests.`);
  }

  private async dispatchTool(block: ToolUseBlock): Promise<{ text: string; isError: boolean }> {
    if (this.config.interactionMode === 'chat' && this.config.voiceOperator) {
      const text = await executeComputerTool(this.workflowId, block.name, block.input);
      return { text, isError: text.startsWith('[error]') };
    }
    const matcher = block.name;
    const ctx: NativeToolContext = {
      cwd: this.config.cwd ?? process.cwd(),
      abortSignal: this.makeAbortSignal('toolAbort'),
      shells: this.shells,
      readSet: this.readSet,
      partialReadSet: this.partialReadSet,
      planMode: this.planMode,
      taskDisabled: this.taskDisabled,
      onTodos: (todos) => {
        this.todos = todos;
        this.todosBroadcast(todos);
      },
      // §C3 — post-write LSP diagnostics. Fire-and-forget: notifyWritten never
      // throws synchronously and we ignore the returned promise (the tool
      // already wraps the call in try/catch, but be belt-and-suspenders so an
      // async rejection can't surface as an unhandled rejection). Diagnostics
      // forwarded as workflow-scoped `diagnostics` events the client renders.
      onFileWritten: (absPath) => {
        const cwd = this.config.cwd ?? process.cwd();
        void lspManager.notifyWritten(absPath, cwd, this.workflowId, (msg) => {
          this.workflowEventBroadcast(msg);
        }).catch(() => { /* diagnostics are best-effort */ });
      },
      // DD3 — a Write/Edit waited on the per-realpath mutation lock (another
      // member/Task was mid-write on the same file). Surface it as a durable
      // workflow event so a contended file is visible in transcript review.
      onFileMutationQueued: ({ tool, path, waitedForMs }) => {
        this.workflowEventBroadcast({
          type: 'file_mutation_queued',
          workflowId: this.workflowId,
          toolUseId: block.id,
          toolName: tool,
          path,
          waitedForMs,
        });
      },
      enterPlanMode: async (plan) => this.handleEnterPlanMode(plan),
      exitPlanMode: async (summary) => this.handleExitPlanMode(summary),
      askUserQuestion: async (question, options) => this.handleAskUserQuestion(question, options),
      // Capture the parent assistant's tool_use block id in closure so the
      // task_started/task_status broadcasts can reference it for chat-side
      // lookup (the inline Task card matches on toolUseId).
      spawnTask: async (args) => this.handleSpawnTask({ ...args, toolUseId: block.id }),
      readTaskOutput: async (taskId) => this.handleReadTaskOutput(taskId),
    };

    const initialInput = (block.input && typeof block.input === 'object' ? block.input : {}) as Record<string, unknown>;
    let input: Record<string, unknown> = initialInput;

    // PreToolUse hook — non-zero blocks; stderr surfaces as the tool result.
    const pre = await fireHooks(this.hooks, 'PreToolUse', matcher,
      { tool_name: block.name, tool_input: input, workflow_id: this.workflowId },
      { cwd: ctx.cwd, abortSignal: ctx.abortSignal, shells: this.shells, workflowId: this.workflowId },
    );
    const blocked = firstBlocking(pre);
    if (blocked) {
      const detail = blocked.stderr.trim() || `(hook exited ${blocked.exitCode}${blocked.timedOut ? ', timed out' : ''})`;
      const text = `[blocked by PreToolUse hook] ${detail.slice(0, 1000)}`;
      this.emitToolActivity(block, input, 'failed', text);
      return { text, isError: true };
    }

    // EFFICIENCY_PLAN.md Phase B0 — fold any PreToolUse hook's
    // hookSpecificOutput.updatedInput into the dispatched input. Last-write-
    // wins matches Claude Code's documented behavior. Each rewrite emits a
    // hook_rewrote_input event so transcript review can attribute the
    // mutation back to its origin (e.g. rtk vs. a bespoke project hook).
    for (const r of pre) {
      const parsed = parseHookOutput(r.stdout);
      const next = parsed.hookSpecificOutput?.updatedInput;
      if (!next) continue;
      const rewritten = { ...input, ...next };
      this.workflowEventBroadcast({
        type: 'hook_rewrote_input',
        workflowId: this.workflowId,
        toolUseId: block.id,
        toolName: block.name,
        hookCommand: r.command ?? '(unknown)',
        originalInput: JSON.stringify(input),
        rewrittenInput: JSON.stringify(rewritten),
      });
      input = rewritten;
    }

    // EFFICIENCY_PLAN.md Phase 6b.2 — tool-call counter for the auto-
    // threshold opt-in. Counts every dispatched tool call (including
    // gated/blocked ones — the model still spent context on the call).
    this.toolCallCountSinceCompact += 1;
    // EFFICIENCY_PLAN.md Phase D §8b — broadcast the worker-authoritative
    // count so the composer chip can read it instead of recounting from
    // events. `maybeEmitAutoThreshold` below resets the counter on auto-
    // compact firing and emits a 0 follow-up after the action lands.
    this.workflowEventBroadcast({
      type: 'primary_tool_counter',
      workflowId: this.workflowId,
      toolCallsSinceCompact: this.toolCallCountSinceCompact,
    });
    this.maybeEmitAutoThreshold();

    // EFFICIENCY_PLAN.md Phase 6c + Phase D §8a — pre-tool-use guards in a
    // deterministic order. Cheap path-shape check first (config-protection
    // never touches state), then the state-bearing fact-force gate. Both
    // emit `tool_gate_triggered`; only the first blocking decision returns
    // a synthetic tool_result. Documented in `docs/GOTCHAS.md § Efficiency`.
    // Config-protection defaults ON (safety gate); the operator can relax it
    // per-tab via `efficiencyConfigProtection: 'off'` when a legitimate config
    // edit is needed. Absent field ⇒ gate ON, so opting out is always explicit.
    // H17 — hardline command floor. ALWAYS ON (not operator-disablable) and
    // checked FIRST: a self-restart/self-kill/rm -rf of the repo would take down
    // this turn + every other tab, so it can never run from an agent turn.
    const hardline = checkHardlineCommand(block.name, input, ctx.cwd);
    if (hardline.blocked) {
      this.workflowEventBroadcast({
        type: 'tool_gate_triggered',
        workflowId: this.workflowId,
        toolUseId: block.id,
        toolName: block.name,
        gate: 'hardline-command-floor',
        decision: 'blocked',
        reason: hardline.reason,
      });
      this.emitToolActivity(block, input, 'failed', hardline.syntheticResult);
      return { text: hardline.syntheticResult, isError: true };
    }

    const guard = (this.config.efficiencyConfigProtection ?? 'on') === 'on'
      ? checkConfigProtection(block.name, input, ctx.cwd)
      : { blocked: false as const };
    if (guard.blocked) {
      this.workflowEventBroadcast({
        type: 'tool_gate_triggered',
        workflowId: this.workflowId,
        toolUseId: block.id,
        toolName: block.name,
        gate: 'config-protection',
        decision: 'blocked',
        reason: guard.reason,
      });
      this.emitToolActivity(block, input, 'failed', guard.syntheticResult);
      return { text: guard.syntheticResult, isError: true };
    }
    // Fact-force runs on Edit/Write/MultiEdit only and never on read tools
    // (the model needs to inspect first). Operator opt-in is per-tab via
    // `efficiencyFactForce: 'on'`. Default 'off' for all tabs: this synthetic
    // failure/retry is an operator opt-in because it adds transcript context
    // without verifying the facts (see EFFICIENCY_PLAN.md §8a).
    if ((this.config.efficiencyFactForce ?? 'off') === 'on') {
      const ff = checkFactForceFirstEdit(block.name, input, ctx.cwd, this.filesEditedThisTurn);
      if (ff.resolvedPath !== null) {
        // Record the path BEFORE returning the synthetic result so the
        // model's subsequent re-issued Edit on the same path passes through
        // silently. Path is added on both blocked and allowed branches: a
        // first-blocked-then-re-issued sequence within one turn only
        // engages the gate once.
        this.filesEditedThisTurn.add(ff.resolvedPath);
      }
      if (ff.blocked) {
        this.workflowEventBroadcast({
          type: 'tool_gate_triggered',
          workflowId: this.workflowId,
          toolUseId: block.id,
          toolName: block.name,
          gate: 'fact-force-first-edit',
          decision: 'blocked',
          reason: ff.reason,
        });
        this.emitToolActivity(block, input, 'failed', ff.syntheticResult);
        return { text: ff.syntheticResult, isError: true };
      }
    }

    // DEBAG (docs/DEBAG_PLAN.md sub-phase 1) — operator-armed durable review
    // gate. `evaluateGate` returns a proposal ONLY when `reviewSafeMode` is
    // armed for this tab AND the call is sensitive (static allowlist in
    // gateReview.ts). Default OFF ⇒ null ⇒ the hot path is untouched. It runs
    // AFTER the existing hardline/config/fact-force guards (a call already
    // refused there never reaches here) and sees the EFFECTIVE post-hook-rewrite
    // `input`, so the operator-facing proposal matches what would actually run.
    //
    // The gate PARKS the turn. We persist the pending gate to the sidecar and
    // write the durable `gate_required` proposal BEFORE suspending (plan §4.6 —
    // writing it after reopens the lost-on-crash hole). Sequential tool dispatch
    // means the for-loop simply waits here (plan §4.4). Sub-phase 4: the sidecar
    // record lets rehydrateGatesOnce re-surface this gate after a restart.
    const gate = evaluateGate((this.config.reviewSafeMode ?? 'off') === 'on', block.name, input, ctx.cwd);
    if (gate) {
      const liveArgsAtFire = gate.proposedArgs;
      const createdAt = Date.now();
      // Sub-phase 5 — scoped standing approval ("approve all like this"). The
      // LIVE signature (computed by evaluateGate from the current args, §4.1) is
      // matched against the operator's standing list: an exact, non-lossy match
      // auto-approves WITHOUT parking. A changed command hashes differently →
      // no match → it parks normally. The auto-approval is still recorded
      // (gate_resolved, standing:true) so the transcript shows it was allowed.
      const standingApproved = await hasStandingApproval(ctx.cwd, this.workflowId, gate.signature).catch(() => false);
      if (standingApproved) {
        this.workflowEventBroadcast({
          type: 'gate_resolved',
          workflowId: this.workflowId,
          gateId: block.id,
          toolUseId: block.id,
          toolName: block.name,
          decision: 'approve',
          wasEdited: false,
          liveArgsAtFire,
          standing: true,
          createdAt,
        });
        // Fall through (no park) — the call runs below with the original input.
      } else {
        // Best-effort durability — never block the turn on a sidecar write
        // failure (the events.jsonl gate_required below is the audit source).
        await recordPendingGate(ctx.cwd, this.workflowId, {
          gateId: block.id,
          toolName: block.name,
          category: gate.category,
          reason: gate.reason,
          proposedArgs: gate.proposedArgs,
          signature: gate.signature,
          createdAt,
        }).catch((e) => console.warn(`[arco] [${this.workflowId.slice(0, 8)}] gate sidecar write failed:`, e));
        this.workflowEventBroadcast({
          type: 'gate_required',
          workflowId: this.workflowId,
          gateId: block.id,
          toolUseId: block.id,
          toolName: block.name,
          category: gate.category,
          reason: gate.reason,
          proposedArgs: gate.proposedArgs,
          signature: gate.signature,
          createdAt,
        });
        let resolution: { decision: 'approve' | 'reject'; finalArgs?: Record<string, unknown>; remember?: boolean };
        try {
          resolution = await new Promise((resolve, reject) => {
            this.pendingGates.set(block.id, {
              gateId: block.id,
              toolName: block.name,
              category: gate.category,
              reason: gate.reason,
              argsPreview: JSON.stringify(gate.proposedArgs).slice(0, 400),
              resolve,
              reject,
            });
          });
        } catch (err) {
          // cancel()/dispose() rejected the park. Drop the handle + sidecar
          // record and unwind the tool loop with an error result (the
          // aborted-signal check downstream handles the turn teardown). Clearing
          // the sidecar stops a cancelled turn's gate from resurrecting on the
          // next rehydrate.
          this.pendingGates.delete(block.id);
          await clearPendingGate(ctx.cwd, this.workflowId, block.id).catch(() => { /* ignore */ });
          const m = err instanceof Error ? err.message : String(err);
          this.emitToolActivity(block, input, 'failed', `[review gate aborted] ${m}`);
          return { text: `[review gate aborted] ${m}`, isError: true };
        }
        await clearPendingGate(ctx.cwd, this.workflowId, block.id).catch(() => { /* ignore */ });
        const outcome = gateOutcome(resolution.decision, block.name, input, resolution.finalArgs);
        this.workflowEventBroadcast({
          type: 'gate_resolved',
          workflowId: this.workflowId,
          gateId: block.id,
          toolUseId: block.id,
          toolName: block.name,
          decision: resolution.decision,
          wasEdited: outcome.wasEdited,
          ...(outcome.wasEdited ? { finalArgs: outcome.effectiveInput } : {}),
          liveArgsAtFire,
          createdAt: Date.now(),
        });
        if (!outcome.run) {
          this.emitToolActivity(block, input, 'failed', outcome.refusalText!);
          return { text: outcome.refusalText!, isError: true };
        }
        // Sub-phase 5 — "approve all like this". Persist a standing approval
        // ONLY on an UNEDITED approve, so the stored signature matches what will
        // actually recur (an edit is a one-off; remembering it could auto-run a
        // form the operator never approved). Broadcast the updated list.
        if (resolution.remember && !outcome.wasEdited) {
          await addStandingApproval(ctx.cwd, this.workflowId, {
            signature: gate.signature,
            toolName: block.name,
            approvedAt: Date.now(),
            sample: block.name === 'Bash' && typeof input.command === 'string' ? String(input.command).slice(0, 200) : undefined,
          }).catch((e) => console.warn(`[arco] [${this.workflowId.slice(0, 8)}] standing-approval write failed:`, e));
          await this.broadcastStandingApprovals(ctx.cwd);
        }
        // approve — run below with the (possibly edited) effective input.
        input = outcome.effectiveInput;
      }
    }

    // H62 (Phase 3) — partial-read → full-write warning. NON-BLOCKING: computed
    // before dispatch (read-state is unaffected by the write), the note is
    // appended to the SUCCESSFUL Write result so the model self-corrects next
    // turn if it just nuked an unseen tail. Emitted as a `tool_gate_triggered`
    // with decision 'allowed' (the write still runs) for transcript review.
    const partialWarn = checkPartialReadFullWrite(block.name, input, ctx.cwd, this.partialReadSet);
    if (partialWarn.warn) {
      this.workflowEventBroadcast({
        type: 'tool_gate_triggered',
        workflowId: this.workflowId,
        toolUseId: block.id,
        toolName: block.name,
        gate: 'partial-read-full-write',
        decision: 'allowed',
        reason: partialWarn.reason,
      });
      // Clear the flag so a second Write to the same path this turn doesn't
      // re-warn (the model has been told once).
      this.partialReadSet.delete(partialWarn.resolvedPath);
    }

    let resultText: string;
    let isError = false;
    // §E1 (E1-Native) — decoded once; the registry branch below uses it.
    const registryTool = parseRegistryToolName(block.name);
    // CLUSTER_MODE_PLAN.md Phase 1 — route peer_* tool_use blocks to the
    // peerTools dispatcher when the worker is in a cluster. The hard gate
    // here mirrors the registration gate in buildToolDefs(): a non-cluster
    // worker will never have advertised the tool, so a model attempting to
    // call peer_send without a clusterId gets the standard "unknown tool"
    // path through executeNativeTool.
    if (this.config.clusterId !== undefined && isPeerTool(block.name)) {
      try {
        resultText = await executePeerTool(block.name, input, {
          workflowId: this.workflowId,
          clusterId: this.config.clusterId,
          taskBoardAttached: this.config.clusterTaskBoardAttached === true,
          accessMode: this.config.clusterAccessMode,
          broadcast: (msg) => this.workflowEventBroadcast(msg),
          broadcastCluster: (msg) => this.clusterEventBroadcast(msg),
        });
        if (resultText.startsWith('[error] ')) isError = true;
      } catch (err) {
        resultText = `[error] ${err instanceof Error ? err.message : String(err)}`;
        isError = true;
      }
    } else if (registryTool && this.mcpSessions.has(registryTool.key)) {
      // §E1 (E1-Native) — route `mcp__reg-<id8>__<tool>` to its open session.
      // A call to a server with no open session (closed/removed) falls through
      // to the unknown-tool path below; a closed/errored session returns a
      // clean `[error] …` (never throws).
      const session = this.mcpSessions.get(registryTool.key)!;
      // Defense in depth: re-check the denylist AT DISPATCH. buildToolDefs()
      // only OMITS dangerous-unticked tools from what the model sees — but a
      // model can emit a tool_use for an un-advertised name (guessed off an
      // advertised safe sibling's namespace, or replayed from context). Without
      // this guard the open session would execute it, defeating the operator
      // gate. Matches the CLI path, where Claude Code's --disallowedTools
      // rejects the same call at its own dispatch.
      if (this.planMode && !isRegistryToolReadOnly(session, registryTool.tool)) {
        // DD11a — plan mode only runs read-only MCP tools. buildToolDefs already
        // omits non-readonly ones; this rejects a model that emits an
        // un-advertised (guessed/replayed) write tool_use anyway.
        resultText = `[error] tool '${block.name}' is disabled in plan mode (only read-only MCP tools run until ExitPlanMode)`;
        isError = true;
      } else if (!isRegistryToolAllowed(this.config.mcpRegistryServers ?? [], registryTool.key, registryTool.tool)) {
        resultText = `[error] tool '${block.name}' is not enabled for this tab (dangerous tools are off until the operator ticks them)`;
        isError = true;
      } else {
        try {
          const r = await session.callTool(registryTool.tool, input);
          resultText = r.text;
          isError = r.isError;
        } catch (err) {
          resultText = `[error] ${err instanceof Error ? err.message : String(err)}`;
          isError = true;
        }
      }
    } else if ((this.config.efficiencySandbox ?? 'off') === 'on' && isSandboxTool(block.name)) {
      // EFFICIENCY_PLAN.md Phase E §9a — sandbox tool dispatch. The
      // registration gate in buildToolDefs() mirrors this predicate so a
      // toggle-off tab will never see ctx_* tool_use blocks. The
      // `onChunkStored` callback fires sandbox_chunk_added so the UI's
      // Files-tab sub-section can refresh without polling.
      try {
        resultText = await executeSandboxTool(block.name, input, {
          workflowId: this.workflowId,
          cwd: ctx.cwd,
          onChunkStored: (chunkId, byteLen, language) => {
            this.workflowEventBroadcast({
              type: 'sandbox_chunk_added',
              workflowId: this.workflowId,
              chunkId,
              byteLen,
              language,
            });
          },
        });
        if (resultText.startsWith('[error] ')) isError = true;
      } catch (err) {
        resultText = `[error] ${err instanceof Error ? err.message : String(err)}`;
        isError = true;
      }
    } else {
      try {
        resultText = await executeNativeTool(block.name, input, ctx);
        if (resultText.startsWith('[error] ')) isError = true;
      } catch (err) {
        resultText = `[error] ${err instanceof Error ? err.message : String(err)}`;
        isError = true;
      }
    }

    // EFFICIENCY_PLAN.md Phase C — Native-side tool-result filter. Runs on
    // the current turn's tool_result only (cache invariant: `messages[]`
    // is never mutated retroactively). Filter runs BEFORE PostToolUse hook
    // augmentation so operator-curated hook stderr / additionalContext
    // stays untouched. When the filter actually shrinks output we gzip
    // the raw bytes to artifacts/raw-tools/ so the operator can recover
    // what the model didn't see — reversibility is non-negotiable.
    const filterMode = this.config.efficiencyToolFilter ?? 'off';
    if (filterMode !== 'off') {
      const pack = resolveFilterPack(block.name, input, filterMode);
      if (pack) {
        // Synthesize an exit code from the [error] sentinel so the pack's
        // branch_on_exit can flip head_cap → tail_cap. true exit codes
        // aren't surfaced by executeNativeTool (returns string only); the
        // model's view of "did this fail" is what matters here.
        const synthExit = isError ? 1 : 0;
        const fr = filterToolResult(block.name, resultText, synthExit, pack);
        if (fr.filteredBytes !== fr.originalBytes) {
          let rawArtifactPath: string | undefined;
          try {
            rawArtifactPath = await this.persistRawArtifact(block.id, resultText);
          } catch (err) {
            console.warn(`[claude-native:${this.workflowId.slice(0, 8)}] raw-tools artifact write failed:`, err);
          }
          this.workflowEventBroadcast({
            type: 'tool_filtered',
            workflowId: this.workflowId,
            toolUseId: block.id,
            toolName: block.name,
            filterName: fr.filterName,
            originalBytes: fr.originalBytes,
            filteredBytes: fr.filteredBytes,
            ...(rawArtifactPath ? { rawArtifactPath } : {}),
          });
          resultText = fr.filtered;
        } else {
          // No-op — still emit so transcript review can confirm the filter
          // ran and chose to pass through.
          this.workflowEventBroadcast({
            type: 'tool_filtered',
            workflowId: this.workflowId,
            toolUseId: block.id,
            toolName: block.name,
            filterName: fr.filterName,
            originalBytes: fr.originalBytes,
            filteredBytes: fr.filteredBytes,
          });
        }
      }
    }

    // H62 — append the partial-read warning to a SUCCESSFUL Write result so the
    // model sees it (a failed write already told the model something's wrong).
    if (partialWarn.warn && !isError) {
      resultText += `\n\n${partialWarn.note}`;
    }

    // PostToolUse hook — informational; stderr appended to result.
    const post = await fireHooks(this.hooks, 'PostToolUse', matcher,
      { tool_name: block.name, tool_input: input, tool_response: resultText, workflow_id: this.workflowId },
      { cwd: ctx.cwd, abortSignal: ctx.abortSignal, shells: this.shells, workflowId: this.workflowId },
    );
    for (const r of post) {
      const stderr = r.stderr.trim();
      if (stderr) resultText += `\n\n[PostToolUse hook stderr] ${stderr.slice(0, 500)}`;
      // EFFICIENCY_PLAN.md Phase B0 — additionalContext from PostToolUse
      // hooks gets appended to the tool_result the model sees. `decision:
      // "block"` triggers a model retry by surfacing the reason as an
      // is_error tool_result; matches Claude Code semantics.
      const parsed = parseHookOutput(r.stdout);
      const extra = parsed.hookSpecificOutput?.additionalContext;
      if (typeof extra === 'string' && extra.length > 0) {
        resultText += `\n\n${extra}`;
      }
      if (parsed.decision === 'block') {
        const reason = parsed.reason ?? 'PostToolUse hook requested retry';
        const text = `[PostToolUse hook blocked] ${reason}`;
        this.emitToolActivity(block, input, 'failed', text);
        return { text, isError: true };
      }
    }
    this.emitToolActivity(block, input, isError ? 'failed' : 'completed', resultText);
    return { text: resultText, isError };
  }

  // ── Phase 7b tool handlers ──

  private async handleEnterPlanMode(plan: string): Promise<{ warnings: string[] }> {
    const warnings = planParserAdvisories(plan);
    this.planMode = true;
    if (this.planBroadcast) {
      try { await this.planBroadcast.set(plan); }
      catch (err) { console.warn(`[claude-native:${this.workflowId.slice(0, 8)}] plan_set broadcast failed:`, err); }
    }
    return { warnings };
  }

  private async handleExitPlanMode(summary: string | undefined): Promise<void> {
    this.planMode = false;
    if (this.planBroadcast) {
      try { await this.planBroadcast.exited(summary); }
      catch (err) { console.warn(`[claude-native:${this.workflowId.slice(0, 8)}] plan_exited broadcast failed:`, err); }
    }
  }

  private async handleAskUserQuestion(question: string, options: string[] | undefined): Promise<string> {
    if (this.pendingQuestion) {
      throw new Error('another question is awaiting response');
    }
    const id = `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    let optionsLine = '';
    if (options && options.length > 0) {
      const encoded = options.map((o) => o.replace(/\|/g, '\\|')).join(' | ');
      optionsLine = `\n[ASK_OPTIONS:${encoded}]`;
    }
    this.emit('system_notice', `[ASK:claude-native:${id}] ${question}${optionsLine}`);
    return await new Promise<string>((resolve, reject) => {
      this.pendingQuestion = { id, text: question, options, resolve, reject };
    });
  }

  private async handleSpawnTask(args: { description: string; prompt: string; subagentType?: string; model?: string; toolUseId: string }): Promise<string> {
    if (!this.taskHandler) throw new Error('Task handler not registered');
    const handle = await this.taskHandler({
      parentWorkflowId: this.workflowId,
      description: args.description,
      prompt: args.prompt,
      subagentType: args.subagentType,
      model: args.model,
    });
    this.tasksByTaskId.set(handle.taskId, handle);
    const startedAt = Date.now();
    // Lifecycle broadcast — picked up by ClaudeNativeTurn → WorkerManager →
    // seedWorker.ts which adds workflowId and forwards as `task_started`.
    this.emit('task_started', {
      taskId: handle.taskId,
      childWorkflowId: handle.childWorkflowId,
      toolUseId: args.toolUseId,
      description: args.description,
      startedAt,
    });
    let finalText: string;
    try {
      finalText = await handle.finalText;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const phase: 'cancelled' | 'error' = /AbortError/i.test(msg) ? 'cancelled' : 'error';
      this.emit('task_status', {
        taskId: handle.taskId,
        toolUseId: args.toolUseId,
        phase,
        elapsedMs: Date.now() - startedAt,
        summary: msg.slice(0, 200),
      });
      // SubagentStop hook fires regardless of success/failure (informational).
      void this.fireSubagentStop({ taskId: handle.taskId, childWorkflowId: handle.childWorkflowId, status: 'error', error: msg })
        .catch((e) => console.warn(`[claude-native:${this.workflowId.slice(0, 8)}] SubagentStop hook failed:`, e));
      return `[error] Task ${handle.taskId} failed: ${msg.slice(0, 500)}`;
    }
    this.emit('task_status', {
      taskId: handle.taskId,
      toolUseId: args.toolUseId,
      phase: 'done',
      elapsedMs: Date.now() - startedAt,
      summary: finalText.slice(0, 200),
    });
    void this.fireSubagentStop({ taskId: handle.taskId, childWorkflowId: handle.childWorkflowId, status: 'completed', finalTextLength: finalText.length })
      .catch((e) => console.warn(`[claude-native:${this.workflowId.slice(0, 8)}] SubagentStop hook failed:`, e));
    return finalText;
  }

  private async handleReadTaskOutput(taskId: string): Promise<string> {
    const handle = this.tasksByTaskId.get(taskId);
    if (!handle) return `[error] no such task: ${taskId}`;
    const { output, settled } = handle.read();
    const head = settled ? '[settled]' : '[in-flight]';
    const TAIL_CAP = 64 * 1024;
    const tail = output.length <= TAIL_CAP
      ? output
      : `[…truncated head ${output.length - TAIL_CAP} bytes]\n` + output.slice(output.length - TAIL_CAP);
    return `${head} task ${taskId} (child ${handle.childWorkflowId.slice(0, 8)})\n\n${tail || '(no output yet)'}`;
  }

  private async fireSubagentStop(payload: Record<string, unknown>): Promise<void> {
    await fireHooks(
      this.hooks,
      'SubagentStop',
      'SubagentStop',
      { workflow_id: this.workflowId, ...payload },
      { cwd: this.config.cwd ?? process.cwd(), abortSignal: this.makeAbortSignal('toolAbort'), shells: this.shells, workflowId: this.workflowId },
    );
  }

  private makeAbortSignal(which: 'inFlight' | 'toolAbort'): AbortSignal {
    if (which === 'inFlight') {
      this.inFlight ??= new AbortController();
      return this.inFlight.signal;
    }
    this.toolAbort ??= new AbortController();
    return this.toolAbort.signal;
  }

  // Map Anthropic SDK errors → retry / system_notice / hard fail.
  private async handleApiError(err: unknown, attempt: number): Promise<'retry' | 'fatal'> {
    // SDK streaming errors (SSE `error` event mid-stream) are thrown as
    // `new APIError(undefined, body, undefined, headers, type)` — status is
    // explicitly `undefined`. The inner error subtype lands on `e.type` (the
    // SDK's own `.type` property), NOT on `e.error.type` (which is the outer
    // body wrapper field "error"). Read `e.type` first so overloaded/rate-limit
    // mid-stream errors are correctly classified for retry.
    const e = err as { status?: number; message?: string; error?: { type?: string; message?: string; error?: { type?: string; message?: string } }; type?: string; name?: string };
    const name = e.name ?? '';
    // Inner message is at e.error.error.message (full body → error → message)
    // for streaming errors; fall back through outer body message and SDK message.
    const msg = e.error?.error?.message || e.error?.message || e.message || String(err);
    const errType = e.type ?? e.error?.type ?? '';

    if (name === 'AbortError' || name === 'APIUserAbortError') {
      this.emit('error', 'Worker killed');
      return 'fatal';
    }
    const status = e.status ?? 0;
    // 401 — auth failure. NOTE: ensureLiveTokens only refreshes near local
    // expiresAt, so a token Anthropic revoked EARLY sails through it and 401s
    // here having never touched the refresh chain. A1: try one forced refresh
    // per turn before declaring re-auth — prod showed near-daily 401s with
    // zero refresh attempts, most likely silently recoverable
    // (REMOTE_CLUSTER_CONTROL_PLAN.md §10.1).
    if (status === 401 || errType === 'authentication_error') {
      // Guard on the attempt budget too: a 'retry' returned on the final
      // attempt is discarded by streamOneRound's loop, which would end the
      // turn silently with no [AUTH:claude] surface at all.
      if (!this.forcedAuthRefreshThisTurn && attempt < MAX_RETRY_ATTEMPTS - 1) {
        this.forcedAuthRefreshThisTurn = true;
        try {
          await forceRefreshTokens(this.clientTokenObtainedAt ?? 0);
          // On-disk tokens rotated → obtainedAt mismatch → client rebuild.
          await this.ensureStarted();
          console.log(`[claude-native:${this.workflowId.slice(0, 8)}] 401 on unexpired token — forced refresh ok, retrying`);
          return 'retry';
        } catch (refreshErr) {
          // refreshUnlocked already journaled `refresh rejected (NNN)` when the
          // endpoint said no; anything else (network, no-auth) logs here. Fall
          // through to the re-auth surface either way.
          const detail = refreshErr instanceof Error ? refreshErr.message : String(refreshErr);
          console.error(`[claude-native:${this.workflowId.slice(0, 8)}] 401 → forced refresh failed: ${detail}`);
        }
      }
      this.authFailureCount += 1;
      const detail = msg || 'Invalid authentication credentials';
      // A2 — flip the live auth-problem flag (phone console banner + one
      // auth-expired notice). Cleared by a successful refresh/bootstrap.
      markClaudeAuthProblem(detail);
      const loud = this.authFailureCount >= AUTH_FAILURE_LOUD_THRESHOLD;
      const prefix = loud
        ? `[AUTH:claude] Repeated Claude auth failures (${this.authFailureCount}). Re-login required to continue.`
        : `[AUTH:claude] Claude authentication failed: ${detail}. Re-login to continue.`;
      this.emit('system_notice', prefix);
      this.emit('error', `claude auth failed (${status})`);
      return 'fatal';
    }
    if (status === 413 || errType === 'request_too_large') {
      this.emit('system_notice', `Anthropic request_too_large: ${msg} — Handoff is recommended.`);
      this.emit('error', 'request_too_large');
      return 'fatal';
    }
    if (status === 429 || status === 529 || errType === 'rate_limit_error' || errType === 'overloaded_error' || status === 500 || errType === 'api_error') {
      // H10 — honor Anthropic's own retry timing when it sends one. `retry-after`
      // (seconds or HTTP-date) wins; else the soonest `anthropic-ratelimit-*-reset`.
      // Falls back to the fixed 15/30/60s ladder when no usable header is present
      // (e.g. mid-stream SSE errors, which carry no headers). With the SDK's
      // internal retries now off (maxRetries:0) this ladder is the only backoff.
      const headers = (e as { headers?: unknown }).headers;
      const timing = resolveRateLimitWait(headers, Date.now());
      const kind = classifyRateLimit(status, errType, headers);
      const backoff = timing.waitMs ?? RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)];
      const via = timing.source
        ? ` (per ${timing.source}${timing.capped ? ', capped' : ''})`
        : '';
      const label = kind === 'genuine'
        ? `rate limit (${errType || `HTTP ${status}`})`
        : `overload (${errType || `HTTP ${status}`})`;
      // Same attempt-budget guard as the auth / thinking branches: a 'retry'
      // on the last attempt is discarded by streamOneRound, which returns null
      // WITHOUT emitting — runTurn reads null as "error already emitted", so a
      // third consecutive 429/529/500 left the tab busy forever.
      if (attempt >= MAX_RETRY_ATTEMPTS - 1) {
        this.emit('system_notice', `Anthropic ${label}: still failing after ${MAX_RETRY_ATTEMPTS} attempts — giving up on this turn. ${msg.slice(0, 300)}`);
        this.emit('error', `claude-native: ${label} after ${MAX_RETRY_ATTEMPTS} attempts`);
        return 'fatal';
      }
      this.emit('system_notice', `Anthropic ${label}: retrying in ${Math.round(backoff / 1000)}s${via} (${attempt + 1}/${MAX_RETRY_ATTEMPTS})…`);
      try { await sleepWithSignal(backoff, this.inFlight?.signal); }
      catch { this.emit('error', 'Worker killed'); return 'fatal'; }
      return 'retry';
    }
    // FABLE_51_APPEND_ONLY_PLAN.md §2 — preserved-thinking rejection (edited
    // history from a pre-refactor session, or an enforced org without the
    // beta). One-time recovery: drop every thinking block and retry once.
    if (status === 400 && isThinkingBindingError(msg) && !this.bindingStripUsed && attempt < MAX_RETRY_ATTEMPTS - 1) {
      this.bindingStripUsed = true;
      const stripped = stripAllThinkingBlocks(this.messages as Array<{ role?: string; content?: unknown }>, THINKING_ONLY_PLACEHOLDER);
      this.workflowEventBroadcast({
        type: 'ctx_action',
        workflowId: this.workflowId,
        action: 'strip_thinking_binding_mismatch',
        trigger: 'recovery',
        detail: `Anthropic rejected a replayed thinking block (${msg.slice(0, 200)}); stripped ${stripped.blocks} thinking block(s) from ${stripped.messages} assistant message(s) and retrying once`,
      });
      this.emit('system_notice', `Anthropic rejected replayed thinking (edited history); retrying without ${stripped.blocks} thinking block(s).`);
      return 'retry';
    }
    // The org / model doesn't take one of the append-only wire features.
    // Thaw: drop Arco's role:'system' messages, forget the freeze, and run
    // rebuild-per-request (the pre-plan behaviour) for the rest of this worker.
    if (status === 400 && !this.prefixThawed && isPrefixFeatureRejection(msg) && attempt < MAX_RETRY_ATTEMPTS - 1) {
      this.prefixThawed = true;
      const removed = removeArcoSystemMessages(this.messages);
      this.resetPrefixFreeze('thaw');
      this.workflowEventBroadcast({
        type: 'ctx_action',
        workflowId: this.workflowId,
        action: 'system_delta',
        trigger: 'recovery',
        detail: `Anthropic rejected an append-only prefix feature (${msg.slice(0, 200)}); removed ${removed} Arco system message(s) and fell back to rebuild-per-request for this worker`,
      });
      this.emit('system_notice', `Anthropic rejected a mid-conversation prefix update (${msg.slice(0, 160)}); this tab falls back to rebuilding its system prompt per request.`);
      return 'retry';
    }
    // Non-retryable: invalid_request, permission, billing, not_found.
    this.emit('system_notice', `Anthropic ${errType || `HTTP ${status}`}: ${msg.slice(0, 500)}`);
    this.emit('error', `claude-native: ${msg.slice(0, 200)}`);
    return 'fatal';
  }

}
