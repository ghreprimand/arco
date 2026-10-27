import { createProviderProcess, type ProviderProcess } from '../providers/index.js';
import { probeProcessActivity } from './processActivity.js';
import { RSS_KILL_BYTES, buildWorkerSafetyFooter } from './limits.js';
import { registerWorkerPid, unregisterWorkerPid } from './pidRegistry.js';
import { registerPrivateLogToken } from '../server/logger.js';
import type {
  ModelName,
  EffortLevel,
  ProviderName,
  WorkerConfig,
  WorkerSpawnedMessage,
  WorkerTextMessage,
  WorkerThinkingMessage,
  WorkerToolUseMessage,
  WorkerCompleteMessage,
  WorkerActivityMessage,
  WorkerModelMessage,
  WorkerErrorMessage,
  WorkerStuckMessage,
  WorkerSystemNoticeMessage,
  TaskStartedMessage,
  TaskStatusMessage,
  PrimaryArtifactMessage,
  WorkerState,
  TokenUsage,
  GenerationSpeed,
} from '@arco/shared';

// Lite: spawn specs are constructed per-primitive (seedWorker / runReviewer)
// rather than parsed from an orchestrator dispatch block. Keep the shape
// local so Phase 2 primitives can own it without a cross-module dependency.
export interface WorkerSpawnSpec {
  id: string;
  task: string;
  model: ModelName;
  effort: EffortLevel;
  provider?: ProviderName;
  tools?: string[];
  systemPrompt?: string;
  appendSystemPrompt?: string;
}

export interface WorkerResult {
  id: string;
  text: string;
  costUsd: number;
  durationMs: number;
  tokens?: TokenUsage;
  error?: string;
  permissionDenials?: Array<{ tool: string; input: string }>;
  modelContextWindow?: number;
  // Claude Native primary turns only — last round's prompt size. See
  // PrimaryCompleteMessage.lastPromptTokens.
  lastPromptTokens?: number;
}

export type WorkerManagerEvent =
  | Omit<WorkerSpawnedMessage, 'workflowId'>
  | Omit<WorkerTextMessage, 'workflowId'>
  | Omit<WorkerThinkingMessage, 'workflowId'>
  | Omit<WorkerToolUseMessage, 'workflowId'>
  | Omit<WorkerCompleteMessage, 'workflowId'>
  | Omit<WorkerActivityMessage, 'workflowId'>
  | Omit<WorkerModelMessage, 'workflowId'>
  | Omit<WorkerErrorMessage, 'workflowId'>
  | Omit<WorkerStuckMessage, 'workflowId'>
  | Omit<WorkerSystemNoticeMessage, 'workflowId'>
  | Omit<TaskStartedMessage, 'workflowId'>
  | Omit<TaskStatusMessage, 'workflowId'>
  | Omit<PrimaryArtifactMessage, 'workflowId'>;

const ACTIVITY_POLL_MS = 1500;

function usageToTokens(usage?: Record<string, number>): TokenUsage | undefined {
  if (!usage) return undefined;
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheCreate = usage.cache_creation_input_tokens ?? 0;
  // Codex-only enrichments. reasoning_output_tokens is a SUBSET of output
  // (the model's hidden reasoning trace, billed differently); total_tokens
  // is the provider's authoritative total. Both are optional — Claude /
  // Gemini / Ollama don't populate them.
  const reasoningOutput = usage.reasoning_output_tokens;
  const total = usage.total_tokens;
  if (!input && !output && !cacheRead && !cacheCreate) return undefined;
  return {
    input,
    output,
    cacheRead,
    cacheCreate,
    ...(typeof reasoningOutput === 'number' ? { reasoningOutput } : {}),
    ...(typeof total === 'number' ? { total } : {}),
  };
}

export class WorkerManager {
  private workers = new Map<string, ProviderProcess>();
  private workerMeta = new Map<string, {
    spec: WorkerSpawnSpec;
    spawnedAt: number;
    lastActivityAt: number;
    hadAnyEvent: boolean;
    settled: boolean;
  }>();

  // Spawn a single worker; resolves when it completes or errors. Streams
  // events via the callback (workflowId-less; caller wraps them before sending
  // over the WebSocket).
  async spawn(
    spec: WorkerSpawnSpec,
    onEvent: (msg: WorkerManagerEvent) => void,
    options?: {
      skipPermissions?: boolean;
      cwd?: string;
      persistenceCwd?: WorkerConfig['persistenceCwd'];
      additionalDirectories?: string[];
      fallbackModel?: WorkerConfig['fallbackModel'];
      workflowId?: string;
      providerAccountRef?: WorkerConfig['providerAccountRef'];
      codexHome?: WorkerConfig['codexHome'];
      sessionId?: string;
      resumeSessionId?: string;
      // Operator-attached files (server-local paths). Image handling is
      // provider-specific; non-image files fall back to path references.
      attachments?: string[];
      // Codex-only: explicit sandbox level. Takes precedence over
      // skipPermissions when set. Reviewers pass 'read-only'.
      sandbox?: WorkerConfig['sandbox'];
      interactionMode?: WorkerConfig['interactionMode'];
      // Chat-only web-tool arming; ignored by agent-mode spawns.
      chatWebAccess?: boolean;
      // Chat-only: the Computer voice operator (arco-voice MCP child).
      voiceOperator?: boolean;
      incognito?: boolean;
      // Skip the tree-RSS auto-kill for this worker. Only the primary-turn
      // spawn site honors this (via WorkflowMeta.disableRssGuard); reviewers
      // and handoff reflections never set it. 5MB output cap + cancel-time
      // kill still apply.
      disableRssGuard?: boolean;
      // Fired once on the first provider `init` event. Primary-worker callers
      // use it to capture the native session UUID (Codex thread_id; Claude's
      // is pre-minted so this is confirmation, not discovery).
      onInit?: (data: { model?: string; sessionId?: string }) => void;
      // Phase 5 — called by Ollama / llama.cpp between tool-result append
      // and the next API round-trip to drain any pending mid-turn steer
      // queue entries. See WorkerConfig.drainSteer.
      drainSteer?: WorkerConfig['drainSteer'];
      // Phase 6b — paired with drainSteer for the Codex app-server worker.
      // Called when `turn/steer` round-trip fails and the drained items
      // need to land back in a queue. Bucket determines whether items
      // re-enter as steer (next operator turn picks them up) or follow-up
      // (routed through the post-turn merge path).
      requeueSteer?: WorkerConfig['requeueSteer'];
      // Phase 6 — Codex transport selector resolved from the cascade in
      // handleUserMessage. Reviewers / handoffs leave this unset so they
      // always run on the exec transport (per the §10 Reviewer-on-exec
      // hard-coding). 'appserver' opts into the long-lived per-workflow
      // worker; default 'exec' preserves today's behavior.
      codexTransport?: WorkerConfig['codexTransport'];
      codexContextPolicy?: WorkerConfig['codexContextPolicy'];
      // Phase 7a — Claude transport selector. Resolved from the cascade
      // by handleUserMessage. Reviewers / handoff seeds leave it unset
      // so they always run on the CLI provider.
      claudeTransport?: WorkerConfig['claudeTransport'];
      ultracode?: WorkerConfig['ultracode'];
      zaiTransport?: WorkerConfig['zaiTransport'];
      // Phase 7b — set on a Task-spawned child so its Claude Native worker
      // refuses to spawn another Task. Parents leave this unset.
      claudeNativeTaskDisabled?: WorkerConfig['claudeNativeTaskDisabled'];
      // Phase 7c-followup — Claude Native server-side compaction toggle.
      // Resolved by handleUserMessage from WorkflowConfig.claudeNativeCompact;
      // ignored by other transports.
      claudeNativeCompact?: WorkerConfig['claudeNativeCompact'];
      // Native-only debug override for forcing the legacy interleaved-thinking
      // beta on adaptive Claude models.
      claudeNativeForceInterleavedThinkingBeta?: WorkerConfig['claudeNativeForceInterleavedThinkingBeta'];
      // Adaptive-thinking display for the Native worker ('omitted' default).
      claudeNativeThinkingDisplay?: WorkerConfig['claudeNativeThinkingDisplay'];
      // Operator-initiated plan-mode entry. Single-turn flag resolved by
      // handleUserMessage from WorkflowState.pendingPlanModeEntry; honoured
      // only when the resolved primary is Claude Native.
      claudeNativePlanModeArmed?: WorkerConfig['claudeNativePlanModeArmed'];
      turnNotice?: WorkerConfig['turnNotice'];
      // docs/PROVIDERS.md - auto-threshold ctx_action emission.
      efficiencyAutoCompact?: WorkerConfig['efficiencyAutoCompact'];
      // docs/PROVIDERS.md - Native tool-result filter mode.
      efficiencyToolFilter?: WorkerConfig['efficiencyToolFilter'];
      // docs/PROVIDERS.md - fact-force first-edit gate mode.
      efficiencyFactForce?: WorkerConfig['efficiencyFactForce'];
      // Config-protection write-gate mode (default ON; operator opt-out).
      efficiencyConfigProtection?: WorkerConfig['efficiencyConfigProtection'];
      // docs/PROVIDERS.md - opt-in sandbox tools.
      efficiencySandbox?: WorkerConfig['efficiencySandbox'];
      // docs/PROVIDERS.md - operator-armed durable review gate.
      reviewSafeMode?: WorkerConfig['reviewSafeMode'];
      // docs/PROVIDERS.md - provider-supported output-style addendum level.
      outputStyle?: WorkerConfig['outputStyle'];
      // docs/GOTCHAS.md - operator-set persistent north-star block text.
      goal?: WorkerConfig['goal'];
      // §4.1 — session-local posture filter for the Native tool union.
      toolPosture?: WorkerConfig['toolPosture'];
      // docs/PROTOCOL_CLUSTER.md - when set, the Native worker
      // registers peer_* tools. Other transports ignore for now.
      clusterId?: WorkerConfig['clusterId'];
      clusterAccessMode?: WorkerConfig['clusterAccessMode'];
      clusterTaskBoardAttached?: WorkerConfig['clusterTaskBoardAttached'];
      // docs/PROTOCOL_CLUSTER.md - shared cluster plan body + this
      // member's role hint, resolved per turn. Threaded into WorkerConfig
      // so the Native worker can inject them as forced system blocks.
      // Other transports ignore.
      clusterPlan?: WorkerConfig['clusterPlan'];
      clusterRole?: WorkerConfig['clusterRole'];
      clusterEfficiencyDoctrine?: WorkerConfig['clusterEfficiencyDoctrine'];
      clusterProgressDoctrine?: WorkerConfig['clusterProgressDoctrine'];
      // Phase 3 + docs/PROVIDERS.md - absolute path to the
      // per-workflow mcp-config.json for CLI Claude when cluster and/or
      // codebase-memory applies. Native ignores it.
      clusterMcpConfigPath?: WorkerConfig['clusterMcpConfigPath'];
      // docs/PROVIDERS.md - codebase-memory-mcp intent + index
      // path threaded into Codex providers for `-c mcp_servers.*` overrides.
      codebaseMemoryAttached?: WorkerConfig['codebaseMemoryAttached'];
      codebaseMemoryIndexPath?: WorkerConfig['codebaseMemoryIndexPath'];
      // docs/ARCHITECTURE.md - dangerous-and-unticked MCP registry tool
      // names for CLI Claude's --disallowedTools. Other transports ignore.
      mcpDisallowedTools?: WorkerConfig['mcpDisallowedTools'];
      // docs/ARCHITECTURE.md - operator-enabled registry servers. Codex
      // builds `-c` overrides from these; CLI Claude gets them via the
      // mcp-config merge (so it ignores this field).
      mcpRegistryServers?: WorkerConfig['mcpRegistryServers'];
      // docs/ARCHITECTURE.md - Deep Research web-tool budget. Threads
      // the run's `maxRounds` into the Claude Native web_search/web_fetch
      // `max_uses` so the round cap is a mechanical ceiling. Other transports
      // ignore it. Unset ⇒ default 10.
      webSearchMaxUses?: WorkerConfig['webSearchMaxUses'];
      // docs/PROVIDERS.md - per-tab Ollama param preset blob. Merged
      // through the typed allowlist by the Ollama provider; other providers
      // ignore it.
      ollamaParams?: WorkerConfig['ollamaParams'];
      // docs/PROVIDERS.md - Ollama top-level `format` (structured
      // output). Set by structured primitives (Review verdict) so the Ollama
      // model is grammar-constrained to a JSON schema. Other providers ignore
      // it. Mutually exclusive with tools on the wire — see ollama.ts.
      ollamaFormat?: WorkerConfig['ollamaFormat'];
    },
  ): Promise<WorkerResult> {
    const config: WorkerConfig = {
      model: spec.model,
      effort: spec.effort,
      provider: spec.provider,
      tools: spec.tools,
      systemPrompt: spec.systemPrompt,
      appendSystemPrompt: spec.appendSystemPrompt,
      skipPermissions: options?.skipPermissions,
      cwd: options?.cwd,
      persistenceCwd: options?.persistenceCwd,
      additionalDirectories: options?.additionalDirectories,
      fallbackModel: options?.fallbackModel,
      sessionId: options?.sessionId,
      resumeSessionId: options?.resumeSessionId,
      attachments: options?.attachments,
      sandbox: options?.sandbox,
      interactionMode: options?.interactionMode,
      chatWebAccess: options?.chatWebAccess,
      voiceOperator: options?.voiceOperator,
      incognito: options?.incognito,
      drainSteer: options?.drainSteer,
      requeueSteer: options?.requeueSteer,
      // Phase 6 — workflowId is required for per-workflow-lifetime providers
      // (Codex app-server caches the long-lived child by workflowId). Other
      // providers ignore it.
      workflowId: options?.workflowId,
      providerAccountRef: options?.providerAccountRef,
      codexHome: options?.codexHome,
      codexTransport: options?.codexTransport,
      codexContextPolicy: options?.codexContextPolicy,
      claudeTransport: options?.claudeTransport,
      ultracode: options?.ultracode,
      zaiTransport: options?.zaiTransport,
      claudeNativeTaskDisabled: options?.claudeNativeTaskDisabled,
      claudeNativeCompact: options?.claudeNativeCompact,
      claudeNativeForceInterleavedThinkingBeta: options?.claudeNativeForceInterleavedThinkingBeta,
      claudeNativeThinkingDisplay: options?.claudeNativeThinkingDisplay,
      claudeNativePlanModeArmed: options?.claudeNativePlanModeArmed,
      turnNotice: options?.turnNotice,
      efficiencyAutoCompact: options?.efficiencyAutoCompact,
      efficiencyToolFilter: options?.efficiencyToolFilter,
      efficiencyFactForce: options?.efficiencyFactForce,
      efficiencyConfigProtection: options?.efficiencyConfigProtection,
      efficiencySandbox: options?.efficiencySandbox,
      reviewSafeMode: options?.reviewSafeMode,
      outputStyle: options?.outputStyle,
      goal: options?.goal,
      toolPosture: options?.toolPosture,
      clusterId: options?.clusterId,
      clusterAccessMode: options?.clusterAccessMode,
      clusterTaskBoardAttached: options?.clusterTaskBoardAttached,
      clusterPlan: options?.clusterPlan,
      clusterRole: options?.clusterRole,
      clusterEfficiencyDoctrine: options?.clusterEfficiencyDoctrine,
      clusterProgressDoctrine: options?.clusterProgressDoctrine,
      clusterMcpConfigPath: options?.clusterMcpConfigPath,
      codebaseMemoryAttached: options?.codebaseMemoryAttached,
      codebaseMemoryIndexPath: options?.codebaseMemoryIndexPath,
      mcpDisallowedTools: options?.mcpDisallowedTools,
      mcpRegistryServers: options?.mcpRegistryServers,
      webSearchMaxUses: options?.webSearchMaxUses,
      ollamaParams: options?.ollamaParams,
      ollamaFormat: options?.ollamaFormat,
    };

    const worker = createProviderProcess(spec.id, config);
    if (options?.incognito) registerPrivateLogToken(spec.id);
    this.workers.set(spec.id, worker);
    const now = Date.now();
    this.workerMeta.set(spec.id, {
      spec,
      spawnedAt: now,
      lastActivityAt: now,
      hadAnyEvent: false,
      settled: false,
    });

    onEvent({
      type: 'worker_spawned',
      workerId: spec.id,
      model: spec.model,
      effort: spec.effort,
      task: spec.task,
      provider: spec.provider ?? 'claude',
    });

    worker.on('init', (data: { model?: string; sessionId?: string }) => {
      if (data.model) {
        onEvent({ type: 'worker_model', workerId: spec.id, resolvedModel: data.model });
      }
      if (options?.onInit) {
        try { options.onInit(data); } catch { /* caller bug; don't kill the worker */ }
      }
    });

    const bump = () => {
      const m = this.workerMeta.get(spec.id);
      if (m) { m.lastActivityAt = Date.now(); m.hadAnyEvent = true; }
    };

    worker.on('text', (text: string) => {
      bump();
      onEvent({ type: 'worker_text', workerId: spec.id, text });
    });
    worker.on('thinking', (text: string) => {
      bump();
      onEvent({ type: 'worker_thinking', workerId: spec.id, text });
    });
    worker.on('tool_use', (data: {
      id?: string;
      name: string;
      input: string;
      status?: 'started' | 'in_progress' | 'completed' | 'failed';
      provider?: ProviderName;
      itemType?: string;
      itemId?: string;
      output?: string;
      exitCode?: number;
      outputHash?: string;
    }) => {
      bump();
      onEvent({
        type: 'worker_tool_use',
        workerId: spec.id,
        tool: data.name,
        input: data.input,
        ...(data.id ? { toolUseId: data.id } : {}),
        ...(data.status ? { status: data.status } : {}),
        ...(data.provider ? { provider: data.provider } : {}),
        ...(data.itemType ? { itemType: data.itemType } : {}),
        ...(data.itemId ? { itemId: data.itemId } : {}),
        ...(data.output ? { output: data.output } : {}),
        ...(typeof data.exitCode === 'number' ? { exitCode: data.exitCode } : {}),
        ...(data.outputHash ? { outputHash: data.outputHash } : {}),
      });
    });
    worker.on('system_notice', (notice: string) => {
      bump();
      onEvent({ type: 'worker_system_notice', workerId: spec.id, notice });
    });
    // §H4 — a generated image (Codex image_generation_call) was persisted into
    // cwd. Forward as a workflowId-less primary_artifact; seedWorker stamps the
    // workflowId + broadcasts (which persists it to events.jsonl).
    worker.on('primary_artifact', (data: {
      artifactId: string;
      kind: PrimaryArtifactMessage['kind'];
      title?: string;
      path?: string;
      openInEditor?: boolean;
    }) => {
      bump();
      onEvent({
        type: 'primary_artifact',
        artifactId: data.artifactId,
        kind: data.kind,
        ...(data.title ? { title: data.title } : {}),
        ...(data.path ? { path: data.path } : {}),
        ...(data.openInEditor ? { openInEditor: data.openInEditor } : {}),
      });
    });
    // Phase 7b — Task lifecycle (Native only). The provider passes opaque
    // payloads through; we narrow + re-emit so the seedWorker layer can
    // wrap them with workflowId and broadcast.
    worker.on('task_started', (data: {
      taskId: string;
      childWorkflowId: string;
      toolUseId: string;
      description: string;
      startedAt: number;
    }) => {
      bump();
      onEvent({
        type: 'task_started',
        taskId: data.taskId,
        childWorkflowId: data.childWorkflowId,
        toolUseId: data.toolUseId,
        description: data.description,
        startedAt: data.startedAt,
      });
    });
    worker.on('task_status', (data: {
      taskId: string;
      toolUseId: string;
      phase: 'running' | 'done' | 'error' | 'cancelled';
      elapsedMs: number;
      summary?: string;
    }) => {
      bump();
      onEvent({
        type: 'task_status',
        taskId: data.taskId,
        toolUseId: data.toolUseId,
        phase: data.phase,
        elapsedMs: data.elapsedMs,
        ...(data.summary ? { summary: data.summary } : {}),
      });
    });

    const resultPromise = new Promise<WorkerResult>((resolve) => {
      let settled = false;
      // Drop both map entries on settle: a per-tab manager used to retain
      // every per-turn worker + its config forever (for Ollama that's the
      // full rendered transcript). After settle nothing needs them — the
      // activity poll stops on non-running status, killAll skips settled
      // workers, and kill() of an unknown id already means "no live worker"
      // to its callers (they synthesize a settle for a lost ready message).
      // Guard on identity so a re-used spec.id's newer worker isn't evicted.
      const markSettled = () => {
        settled = true;
        const m = this.workerMeta.get(spec.id);
        if (m) m.settled = true;
        if (this.workers.get(spec.id) === worker) {
          this.workers.delete(spec.id);
          this.workerMeta.delete(spec.id);
        }
      };
      worker.on('result', (data: { text: string; costUsd: number; durationMs: number; usage?: Record<string, number>; permissionDenials?: Array<{ tool: string; input: string }>; modelContextWindow?: number; lastPromptTokens?: number; thinkingBytes?: number; toolResultBytes?: number; toolResultBytesRaw?: number; serverToolResultBytes?: number; genSpeed?: GenerationSpeed }) => {
        if (settled) return;
        markSettled();
        const tokens = usageToTokens(data.usage);
        onEvent({
          type: 'worker_complete',
          workerId: spec.id,
          result: data.text,
          costUsd: data.costUsd,
          durationMs: data.durationMs,
          tokens,
          ...(data.permissionDenials && data.permissionDenials.length > 0 && { permissionDenials: data.permissionDenials }),
          ...(typeof data.modelContextWindow === 'number' ? { modelContextWindow: data.modelContextWindow } : {}),
          ...(typeof data.lastPromptTokens === 'number' ? { lastPromptTokens: data.lastPromptTokens } : {}),
          ...(typeof data.thinkingBytes === 'number' ? { thinkingBytes: data.thinkingBytes } : {}),
          ...(typeof data.toolResultBytes === 'number' ? { toolResultBytes: data.toolResultBytes } : {}),
          ...(typeof data.toolResultBytesRaw === 'number' ? { toolResultBytesRaw: data.toolResultBytesRaw } : {}),
          ...(typeof data.serverToolResultBytes === 'number' ? { serverToolResultBytes: data.serverToolResultBytes } : {}),
          ...(data.genSpeed ? { genSpeed: data.genSpeed } : {}),
        });
        resolve({
          id: spec.id,
          text: data.text,
          costUsd: data.costUsd,
          durationMs: data.durationMs,
          tokens,
          ...(data.permissionDenials && data.permissionDenials.length > 0 && { permissionDenials: data.permissionDenials }),
          ...(typeof data.modelContextWindow === 'number' ? { modelContextWindow: data.modelContextWindow } : {}),
          ...(typeof data.lastPromptTokens === 'number' ? { lastPromptTokens: data.lastPromptTokens } : {}),
        });
      });
      worker.on('error', (error: string) => {
        if (settled) {
          console.log(`[arco] [worker ${spec.id}] post-settle error ignored: ${error.slice(0, 100)}`);
          return;
        }
        markSettled();
        onEvent({ type: 'worker_error', workerId: spec.id, error });
        resolve({
          id: spec.id,
          text: `[ERROR] ${error}`,
          costUsd: 0,
          durationMs: 0,
          error,
        });
      });
    });

    // Listeners are wired; now fire the subprocess. The activity probe catches
    // silent exits (no result/error within the grace window).
    //
    // Skip the Arco safety footer for Antigravity — it's agent-in-agent
    // (desktop app has its own sandboxing + permission model), and the
    // footer's "[Arco safety reminders...]" text confuses Gemini into
    // responding about Arco instead of the operator's actual project.
    const footer = spec.provider === 'antigravity' || options?.interactionMode === 'chat'
      ? ''
      : buildWorkerSafetyFooter(options?.cwd, options?.workflowId);
    worker.spawn(spec.task + footer);
    // Record the pid in the durable registry so a crashed/force-quit server
    // can reap this subprocess on next startup. Unregister once the worker
    // settles (either resolution path fires synchronously via kill(), so a
    // fast shutdown after tab close still clears the entry).
    const spawnedPid = worker.pid;
    if (spawnedPid !== undefined && !options?.incognito) {
      registerWorkerPid(spawnedPid);
      const cleanup = (): void => unregisterWorkerPid(spawnedPid);
      worker.once('result', cleanup);
      worker.once('error', cleanup);
    }
    this.startActivityPoll(spec.id, worker, onEvent, options?.disableRssGuard === true);
    return resultPromise;
  }

  private startActivityPoll(
    workerId: string,
    worker: ProviderProcess,
    onEvent: (msg: WorkerManagerEvent) => void,
    disableRssGuard: boolean,
  ): void {
    let prevTicks = -1;
    let prevDescendants = -1;
    let prevAlive: boolean | null = null;
    let rssWarned = false;
    const interval = setInterval(async () => {
      if (worker.status !== 'running' && worker.status !== 'spawning') {
        clearInterval(interval);
        return;
      }
      const pid = worker.pid;
      if (!pid) return;
      let activity;
      try {
        activity = await probeProcessActivity(pid);
      } catch {
        return;
      }
      if (!activity) return;
      if (activity.alive && activity.rssBytes > RSS_KILL_BYTES) {
        const usedGb = (activity.rssBytes / (1024 ** 3)).toFixed(2);
        const capGb = (RSS_KILL_BYTES / (1024 ** 3)).toFixed(0);
        if (disableRssGuard) {
          // Workflow opted out (meta.json `disableRssGuard: true`). Still log
          // once per worker crossing the cap so the operator can tell from
          // the console that the bypass is doing real work — then rearm so
          // we don't log every poll tick. Nothing else is bypassed: 5MB
          // output cap + cancel-time process-tree kill still apply.
          if (!rssWarned) {
            console.warn(`[arco] worker ${workerId} exceeded RSS cap (${usedGb}GB > ${capGb}GB) — RSS guard disabled for this workflow; not killing`);
            rssWarned = true;
          }
        } else {
          console.error(`[arco] worker ${workerId} exceeded RSS cap (${usedGb}GB > ${capGb}GB); killing process tree`);
          // §3.1 — route the hard RSS kill through the breaker surface FIRST so
          // it lands in events.jsonl as a structured 'limit' trip, not just a
          // bare error string. The kill still follows (a 32GB runaway can't be
          // paused), but the operator sees it on the same breaker surface as a
          // stuck loop.
          onEvent({
            type: 'worker_stuck',
            workerId,
            escalation: 'limit',
            recommendedAction: 'pause',
            reason: `process tree exceeded the ${capGb}GB RSS safety cap (used ${usedGb}GB across ${activity.descendantCount} subprocess(es)) — killing. Set \`disableRssGuard: true\` in this workflow's meta.json if this workload legitimately exceeds the cap.`,
          });
          // Settle with the RSS cause BEFORE killing: kill() emits its own
          // 'Worker killed' error, which used to win the settle race — two
          // worker_errors, and the turn result blamed a plain kill. Routed
          // through the worker's error channel it's the one settle; the
          // kill's error then lands as post-settle and is dropped.
          worker.emit('error', `Killed by Arco: process tree exceeded ${capGb}GB RSS safety cap (used ${usedGb}GB across ${activity.descendantCount} subprocess(es)). Set \`disableRssGuard: true\` in this workflow's meta.json if you expect this workload to legitimately exceed the cap.`);
          worker.kill();
          clearInterval(interval);
          return;
        }
      }
      const cpuActive = prevTicks >= 0 && activity.cpuTicks > prevTicks;
      const meta = this.workerMeta.get(workerId);
      if (meta && !meta.settled && !activity.alive) {
        const sinceLastActivity = Date.now() - meta.lastActivityAt;
        const graceMs = meta.hadAnyEvent ? 20_000 : 60_000;
        if (sinceLastActivity > graceMs) {
          console.error(`[arco] worker ${workerId} exited silently (no result/error within ${graceMs}ms grace); synthesizing worker_error`);
          worker.emit('error', '[worker exited silently]');
          worker.kill();
          clearInterval(interval);
          return;
        }
      }
      if (meta && activity.alive && (cpuActive || activity.descendantCount > 0)) {
        meta.lastActivityAt = Date.now();
        meta.hadAnyEvent = true;
      }
      const changed = activity.alive !== prevAlive
        || activity.descendantCount !== prevDescendants
        || cpuActive
        || prevTicks < 0;
      prevTicks = activity.cpuTicks;
      prevDescendants = activity.descendantCount;
      prevAlive = activity.alive;
      if (!changed) return;
      onEvent({
        type: 'worker_activity',
        workerId,
        alive: activity.alive,
        cpuActive,
        descendantCount: activity.descendantCount,
        rssBytes: activity.rssBytes,
      });
    }, ACTIVITY_POLL_MS);
  }

  get workerCount(): number {
    return this.workers.size;
  }

  // The primary's background-jobs tracker needs the CLI pid so it can walk
  // /proc descendants while the turn is live. Returns undefined once the
  // worker exits (and the process entry is cleared).
  getWorkerPid(workerId: string): number | undefined {
    return this.workers.get(workerId)?.pid;
  }

  snapshotWorkers(): Record<string, WorkerState> {
    const out: Record<string, WorkerState> = {};
    for (const [id, worker] of this.workers) {
      const meta = this.workerMeta.get(id);
      if (!meta) continue;
      out[id] = {
        id,
        model: meta.spec.model,
        effort: meta.spec.effort,
        status: worker.status,
        task: meta.spec.task,
        output: '',
        thinking: '',
        toolCalls: [],
        spawnedAt: meta.spawnedAt,
        lastActivityAt: Date.now(),
        provider: meta.spec.provider,
      };
    }
    return out;
  }

  async interrupt(workerId: string): Promise<boolean | void> {
    const worker = this.workers.get(workerId);
    if (!worker) return;
    if (worker.interrupt) return await worker.interrupt();
    else worker.kill();
  }

  killAll(): void {
    for (const worker of this.workers.values()) {
      if (worker.status === 'running' || worker.status === 'spawning') {
        worker.kill();
      }
    }
  }

  // Returns true when a live worker was actually killed. Callers use the
  // false case to recover from "zombie" state where the server no longer
  // tracks a worker id (e.g. after a restart) but the client still shows it
  // as in-flight — they can then synthesize a settle event to clear the UI.
  kill(workerId: string): boolean {
    const worker = this.workers.get(workerId);
    if (!worker) return false;
    worker.kill();
    return true;
  }
}
