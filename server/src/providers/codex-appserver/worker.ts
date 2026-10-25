import { CodexOperatorQuestions } from './operatorQuestions.js';
// Long-lived per-workflow `codex app-server` worker (Phase 6a + 6b).
//
// One Codex CLI subprocess runs for the lifetime of an Arco tab on the
// `appserver` transport. Each operator turn is one `turn/start` round-trip
// against the same JSON-RPC connection, with notifications streaming back
// as the model thinks/runs tools/replies. Cancel is `turn/interrupt` (not
// SIGKILL); steer is `turn/steer` (not "queue and wait for next turn").
//
// Pattern parallels `antigravity.ts:antigravityManager` — one connection
// per primary tab — except scoped per-workflow, mutex-guarded by the JSON-
// RPC request/response IDs rather than an explicit lock.
//
// The exec-mode worker (`codex.ts`) is unchanged and remains the default.
// `codex.transport: 'appserver'` in settings opts a tab into this path.
// See `docs/CODEX_APPSERVER_PLAN.md` for the full design.

import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { statSync } from 'fs';
import { writeFile, access } from 'fs/promises';
import { extname } from 'path';
import {
  resolveGeneratedImageTarget,
  generatedImageRelPath,
  generatedImageTitle,
  isGenerationFailure,
  type ImageGenerationItem,
} from './imageGen.js';
import { resolveWithinCwd } from '../ollamaTools.js';
import { randomUUID } from 'crypto';
import { JsonRpcClient, JsonRpcRequestError, type JsonRpcNotification, type JsonRpcServerRequest } from './jsonRpc.js';
import { killProcessTree } from '../../workers/processKill.js';
import { markThrottled, markAvailable } from '../../quota.js';
import { parseCodexThrottle } from '../codex.js';
import { getCachedCodexModelCapabilities } from './catalog.js';
import { MAX_WORKER_OUTPUT_BYTES, OUTPUT_TRUNCATION_NOTICE } from '../../workers/limits.js';
import { buildCodexMcpOverrides, buildVoiceMcpOverrides } from '../../mcp/mcpConfigWriter.js';
import { VOICE_OPERATOR_PROMPT } from '../../voice/operatorPrompt.js';
import { getZaiResponsesProxyBaseUrl } from '../zaiResponsesProxy.js';
import { codexContextWindowOverride } from '../codexContextWindow.js';
import { outputStyleAddendum } from '../outputStyle.js';
import { goalBlock } from '../goalBlock.js';
import { awaitModelImage } from '../attachments.js';
import { codexClusterDeveloperInstructions } from '../codexCodeMode.js';
import { zaiModelContextWindow, type ProviderName, type SteerItem, type WorkerConfig } from '@arco/shared';
import type { InitializeResponse } from './bindings/InitializeResponse.js';
import type { ThreadStartParams } from './bindings/v2/ThreadStartParams.js';
import type { ThreadStartResponse } from './bindings/v2/ThreadStartResponse.js';
import type { ThreadResumeParams } from './bindings/v2/ThreadResumeParams.js';
import type { ThreadResumeResponse } from './bindings/v2/ThreadResumeResponse.js';
import type { TurnStartParams } from './bindings/v2/TurnStartParams.js';
import type { TurnStartResponse } from './bindings/v2/TurnStartResponse.js';
import type { ThreadGoalClearParams } from './bindings/v2/ThreadGoalClearParams.js';
import type { ThreadGoalClearResponse } from './bindings/v2/ThreadGoalClearResponse.js';
import type { ThreadGoalUpdatedNotification } from './bindings/v2/ThreadGoalUpdatedNotification.js';
import type { ThreadCompactStartParams } from './bindings/v2/ThreadCompactStartParams.js';
import type { ThreadCompactStartResponse } from './bindings/v2/ThreadCompactStartResponse.js';
import type { TurnInterruptParams } from './bindings/v2/TurnInterruptParams.js';
import type { TurnSteerParams } from './bindings/v2/TurnSteerParams.js';
import type { TurnSteerResponse } from './bindings/v2/TurnSteerResponse.js';
import type { ThreadStartedNotification } from './bindings/v2/ThreadStartedNotification.js';
import type { TurnStartedNotification } from './bindings/v2/TurnStartedNotification.js';
import type { TurnCompletedNotification } from './bindings/v2/TurnCompletedNotification.js';
import type { ItemStartedNotification } from './bindings/v2/ItemStartedNotification.js';
import type { ItemCompletedNotification } from './bindings/v2/ItemCompletedNotification.js';
import type { AgentMessageDeltaNotification } from './bindings/v2/AgentMessageDeltaNotification.js';
import type { ReasoningTextDeltaNotification } from './bindings/v2/ReasoningTextDeltaNotification.js';
import type { ReasoningSummaryTextDeltaNotification } from './bindings/v2/ReasoningSummaryTextDeltaNotification.js';
import type { ThreadTokenUsageUpdatedNotification } from './bindings/v2/ThreadTokenUsageUpdatedNotification.js';
import type { ErrorNotification } from './bindings/v2/ErrorNotification.js';
import type { CodexErrorInfo } from './bindings/v2/CodexErrorInfo.js';
import type { ThreadItem } from './bindings/v2/ThreadItem.js';
import type { UserInput } from './bindings/v2/UserInput.js';
import type { SandboxMode } from './bindings/v2/SandboxMode.js';
import type { ReasoningEffort } from './bindings/ReasoningEffort.js';
import type { JsonValue } from './bindings/serde_json/JsonValue.js';

// Pinned Codex CLI version this worker was validated against. See
// docs/CODEX_APPSERVER_PLAN.md §0/§11 — bump the constant + regen the
// vendored bindings as a paired change.
const PINNED_CODEX_CLI_VERSION = '0.128.0';

const ARCO_CLIENT_NAME = 'arco';
const ARCO_CLIENT_VERSION = '0.1.0';

// Operator cancel: send turn/interrupt, then wait this long for the
// matching `turn/completed { status: 'interrupted' }` notification before
// falling through to SIGKILL. Mirrors §7 of the plan doc; tunable but no
// per-tab setting in v1 per the operator's open-question answer #2.
const INTERRUPT_ACK_TIMEOUT_MS = 5_000;

// Hard ceiling for an operator-triggered `thread/compact/start`. A real Astra
// compact at 86% of its ~922K input window took 158s (2026-09-07), so the old
// 120s timer unlocked the tab 38s early and two operator turns bounced with
// ActiveTurnNotSteerable. Completion is now ONLY the compact turn's own
// turn/completed notification. Hitting this generous ceiling is a failure: the
// app-server process is recycled before Arco unlocks the tab.
const COMPACT_TIMEOUT_MS = 10 * 60_000;

type CompactOutcome = 'completed' | 'transport-ended' | 'timeout' | 'request-failed';

// Codex-side cooldown when a genuine usage-limit / 429 signal fires. Same
// value as the exec-mode `parseCodexThrottle` cooldown because the protocol
// doesn't expose a Retry-After either. `serverOverloaded` is deliberately not
// included: the 2026-08-30 gpt-5.6-sol incident proved that enum also carries
// the model-scoped "Selected model is at capacity" response. Promoting that
// transient capacity miss to a provider-wide 30-minute quota state made the
// header lie and stopped operator-armed Goal Runs unnecessarily.
const CODEX_COOLDOWN_MS = 30 * 60 * 1000;
const ZAI_APP_SERVER_COOLDOWN_MS = 2 * 60 * 1000;

const ZAI_TOOL_CADENCE_ADDENDUM = [
  '## Z.ai tool cadence',
  'Z.ai may rate-limit rapid model/tool/model loops even when subscription quota remains. Batch related reads, searches, and shell commands before returning to the model. Prefer fewer, broader tool rounds over many small exploratory calls. Do not send peer/cluster updates unless they materially change coordination.',
].join('\n');

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

// Phase 4 + Phase F9 — collapse the per-appserver MCP wiring (cluster +
// codebase-memory) into a stable signature string the dispatcher compares
// against the incoming config to decide whether to recycle the long-lived
// child. The string includes both spawn-time MCP wiring and thread-bootstrap
// values; changing any dimension requires a fresh appserver + thread/resume.
export function computeMcpSignature(
  clusterId: string | undefined,
  taskBoardAttached: boolean | undefined,
  codebaseMemoryIndexPath: string | undefined,
  providerAccountRef?: string,
  codexHome?: string,
  accessMode?: WorkerConfig['clusterAccessMode'],
  clusterRole?: string,
  model?: string,
  contextPolicy?: WorkerConfig['codexContextPolicy'],
  contextWindow?: number,
  surface?: string,
): string {
  return `cl:${clusterId ?? ''}|tb:${taskBoardAttached === true ? '1' : '0'}|cm:${codebaseMemoryIndexPath ?? ''}|acct:${providerAccountRef ?? ''}|home:${codexHome ?? ''}|access:${accessMode ?? 'standard'}|role:${clusterRole ?? ''}|model:${model ?? ''}|ctx:${contextPolicy ?? 'max'}:${contextWindow ?? 'provider-default'}|surface:${surface ?? ''}`;
}

// Interaction mode + effective web_search are baked in at thread start/resume
// (spawn-time `mcp_servers={}` and the thread `config.web_search`); turn/start
// can't change them. Without this in the signature, turning a Chat tab's WEB
// chip off left web search live on the running Codex / Z.ai app-server child.
export function bootstrapSurfaceKey(config: WorkerConfig): string {
  return `${config.interactionMode === 'chat' ? 'chat' : 'agent'}:web-${webSearchMode(config)}${config.voiceOperator === true ? ':voice' : ''}${config.incognito ? ':private' : ''}`;
}

function splitAttachments(paths: string[] | undefined): { images: string[]; nonImages: string[]; error?: string } {
  const images: string[] = [];
  const nonImages: string[] = [];
  for (const p of paths ?? []) {
    if (!IMAGE_EXT.has(extname(p).toLowerCase())) {
      nonImages.push(p);
      continue;
    }
    try {
      const s = statSync(p);
      if (!s.isFile()) return { images, nonImages, error: `image attachment "${p}" is not a file` };
      images.push(p);
    } catch (err) {
      return {
        images,
        nonImages,
        error: `image attachment "${p}" unreadable: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  return { images, nonImages };
}

// Translate Arco's effort to Codex's ReasoningEffort. The catalog
// (getCachedCodexModelCapabilities) is consulted when available so we
// downgrade to the highest *supported* effort for the active model rather
// than blindly sending `xhigh` to a model that doesn't advertise it (which
// the appserver would 400 on). Cold-start (no catalog yet) falls back to a
// safe pass-through.
function mapEffort(effort: string | undefined, modelId: string): ReasoningEffort | null {
  const desired = baseMapEffort(effort);
  if (!desired) return null;
  const caps = getCachedCodexModelCapabilities(modelId);
  if (!caps || caps.supportedReasoningEfforts.length === 0) return desired;
  if (caps.supportedReasoningEfforts.includes(desired)) return desired;
  // Pick the highest effort the model actually supports (catalog distil
  // sorts the array ascending).
  return caps.supportedReasoningEfforts[caps.supportedReasoningEfforts.length - 1];
}

// Arco's EffortLevel maps 1:1 onto Codex's ReasoningEffort now. It did not
// always: Codex topped out at 'xhigh', so Arco's 'max' was collapsed down to
// it. GPT-6 Astra (2026-09-03) added real 'max' and 'ultra' levels, and keeping
// the old collapse silently downgraded every MAX turn on Astra. The per-model
// clamp in mapEffort() is what protects older models that still stop at xhigh —
// do not reintroduce a blanket collapse here.
function baseMapEffort(effort: string | undefined): ReasoningEffort | null {
  switch (effort) {
    case 'low': return 'low';
    case 'medium': return 'medium';
    case 'high': return 'high';
    case 'xhigh': return 'xhigh';
    case 'max': return 'max';
    case 'ultra': return 'ultra';
    default: return null;
  }
}

function mapSandbox(config: WorkerConfig): SandboxMode {
  return config.sandbox
    ?? (config.skipPermissions ? 'danger-full-access' : 'workspace-write');
}

function appServerProvider(config: WorkerConfig): 'codex' | 'zai' {
  return config.provider === 'zai' ? 'zai' : 'codex';
}

function appServerNoticeTag(config: WorkerConfig): string {
  return appServerProvider(config);
}

// Chat exposes no project tools, but the operator can arm web search per tab
// (WorkflowConfig.chatWebAccess). Agent mode is unchanged: always live.
function webSearchMode(config: WorkerConfig): 'live' | 'disabled' {
  if (config.interactionMode !== 'chat') return 'live';
  return config.chatWebAccess ? 'live' : 'disabled';
}

export async function buildThreadConfigOverrides(config: WorkerConfig): Promise<Record<string, JsonValue>> {
  if (config.provider !== 'zai') {
    const contextWindow = codexContextWindowOverride(config);
    return {
      web_search: webSearchMode(config),
      ...(contextWindow ? { model_context_window: contextWindow } : {}),
    };
  }
  const baseUrl = await getZaiResponsesProxyBaseUrl();
  const contextWindow = zaiModelContextWindow(config.model);
  return {
    web_search: webSearchMode(config),
    model_context_window: contextWindow,
    model_auto_compact_token_limit: Math.floor(contextWindow * 0.9),
    model_provider: 'zai',
    model_providers: {
      zai: {
        name: 'Z.ai Coding Plan via Arco Responses Proxy',
        base_url: baseUrl,
        wire_api: 'responses',
      },
    },
  };
}

// Build the `UserInput[]` payload for `turn/start`. Phase 6c promotes image
// attachments to first-class `{type:'localImage', path}` UserInput items;
// non-images keep folding into the trailing text element as
// `[attached file: <path>]` lines (per §4 of the plan doc — `mention` is for
// at-mentioned named refs, not arbitrary file paths). 6b's steer payloads
// come through `buildSteerInput` below.
//
// Order: images first, text last. Mirrors exec mode's argv layout where `-i`
// flags precede the prompt that arrives via stdin, and keeps the user's
// active prompt as the trailing item the model reads.
//
// `appendSystemPrompt` folds into the trailing text element rather than
// `developerInstructions` on `thread/start` — see §4 of the plan doc.
// Folding mirrors exec mode's "byte-stable prefix + fresh tail per turn"
// shape that Codex's prefix cache already exploits.
function buildTurnInput(
  prompt: string,
  provider: Extract<ProviderName, 'codex' | 'zai'>,
  appendSystemPrompt: string | undefined,
  outputStyle: WorkerConfig['outputStyle'] | undefined,
  goal: string | undefined,
  attachmentImages: string[],
  attachmentNonImages: string[],
): UserInput[] {
  const promptWithRefs = attachmentNonImages.length > 0
    ? `${prompt}\n\n${attachmentNonImages.map((p) => `[attached file: ${p}]`).join('\n')}`
    : prompt;
  const styleText = outputStyleAddendum(outputStyle);
  const providerText = provider === 'zai' ? ZAI_TOOL_CADENCE_ADDENDUM : null;
  // GOAL_NORTHSTAR_PLAN.md G2 — north-star at the TOP of the byte-stable prefix
  // (broad framing first). Covers operator turns AND primitive seeds. Blank ⇒ omitted.
  const northStarBlock = goalBlock(goal);
  const prefix = [northStarBlock, appendSystemPrompt, providerText, styleText].filter((s): s is string => typeof s === 'string' && s.trim().length > 0).join('\n\n');
  const fullText = prefix ? `${prefix}\n\n---\n\n${promptWithRefs}` : promptWithRefs;
  const items: UserInput[] = attachmentImages.map((path) => ({ type: 'localImage', path }));
  items.push({ type: 'text', text: fullText, text_elements: [] });
  return items;
}

// Steer payload — Phase 6b. Drained items are folded into a single text
// element with the same `[attached file: <path>]` shape Phase 5 uses for
// Ollama / llama.cpp mid-turn steer (see §9 of the plan doc).
function buildSteerInput(items: SteerItem[]): UserInput[] {
  const parts: string[] = [];
  for (const item of items) {
    let text = item.content;
    if (item.attachments && item.attachments.length > 0) {
      text += '\n\n' + item.attachments.map((p) => `[attached file: ${p}]`).join('\n');
    }
    parts.push(text);
  }
  return [{ type: 'text', text: parts.join('\n\n'), text_elements: [] }];
}

// Per-turn settle outcome handed back to the per-turn wrapper.
export interface TurnSettleData {
  text: string;
  costUsd: number;
  durationMs: number;
  usage?: Record<string, number>;
  modelContextWindow?: number;
  lastPromptTokens?: number;
}

// Public events on the long-lived worker. The per-turn wrapper subscribes
// at `beginTurn` and unsubscribes on settle.
export interface CodexAppServerWorkerEvents {
  // Fired once per turn on the first `thread/started` (new thread) or on
  // `thread/resume` ack (warm thread). `sessionId` is the Codex thread.id.
  init: (data: { model?: string; sessionId?: string }) => void;
  // Streaming deltas during the turn.
  text: (text: string) => void;
  thinking: (text: string) => void;
  tool_use: (data: ToolUseEvent) => void;
  // §H4 — a generated image was persisted into cwd; render it inline.
  primary_artifact: (data: PrimaryArtifactEvent) => void;
  // Fired exactly once per turn — settle path. `error` populated on failure.
  turn_settled: (data: { error?: string; result?: TurnSettleData }) => void;
  // Out-of-band notices (config warnings, deprecation, model rerouted).
  // The per-turn wrapper forwards as `system_notice`.
  system_notice: (notice: string) => void;
  // The app-server child died unexpectedly. The wrapper treats this as a
  // turn failure and the workflow's next turn will re-`ensureStarted()`.
  fatal: (reason: string) => void;
}

export interface ToolUseEvent {
  name: string;
  input: string;
  status: 'started' | 'completed' | 'failed';
  provider: Extract<ProviderName, 'codex' | 'zai'>;
  itemType: string;
  itemId: string;
  output?: string;
  exitCode?: number;
}

// §H4 — a generated image written into cwd. Re-emitted by the per-turn wrapper
// and broadcast (via seedWorker) as a `primary_artifact` WS message. `path` is
// cwd-relative; the client renders it inline and offers "Open in editor".
export interface PrimaryArtifactEvent {
  artifactId: string;
  kind: 'image';
  title?: string;
  path: string;
  openInEditor?: boolean;
}

interface CurrentTurnState {
  turnId: string | null;
  // Buffered text/reasoning byte counts so the 5MB cap fires symmetrically
  // with exec-mode's `MAX_WORKER_OUTPUT_BYTES` ceiling.
  textBytes: number;
  capped: boolean;
  fullText: string;
  startedAt: number;
  // Pending interrupt ack — set when kill() fires; cleared by the
  // turn/completed notification.
  interruptDeadline: number | null;
  interruptResolve: (() => void) | null;
  // Phase 6b — fire-and-forget mid-turn steer; recorded for diagnostics
  // (we only count, not retain payloads).
  steerCount: number;
  // Codex app-server may emit a burst of identical retryable error
  // notifications before the turn either recovers or lands failed.
  transientNoticeKey: string | null;
  transientNoticeCount: number;
  // itemId of the agentMessage whose deltas we're currently streaming. Codex
  // emits a fresh agentMessage item for each narration block between tool
  // calls; the deltas within one item are continuous, but consecutive items
  // carry no separator — so without a boundary break they concatenate into a
  // wall of text ("…release process.Kernel.org confirms…"). We insert a
  // paragraph break when the item id changes. Null until the first delta.
  lastAgentMsgItemId: string | null;
}

function emptyTurnState(): CurrentTurnState {
  return {
    turnId: null,
    textBytes: 0,
    capped: false,
    fullText: '',
    startedAt: 0,
    interruptDeadline: null,
    interruptResolve: null,
    steerCount: 0,
    transientNoticeKey: null,
    transientNoticeCount: 0,
    lastAgentMsgItemId: null,
  };
}

function codexErrorInfoLabel(info: CodexErrorInfo | null | undefined): string | null {
  if (!info) return null;
  if (typeof info === 'string') return info;
  const key = Object.keys(info)[0];
  return key || 'other';
}

function codexErrorInfoHttpStatus(info: CodexErrorInfo): number | null {
  if (typeof info === 'string') return null;
  const value = Object.values(info)[0];
  if (!value || typeof value !== 'object') return null;
  const status = (value as { httpStatusCode?: unknown }).httpStatusCode;
  return typeof status === 'number' ? status : null;
}

export function isCodexQuotaInfo(info: CodexErrorInfo, fallbackMsg: string): boolean {
  if (info === 'usageLimitExceeded') return true;
  if (codexErrorInfoHttpStatus(info) === 429) return true;
  return /\b429\b|too many requests/i.test(fallbackMsg);
}

// Long-lived (per-workflow) worker. Spawned lazily on the first turn,
// kept alive across turns, disposed when the workflow is removed.
export class CodexAppServerWorker extends EventEmitter {
  readonly workflowId: string;
  private proc: ChildProcess | null = null;
  private rpc: JsonRpcClient | null = null;
  private threadId: string | null = null;
  private resolvedModel: string | null = null;
  private resolvedContextWindow: number | null = null;
  // Latest token-usage snapshot — used to populate `result.usage` /
  // `modelContextWindow` on settle.
  private lastTokenUsage: ThreadTokenUsageUpdatedNotification | null = null;
  private current: CurrentTurnState = emptyTurnState();
  private readonly operatorQuestions: CodexOperatorQuestions;
  // Operator-triggered native compaction (`thread/compact/start`) is running.
  // While set, the turn-lifecycle notifications for the compact's own internal
  // turn are isolated from Arco's turn machinery (we don't adopt its turnId
  // or build a phantom result). Cleared only after the compact's turn/completed
  // arrives, or dispose/teardown drains the waiters.
  private compacting = false;
  private compactTurnId: string | null = null;
  // Resolvers for the in-flight compactThread() promise. Drained on any
  // completion signal so the operator's request never hangs.
  private compactWaiters: Array<(outcome: CompactOutcome) => void> = [];
  // Instance field only so the lifecycle test can exercise the hard-ceiling
  // path without waiting ten minutes. Production never mutates it.
  private compactTimeoutMs = COMPACT_TIMEOUT_MS;
  // True once initialize() + thread/start (or thread/resume) succeeded.
  private bootstrapped = false;
  // Set when the child has been disposed; new turns refuse.
  private disposed = false;
  // Stderr buffer — fallback throttle sniffer for any signal the protocol
  // didn't surface as an `error` notification (paranoia per §8).
  private stderrBuf = '';
  // Captured for `init` event — the Codex CLI userAgent string.
  private userAgent: string | null = null;
  // CLUSTER_MODE_PLAN.md Phase 4 + EFFICIENCY_PLAN.md Phase F9 — signature
  // hash of the MCP wiring baked into the long-lived child at
  // ensureStarted(). Components: clusterId, codebaseMemoryAttached,
  // codebaseMemoryIndexPath. Compared against the incoming config on every
  // acquireWorker(); a mismatch (member joined/left a cluster, operator
  // attached/detached codebase-memory, or changed the index path while the
  // appserver was already up) forces tear-down + re-bootstrap so the MCP
  // children appear / disappear / re-target in lockstep with operator intent.
  private bootstrappedSignature: string | null = null;

  constructor(
    workflowId: string,
    private config: WorkerConfig,
    private readonly resumeSessionId: string | undefined,
  ) {
    super();
    this.workflowId = workflowId;
    this.operatorQuestions = new CodexOperatorQuestions(workflowId, appServerProvider(config));
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  // Phase 4 + Phase F9 — accessor for the dispatcher's MCP-context-change
  // check. Returns the signature baked into the running child, or `null`
  // when no MCP wiring was applied at bootstrap. The dispatcher recomputes
  // the desired signature from the incoming config and recycles on mismatch.
  get currentMcpSignature(): string | null {
    return this.bootstrappedSignature;
  }

  updateConfig(next: WorkerConfig): void {
    this.config = next;
  }

  // Lazy subprocess + handshake. Called on the first turn (and again after
  // a fatal exit when the next turn re-enters this method).
  async ensureStarted(): Promise<void> {
    if (this.disposed) throw new Error('codex app-server worker disposed');
    if (this.bootstrapped && this.rpc) return;
    if (this.proc) {
      // Mid-bootstrap (race) — wait for the existing attempt to settle.
      // No real concurrency in v1 (one operator turn at a time); guard
      // anyway so a future caller can't fire two parallel ensureStarted.
      throw new Error('codex app-server worker is mid-bootstrap');
    }

    // CLUSTER_MODE_PLAN.md Phase 4 + EFFICIENCY_PLAN.md Phase F9 — when the
    // workflow is a cluster member AND/OR has codebase-memory attached,
    // register the corresponding MCP stdio children via `-c` TOML overrides
    // before the `app-server` subcommand. The children are owned by the
    // app-server process — their lifetime spans the whole appserver, not
    // just one turn (asymmetric with codex `exec` and Claude CLI which
    // spawn them per-turn). Operator's `~/.codex/config.toml` mcp_servers
    // entries are unaffected because TOML overrides only set the specific
    // dotted keys.
    const spawnArgs: string[] = this.config.interactionMode === 'chat'
      ? ['-c', 'mcp_servers={}']
      : [];
    // VOICE_AGENT_PLAN.md — the Computer voice operator is a Chat (still no
    // project tools, no operator config.toml servers) plus exactly one MCP
    // child whose tools the browser executes. Layered after the reset above.
    if (this.config.interactionMode === 'chat' && this.config.voiceOperator === true) {
      spawnArgs.push(...buildVoiceMcpOverrides(this.workflowId, parseInt(process.env.ARCO_PORT || '3001', 10)));
    }
    const codebaseMemoryIndexPath = this.config.codebaseMemoryAttached
      ? this.config.codebaseMemoryIndexPath
      : undefined;
    // The workflow-scoped `arco` plan entry applies to every workflow with a
    // cwd, so this is no longer gated on cluster / codebase-memory.
    if (this.config.interactionMode !== 'chat' && (this.config.cwd || this.config.clusterId || codebaseMemoryIndexPath)) {
      const port = parseInt(process.env.ARCO_PORT || '3001', 10);
      spawnArgs.push(
        ...buildCodexMcpOverrides(this.workflowId, {
          planToolsCwd: this.config.cwd,
          clusterId: this.config.clusterId,
          taskBoardAttached: this.config.clusterTaskBoardAttached === true,
          accessMode: this.config.clusterAccessMode,
          port,
          codebaseMemoryIndexPath,
        }),
      );
      this.bootstrappedSignature = computeMcpSignature(this.config.clusterId, this.config.clusterTaskBoardAttached === true, codebaseMemoryIndexPath, this.config.providerAccountRef, this.config.codexHome, this.config.clusterAccessMode, this.config.clusterRole, this.config.model, this.config.codexContextPolicy, codexContextWindowOverride(this.config), bootstrapSurfaceKey(this.config));
    } else {
      this.bootstrappedSignature = computeMcpSignature(undefined, false, undefined, this.config.providerAccountRef, this.config.codexHome, undefined, undefined, this.config.model, this.config.codexContextPolicy, codexContextWindowOverride(this.config), bootstrapSurfaceKey(this.config));
    }
    if (this.config.incognito) spawnArgs.push('-c', 'history.persistence="none"', '-c', 'analytics.enabled=false');
    spawnArgs.push('app-server');

    this.proc = spawn('codex', spawnArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...(this.config.codexHome ? { CODEX_HOME: this.config.codexHome } : {}),
      },
      cwd: this.config.cwd || undefined,
      detached: true,
    });

    this.proc.on('exit', (code, signal) => {
      const reason = code !== null ? `code ${code}` : `signal ${signal ?? 'unknown'}`;
      this.onChildDeath(`codex app-server exited (${reason})`);
    });
    this.proc.on('error', (err) => {
      this.onChildDeath(`codex app-server spawn error: ${err.message}`);
    });

    if (this.proc.stderr) {
      this.proc.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        this.stderrBuf += text;
        if (this.stderrBuf.length > 64 * 1024) this.stderrBuf = this.stderrBuf.slice(-32 * 1024);
        if (!this.config.incognito) process.stderr.write(`[appserver:${this.workflowId.slice(0, 8)}] ${text}`);
      });
    }

    if (!this.proc.stdin || !this.proc.stdout) {
      throw new Error('codex app-server stdio not available');
    }
    this.rpc = new JsonRpcClient(this.proc.stdin, this.proc.stdout, (req) => {
      if (req.method !== 'item/tool/requestUserInput') return false;
      try {
        const p = req.params as { threadId?: string; turnId?: string } | null;
        if (!this.current.startedAt || p?.threadId !== this.threadId || (this.current.turnId && p.turnId !== this.current.turnId)) throw new Error('Question does not belong to the active operator turn.');
        this.operatorQuestions.acceptRpc(req, (result) => this.rpc?.respond(req.id, result) ?? false);
      } catch (err) {
        this.rpc?.respondError(req.id, { code: -32602, message: err instanceof Error ? err.message : 'Invalid question request' });
        this.emit('system_notice', 'Codex sent a question Arco could not display. The request was rejected.');
      }
      return true;
    });
    this.rpc.on('notification', (n: JsonRpcNotification) => this.onNotification(n));
    this.rpc.on('close', (reason: string) => {
      this.operatorQuestions.cancel('The Codex connection closed.');
      // Don't double-fire fatal — onChildDeath already tears down.
      console.log(`[appserver:${this.workflowId.slice(0, 8)}] rpc closed: ${reason}`);
    });
    this.rpc.on('protocol_error', (msg: string) => {
      console.warn(`[appserver:${this.workflowId.slice(0, 8)}] protocol error: ${msg}`);
    });
    // jsonRpc already answered it (decline / -32601); surface it so a model
    // that stalls on a refused approval isn't a mystery in the transcript.
    this.rpc.on('server_request', (req: JsonRpcServerRequest, declined: boolean) => {
      console.warn(`[appserver:${this.workflowId.slice(0, 8)}] server request ${req.method} id=${String(req.id)} → ${declined ? 'declined' : 'method-not-found'}`);
      this.emit('system_notice', `[${appServerNoticeTag(this.config)}] Codex asked Arco for ${req.method}; Arco has no interactive path for it and declined.`);
    });

    try {
      const init = await this.rpc.request<InitializeResponse>('initialize', {
        clientInfo: { name: ARCO_CLIENT_NAME, title: 'Arco', version: ARCO_CLIENT_VERSION },
        capabilities: { experimentalApi: true, optOutNotificationMethods: null },
      });
      this.userAgent = init.userAgent;
      // JSON-RPC initialization is a two-part handshake. Newer app-server
      // builds defer plugin/skill activation until the client acknowledges
      // the initialize response; without this, threads see system skills but
      // silently miss installed plugin skills.
      this.rpc.notify('initialized');
      console.log(`[appserver:${this.workflowId.slice(0, 8)}] initialized — ${init.userAgent}`);

      const threadConfig = await buildThreadConfigOverrides(this.config);
      if (this.config.incognito && this.resumeSessionId) throw new Error('Incognito Computer cannot resume a provider thread.');
      if (this.resumeSessionId) {
        const params: ThreadResumeParams = {
          threadId: this.resumeSessionId,
          history: null,
          path: null,
          model: this.config.model,
          modelProvider: this.config.provider === 'zai' ? 'zai' : null,
          serviceTier: null,
          cwd: this.config.cwd ?? null,
          approvalPolicy: 'never',
          approvalsReviewer: null,
          sandbox: mapSandbox(this.config),
          permissions: null,
          config: threadConfig,
          baseInstructions: this.config.interactionMode === 'chat' ? (this.config.voiceOperator === true ? VOICE_OPERATOR_PROMPT : this.config.systemPrompt ?? this.config.appendSystemPrompt ?? null) : null,
          developerInstructions: codexClusterDeveloperInstructions(this.config),
          personality: null,
          excludeTurns: true,
        };
        const res = await this.rpc.request<ThreadResumeResponse>('thread/resume', params);
        this.threadId = res.thread.id;
        this.resolvedModel = res.model;
      } else {
        const params: ThreadStartParams = {
          model: this.config.model,
          modelProvider: this.config.provider === 'zai' ? 'zai' : null,
          serviceTier: null,
          cwd: this.config.cwd ?? null,
          approvalPolicy: 'never',
          approvalsReviewer: null,
          sandbox: mapSandbox(this.config),
          permissions: null,
          config: threadConfig,
          serviceName: null,
          baseInstructions: this.config.interactionMode === 'chat' ? (this.config.voiceOperator === true ? VOICE_OPERATOR_PROMPT : this.config.systemPrompt ?? this.config.appendSystemPrompt ?? null) : null,
          developerInstructions: codexClusterDeveloperInstructions(this.config),
          personality: null,
          ephemeral: this.config.incognito === true,
          sessionStartSource: null,
          environments: null,
          dynamicTools: null,
          mockExperimentalField: null,
          experimentalRawEvents: false,
        };
        const res = await this.rpc.request<ThreadStartResponse>('thread/start', params);
        if (this.config.incognito && (res.thread.ephemeral !== true || res.thread.path != null)) throw new Error('Codex did not create a memory-only thread. No request was sent.');
        this.threadId = res.thread.id;
        this.resolvedModel = res.model;
      }
      this.bootstrapped = true;
      // Codex ships its own persistent thread-goal feature (`create_goal` /
      // `get_goal` tools + a `goals_*.sqlite` store). An active goal makes
      // app-server auto-start a fresh turn ~3ms after every turn completes,
      // injecting `<codex_internal_context source="goal">Continue working
      // toward the active thread goal`. That's standing operator-absent
      // authority over the workflow — the exact pattern CLAUDE.md § Non-goals
      // fences off — and it's invisible to Arco: the tab shows the turn
      // ended while Codex keeps spending. 2026-07-28 incident: a JWLibrary tab
      // burned 5.4M input tokens over 13 unattended minutes and every operator
      // send bounced with "already has a turn in flight". Clear on every
      // bootstrap/resume; Arco's NORTH STAR is the operator-owned equivalent.
      await this.clearThreadGoal();
      markAvailable(appServerProvider(this.config));
    } catch (err) {
      // Bootstrap failed — tear down so the next operator turn can retry
      // from scratch. Surface the error to the caller.
      this.teardownProcess();
      throw err;
    }
  }

  // Best-effort `thread/goal/clear`. Never throws — an older app-server
  // without the method, or a thread that has no goal, must not fail bootstrap.
  private async clearThreadGoal(): Promise<void> {
    if (!this.rpc || !this.threadId) return;
    const params: ThreadGoalClearParams = { threadId: this.threadId };
    try {
      const res = await this.rpc.request<ThreadGoalClearResponse>('thread/goal/clear', params);
      if (res?.cleared) {
        console.log(`[appserver:${this.workflowId.slice(0, 8)}] cleared a Codex-native thread goal on bootstrap`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[appserver:${this.workflowId.slice(0, 8)}] thread/goal/clear failed (non-fatal): ${msg}`);
    }
  }

  // Begin one operator turn. Resolves immediately after `turn/start` returns
  // (or rejects if the request itself fails); the per-turn settle fires via
  // the `turn_settled` event when the corresponding `turn/completed`
  // notification arrives.
  //
  // `appendSystemPrompt` is folded into the user message so the byte-stable
  // prefix + per-spawn-tail shape mirrors exec mode's prefix-cache hit
  // pattern. Image attachments are emitted as native `{type:'localImage',
  // path}` UserInput items (Phase 6c, §4 of the plan doc — `image` is for
  // remote URLs, `localImage` is for filesystem paths); non-images still
  // fold as `[attached file: <path>]` text references in the trailing text
  // element. Empty prompt + image-only payload is a valid request shape now
  // that images are first-class — no more "Please inspect the attached
  // image(s)." synthetic fallback.
  async beginTurn(prompt: string, appendSystemPrompt: string | undefined): Promise<void> {
    if (this.disposed) throw new Error('codex app-server worker disposed');
    if (!this.rpc || !this.threadId) {
      throw new Error('codex app-server worker not bootstrapped');
    }
    if (this.current.turnId !== null) {
      throw new Error('codex app-server worker already has a turn in flight');
    }
    if (this.compacting) {
      throw new Error('codex app-server worker has a compaction in flight');
    }

    const attachments = splitAttachments(this.config.attachments);
    if (attachments.error) throw new Error(attachments.error);
    // localImage items point at the downscaled sibling (bounded wait for an
    // in-flight upload derivation); non-image refs keep the original paths.
    // No-image turns stay tick-free.
    const modelImages = attachments.images.length > 0
      ? await Promise.all(attachments.images.map((p) => awaitModelImage(p)))
      : [];
    if (this.disposed) throw new Error('codex app-server worker disposed');
    const input = buildTurnInput(prompt, appServerProvider(this.config), appendSystemPrompt, this.config.outputStyle, this.config.goal, modelImages, attachments.nonImages);

    this.current = emptyTurnState();
    this.current.startedAt = Date.now();
    this.lastTokenUsage = null;

    // Surface init for the per-turn wrapper. Fired pre-turn so the
    // `worker_model` event lands before any text/thinking deltas.
    this.emit('init', { model: this.resolvedModel ?? this.config.model, sessionId: this.threadId });

    const params: TurnStartParams = {
      threadId: this.threadId,
      input,
      responsesapiClientMetadata: null,
      environments: null,
      cwd: this.config.cwd ?? null,
      approvalPolicy: 'never',
      approvalsReviewer: null,
      sandboxPolicy: this.buildSandboxPolicy(),
      permissions: null,
      model: this.config.model,
      serviceTier: null,
      effort: mapEffort(this.config.effort, this.config.model),
      summary: null,
      personality: null,
      outputSchema: null,
      collaborationMode: null,
    };

    try {
      const res = await this.rpc.request<TurnStartResponse>('turn/start', params);
      this.current.turnId = res.turn.id;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.settleTurn({ error: `turn/start failed: ${error}` });
      throw err;
    }
  }

  // Operator cancel. Two-step per §7 of the plan doc:
  //   1. send `turn/interrupt`; await ack + matching `turn/completed
  //      { status: 'interrupted' }` notification, max INTERRUPT_ACK_TIMEOUT_MS.
  //   2. on timeout / RPC error, SIGKILL the child and emit a fatal — the
  //      next operator turn re-enters `ensureStarted()` and resumes via
  //      `thread/resume`.
  async cancelCurrentTurn(): Promise<void> {
    this.operatorQuestions.cancel('The operator cancelled this turn.');
    if (!this.rpc || !this.threadId || !this.current.turnId) {
      // Nothing to interrupt — emit a synthetic settle so the wrapper
      // resolves. Mirrors exec-mode kill()'s "always fire 'error' on a
      // running worker" contract.
      this.settleTurn({ error: 'Worker killed' });
      return;
    }
    const turnId = this.current.turnId;
    const params: TurnInterruptParams = { threadId: this.threadId, turnId };
    const ackPromise = new Promise<void>((resolve) => {
      this.current.interruptResolve = resolve;
      this.current.interruptDeadline = Date.now() + INTERRUPT_ACK_TIMEOUT_MS;
    });
    let interruptError: Error | null = null;
    try {
      await this.rpc.request('turn/interrupt', params);
    } catch (err) {
      interruptError = err instanceof Error ? err : new Error(String(err));
    }
    if (interruptError) {
      console.warn(`[appserver:${this.workflowId.slice(0, 8)}] turn/interrupt RPC error — falling through to SIGKILL: ${interruptError.message}`);
      this.hardKill();
      this.settleTurn({ error: 'Worker killed (interrupt failed)' });
      return;
    }
    // Wait for `turn/completed { status: 'interrupted' }`; the notification
    // handler resolves `interruptResolve` and clears `current.turnId`.
    const timer = setTimeout(() => {
      if (this.current.interruptResolve) {
        const r = this.current.interruptResolve;
        this.current.interruptResolve = null;
        this.current.interruptDeadline = null;
        console.warn(`[appserver:${this.workflowId.slice(0, 8)}] interrupt ack timed out — SIGKILL`);
        this.hardKill();
        this.settleTurn({ error: 'Worker killed (interrupt timed out)' });
        r();
      }
    }, INTERRUPT_ACK_TIMEOUT_MS);
    try {
      await ackPromise;
    } finally {
      clearTimeout(timer);
    }
  }

  // Operator-triggered native compaction — the app-server equivalent of
  // `/compact` in Codex CLI. Codex owns the thread's history server-side, so
  // this is a single `thread/compact/start` RPC against the live thread; Codex
  // summarizes earlier history into its rollout and the next operator turn
  // continues against the compacted thread (the reduced input shows up on the
  // CTX bar). Persists automatically in Codex's on-disk rollout — no Arco
  // resume gymnastics, unlike a handoff.
  //
  // Preconditions: bootstrapped (a turn has run, so there's a thread to
  // compact) and idle (no operator turn in flight). Returns a structured
  // result rather than throwing so the WS handler can surface a clean notice.
  //
  // The compact runs as Codex's own internal turn. Because the `Turn` object
  // carries no `turnKind`, we can't tell a compact turn from an operator turn
  // by inspection — so instead `this.compacting` isolates it: turn/started is
  // captured separately, and ONLY its turn/completed notification unlocks the
  // operator. `thread/compacted` means the summary landed, but Codex can still
  // reject turn/start until that internal turn completes.
  async compactThread(): Promise<{ ok: boolean; error?: string; recycle?: boolean }> {
    if (this.disposed) return { ok: false, error: 'worker disposed' };
    if (!this.rpc || !this.threadId || !this.bootstrapped) {
      return { ok: false, error: 'no Codex thread yet — run a turn before compacting' };
    }
    if (this.current.turnId !== null) {
      return { ok: false, error: 'a turn is in flight — wait for it to finish, then compact' };
    }
    if (this.compacting) {
      return { ok: false, error: 'a compaction is already running' };
    }
    this.compacting = true;
    this.compactTurnId = null;

    // Register before sending the RPC. A very small compact can emit
    // turn/completed before thread/compact/start's response is delivered.
    let finish!: (outcome: CompactOutcome) => void;
    const completion = new Promise<CompactOutcome>((resolve) => {
      let finished = false;
      let timer: NodeJS.Timeout | undefined;
      finish = (outcome) => {
        if (finished) return;
        finished = true;
        const i = this.compactWaiters.indexOf(finish);
        if (i >= 0) this.compactWaiters.splice(i, 1);
        if (timer) clearTimeout(timer);
        resolve(outcome);
      };
      timer = setTimeout(() => finish('timeout'), this.compactTimeoutMs);
      this.compactWaiters.push(finish);
    });

    try {
      const params: ThreadCompactStartParams = { threadId: this.threadId };
      await this.rpc.request<ThreadCompactStartResponse>('thread/compact/start', params);
    } catch (err) {
      finish('request-failed');
      await completion;
      this.compacting = false;
      this.compactTurnId = null;
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    const outcome = await completion;
    this.compacting = false;
    this.compactTurnId = null;
    if (outcome === 'completed') return { ok: true };
    if (outcome === 'timeout') {
      // A timeout must never become a false success while Codex still owns an
      // active Compact turn. Terminate the transport and make the dispatcher
      // drop this worker; the next operator turn resumes the durable thread in
      // a fresh app-server process.
      this.hardKill();
      this.teardownProcess();
      return {
        ok: false,
        recycle: true,
        error: `Codex compact did not complete within ${Math.round(this.compactTimeoutMs / 60_000)} minutes; the app-server process was recycled. Resend your message to continue from the last durable thread state.`,
      };
    }
    return {
      ok: false,
      recycle: true,
      error: 'Codex app-server ended before compaction completed; the next turn will resume the durable thread in a fresh process.',
    };
  }

  // Drain the compactThread() waiters. Idempotent — safe to call from compact
  // turn/completed, dispose, and child death so the operator never hangs.
  private resolveCompaction(outcome: CompactOutcome): void {
    const waiters = this.compactWaiters;
    this.compactWaiters = [];
    for (const w of waiters) w(outcome);
  }

  // Phase 6b — drain the steer queue and hand the items to Codex via
  // `turn/steer`. The drain hook is fired by `onItemCompleted` after every
  // tool item lands; `expectedTurnId` makes the steer fail loud if the
  // turn ended in the round-trip window.
  //
  // Re-queue semantics on errors mirror the §9 mapping:
  //   - activeTurnNotSteerable {turnKind: review|compact} → re-enqueue to
  //     the steer bucket; the next operator turn picks it up
  //   - mismatched turnId / turn already ended → re-enqueue as follow-up
  //   - any other transport error → re-enqueue to follow-up + system_notice
  private async dispatchSteer(items: SteerItem[]): Promise<void> {
    if (!this.rpc || !this.threadId || !this.current.turnId) {
      // No live turn — push everything back into follow-up so the operator
      // sees their messages reappear after the next user_message arrives.
      this.requeueSteer(items, 'follow-up', 'turn ended before steer dispatched');
      return;
    }
    const params: TurnSteerParams = {
      threadId: this.threadId,
      input: buildSteerInput(items),
      responsesapiClientMetadata: null,
      expectedTurnId: this.current.turnId,
    };
    try {
      const res = await this.rpc.request<TurnSteerResponse>('turn/steer', params);
      this.current.steerCount += 1;
      console.log(`[appserver:${this.workflowId.slice(0, 8)}] steer landed (turnId=${res.turnId.slice(0, 8)}, items=${items.length})`);
    } catch (err) {
      const rpc = (err instanceof JsonRpcRequestError) ? err.rpcError : null;
      const data = rpc?.data as { codexErrorInfo?: CodexErrorInfo } | undefined;
      const info = data?.codexErrorInfo;
      if (info && typeof info === 'object' && 'activeTurnNotSteerable' in info) {
        const kind = info.activeTurnNotSteerable.turnKind;
        this.requeueSteer(items, 'steer', `turn not steerable (kind=${kind})`);
      } else {
        // Anything else — mismatched expectedTurnId, transport blip, etc.
        // Treat as follow-up; the operator's next turn will see the item.
        const reason = err instanceof Error ? err.message : String(err);
        this.requeueSteer(items, 'follow-up', `steer rpc failed: ${reason}`);
        // Surface non-`activeTurnNotSteerable` failures so the operator sees
        // a telltale system_notice. Don't surface `activeTurnNotSteerable`
        // there — that's expected during compact / review and would spam.
        this.emit('system_notice', `Mid-turn steer was not delivered (${reason}); re-queued as follow-up.`);
      }
    }
  }

  // Re-enqueue support — Phase 6b. The drain callback is destructive
  // (splice on the server-side queue), so on failure we hand the items back
  // through a server-supplied callback rather than reaching into wf.queue
  // directly. The hook is set on the WorkerConfig at turn-begin time.
  private requeueSteer(items: SteerItem[], bucket: 'steer' | 'follow-up', reason: string): void {
    const requeue = this.config.requeueSteer;
    if (!requeue) {
      console.warn(`[appserver:${this.workflowId.slice(0, 8)}] steer dispatch failed (${reason}) and no requeue hook — ${items.length} item(s) dropped`);
      return;
    }
    try {
      requeue(items, bucket);
    } catch (err) {
      console.error(`[appserver:${this.workflowId.slice(0, 8)}] requeue hook threw:`, err);
    }
    console.log(`[appserver:${this.workflowId.slice(0, 8)}] steer re-queued (bucket=${bucket}, items=${items.length}, reason=${reason})`);
  }

  // Workflow tab close → tear down the long-lived child. Pending turn (if
  // any) is force-settled.
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.operatorQuestions.cancel('The worker was disposed.');
    // Force a settle if a turn is in flight — caller (workflow remove)
    // already broadcast turn-end / cancel; we don't fight that.
    if (this.current.turnId) {
      this.settleTurn({ error: 'Worker disposed (workflow removed)' });
    }
    // Best-effort graceful close. Stdin end → app-server flushes + exits.
    // Hard kill after a short grace if it doesn't go down on its own.
    try { this.proc?.stdin?.end(); } catch { /* ignore */ }
    const proc = this.proc;
    // Resolves once the child is actually gone (or after a cap). Callers
    // that are about to resume the same thread from another process must
    // await this — codex holds a single-writer lock on the thread until exit.
    const exited = proc && proc.exitCode === null && proc.signalCode === null
      ? new Promise<void>((resolve) => {
          proc.once('exit', () => resolve());
          setTimeout(resolve, 3000).unref();
        })
      : Promise.resolve();
    if (proc && proc.pid) {
      const pid = proc.pid;
      setTimeout(() => {
        try {
          // Only kill if still alive — process.kill(pid, 0) probes liveness.
          process.kill(pid, 0);
          killProcessTree(pid);
        } catch { /* already exited */ }
      }, 500);
    }
    this.teardownProcess();
    await exited;
  }

  // Wire the SandboxPolicy field on `turn/start`. Defaults to the same
  // shape `thread/start` set at bootstrap; only overridden when
  // additionalDirectories changes between turns (the resume-narrows-flags
  // gotcha from exec mode goes away here — the protocol takes the policy
  // per-turn).
  private buildSandboxPolicy(): TurnStartParams['sandboxPolicy'] {
    const sandbox = mapSandbox(this.config);
    if (sandbox === 'danger-full-access') {
      return { type: 'dangerFullAccess' };
    }
    if (sandbox === 'read-only') {
      return { type: 'readOnly', networkAccess: false };
    }
    // workspace-write — fold additionalDirectories into writableRoots.
    return {
      type: 'workspaceWrite',
      writableRoots: this.config.additionalDirectories ?? [],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    };
  }

  // ── Notification handling ────────────────────────────────────────────

  private onNotification(n: JsonRpcNotification): void {
    switch (n.method) {
      case 'serverRequest/resolved': {
        const p = n.params as { threadId: string; requestId: string | number };
        if (p.threadId === this.threadId) this.operatorQuestions.resolvedRpc(p.requestId);
        return;
      }
      case 'thread/started': {
        const p = n.params as ThreadStartedNotification;
        this.threadId = p.thread.id;
        return;
      }
      case 'turn/started': {
        // An operator-triggered compaction runs as Codex's own internal turn.
        // Don't adopt its turnId as an Arco operator turn — otherwise a real
        // operator turn would be refused ("turn in flight") and the compact's
        // turn/completed would try to settle a turn nobody is listening for.
        const p = n.params as TurnStartedNotification;
        if (this.compacting) {
          this.compactTurnId = p.turn.id;
          return;
        }
        // Only adopt turns ARCO started. `startedAt` is stamped in
        // beginTurn() before the `turn/start` RPC, so a genuine operator turn
        // always has it by the time this notification can land — while a turn
        // Codex starts on its own (goal auto-continuation, and anything like
        // it) arrives with our state empty. Adopting one of those latched a
        // turn no wrapper was listening for: it could never settle, so every
        // subsequent operator send threw "already has a turn in flight" with
        // no way out but closing the tab. See the 2026-07-28 goal-loop
        // incident noted on `clearThreadGoal`.
        if (!this.current.startedAt) {
          console.warn(`[appserver:${this.workflowId.slice(0, 8)}] ignoring Codex-initiated turn ${p.turn.id.slice(0, 8)} (no operator turn in flight)`);
          this.emit('system_notice', `[${appServerNoticeTag(this.config)}] Codex started a turn on its own — ignored. Arco only tracks operator-initiated turns.`);
          return;
        }
        // turn/start's response also carries the id; this is a redundant
        // confirmation. Capture if turn/start hadn't returned yet.
        if (!this.current.turnId) this.current.turnId = p.turn.id;
        return;
      }
      case 'thread/goal/updated': {
        // Surfaced, not silently honored — an agent arming a Codex-native
        // persistent goal is exactly the thing that must never be invisible.
        // The next bootstrap clears it; say so now so the operator sees it in
        // the transcript rather than as unexplained background spend.
        const p = n.params as ThreadGoalUpdatedNotification;
        console.warn(`[appserver:${this.workflowId.slice(0, 8)}] Codex-native thread goal set (status=${p.goal.status}) — clearing`);
        this.emit('system_notice', `[${appServerNoticeTag(this.config)}] The model set a Codex-native persistent goal ("${p.goal.objective.slice(0, 120)}…"). Arco cleared it — use the NORTH STAR field instead.`);
        void this.clearThreadGoal();
        return;
      }
      case 'item/agentMessage/delta': {
        const p = n.params as AgentMessageDeltaNotification;
        // Separate distinct agentMessage items with a paragraph break so the
        // chat doesn't render consecutive narration blocks glued together. The
        // guard on a non-null prior id means we only break BETWEEN items, never
        // before the first one. fullText only accumulates agent text (reasoning
        // streams via emit('thinking')), so its length is the right "have we
        // emitted anything yet" signal.
        if (
          this.current.lastAgentMsgItemId !== null &&
          p.itemId !== this.current.lastAgentMsgItemId &&
          this.current.fullText.length > 0
        ) {
          this.appendText('\n\n');
        }
        this.current.lastAgentMsgItemId = p.itemId;
        this.appendText(p.delta);
        return;
      }
      case 'item/reasoning/textDelta': {
        const p = n.params as ReasoningTextDeltaNotification;
        if (p.delta) this.emit('thinking', p.delta);
        return;
      }
      case 'item/reasoning/summaryTextDelta': {
        const p = n.params as ReasoningSummaryTextDeltaNotification;
        if (p.delta) this.emit('thinking', p.delta);
        return;
      }
      case 'item/started': {
        const p = n.params as ItemStartedNotification;
        this.emitToolUseFromItem(p.item, 'started');
        return;
      }
      case 'item/completed': {
        const p = n.params as ItemCompletedNotification;
        this.emitToolUseFromItem(p.item, 'completed');
        const asyncItem = p.item as ThreadItem & { delivery?: string; questions?: unknown };
        if (asyncItem.type === 'agentMessage' && asyncItem.delivery === 'async' && p.threadId === this.threadId && this.current.startedAt && (!this.current.turnId || p.turnId === this.current.turnId)) {
          try { this.operatorQuestions.acceptAsync(p.threadId, p.turnId, asyncItem); }
          catch { this.emit('system_notice', 'Codex sent an async question Arco could not display.'); }
        }
        // §H4 — persist + render a generated image. The persist is async (decode
        // → fs write) so it runs OUT-OF-BAND of this sync handler: we kick it off
        // fire-and-forget and DO NOT await it here, so the drain hook below still
        // fires in the same tick exactly as before. `handleImageGeneration` never
        // rejects (it catches + surfaces a structured failure).
        if (p.item.type === 'imageGeneration') {
          void this.handleImageGeneration(p.item as ImageGenerationItem);
        }
        // Phase 6b — drain hook. Fire after every item completes; the
        // expectedTurnId precondition on `turn/steer` is the safety net for
        // the late-arriving case (turn ended between `item/completed` and
        // the steer round-trip).
        this.tryDrainSteer();
        return;
      }
      case 'thread/tokenUsage/updated': {
        const p = n.params as ThreadTokenUsageUpdatedNotification;
        if (this.compacting) return;
        if (!this.current.startedAt) return;
        if (this.current.turnId && p.turnId !== this.current.turnId) return;
        if (!this.current.turnId) this.current.turnId = p.turnId;
        this.lastTokenUsage = p;
        if (typeof p.tokenUsage.modelContextWindow === 'number') {
          this.resolvedContextWindow = p.tokenUsage.modelContextWindow;
        }
        return;
      }
      case 'turn/completed': {
        // The compact's own internal turn completing is a completion signal,
        // not an operator turn settle. Resolve the compact and stop — don't
        // route it through onTurnCompleted (no wrapper is listening).
        if (this.compacting) {
          const p = n.params as TurnCompletedNotification;
          if (this.compactTurnId && p.turn.id !== this.compactTurnId) {
            console.warn(`[appserver:${this.workflowId.slice(0, 8)}] ignored turn/completed ${p.turn.id.slice(0, 8)} while waiting for compact turn ${this.compactTurnId.slice(0, 8)}`);
            return;
          }
          this.resolveCompaction('completed');
          return;
        }
        const p = n.params as TurnCompletedNotification;
        this.onTurnCompleted(p);
        return;
      }
      case 'error': {
        const p = n.params as ErrorNotification;
        this.onErrorNotification(p);
        return;
      }
      case 'configWarning':
      case 'deprecationNotice': {
        const params = (n.params ?? {}) as { summary?: string; details?: string };
        const msg = `[${appServerNoticeTag(this.config)}] ${params.summary ?? n.method}${params.details ? ' — ' + params.details : ''}`;
        this.emit('system_notice', msg);
        return;
      }
      case 'model/rerouted': {
        const p = n.params as { fromModel?: string; toModel?: string; reason?: string };
        this.emit('system_notice', `[${appServerNoticeTag(this.config)}] Model rerouted: ${p.fromModel ?? '?'} → ${p.toModel ?? '?'}${p.reason ? ' (' + p.reason + ')' : ''}`);
        return;
      }
      case 'thread/compacted': {
        // Fires both for Codex's own auto-compaction (mid-turn, internal) and
        // when an operator-triggered compact has written its summary. It is NOT
        // an idle signal: the compact turn can remain active briefly afterward,
        // so compactThread() continues waiting for turn/completed.
        this.emit('system_notice', `[${appServerNoticeTag(this.config)}] Thread context was compacted internally.`);
        return;
      }
      // Drop the high-volume / not-relevant notifications — see §3 of the
      // plan doc. Keep the default-no-op so future Codex CLI bumps that add
      // notifications don't crash the worker.
      default:
        return;
    }
  }

  private emitToolUseFromItem(item: ThreadItem, status: 'started' | 'completed'): void {
    // Map the discriminated `ThreadItem` union to our `tool_use` shape.
    // Mirror the verb naming exec-mode's `codex-stream` produces so the
    // Activity tab's TOOL_VERBS map ("Bash", "Patching", …) keeps working
    // unchanged on appserver tabs.
    const provider = appServerProvider(this.config);
    switch (item.type) {
      case 'commandExecution': {
        const completed = status === 'completed';
        const finalStatus: ToolUseEvent['status'] =
          completed ? (item.exitCode === 0 ? 'completed' : 'failed') : 'started';
        this.emit('tool_use', {
          name: 'Bash',
          input: JSON.stringify({ command: item.command, cwd: item.cwd }),
          status: finalStatus,
          provider,
          itemType: 'command_execution',
          itemId: item.id,
          ...(completed && item.aggregatedOutput !== null
            ? { output: item.aggregatedOutput }
            : {}),
          ...(completed && item.exitCode !== null ? { exitCode: item.exitCode } : {}),
        });
        return;
      }
      case 'fileChange': {
        const completed = status === 'completed';
        const finalStatus: ToolUseEvent['status'] =
          completed ? (item.status === 'completed' ? 'completed' : 'failed') : 'started';
        const summary = item.changes.map((c) => c.path).join(', ');
        this.emit('tool_use', {
          name: 'apply_patch',
          input: JSON.stringify({ paths: item.changes.map((c) => c.path) }),
          status: finalStatus,
          provider,
          itemType: 'file_change',
          itemId: item.id,
          ...(completed ? { output: summary } : {}),
        });
        return;
      }
      case 'webSearch': {
        const finalStatus: ToolUseEvent['status'] = status === 'completed' ? 'completed' : 'started';
        this.emit('tool_use', {
          name: 'web_search',
          input: JSON.stringify({ query: item.query }),
          status: finalStatus,
          provider,
          itemType: 'web_search',
          itemId: item.id,
        });
        return;
      }
      case 'mcpToolCall': {
        const completed = status === 'completed';
        const finalStatus: ToolUseEvent['status'] =
          completed ? (item.error === null ? 'completed' : 'failed') : 'started';
        this.emit('tool_use', {
          name: `${item.server}/${item.tool}`,
          input: JSON.stringify(item.arguments ?? {}),
          status: finalStatus,
          provider,
          itemType: 'mcp_tool_call',
          itemId: item.id,
        });
        return;
      }
      case 'plan': {
        const finalStatus: ToolUseEvent['status'] = status === 'completed' ? 'completed' : 'started';
        this.emit('tool_use', {
          name: 'update_plan',
          input: JSON.stringify({ text: item.text }),
          status: finalStatus,
          provider,
          itemType: 'update_plan',
          itemId: item.id,
        });
        return;
      }
      case 'imageGeneration': {
        // §H4 — surface a `started` tool_use for transcript/Activity visibility.
        // The terminal completed/failed tool_use is emitted by
        // `handleImageGeneration` once the async persist resolves (it knows the
        // saved path / failure reason). Emitting `completed` here too would
        // race the persist, so we only surface `started` from this sync path.
        if (status === 'started') {
          this.emit('tool_use', {
            name: 'image_generation',
            input: JSON.stringify({ prompt: item.revisedPrompt ?? '' }),
            status: 'started',
            provider,
            itemType: 'image_generation',
            itemId: item.id,
          });
        }
        return;
      }
      // agentMessage / reasoning / userMessage / hookPrompt / imageView /
      // collabAgentToolCall / dynamicToolCall / contextCompaction /
      // enteredReviewMode / exitedReviewMode are not surfaced as tool_use
      // events — they're either streamed via deltas (agentMessage, reasoning)
      // or out-of-scope for v1.
      default:
        return;
    }
  }

  // §H4 — async persist + render of a Codex `image_generation_call` result.
  // Invoked fire-and-forget from the `item/completed` handler (NEVER awaited
  // there, so the drain hook fires unaffected). Decodes/locates the image,
  // writes it confined to the workflow cwd, then emits a `primary_artifact`
  // (renders inline + persists to events.jsonl) plus a terminal `tool_use`.
  // Never rejects — every failure path surfaces a structured tool_use + notice.
  private async handleImageGeneration(item: ImageGenerationItem): Promise<void> {
    const cwd = this.config.cwd || '';
    const provider = appServerProvider(this.config);
    const fail = (reason: string): void => {
      this.emit('tool_use', {
        name: 'image_generation',
        input: JSON.stringify({ prompt: item.revisedPrompt ?? '' }),
        status: 'failed',
        provider,
        itemType: 'image_generation',
        itemId: item.id,
        output: reason,
      });
      this.emit('system_notice', `[${appServerNoticeTag(this.config)}] Image generation could not be saved: ${reason}`);
    };

    try {
      if (isGenerationFailure(item.status)) {
        fail(`generation reported status "${item.status}"`);
        return;
      }

      const target = resolveGeneratedImageTarget(cwd, item);
      if (!target.ok) {
        fail(target.reason);
        return;
      }

      let relPath = target.relPath;
      if (target.source === 'decoded') {
        // Pick a non-clobbering filename, then write the bytes. Pure fs — no
        // shell. Confinement is re-checked on every candidate.
        const written = await this.writeGeneratedImage(cwd, target.relPath, target.buf, item.id);
        if (!written) {
          fail('failed to write decoded image bytes to cwd');
          return;
        }
        relPath = written;
      }
      // (savedPath source: the app-server already wrote it inside cwd; nothing
      // to write — we just surface the in-cwd relative path.)

      const title = generatedImageTitle(item);
      // Renders inline + persists to events.jsonl via the broadcast/seq path.
      this.emit('primary_artifact', {
        artifactId: randomUUID(),
        kind: 'image',
        title,
        path: relPath,
        openInEditor: true,
      });
      // Terminal tool_use so the Activity tab flips the row to completed.
      this.emit('tool_use', {
        name: 'image_generation',
        input: JSON.stringify({ prompt: item.revisedPrompt ?? '' }),
        status: 'completed',
        provider,
        itemType: 'image_generation',
        itemId: item.id,
        output: relPath,
      });
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  }

  // Write decoded image bytes to a confined, non-clobbering filename inside cwd.
  // Returns the cwd-relative path on success, null on failure. Pure fs.
  private async writeGeneratedImage(
    cwd: string,
    preferredRelPath: string,
    buf: Buffer,
    itemId: string,
  ): Promise<string | null> {
    for (let attempt = 0; attempt < 6; attempt++) {
      const relPath = attempt === 0 ? preferredRelPath : generatedImageRelPath(itemId, `-${attempt}`);
      let abs: string;
      try {
        abs = resolveWithinCwd(cwd, relPath);
      } catch {
        return null;
      }
      // Don't clobber an existing file — try the next suffix.
      try {
        await access(abs);
        continue; // exists; bump the suffix
      } catch {
        // doesn't exist — claim it
      }
      try {
        await writeFile(abs, buf, { flag: 'wx' });
        return relPath;
      } catch {
        // Lost a race (wx) or transient — try the next suffix.
        continue;
      }
    }
    return null;
  }

  private appendText(text: string): void {
    if (this.current.capped || !text) return;
    const remaining = MAX_WORKER_OUTPUT_BYTES - this.current.textBytes;
    if (text.length <= remaining) {
      this.current.fullText += text;
      this.current.textBytes += text.length;
      this.emit('text', text);
      return;
    }
    const fit = remaining > 0 ? text.slice(0, remaining) : '';
    if (fit) {
      this.current.fullText += fit;
      this.current.textBytes += fit.length;
      this.emit('text', fit);
    }
    this.current.fullText += OUTPUT_TRUNCATION_NOTICE;
    this.emit('text', OUTPUT_TRUNCATION_NOTICE);
    this.current.capped = true;
    // Mirror exec mode: a capped output force-cancels the turn so the
    // workflow doesn't burn more model context after we're already
    // truncating client-visible bytes.
    void this.cancelCurrentTurn().catch((err) => {
      console.warn(`[appserver:${this.workflowId.slice(0, 8)}] post-cap cancel failed:`, err);
    });
  }

  private onTurnCompleted(p: TurnCompletedNotification): void {
    if (!this.current.turnId) return;
    if (p.turn.id !== this.current.turnId) return;
    // Resolve any pending interrupt waiter — kill() awaits this notification.
    if (this.current.interruptResolve) {
      const r = this.current.interruptResolve;
      this.current.interruptResolve = null;
      this.current.interruptDeadline = null;
      r();
    }
    if (p.turn.status === 'interrupted') {
      this.settleTurn({ error: 'Worker killed' });
      return;
    }
    if (p.turn.status === 'failed') {
      const reason = p.turn.error?.message ?? 'turn failed (no message)';
      const info = p.turn.error?.codexErrorInfo;
      if (info) this.applyCodexErrorInfo(info, reason);
      this.settleTurn({ error: reason });
      return;
    }
    // Completed cleanly. Build the Arco-shape result.
    const usageSnapshot = this.lastTokenUsage?.turnId === p.turn.id ? this.lastTokenUsage : null;
    const usage = usageSnapshot?.tokenUsage.last;
    const total = usageSnapshot?.tokenUsage.total;
    const modelContextWindow = this.config.provider === 'zai'
      ? zaiModelContextWindow(this.config.model)
      : this.resolvedContextWindow;
    const result: TurnSettleData = {
      text: this.current.fullText,
      costUsd: 0,
      durationMs: typeof p.turn.durationMs === 'number' ? p.turn.durationMs : Date.now() - this.current.startedAt,
      ...(typeof modelContextWindow === 'number' && modelContextWindow > 0 ? { modelContextWindow } : {}),
      // Live scripts need the last request's prompt, never a sum of tool rounds
      // or a rollout that may not yet have flushed to disk.
      ...(usage ? { lastPromptTokens: usage.inputTokens } : {}),
      ...(usage ? {
        usage: {
          // Map TokenUsageBreakdown → Arco's TokenUsage usageToTokens()
          // input. `cached_input_tokens` is a SUBSET of `input_tokens` for
          // OpenAI — see GOTCHAS.md "Codex" section. Surface as cacheRead
          // for the per-worker hover display; the client-side `contextTokens`
          // function already knows not to sum cacheRead into input on Codex.
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
          cache_read_input_tokens: usage.cachedInputTokens,
          cache_creation_input_tokens: 0,
          ...(typeof usage.reasoningOutputTokens === 'number' ? { reasoning_output_tokens: usage.reasoningOutputTokens } : {}),
          ...(typeof total?.totalTokens === 'number' ? { total_tokens: total.totalTokens } : {}),
        },
      } : {}),
    };
    this.settleTurn({ result });
  }

  private onErrorNotification(p: ErrorNotification): void {
    if (p.willRetry) {
      if (p.error.codexErrorInfo) {
        this.applyCodexErrorInfo(p.error.codexErrorInfo, p.error.message);
      }
      // App-server is doing its own retry — surface as a system_notice so
      // the operator knows the turn isn't dead yet. GPT-5.5 can produce
      // several identical retry notifications on a busy backend, so cap
      // duplicate chat noise while keeping the first few breadcrumbs.
      const code = codexErrorInfoLabel(p.error.codexErrorInfo);
      const suffix = p.error.additionalDetails ? ` (${p.error.additionalDetails.slice(0, 300)})` : '';
      const tag = appServerNoticeTag(this.config);
      const notice = `[${tag}] Transient error${code ? ` (${code})` : ''}, will retry: ${p.error.message}${suffix}`;
      const key = `${code ?? ''}\0${p.error.message}`;
      if (this.current.transientNoticeKey === key) {
        this.current.transientNoticeCount += 1;
      } else {
        this.current.transientNoticeKey = key;
        this.current.transientNoticeCount = 1;
      }
      if (this.current.transientNoticeCount <= 3) {
        this.emit('system_notice', notice);
      } else if (this.current.transientNoticeCount === 4) {
        this.emit('system_notice', `[${tag}] Further identical transient errors suppressed for this turn. ${tag} is still retrying: ${p.error.message}`);
      }
      return;
    }
    if (p.error.codexErrorInfo) {
      this.applyCodexErrorInfo(p.error.codexErrorInfo, p.error.message);
    }
    // The settle path lives on `turn/completed { status: 'failed' }`.
    // `error { willRetry:false }` typically precedes a turn-completed-failed
    // landing; if the protocol ever leaks one without a turn/completed, the
    // eventual turn end will surface the same message anyway.
  }

  private applyCodexErrorInfo(info: CodexErrorInfo, fallbackMsg: string): void {
    if (isCodexQuotaInfo(info, fallbackMsg)) {
      const provider = appServerProvider(this.config);
      const cooldown = provider === 'zai' ? ZAI_APP_SERVER_COOLDOWN_MS : CODEX_COOLDOWN_MS;
      markThrottled(provider, fallbackMsg.slice(0, 500), Date.now() + cooldown);
      return;
    }
    if (info === 'unauthorized') {
      // [AUTH:<provider>] sentinel — see GOTCHAS.md "Auth-expired notices".
      this.emit('system_notice', `[AUTH:${appServerProvider(this.config)}] ${fallbackMsg}`);
      return;
    }
    if (info === 'contextWindowExceeded') {
      this.emit('system_notice', `[${appServerNoticeTag(this.config)}] Context window exceeded — Handoff to a fresh thread to continue.`);
      return;
    }
    // Other codes (httpConnectionFailed, internalServerError, sandboxError,
    // …) ride along on the eventual turn-completed-failed without special
    // handling — operator sees the message, no quota state changes.
  }

  // Drain the steer queue if there's a hook + a pending steer. Best-effort
  // and async — the dispatch is fire-and-forget; the result lands on the
  // next assistant message stream the model emits.
  private tryDrainSteer(): void {
    const drainSteer = this.config.drainSteer;
    if (!drainSteer || !this.current.turnId) return;
    let items: SteerItem[];
    try {
      items = drainSteer();
    } catch (err) {
      console.warn(`[appserver:${this.workflowId.slice(0, 8)}] drainSteer threw:`, err);
      return;
    }
    if (items.length === 0) return;
    void this.dispatchSteer(items).catch((err) => {
      console.warn(`[appserver:${this.workflowId.slice(0, 8)}] dispatchSteer rejected:`, err);
    });
  }

  // Settle helper — fire `turn_settled`, clear current-turn state. Idempotent
  // (subsequent calls during the same turn are no-ops; the turn id is the
  // gate).
  private settleTurn(data: { error?: string; result?: TurnSettleData }): void {
    this.operatorQuestions.cancel('The turn ended before an answer was received.', true);
    if (!this.current.turnId && !this.current.startedAt) {
      // No turn was actually in flight (e.g., kill() before turn/start).
      // Fire once anyway so the wrapper can resolve.
      this.current = emptyTurnState();
      this.emit('turn_settled', data);
      return;
    }
    this.current = emptyTurnState();
    if (data.error && data.error !== 'Worker killed') {
      // Also run the stderr fallback throttle sniffer in case the protocol
      // didn't surface the rate-limit info — paranoia per §8.
      const parsed = parseCodexThrottle(this.stderrBuf);
      if (parsed) markThrottled(appServerProvider(this.config), this.stderrBuf.slice(-500), parsed.resetsAt);
    }
    this.emit('turn_settled', data);
  }

  // Child-process death (exit / spawn error). Tear down RPC, emit fatal,
  // settle any in-flight turn. The next ensureStarted() will rebuild.
  private onChildDeath(reason: string): void {
    if (!this.proc && !this.rpc) return;
    console.warn(`[appserver:${this.workflowId.slice(0, 8)}] child death — ${reason}`);
    if (this.current.turnId || this.current.startedAt) {
      this.settleTurn({ error: `codex app-server died: ${reason}` });
    }
    this.teardownProcess();
    this.emit('fatal', reason);
  }

  private teardownProcess(): void {
    this.operatorQuestions.cancel('The Codex connection closed.');
    if (this.rpc) {
      try { this.rpc.close('worker teardown'); } catch { /* ignore */ }
      this.rpc = null;
    }
    this.proc = null;
    this.bootstrapped = false;
    // A compact in flight when the child goes down can never get its
    // completion signal — drain the waiters so compactThread() resolves
    // instead of waiting out the full timeout. The result is still reported
    // ok:true (Codex may have compacted before dying; the next resume picks
    // up whatever landed on disk).
    this.compacting = false;
    this.compactTurnId = null;
    this.resolveCompaction('transport-ended');
    // Don't clear threadId / resolvedModel — they're still valid on disk; a
    // re-spawn re-resumes via thread/resume.
  }

  private hardKill(): void {
    const proc = this.proc;
    if (!proc || !proc.pid) return;
    try { killProcessTree(proc.pid); } catch { /* ignore */ }
  }
}

// Pinned-version probe export. Surfaced from the dispatcher's first-use
// path so a CLI-version mismatch lands as a one-time system_notice rather
// than a confusing wire-shape error mid-turn.
export function getPinnedCodexCliVersion(): string {
  return PINNED_CODEX_CLI_VERSION;
}
