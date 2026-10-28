// The primary-worker chat primitive.
//
// One operator turn = one short-lived provider spawn, pinned to a native CLI
// session so the conversation survives across turns (and is resumable from a
// terminal). On the first turn we mint a Claude UUID or let Codex mint its
// own thread_id at `thread.started`; from turn two on, the session id is
// passed back in as `resumeSessionId` and the CLI's `--resume` / `exec resume`
// form picks up where the last turn left off.
//
// Worker events are translated to `orchestrator_text` / `orchestrator_complete`
// (phase=passthrough) so the existing client chat pipeline + TokenBadge light
// up unchanged. "orchestrator_*" naming is transitional — the protocol rename
// to primary_* is deferred to Phase 8.

import { randomUUID } from 'crypto';
import { WorkerManager } from '../workers/WorkerManager.js';
import type { PrimaryBackgroundTracker } from '../primaryBackgroundTracker.js';
import type {
  ServerMessage,
  ProviderName,
  ModelName,
  EffortLevel,
  SteerItem,
  WorkerConfig,
} from '@arco/shared';
import * as clusterMailbox from '../clusterMailbox.js';
import * as clusterBudget from '../clusterBudget.js';
import * as clusterStore from '../clusterStore.js';
import * as stuckBreaker from '../workers/stuckBreaker.js';
import { extractReadPath, recordSkillRead } from '../skillUsage.js';
import { addGoalRunTokens } from '../goalRun.js';
import { workflows } from '../server/state.js';

export interface PrimaryConfig {
  provider: ProviderName;
  model: ModelName;
  effort: EffortLevel;
  tools?: string[];
  additionalDirectories?: string[];
  skipPermissions?: boolean;
  fallbackModel?: ModelName;
}

export interface TurnContext {
  workflowId: string;
  cwd: string;
  manager: WorkerManager;
  broadcast: (msg: ServerMessage) => void;
  // Optional — when present, `worker_tool_use` events are inspected for
  // Bash calls with `run_in_background: true` and the turn's CLI pid is
  // handed off to the tracker so long-running descendants survive past
  // primary_complete in the Activity tab.
  bgTracker?: PrimaryBackgroundTracker;
  // Optional — when present, every Bash command from the primary is sniffed
  // for a dev-server-shaped invocation. Match → kick a port probe → bind
  // the Preview tab automatically. `toolUseId` enables Layer 2 PID-attributed
  // discovery (deterministic when the bgTracker picks up the descendant);
  // omitted on non-bg paths where Layer 1 carries the load alone. See
  // previewAutoDetect.ts.
  notePotentialDevServerStart?: (command: string, toolUseId?: string) => void;
  // Optional — when present, every primary_text delta is scanned for
  // `http://localhost:NNNN` URLs. Catches the case where the dev server
  // was already running before this turn (so no Bash hint fires) but the
  // agent still prints the URL per the system-prompt nudge.
  noteAgentText?: (text: string) => void;
}

export interface TurnHandle {
  workerId: string;
  // Pre-minted UUID for Claude-first-turn. Empty for Codex (captured at init)
  // and Gemini/Ollama (no native session concept in Lite). Use
  // `onSessionDiscovered` to learn Codex's thread_id when it arrives.
  initialSessionId: string;
  settled: Promise<{ error?: string; lastPromptTokens?: number; modelContextWindow?: number }>;
  // Fires exactly once when the provider emits its init event. Carries the
  // authoritative native session id (Codex thread_id; Claude confirms the
  // pre-minted uuid). Never fires for Gemini/Ollama since they have no init-
  // phase session payload.
  onSessionDiscovered: (cb: (sessionId: string) => void) => void;
}

// docs/PROTOCOL_CLUSTER.md - pre-turn injection helper.
//
// Drains the recipient's mailbox, emits one `peer_message_received` event
// per drained item via the supplied broadcast (each lands in events.jsonl
// when the broadcast is the workflow-scoped persisted-broadcast helper),
// and returns a formatted system-block prologue ready to fold into the
// turn's `appendSystemPrompt`. Caller MUST invoke this BEFORE emitting
// the operator's `user_message_echo` so the events.jsonl ordering rule
// holds: peer_message_received comes before user_message on the same
// turn. The prologue text follows the plan §6.1b shape verbatim.
export async function drainPeerMailbox(
  workflowId: string,
  broadcast: (msg: ServerMessage) => void,
): Promise<string | undefined> {
  const drained = await clusterMailbox.drain(workflowId).catch(() => []);
  if (drained.length === 0) return undefined;
  const artifactPaths = new Map<string, Array<{ name: string; path: string; byteLength: number }>>();
  for (const m of drained) {
    const materialized = await clusterMailbox.materializeArtifacts(workflowId, m).catch(() => []);
    artifactPaths.set(m.msgId, materialized);
    // 2026-05-12 — stamp with original createdAt so the chat sorts at
    // send-time, not drain-time. See clusterPeerOps.peerRead for the
    // mid-turn equivalent.
    const ts = Date.parse(m.createdAt);
    broadcast({
      type: 'peer_message_received',
      workflowId,
      msgId: m.msgId,
      from: m.fromWorkflowId,
      fromName: m.fromDisplayName,
      content: materialized.length > 0
        ? `${m.content}\n\n[Artifacts materialized]\n${materialized.map((a) => `- ${a.path} (${a.byteLength} bytes)`).join('\n')}`
        : m.content,
      ...(Number.isFinite(ts) ? { ts } : {}),
    });
  }
  // Directive framing — make it structurally hard for the recipient to
  // brush off a substantive peer message. Earlier the prologue was neutral
  // ("from X: <content>") and the recipient often filed reviews/findings as
  // "FYI, plan still complete." The wrapped framing tells the model the
  // expected behavior in the language it can't easily sidestep.
  const clusterId = clusterStore.getClusterIdForWorkflow(workflowId);
  const mailboxOnly = !!clusterId && clusterStore.getMemberAccessMode(clusterId, workflowId) !== 'standard';
  const lines = mailboxOnly
    ? [
      '--- PEER MESSAGES ---',
      '',
      'These are the only cluster materials Arco exposes to this blind worker. Read them and respond only as the sender or operator requested.',
      '',
    ]
    : [
      '--- PEER MESSAGES — READ AND ACT ---',
      '',
      'The following messages arrived in your mailbox since your last turn.',
      'If any message contains a review, findings, or work assignment that',
      'contradicts your current plan state or claimed-complete items:',
      '  - un-tick affected plan items',
      '  - assign follow-ups via peer_send to the responsible peer',
      '  - re-engage on the work within your role (a director delegates it',
      '    rather than doing the peer\'s work)',
      'Do NOT report "standing by" or "no work remaining" when findings imply',
      'remaining work. The peer that sent this expects you to act.',
      '',
    ];
  for (const m of drained) {
    lines.push(`[from ${m.fromDisplayName} at ${m.createdAt}]`);
    lines.push(m.content);
    const materialized = artifactPaths.get(m.msgId) ?? [];
    if (materialized.length > 0) {
      lines.push('[Artifacts materialized]');
      for (const artifact of materialized) lines.push(`- ${artifact.path} (${artifact.byteLength} bytes)`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// §3.1 — turn a breaker verdict into the visible `worker_stuck` event (always)
// plus an operator-facing `system_notice` (on a nudge/pause). Heal-first: the
// 'detected'/nudge trip just surfaces the loop; 'persist'/pause recommends a
// reversible pause (cleared by a success or the operator's next turn) — never a
// kill. The breaker NEVER prompts the worker itself (matching the cluster
// idle-nudger's never-auto-prompt posture); the operator acts on the signal.
function emitWorkerStuck(ctx: TurnContext, toolName: string, verdict: stuckBreaker.StuckVerdict): void {
  const escalation = verdict.action === 'pause' ? 'persist'
    : verdict.action === 'recovered' ? 'recovered'
    : 'detected';
  const recommendedAction = verdict.action === 'pause' ? 'pause'
    : verdict.action === 'nudge' ? 'nudge'
    : 'none';
  const reason = verdict.action === 'pause'
    ? `${toolName} returned the identical failing result ${verdict.streak}× in a row — recommend pausing this worker (reversible: a success or your next turn clears it).`
    : verdict.action === 'recovered'
      ? `${toolName} succeeded — stuck-worker breaker cleared.`
      : `${toolName} returned the identical failing result ${verdict.streak}× in a row with no progress — try a different approach.`;
  ctx.broadcast({
    type: 'worker_stuck',
    workflowId: ctx.workflowId,
    escalation,
    recommendedAction,
    toolName,
    ...(verdict.signature ? { signature: verdict.signature } : {}),
    streak: verdict.streak,
    reason,
  });
  if (verdict.action === 'nudge' || verdict.action === 'pause') {
    ctx.broadcast({ type: 'system_notice', workflowId: ctx.workflowId, content: `Stuck-worker breaker: ${reason}` });
  }
}

export function runPrimaryTurn(
  ctx: TurnContext,
  args: {
    primary: PrimaryConfig;
    prompt: string;
    resumeSessionId?: string;
    // Server-local paths of operator-attached files for this turn. Providers
    // decide how to encode them (Claude content blocks, Codex --image,
    // Ollama /api/chat images, or path references for non-image files).
    attachments?: string[];
    // Mirrors WorkflowMeta.disableRssGuard. When true, the WorkerManager
    // activity poll skips the tree-RSS kill for this primary turn. Operator
    // opt-in only — reviewers/handoff reflections never set this.
    disableRssGuard?: boolean;
    // Pre-rendered workflow transcript prepended to the provider's request.
    // Ollama-as-primary path uses this to feed prior turns through the
    // /api/chat structured-messages shape — without it the model has no
    // memory and the prefix cache has nothing stable to hit. Other primary
    // providers ignore the field (Claude/Codex use native session resume,
    // Gemini concatenates).
    appendSystemPrompt?: string;
    // Provider-side system prompt. Today only the Ollama path consumes it
    // (sets behavior + tool-availability framing for local models). Pass
    // byte-stable text — anything dynamic invalidates the prefix cache.
    systemPrompt?: string;
    interactionMode?: WorkerConfig['interactionMode'];
    // Chat-only: arm the provider's web tools for this turn.
    chatWebAccess?: boolean;
    // Chat-only: the Computer voice operator (docs/VOICE.md).
    voiceOperator?: boolean;
    incognito?: boolean;
    // Phase 5 — mid-turn steer hook. Wired only on the operator-driven
    // primary-turn path so handoff-seed and spawn-from-here flows aren't
    // exposed to a steer the operator queued for the previous tab.
    // Providers that own their loop (Ollama, llama.cpp) call this between
    // tool-result append and the next API round-trip. Other providers
    // ignore it; the post-turn drain still picks up anything not consumed.
    drainSteer?: () => SteerItem[];
    // Phase 6b — paired with drainSteer for the Codex app-server worker.
    // Symmetrical contract — same scoping (primary-turn only), same
    // in-process callback shape. Called when a `turn/steer` round-trip
    // fails and the drained items have to land back in a queue.
    requeueSteer?: (items: SteerItem[], bucket: 'steer' | 'follow-up') => void;
    // Phase 6 — Codex transport selector. Resolved by handleUserMessage
    // from the project/global cascade and threaded through. 'appserver'
    // opts into the long-lived `codex app-server` worker; 'exec' (default)
    // keeps today's per-turn `codex exec --json` worker. Other providers
    // ignore the field.
    codexTransport?: 'exec' | 'appserver';
    codexContextPolicy?: 'max' | 'standard';
    providerAccountRef?: string;
    codexHome?: string;
    // Phase 7a — Claude transport selector. Symmetric with codexTransport.
    // Reviewers / handoff seeds leave this unset so they fall through to
    // the CLI provider (per the §10 reviewer-on-CLI rule).
    claudeTransport?: 'cli' | 'native';
    // docs/PROVIDERS.md - sticky ultracode mode for this turn. The caller has
    // already forced claudeTransport='cli' when this is true. Reviewers /
    // handoff seeds / Task children leave it unset.
    ultracode?: boolean;
    zaiTransport?: 'native' | 'appserver';
    // Phase 7b — Task-spawned children carry this so the Claude Native
    // worker drops `Task` from its tool registry (depth-1 cap). Operator-
    // driven turns and reviewers / handoff seeds leave this unset.
    claudeNativeTaskDisabled?: boolean;
    // Phase 7c-followup — Claude Native server-side compaction. Resolved
    // by handleUserMessage from WorkflowConfig.claudeNativeCompact. Only
    // honored on Claude Native turns; reviewers / handoff seeds always
    // run on CLI (which manages compaction internally) and leave this
    // unset.
    claudeNativeCompact?: boolean;
    // Debug override: force `interleaved-thinking-2025-05-14` on adaptive
    // Claude Native models for A/B testing. Default false.
    claudeNativeForceInterleavedThinkingBeta?: boolean;
    // Adaptive-thinking display for Claude Native. Absent ⇒ 'omitted'.
    // Reviewers / handoff seeds leave it unset (like outputStyle's 'normal').
    claudeNativeThinkingDisplay?: 'omitted' | 'summarized' | 'updates';
    // Operator-initiated plan-mode entry. Resolved by handleUserMessage from
    // WorkflowState.pendingPlanModeEntry (single-turn). Only honoured by
    // Claude Native; other providers / transports ignore the flag.
    claudeNativePlanModeArmed?: boolean;
    // docs/PROVIDERS.md - per-turn notice for Claude Native
    // (mailbox depth / plan-mode nudge). Operator turns only.
    turnNotice?: string;
    // docs/PROVIDERS.md - auto-threshold ctx_action emission.
    // Resolved from WorkflowConfig.efficiencyAutoCompact in handleUserMessage.
    efficiencyAutoCompact?: 'off' | 'conservative' | 'aggressive';
    // docs/PROVIDERS.md - Native tool-result filter mode. Resolved
    // from WorkflowConfig.efficiencyToolFilter in handleUserMessage.
    efficiencyToolFilter?: 'off' | 'conservative' | 'aggressive';
    // docs/PROVIDERS.md - fact-force first-edit gate mode.
    // Resolved from WorkflowConfig.efficiencyFactForce in handleUserMessage.
    // Only honored on Claude Native; CLI parity deferred (master §3.3 F4).
    efficiencyFactForce?: 'on' | 'off';
    // Config-protection write-gate mode. Resolved from
    // WorkflowConfig.efficiencyConfigProtection in handleUserMessage. Native-
    // only; default ON. The operator opts out per-tab via the CONFIG toggle.
    efficiencyConfigProtection?: 'on' | 'off';
    // docs/PROVIDERS.md - opt-in sandbox tools. Resolved from
    // WorkflowConfig.efficiencySandbox in handleUserMessage. Native-only;
    // CLI / Codex ignore the field.
    efficiencySandbox?: 'off' | 'on';
    // docs/PROVIDERS.md - operator-armed durable review gate. Resolved from
    // WorkflowConfig.reviewSafeMode in handleUserMessage. Native-only; CLI /
    // Codex / Gemini ignore the field.
    reviewSafeMode?: 'off' | 'on';
    // docs/PROVIDERS.md - output-style addendum level. Resolved from
    // WorkflowConfig.outputStyle in handleUserMessage. Honored by Claude
    // Native and Codex app-server providers (including Z.ai). Reviewers /
    // handoff seeds / DOCS / GIT primitives hard-code 'normal'. Renamed
    // `caveman` → `terse` 2026-05-10.
    outputStyle?: 'normal' | 'lite' | 'terse';
    // docs/GOTCHAS.md - operator-set persistent north-star, resolved from
    // WorkflowConfig.goal in handleUserMessage. Injected as a stable system block
    // by every transport that folds clusterPlan. Unlike outputStyle, the Review /
    // Handoff / DOCS / GIT seeds INHERIT the source tab's value (they pass it in);
    // Spawn-from-here and Task children inherit the parent's.
    goal?: string;
    // §4.1 — posture-based toolset (session-local). Resolved from
    // WorkflowState.toolPosture in handleUserMessage; threaded to the Native
    // worker which filters buildToolDefs(). Other transports ignore.
    toolPosture?: import('@arco/shared').ToolPosture;
    // docs/PROTOCOL_CLUSTER.md - when set, the Native worker registers
    // peer_* tools and routes their tool_use blocks via peerTools.
    // Resolved by handleUserMessage from clusterStore.getClusterIdForWorkflow
    // at turn start. Ordinary one-off workers leave this unset; the
    // cluster-aware handoff pre-warm resolves it explicitly.
    clusterId?: string;
    clusterAccessMode?: WorkerConfig['clusterAccessMode'];
    // Execution cwd may differ from ctx.cwd for isolated cluster members.
    // persistenceCwd keeps events/meta replay rooted at the owning project.
    executionCwd?: string;
    persistenceCwd?: string;
    clusterTaskBoardAttached?: boolean;
    // docs/PROTOCOL_CLUSTER.md - shared cluster plan body + this
    // member's role hint, resolved at turn start alongside clusterId.
    // Threaded into WorkerConfig so the Native worker's buildSystemBlocks
    // can inject them as forced system blocks. Ordinary one-off workers leave
    // them unset; the cluster-aware handoff pre-warm resolves them explicitly.
    clusterPlan?: string;
    clusterRole?: string;
    // 2026-06-15 — per-cluster efficiency doctrine block (canned restraint
    // text for the cluster's efficiency level + optional operator addendum),
    // resolved at turn start. Threaded into WorkerConfig for system-prompt
    // injection. The cluster-aware handoff pre-warm resolves it explicitly.
    clusterEfficiencyDoctrine?: string;
    // 2026-06-29 — per-cluster progress-tracking doctrine (keep plan/board
    // current), resolved at turn start. Threaded into WorkerConfig for
    // system-prompt injection. The cluster-aware handoff pre-warm resolves it explicitly.
    clusterProgressDoctrine?: string;
    // docs/PROTOCOL_CLUSTER.md - absolute path to the per-workflow
    // mcp-config.json. Only set on CLI Claude cluster-member turns by
    // handleUserMessage. Threaded through to the CLI provider which
    // appends `--mcp-config <path>` to its claude argv.
    clusterMcpConfigPath?: string;
    // docs/PROVIDERS.md - operator-attached codebase-memory-mcp
    // intent + resolved index path. Threaded into the Codex providers so
    // they can build `-c mcp_servers.codebase-memory.*` TOML overrides.
    codebaseMemoryAttached?: boolean;
    codebaseMemoryIndexPath?: string;
    // docs/ARCHITECTURE.md - registry MCP servers + dangerous-tool denials
    // for this turn, resolved from the global registry + the workflow's
    // allowlist. registryServers feed the Codex `-c` overrides AND the CLI
    // Claude mcp-config merge; mcpDisallowedTools feed CLI Claude's
    // --disallowedTools. Reviewers / handoff seeds leave them unset.
    mcpRegistryServers?: import('@arco/shared').ResolvedMcpServer[];
    mcpDisallowedTools?: string[];
    // docs/PROVIDERS.md - per-tab Ollama param preset blob, resolved
    // from WorkflowConfig.ollamaParams in handleUserMessage (Ollama tabs only).
    // Threaded to the Ollama provider which merges it through the typed
    // allowlist; every other provider ignores it.
    ollamaParams?: Record<string, unknown>;
    // Per-tab Claude Native web_search/web_fetch per-turn budget. Native-only;
    // other transports ignore. Absent ⇒ server default (15).
    webSearchMaxUses?: number;
  },
): TurnHandle {
  const { primary, prompt, resumeSessionId, attachments, disableRssGuard, appendSystemPrompt, systemPrompt, interactionMode, chatWebAccess, voiceOperator, incognito, drainSteer, requeueSteer, codexTransport, codexContextPolicy, providerAccountRef, codexHome, claudeTransport, ultracode, zaiTransport, claudeNativeTaskDisabled, claudeNativeCompact, claudeNativeForceInterleavedThinkingBeta, claudeNativeThinkingDisplay, claudeNativePlanModeArmed, turnNotice, efficiencyAutoCompact, efficiencyToolFilter, efficiencyFactForce, efficiencyConfigProtection, efficiencySandbox, reviewSafeMode, outputStyle, goal, toolPosture, clusterId, clusterAccessMode, executionCwd, persistenceCwd, clusterTaskBoardAttached, clusterPlan, clusterRole, clusterEfficiencyDoctrine, clusterProgressDoctrine, clusterMcpConfigPath, codebaseMemoryAttached, codebaseMemoryIndexPath, mcpRegistryServers, mcpDisallowedTools, ollamaParams, webSearchMaxUses } = args;

  const workerId = `primary-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  // Claude: pre-mint on first turn so meta.json can pin it before the CLI
  // even starts. Codex mints its own; we'll learn it via the init event.
  let initialSessionId = resumeSessionId ?? '';
  let claudeNewSessionId: string | undefined;
  if (primary.provider === 'claude' && !resumeSessionId && !incognito) {
    claudeNewSessionId = randomUUID();
    initialSessionId = claudeNewSessionId;
  }

  const spec = {
    id: workerId,
    task: prompt,
    model: primary.model,
    effort: primary.effort,
    provider: primary.provider,
    tools: primary.tools,
    systemPrompt,
    appendSystemPrompt,
  };

  // Per-provider session flag wiring. Claude uses --session-id (new) or
  // --resume (continuation); Codex uses `exec` (new) or `exec resume <uuid>`
  // (continuation) — both mapped via WorkerConfig.sessionId / resumeSessionId.
  const spawnOptions: Parameters<WorkerManager['spawn']>[2] = {
    cwd: executionCwd ?? ctx.cwd,
    persistenceCwd,
    workflowId: ctx.workflowId,
    skipPermissions: primary.skipPermissions,
    additionalDirectories: primary.additionalDirectories,
    fallbackModel: primary.fallbackModel,
    attachments,
    interactionMode,
    chatWebAccess,
    voiceOperator,
    incognito,
    // Every chat worker is read-only, not just codex/cursor: a Z.ai chat on the
    // `appserver` transport runs on the Codex app-server substrate, whose
    // mapSandbox falls back to workspace-write — a projectless chat got a
    // writable shell + apply_patch. Providers without a sandbox ignore it
    // (cursor routes read-only to its print one-shot, as before).
    ...(interactionMode === 'chat' ? { sandbox: 'read-only' as const } : {}),
    disableRssGuard,
    drainSteer,
    requeueSteer,
    codexTransport,
    codexContextPolicy,
    providerAccountRef,
    codexHome,
    claudeTransport,
    ultracode,
    zaiTransport,
    claudeNativeTaskDisabled,
    claudeNativeCompact,
    claudeNativeForceInterleavedThinkingBeta,
    claudeNativeThinkingDisplay,
    claudeNativePlanModeArmed,
    turnNotice,
    efficiencyAutoCompact,
    efficiencyToolFilter,
    efficiencyFactForce,
    efficiencyConfigProtection,
    efficiencySandbox,
    reviewSafeMode,
    outputStyle,
    goal,
    toolPosture,
    clusterId,
    clusterAccessMode,
    clusterTaskBoardAttached,
    clusterPlan,
    clusterRole,
    clusterEfficiencyDoctrine,
    clusterProgressDoctrine,
    clusterMcpConfigPath,
    codebaseMemoryAttached,
    codebaseMemoryIndexPath,
    mcpRegistryServers,
    mcpDisallowedTools,
    ollamaParams,
    webSearchMaxUses,
  };
  if (primary.provider === 'claude' && !incognito) {
    if (resumeSessionId) spawnOptions.resumeSessionId = resumeSessionId;
    else if (claudeNewSessionId) spawnOptions.sessionId = claudeNewSessionId;
  } else if ((primary.provider === 'codex' || primary.provider === 'zai') && !incognito) {
    if (resumeSessionId) spawnOptions.resumeSessionId = resumeSessionId;
  } else if (primary.provider === 'antigravity') {
    // Resume an in-progress Antigravity cascade by id; absence of
    // resumeSessionId tells the RPC layer to start a fresh cascade. The
    // provider surfaces the cascadeId on its init event so seedWorker can
    // pin it as the workflow's primarySessionId for subsequent turns.
    if (resumeSessionId) spawnOptions.resumeSessionId = resumeSessionId;
  } else if (primary.provider === 'gemini') {
    // Gemini supports `-r <index>` resume, but `--list-sessions` returns an
    // index that shifts whenever sessions are added/deleted. The provider
    // resolves the stored UUID → current index immediately before spawn,
    // so we just thread the UUID through here. The `init` event from the
    // CLI surfaces the same UUID back to onInit, which lets seedWorker pin
    // it as primarySessionId on the first turn — same flow as Claude/Codex.
    if (resumeSessionId) spawnOptions.resumeSessionId = resumeSessionId;
  } else if (primary.provider === 'cursor') {
    // Cursor (ACP): the worker persists its sessionId via the `init` event
    // (onInit above → primarySessionId). On a later turn we thread that id
    // back so the worker attempts ACP `session/load` before falling back to
    // a fresh `session/new` - Phase 3 resume. (docs/PROVIDERS.md)
    if (resumeSessionId) spawnOptions.resumeSessionId = resumeSessionId;
  }
  // ollama: no native session — transcript is rebuilt from events.jsonl by
  // the orchestrator and prepended via appendSystemPrompt every turn.

  let sessionDiscoveredCb: ((sid: string) => void) | null = null;
  let discoveredSessionId: string | null = null;
  // Native/API providers — last round's prompt size as reported by the
  // provider. Captured on worker_complete and surfaced via the settled outcome
  // so the server can broadcast a fresh ground-truth context_usage
  // (broadcastTransient — keep it out of events.jsonl; primary_complete
  // already persists the field).
  let turnLastPromptTokens: number | undefined;
  // M6 — the provider-reported context window (Ollama: per-backend probed
  // num_ctx; Codex: rollout model_context_window). Surfaced via the settled
  // outcome so the turn engine can build a ground-truth context_usage with the
  // honest denominator the request actually used, instead of a static map.
  let turnModelContextWindow: number | undefined;
  spawnOptions.onInit = (data) => {
    const sid = data.sessionId ?? '';
    if (!sid) return;
    if (discoveredSessionId) return;
    discoveredSessionId = sid;
    if (sessionDiscoveredCb) sessionDiscoveredCb(sid);
  };

  // docs/PROVIDERS.md - captured here so the matching
  // primary_turn_token_usage broadcast at end-of-turn can stamp the same
  // timestamp as a stable per-turn identifier for the Activity tab.
  const turnStartedAt = Date.now();

  ctx.broadcast({
    type: 'primary_turn_started',
    workflowId: ctx.workflowId,
    startedAt: turnStartedAt,
  });

  // docs/PROTOCOL_CLUSTER.md - per-sender-per-turn send budget resets
  // on every operator turn for this member, regardless of cluster
  // membership. Cheap no-op when the workflow has never sent.
  clusterBudget.reset(ctx.workflowId);

  const settled = ctx.manager.spawn(spec, (ev) => {
    switch (ev.type) {
      case 'worker_spawned':
        // In Lite, the "primary worker" is a chat agent — no worker card.
        // Swallow the spawned event; chat already knows a turn is in flight
        // via the originating user_message_echo.
        return;
      case 'worker_model':
        ctx.broadcast({
          type: 'primary_model',
          workflowId: ctx.workflowId,
          resolvedModel: ev.resolvedModel,
        });
        return;
      case 'worker_text':
        ctx.broadcast({
          type: 'primary_text',
          workflowId: ctx.workflowId,
          text: ev.text,
          phase: 'passthrough',
        });
        // Sniff text for `http://localhost:NNNN` and feed those ports to
        // the preview auto-detect. Cheap (regex no-match on most deltas);
        // catches dev servers the agent didn't start during this turn.
        if (ctx.noteAgentText && ev.text) ctx.noteAgentText(ev.text);
        return;
      case 'worker_thinking':
        // Reasoning deltas. Drives the ACTIVITY tab "Thinking" pill + the
        // composer verb cycle. Text is a chunk, not a full reasoning block.
        ctx.broadcast({
          type: 'primary_thinking',
          workflowId: ctx.workflowId,
          text: ev.text,
        });
        return;
      case 'worker_tool_use': {
        // Prefer the provider's own tool_use id when present (Native worker
        // forwards Anthropic's block.id) — chat-side surfaces (e.g. the
        // Phase 7b Task inline card) match on this id, so a server-minted
        // UUID would never line up with the assistant's tool_use block.
        // Fall back to a server-minted id for bg-tracker correlation when
        // the provider doesn't supply one (CLI Claude, Codex, Gemini).
        const toolUseId = ev.toolUseId ?? randomUUID();
        ctx.broadcast({
          type: 'primary_tool_use',
          workflowId: ctx.workflowId,
          tool: ev.tool,
          input: ev.input,
          toolUseId,
          ...(ev.status ? { status: ev.status } : {}),
          ...(ev.provider ? { provider: ev.provider } : {}),
          ...(ev.itemType ? { itemType: ev.itemType } : {}),
          ...(ev.itemId ? { itemId: ev.itemId } : {}),
          ...(ev.output ? { output: ev.output } : {}),
          ...(typeof ev.exitCode === 'number' ? { exitCode: ev.exitCode } : {}),
          ...(ev.outputHash ? { outputHash: ev.outputHash } : {}),
        });
        // §3.1 — feed the cross-turn stuck-worker breaker. Only the terminal
        // result carries an outputHash (started/in_progress ticks don't), so
        // this fires once per completed tool call. `failing` is the union of the
        // provider's signals: explicit 'failed' status, a non-zero exit code, or
        // the `[error]` sentinel Arco prefixes onto tool errors.
        if (ev.outputHash) {
          const failing =
            ev.status === 'failed' ||
            (typeof ev.exitCode === 'number' && ev.exitCode !== 0) ||
            (typeof ev.output === 'string' && ev.output.startsWith('[error]'));
          const verdict = stuckBreaker.observe(ctx.workflowId, {
            toolName: ev.tool,
            inputHash: stuckBreaker.inputHash(ev.input),
            outputHash: ev.outputHash,
            failing,
          });
          if (verdict.action !== 'none') emitWorkerStuck(ctx, ev.tool, verdict);
        }
        // §5.2 — a Read of a skill's SKILL.md is the reliable cross-transport use
        // signal. Fire-and-forget into the usage sidecar (diagnostic-only; never
        // blocks the turn). recordSkillRead no-ops on a non-skill path.
        if (ev.tool === 'Read') {
          const target = extractReadPath(ev.input);
          if (target) void recordSkillRead(target, Date.now());
        }
        if (ev.tool === 'Bash') {
          // The Bash input shape is {command, description?, run_in_background?, ...}.
          // A malformed/non-JSON input (shouldn't happen from Claude, but cheap
          // to guard) silently skips both the bg-tracker hint and the
          // preview auto-detect probe.
          try {
            const parsed = JSON.parse(ev.input) as { command?: string; run_in_background?: boolean };
            const cmd = typeof parsed.command === 'string' ? parsed.command : '';
            if (ctx.bgTracker && parsed.run_in_background === true) {
              ctx.bgTracker.noteBgHint(toolUseId, cmd || '(bash background)');
            }
            // Probe on every Bash, not just bg ones — most dev servers run in
            // bg, but the regex inside notePotentialDevServerStart filters so
            // non-dev-server commands are cheap no-ops. Pass toolUseId only
            // when the call is bg (otherwise the bgTracker has nothing to
            // attribute and Layer 2 wouldn't have a PID to watch anyway).
            if (ctx.notePotentialDevServerStart && cmd) {
              ctx.notePotentialDevServerStart(cmd, parsed.run_in_background === true ? toolUseId : undefined);
            }
          } catch { /* ignore */ }
        }
        return;
      }
      case 'worker_complete':
        ctx.broadcast({
          type: 'primary_complete',
          workflowId: ctx.workflowId,
          phase: 'passthrough',
          costUsd: ev.costUsd,
          durationMs: ev.durationMs,
          tokens: ev.tokens,
          // Forward the provider-reported context window when available
          // (Codex emits this; others don't yet). Drives the client's
          // CTX-bar denominator more accurately than the hardcoded
          // codexModelWindow() fallback. Stays sticky on the workflow
          // once observed.
          ...(typeof ev.modelContextWindow === 'number' ? { modelContextWindow: ev.modelContextWindow } : {}),
          // Native/API providers — last round's prompt size, persisted on
          // primary_complete so on-resume rehydrate can re-broadcast the
          // ground-truth context_usage without needing a session JSONL/rollout.
          ...(typeof ev.lastPromptTokens === 'number' ? { lastPromptTokens: ev.lastPromptTokens } : {}),
          ...(ev.genSpeed ? { genSpeed: ev.genSpeed } : {}),
        });
        if (typeof ev.lastPromptTokens === 'number' && ev.lastPromptTokens > 0) {
          turnLastPromptTokens = ev.lastPromptTokens;
        }
        if (typeof ev.modelContextWindow === 'number' && ev.modelContextWindow > 0) {
          turnModelContextWindow = ev.modelContextWindow;
        }
        // docs/PROVIDERS.md - per-turn token telemetry. Skipped
        // when no usage was reported (defensive: providers should always
        // produce one but a transient API hiccup could leave usage absent).
        if (ev.tokens) {
          // docs/GOTCHAS.md - fold this turn's spend into an armed goal run.
          // Here rather than in turnEngine because the settled outcome carries
          // no usage; this is the only per-turn, per-provider normalized count.
          addGoalRunTokens(workflows.get(ctx.workflowId)?.config.goalRun, {
            input: ev.tokens.input,
            output: ev.tokens.output,
            cacheRead: ev.tokens.cacheRead ?? 0,
            cacheCreate: ev.tokens.cacheCreate ?? 0,
          });
          const transport: 'native' | 'cli' | 'exec' | 'appserver' | undefined =
            primary.provider === 'claude' ? (claudeTransport ?? 'cli')
            : primary.provider === 'codex' ? (codexTransport ?? 'exec')
            : primary.provider === 'zai' ? (zaiTransport ?? 'native')
            : undefined;
          ctx.broadcast({
            type: 'primary_turn_token_usage',
            workflowId: ctx.workflowId,
            turnStartedAt,
            durationMs: ev.durationMs,
            provider: primary.provider,
            ...(transport ? { transport } : {}),
            input: ev.tokens.input,
            output: ev.tokens.output,
            cacheRead: ev.tokens.cacheRead ?? 0,
            cacheCreate: ev.tokens.cacheCreate ?? 0,
            ...(typeof ev.lastPromptTokens === 'number' ? { lastPromptTokens: ev.lastPromptTokens } : {}),
            ...(typeof ev.tokens.reasoningOutput === 'number' ? { reasoningOutput: ev.tokens.reasoningOutput } : {}),
            thinkingBytes: ev.thinkingBytes ?? 0,
            toolResultBytes: typeof ev.toolResultBytes === 'number' ? ev.toolResultBytes : -1,
            toolResultBytesRaw: typeof ev.toolResultBytesRaw === 'number' ? ev.toolResultBytesRaw : -1,
            ...(typeof ev.serverToolResultBytes === 'number' ? { serverToolResultBytes: ev.serverToolResultBytes } : {}),
            ...(ev.genSpeed ? { genSpeed: ev.genSpeed } : {}),
          });
        }
        return;
      case 'worker_activity':
        // Activity probe is subprocess-level housekeeping. Not chat-relevant.
        return;
      case 'worker_error':
        ctx.broadcast({
          type: 'error',
          workflowId: ctx.workflowId,
          message: ev.error,
        });
        return;
      case 'worker_stuck':
        // §3.1 — a hard ceiling (RSS cap) routed through the breaker surface by
        // WorkerManager. Stamp the workflowId + broadcast so it persists like
        // the error-persistence trips emitted from the tool-use path above.
        ctx.broadcast({
          type: 'worker_stuck',
          workflowId: ctx.workflowId,
          escalation: ev.escalation,
          recommendedAction: ev.recommendedAction,
          ...(ev.toolName ? { toolName: ev.toolName } : {}),
          ...(ev.signature ? { signature: ev.signature } : {}),
          ...(typeof ev.streak === 'number' ? { streak: ev.streak } : {}),
          reason: ev.reason,
        });
        return;
      case 'worker_system_notice':
        // Provider-level out-of-band status (transient API errors, retry
        // backoff notifications). Persisted via the broadcast layer so the
        // notice survives replay/resume — operator can see why a turn
        // stalled even after closing and reopening the tab.
        ctx.broadcast({
          type: 'system_notice',
          workflowId: ctx.workflowId,
          content: ev.notice,
        });
        return;
      case 'primary_artifact':
        // §H4 — a generated image (Codex image_generation_call) was persisted
        // into cwd. Stamp the workflowId + broadcast so it renders inline and
        // lands in events.jsonl (so it survives replay/resume).
        ctx.broadcast({
          type: 'primary_artifact',
          workflowId: ctx.workflowId,
          artifactId: ev.artifactId,
          kind: ev.kind,
          ...(ev.title ? { title: ev.title } : {}),
          ...(ev.content ? { content: ev.content } : {}),
          ...(ev.language ? { language: ev.language } : {}),
          ...(ev.path ? { path: ev.path } : {}),
          ...(ev.message ? { message: ev.message } : {}),
          ...(ev.choices ? { choices: ev.choices } : {}),
          ...(ev.openInEditor ? { openInEditor: ev.openInEditor } : {}),
        });
        return;
      case 'task_started':
        // Phase 7b — Task tool spawned a child workflow. Broadcast on the
        // PARENT so the inline chat card + right-panel TASKS tab can render
        // without subscribing to the child's own event stream.
        ctx.broadcast({
          type: 'task_started',
          workflowId: ctx.workflowId,
          taskId: ev.taskId,
          childWorkflowId: ev.childWorkflowId,
          toolUseId: ev.toolUseId,
          description: ev.description,
          startedAt: ev.startedAt,
        });
        return;
      case 'task_status':
        ctx.broadcast({
          type: 'task_status',
          workflowId: ctx.workflowId,
          taskId: ev.taskId,
          toolUseId: ev.toolUseId,
          phase: ev.phase,
          elapsedMs: ev.elapsedMs,
          ...(ev.summary ? { summary: ev.summary } : {}),
        });
        return;
    }
  }, spawnOptions);

  // Hand the primary CLI's pid to the bg-jobs tracker as soon as it's
  // available. The provider sets `pid` inside worker.spawn() (called
  // synchronously before `manager.spawn()` returns), but we still poll a
  // few ticks in case a provider defers assignment.
  if (ctx.bgTracker) {
    const tryAttach = (tries: number): void => {
      const pid = ctx.manager.getWorkerPid(workerId);
      if (pid !== undefined) {
        ctx.bgTracker!.attachParent(pid);
        return;
      }
      if (tries <= 0) return;
      setTimeout(() => tryAttach(tries - 1), 100);
    };
    tryAttach(20); // up to 2s, covers slow-spawning providers
  }

  // `primary_turn_ended` is sibling to `_started` so the client's busy flag
  // drops exactly when the subprocess settles (error or clean exit). Kept
  // fire-and-forget — we don't care about the outcome shape here.
  settled.then(
    () => {
      ctx.bgTracker?.detachParent();
      ctx.broadcast({ type: 'primary_turn_ended', workflowId: ctx.workflowId, endedAt: Date.now() });
    },
    () => {
      ctx.bgTracker?.detachParent();
      ctx.broadcast({ type: 'primary_turn_ended', workflowId: ctx.workflowId, endedAt: Date.now() });
    },
  );

  return {
    workerId,
    initialSessionId,
    settled: settled.then((r) => ({
      ...(r.error ? { error: r.error } : {}),
      ...(typeof turnLastPromptTokens === 'number' ? { lastPromptTokens: turnLastPromptTokens } : {}),
      ...(typeof turnModelContextWindow === 'number' ? { modelContextWindow: turnModelContextWindow } : {}),
    })),
    onSessionDiscovered: (cb) => {
      // Late subscribers still get the fire-once signal if init already arrived.
      if (discoveredSessionId) cb(discoveredSessionId);
      else sessionDiscoveredCb = cb;
    },
  };
}
