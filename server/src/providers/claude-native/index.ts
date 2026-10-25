// Phase 7a — Claude Native dispatcher.
//
// One ClaudeNativeWorker is cached per workflowId. Each operator turn
// instantiates a ClaudeNativeTurn wrapper that adapts the long-lived
// worker's "events stream forever" surface to Archon's "one
// ProviderProcess per turn" contract — same shape as
// codex-appserver/index.ts:43.
//
// disposeClaudeNativeWorker(workflowId) is called from
// disposeProviderResources on tab close + after handoff_complete, so
// the next operator turn rebuilds the messages array from the post-
// handoff transcript.

import { EventEmitter } from 'events';
import type { WorkerConfig, WorkerStatus, ServerMessage } from '@archon/shared';
import type { Provider, ProviderProcess } from '../types.js';
import { ClaudeNativeWorker, replayMessagesFromEvents, type PlanBroadcast, type TaskSpawnHandler } from './worker.js';
import type { Todo } from './tools.js';

const workersByWorkflow = new Map<string, ClaudeNativeWorker>();

// Optional broadcast hook so worker-emitted todos can land on the
// workflow's transient bus (Activity tab). Wired by server/src/index.ts.
let todosBroadcast: ((workflowId: string, todos: Todo[]) => void) | null = null;
export function setClaudeNativeTodosBroadcast(fn: (workflowId: string, todos: Todo[]) => void): void {
  todosBroadcast = fn;
}

// Phase 7b — plan-mode broadcast hook. Server wires this so EnterPlanMode /
// ExitPlanMode tools land plan_set / plan_exited messages on the workflow.
let planBroadcastFactory: ((workflowId: string) => PlanBroadcast) | null = null;
export function setClaudeNativePlanBroadcast(fn: (workflowId: string) => PlanBroadcast): void {
  planBroadcastFactory = fn;
}

// Phase 7b — Task tool handler. Server wires this so the Task tool can
// mint a child workflow and await its final reply.
let taskHandlerFn: TaskSpawnHandler | null = null;
export function setClaudeNativeTaskHandler(fn: TaskSpawnHandler): void {
  taskHandlerFn = fn;
}

// EFFICIENCY_PLAN.md Phase B/D — generic workflow-scoped event broadcaster.
// The Native worker uses this for every event whose lifecycle isn't already
// covered by a WorkerManager-routed channel: `hook_rewrote_input` (B0),
// `tool_gate_triggered` (B/D), `ctx_action` (B/D). Wired in server/index.ts
// as `(wfid, msg) => broadcastWorkflow(wfid, msg)`. Persisted to events.jsonl
// per the standard broadcast path.
let workflowEventBroadcast: ((workflowId: string, msg: ServerMessage) => void) | null = null;
export function setClaudeNativeWorkflowEventBroadcast(fn: (workflowId: string, msg: ServerMessage) => void): void {
  workflowEventBroadcast = fn;
}

// Cluster-scoped event broadcaster — used by the `cluster_plan_tick` peer
// tool so a successful toggle emits `cluster_plan_changed` to every WS
// subscribed to the cluster (not just the calling worker's workflow). Wired
// in server/index.ts as `(clusterId, msg) => broadcastCluster(clusterId, msg)`.
let clusterEventBroadcast: ((clusterId: string, msg: ServerMessage) => void) | null = null;
export function setClaudeNativeClusterEventBroadcast(fn: (clusterId: string, msg: ServerMessage) => void): void {
  clusterEventBroadcast = fn;
}

// Phase 7b — server-side AskUserQuestion reply routing.
export function routeClaudeNativeQuestionReply(workflowId: string, questionId: string, reply: string): boolean {
  const worker = workersByWorkflow.get(workflowId);
  if (!worker) return false;
  return worker.resolveQuestion(questionId, reply);
}

// R1 (REMOTE_CLUSTER_CONTROL_PLAN.md §4.1) — read-only parked-interaction
// snapshot for the hub link's workflow summary. Null when no live worker
// (nothing parked by definition — parks don't survive worker disposal; the
// gate sidecar's orphans stay resolvable via gate_reply but aren't listed).
export function getClaudeNativePendingInteractions(workflowId: string): {
  question: { questionId: string; text: string } | null;
  gates: Array<{ gateId: string; toolName: string; category: string; reason: string; argsPreview: string }>;
} | null {
  const worker = workersByWorkflow.get(workflowId);
  return worker ? worker.getPendingInteractions() : null;
}

// DEBAG (docs/DEBAG_PLAN.md) — server-side review-gate reply routing. Returns
// false if no worker or no matching parked gate (stale reply) so the caller can
// log a drop.
export function routeClaudeNativeGateReply(
  workflowId: string,
  gateId: string,
  decision: 'approve' | 'reject',
  finalArgs?: Record<string, unknown>,
  remember?: boolean,
): boolean {
  const worker = workersByWorkflow.get(workflowId);
  if (!worker) return false;
  return worker.resolveGate(gateId, decision, finalArgs, remember);
}

class ClaudeNativeTurn extends EventEmitter implements ProviderProcess {
  readonly id: string;
  private _status: WorkerStatus = 'spawning';
  private _output = '';
  private settled = false;
  private wired: Array<{ event: string; fn: (...args: unknown[]) => void }> = [];

  constructor(
    id: string,
    private readonly worker: ClaudeNativeWorker,
    private readonly config: WorkerConfig,
  ) {
    super();
    this.id = id;
  }

  get status(): WorkerStatus { return this._status; }
  get output(): string { return this._output; }
  get pid(): number | undefined { return undefined; }

  spawn(prompt: string): void {
    this.worker.updateConfig(this.config);
    this.wireListeners();
    this.worker.runTurn(prompt).catch((err: unknown) => {
      if (this.settled) return;
      this.fail(err instanceof Error ? err.message : String(err));
    });
  }

  kill(): void {
    if (this.settled) return;
    this.worker.cancel();
  }

  private wireListeners(): void {
    const onInit = (data: { model?: string; sessionId?: string }) => {
      if (this.settled) return;
      this._status = 'running';
      this.emit('init', data);
    };
    const onText = (text: string) => {
      if (this.settled) return;
      this._output += text;
      this.emit('text', text);
    };
    // A mid-stream overload retry regenerates the round from scratch; drop
    // the interrupted attempt's partial so result.text (→ persisted
    // primary_text) isn't partial + full retry. The already-broadcast
    // worker_text deltas can't be recalled from here — the worker's
    // system_notice tells the operator the partial above was discarded.
    const onTextDiscard = (chars: number) => {
      if (this.settled) return;
      this._output = this._output.slice(0, Math.max(0, this._output.length - chars));
    };
    const onThinking = (text: string) => {
      if (this.settled) return;
      this.emit('thinking', text);
    };
    const onToolUse = (data: {
      id?: string;
      name: string;
      input: string;
      status?: 'started' | 'in_progress' | 'completed' | 'failed';
      provider?: WorkerConfig['provider'];
      itemType?: string;
      itemId?: string;
      output?: string;
      exitCode?: number;
      outputHash?: string;
    }) => {
      if (this.settled) return;
      this.emit('tool_use', data);
    };
    const onSystemNotice = (notice: string) => {
      if (this.settled) return;
      this.emit('system_notice', notice);
    };
    // Phase 7b — Task lifecycle. Forwarded as opaque payloads so the
    // WorkerManager → seedWorker layer above stays in sole charge of
    // adding workflowId and broadcasting.
    const onTaskStarted = (data: unknown) => {
      if (this.settled) return;
      this.emit('task_started', data);
    };
    const onTaskStatus = (data: unknown) => {
      if (this.settled) return;
      this.emit('task_status', data);
    };
    const onResult = (data: { text: string; costUsd: number; durationMs: number; usage?: Record<string, number>; modelContextWindow?: number; lastPromptTokens?: number; thinkingBytes?: number; toolResultBytes?: number; toolResultBytesRaw?: number; serverToolResultBytes?: number }) => {
      if (this.settled) return;
      this.settled = true;
      this._status = 'completed';
      this.unwire();
      this.emit('result', {
        text: this._output.length >= data.text.length ? this._output : data.text,
        costUsd: data.costUsd,
        durationMs: data.durationMs,
        ...(data.usage ? { usage: data.usage } : {}),
        ...(typeof data.modelContextWindow === 'number' ? { modelContextWindow: data.modelContextWindow } : {}),
        ...(typeof data.lastPromptTokens === 'number' ? { lastPromptTokens: data.lastPromptTokens } : {}),
        ...(typeof data.thinkingBytes === 'number' ? { thinkingBytes: data.thinkingBytes } : {}),
        ...(typeof data.toolResultBytes === 'number' ? { toolResultBytes: data.toolResultBytes } : {}),
        ...(typeof data.toolResultBytesRaw === 'number' ? { toolResultBytesRaw: data.toolResultBytesRaw } : {}),
        ...(typeof data.serverToolResultBytes === 'number' ? { serverToolResultBytes: data.serverToolResultBytes } : {}),
      });
    };
    const onError = (reason: string) => {
      if (this.settled) return;
      this.fail(reason);
    };

    this.worker.on('init', onInit);
    this.worker.on('text', onText);
    this.worker.on('text_discard', onTextDiscard);
    this.worker.on('thinking', onThinking);
    this.worker.on('tool_use', onToolUse);
    this.worker.on('system_notice', onSystemNotice);
    this.worker.on('task_started', onTaskStarted);
    this.worker.on('task_status', onTaskStatus);
    this.worker.on('result', onResult);
    this.worker.on('error', onError);

    this.wired.push(
      { event: 'init', fn: onInit as (...args: unknown[]) => void },
      { event: 'text', fn: onText as (...args: unknown[]) => void },
      { event: 'text_discard', fn: onTextDiscard as (...args: unknown[]) => void },
      { event: 'thinking', fn: onThinking as (...args: unknown[]) => void },
      { event: 'tool_use', fn: onToolUse as (...args: unknown[]) => void },
      { event: 'system_notice', fn: onSystemNotice as (...args: unknown[]) => void },
      { event: 'task_started', fn: onTaskStarted as (...args: unknown[]) => void },
      { event: 'task_status', fn: onTaskStatus as (...args: unknown[]) => void },
      { event: 'result', fn: onResult as (...args: unknown[]) => void },
      { event: 'error', fn: onError as (...args: unknown[]) => void },
    );
  }

  private unwire(): void {
    for (const { event, fn } of this.wired) {
      this.worker.off(event, fn);
    }
    this.wired = [];
  }

  private fail(reason: string): void {
    if (this.settled) return;
    this.settled = true;
    this._status = 'failed';
    this.unwire();
    this.emit('error', reason);
  }
}

function acquireWorker(workflowId: string, config: WorkerConfig): ClaudeNativeWorker {
  const existing = workersByWorkflow.get(workflowId);
  if (existing) {
    configureClusterEventBroadcast(existing, config);
    return existing;
  }
  const fresh = new ClaudeNativeWorker({ workflowId, config, taskDisabled: config.claudeNativeTaskDisabled === true });
  fresh.setTodosBroadcast((todos) => {
    if (todosBroadcast) todosBroadcast(workflowId, todos);
  });
  if (planBroadcastFactory) fresh.setPlanBroadcast(planBroadcastFactory(workflowId));
  if (taskHandlerFn) fresh.setTaskHandler(taskHandlerFn);
  if (workflowEventBroadcast) {
    const wfid = workflowId;
    fresh.setWorkflowEventBroadcast((msg) => { workflowEventBroadcast?.(wfid, msg); });
  }
  configureClusterEventBroadcast(fresh, config);
  workersByWorkflow.set(workflowId, fresh);
  return fresh;
}

function configureClusterEventBroadcast(worker: ClaudeNativeWorker, config: WorkerConfig): void {
  if (clusterEventBroadcast && config.clusterId) {
    const cid = config.clusterId;
    worker.setClusterEventBroadcast((msg) => { clusterEventBroadcast?.(cid, msg); });
  } else {
    worker.setClusterEventBroadcast(() => { /* no cluster */ });
  }
}

// Pre-create + seed a Native worker for the target workflow with messages
// replayed from a foreign workflow's events.jsonl. Used by the Spawn-from-here
// original-worker path: the child workflow's worker boots with the parent's
// conversation history so the reflection turn carries full context. The
// worker is registered in workersByWorkflow under `targetWorkflowId`, so the
// next runPrimaryTurn → ClaudeNativeProvider.create → acquireWorker returns
// this seeded instance instead of creating a fresh empty one.
export async function seedClaudeNativeWorkerFromForeignEvents(
  targetWorkflowId: string,
  baseConfig: WorkerConfig,
  source: { cwd: string; workflowId: string },
  // Phase 8 — when set, only events with seq <= maxSeq are replayed into
  // messages[]. Used by HISTORY's "SPAWN FROM HERE" cutoff so the spawned
  // worker's history matches the operator-chosen anchor.
  maxSeq?: number,
): Promise<void> {
  // Drop any prior worker for this id — caller owns lifecycle and we don't
  // want to leave a half-initialized one behind on retry.
  disposeClaudeNativeWorker(targetWorkflowId);
  const messages = await replayMessagesFromEvents(source.cwd, source.workflowId, maxSeq);
  const worker = acquireWorker(targetWorkflowId, baseConfig);
  worker.seedMessages(messages);
}

export function disposeClaudeNativeWorker(workflowId: string): void {
  const worker = workersByWorkflow.get(workflowId);
  if (!worker) return;
  workersByWorkflow.delete(workflowId);
  void worker.dispose().catch((err: unknown) => {
    console.warn(`[claude-native:${workflowId.slice(0, 8)}] dispose failed:`, err);
  });
}

// Operator-triggered in-place compaction (the in-Archon `/compact` for the
// native transport). Runs against the long-lived per-workflow worker. If the
// worker was disposed/restarted but the workflow has persisted events, callers
// may pass a config so we can cold-acquire the worker and let ensureStarted()
// replay events.jsonl before summarizing.
export async function compactClaudeNativeWorker(
  workflowId: string,
  config?: WorkerConfig,
): Promise<{ ok: boolean; error?: string; foldedTurns?: number }> {
  const worker = workersByWorkflow.get(workflowId) ?? (config ? acquireWorker(workflowId, config) : undefined);
  if (!worker) {
    return { ok: false, error: 'no active Claude Native worker for this workflow — run a turn first' };
  }
  if (config) worker.updateConfig(config);
  return worker.compactInPlace();
}

// §2.1 — operator/auto Fold. Same acquire-or-reuse contract as
// compactClaudeNativeWorker; the Fold itself is deterministic (no API spend).
export async function foldClaudeNativeWorker(
  workflowId: string,
  config?: WorkerConfig,
  opts?: { tailTokenBudget?: number; trigger?: 'operator' | 'auto' },
): Promise<{ ok: boolean; error?: string; foldedTurns?: number; byteDelta?: number }> {
  const worker = workersByWorkflow.get(workflowId) ?? (config ? acquireWorker(workflowId, config) : undefined);
  if (!worker) {
    return { ok: false, error: 'no active Claude Native worker for this workflow — run a turn first' };
  }
  if (config) worker.updateConfig(config);
  return worker.foldInPlace(opts);
}

// Server Fold (on-demand compaction, serverFold.ts). Same acquire-or-reuse
// contract as foldClaudeNativeWorker. Any server-side failure (beta rejected
// on this account/model, missing summary, 429/5xx) runs the deterministic Fold
// in the same call — fence B's "degrade, don't fail closed". `fellBack` +
// `fallbackReason` let the handler word the notice honestly.
export async function serverFoldClaudeNativeWorker(
  workflowId: string,
  config?: WorkerConfig,
): Promise<{
  ok: boolean;
  error?: string;
  foldedTurns?: number;
  keptTurns?: number;
  byteDelta?: number;
  usage?: { input: number; output: number; cacheRead: number; cacheCreate: number };
  fellBack?: boolean;
  fallbackKind?: 'unsupported' | 'failed';
  fallbackReason?: string;
}> {
  const worker = workersByWorkflow.get(workflowId) ?? (config ? acquireWorker(workflowId, config) : undefined);
  if (!worker) {
    return { ok: false, error: 'no active Claude Native worker for this workflow — run a turn first' };
  }
  if (config) worker.updateConfig(config);
  const res = await worker.serverFoldInPlace();
  if (res.ok || !res.fallback) return res;
  const fold = await worker.foldInPlace({ trigger: 'operator' });
  return {
    ...fold,
    ...(res.usage ? { usage: res.usage } : {}),
    fellBack: true,
    fallbackKind: res.fallback,
    fallbackReason: res.error,
  };
}

// NATIVE_COMPACTION_PLAN Phase 2 — ARCHON_TEST-only seam for
// scripts/smoke/native-auto-compact.ts. Acquire (or reuse) the cached worker and
// force-seed it with a probe history so `maybeAutoCompactNative` →
// `compactInPlace` can run with a canned summary (no API spend). Returns false
// when there's no config to acquire a worker (shouldn't happen in the smoke).
export function debugSeedNativeCompactProbe(
  workflowId: string,
  config: WorkerConfig,
  messages: Array<{ role: 'user' | 'assistant'; content: unknown }>,
): boolean {
  if (process.env.ARCHON_TEST !== '1') return false;
  const worker = acquireWorker(workflowId, config);
  worker.__debugSeedForCompactProbe(messages as never);
  return true;
}

export const ClaudeNativeProvider: Provider = {
  create(id, config) {
    const workflowId = config.workflowId;
    if (!workflowId) {
      throw new Error('claude-native transport requires WorkerConfig.workflowId');
    }
    const worker = acquireWorker(workflowId, config);
    return new ClaudeNativeTurn(id, worker, config);
  },
};
