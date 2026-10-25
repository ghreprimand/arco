// Phase 6a + 6b — Codex `app-server` transport entry.
//
// The long-lived `CodexAppServerWorker` is cached per workflowId. Each
// operator turn instantiates a `CodexAppServerTurn` wrapper that adapts
// the long-lived worker's "events stream forever" surface to Arco's
// "one ProviderProcess per turn" contract.
//
// `acquireForTurn(workflowId, config)` returns the per-turn wrapper.
// `disposeForWorkflow(workflowId)` is called from `handleRemoveWorkflow`
// to tear down the long-lived child when the operator closes the tab.

import { EventEmitter } from 'events';
import type { WorkerConfig, WorkerStatus } from '@arco/shared';
import type { Provider, ProviderProcess } from '../types.js';
import { CodexAppServerWorker, computeMcpSignature, bootstrapSurfaceKey, type ToolUseEvent, type PrimaryArtifactEvent, type TurnSettleData } from './worker.js';
import { codexContextWindowOverride } from '../codexContextWindow.js';
import { allowVoiceTools, blockVoiceTools, observeVoiceTools } from '../../voice/operatorTools.js';
import { ComputerTurnWatchdog } from '../../voice/turnWatchdog.js';

const workersByWorkflow = new Map<string, CodexAppServerWorker>();

// Children being torn down for a recycle (bootstrap-signature change,
// post-compact). Codex holds a single-writer lock on the thread until the old
// child exits; a fresh child that thread/resumes first fails "already has an
// active writer" and burns a breaker strike. The next ensureStarted() for the
// workflow waits on this.
const retiringByWorkflow = new Map<string, Promise<void>>();

function retireWorker(workflowId: string, worker: CodexAppServerWorker, label: string): void {
  const prior = retiringByWorkflow.get(workflowId) ?? Promise.resolve();
  const done: Promise<void> = Promise.all([
    prior,
    worker.dispose().catch((err: unknown) => {
      console.warn(`[appserver:${workflowId.slice(0, 8)}] ${label} dispose failed:`, err);
    }),
  ]).then(() => {
    if (retiringByWorkflow.get(workflowId) === done) retiringByWorkflow.delete(workflowId);
  });
  retiringByWorkflow.set(workflowId, done);
}

function awaitRetired(workflowId: string): Promise<void> {
  return retiringByWorkflow.get(workflowId) ?? Promise.resolve();
}

// Phase 6d — circuit breaker for repeated app-server spawn failures. Counts
// consecutive ensureStarted/onChildDeath failures since the last successful
// turn. Lives at the dispatcher layer (not on the cached worker) because the
// cache entry is dropped on `fatal` — the counter has to survive that drop.
// Reset on a successful turn settle or when the operator disposes the tab.
// Cleared by the same `disposeCodexAppServerWorker` that tears down the
// worker, so a tab close + reopen also resets.
const MAX_CONSECUTIVE_SPAWN_FAILURES = 3;
const failureStateByWorkflow = new Map<string, { count: number; lastError: string }>();

function bumpFailureCount(workflowId: string, reason: string): number {
  const state = failureStateByWorkflow.get(workflowId) ?? { count: 0, lastError: '' };
  state.count += 1;
  state.lastError = reason;
  failureStateByWorkflow.set(workflowId, state);
  return state.count;
}

function resetFailureCount(workflowId: string): void {
  failureStateByWorkflow.delete(workflowId);
}

// One operator turn against the long-lived worker. ProviderProcess shape
// preserved so WorkerManager / seedWorker can stay unchanged.
class CodexAppServerTurn extends EventEmitter implements ProviderProcess {
  readonly id: string;
  private _status: WorkerStatus = 'spawning';
  private _output = '';
  private settled = false;
  // Listener handles so we can unwire on settle without leaking on the
  // long-lived emitter.
  private wired: Array<{ event: string; fn: (...args: unknown[]) => void }> = [];
  // Phase 6d — set when the long-lived worker emits `fatal` for THIS turn
  // (the child died mid-bootstrap or mid-turn). The fatal listener already
  // bumps the failure counter, so the .catch on ensureStarted/beginTurn
  // skips a second bump when the rejection traces back to that same fatal.
  private fatalSeen = false;
  private watchdog?: ComputerTurnWatchdog;
  private stopToolObserver?: () => void;
  private timeoutReason?: string;

  constructor(
    id: string,
    private readonly worker: CodexAppServerWorker,
    private readonly config: WorkerConfig,
    private readonly appendSystemPrompt: string | undefined,
    private readonly workflowId: string,
  ) {
    super();
    this.id = id;
  }

  get status(): WorkerStatus { return this._status; }
  get output(): string { return this._output; }
  get pid(): number | undefined { return this.worker.pid; }

  spawn(prompt: string): void {
    // The app-server child is cached per workflow, but the Arco
    // WorkerConfig is per turn. Refresh it before ensureStarted()/beginTurn()
    // so attachments, model/effort swaps, cwd, sandbox, and queue hooks match
    // the operator's current send instead of the turn that created the child.
    this.worker.updateConfig(this.config);

    // Set up listeners up-front; ensureStarted() may resolve before we'd
    // otherwise be subscribed.
    this.wireListeners();
    if (this.config.interactionMode === 'chat' && this.config.voiceOperator) {
      this.watchdog = new ComputerTurnWatchdog((reason) => {
        this.timeoutReason = reason + (this.config.incognito ? ' Private context was discarded.' : ' Saved conversation history is preserved.');
        blockVoiceTools(this.workflowId);
        if (workersByWorkflow.get(this.workflowId) === this.worker) workersByWorkflow.delete(this.workflowId);
        retireWorker(this.workflowId, this.worker, 'Computer timeout');
        this.fail(this.timeoutReason);
      });
      this.stopToolObserver = observeVoiceTools(this.workflowId, (event) => this.watchdog?.tool(event));
    }

    let bootstrapped = false;
    // kill() during bootstrap settles this wrapper synchronously (synthetic
    // "Worker killed"), but the promise chain kept going: the turn started
    // anyway with nobody listening, and the operator's next send bounced
    // with "already has a turn in flight". Re-check `settled` after each await.
    awaitRetired(this.workflowId)
      .then(() => {
        if (this.settled) return Promise.reject(new Error('Worker killed'));
        if (this.config.voiceOperator) allowVoiceTools(this.workflowId);
        return this.worker.ensureStarted();
      })
      .then(async () => {
        bootstrapped = true;
        if (this.settled) return;
        await this.worker.beginTurn(prompt, this.appendSystemPrompt);
        // Killed while turn/start was in flight: the synthetic settle already
        // cleared the worker's turn state, then turn/start landed a live
        // turnId. Interrupt that orphan so the thread goes idle.
        if (this.settled) {
          void this.worker.cancelCurrentTurn().catch((err: unknown) => {
            console.warn(`[appserver:${this.workflowId.slice(0, 8)}] orphan-turn interrupt failed:`, err);
          });
        }
      })
      .catch((err: unknown) => {
        if (this.settled) return;
        const msg = err instanceof Error ? err.message : String(err);
        // Bootstrap failure that did NOT come through `fatal` (handshake RPC
        // error, thread/start rejection, …). Count it toward the spawn-failure
        // circuit breaker; `fatal` paths already bumped the counter via the
        // worker's own listener. A rejection AFTER a clean ensureStarted is a
        // beginTurn pre-flight throw against a healthy child — not a spawn
        // failure, and counting it wrongly burned strikes the operator could
        // only clear by closing the tab (2026-07-28: two "already has a turn
        // in flight" bounces plus one child death tripped the 3-strike cap).
        if (!this.fatalSeen && !bootstrapped) {
          bumpFailureCount(this.workflowId, msg);
        }
        this.fail(msg);
      });
  }

  async interrupt(): Promise<void> {
    if (!this.settled) await this.worker.cancelCurrentTurn();
  }

  kill(): void {
    if (this.settled) return;
    // Async; the wrapper's `error` event fires when `turn_settled` lands.
    void this.worker.cancelCurrentTurn().catch((err: unknown) => {
      if (this.settled) return;
      const msg = err instanceof Error ? err.message : String(err);
      this.fail(`cancel failed: ${msg}`);
    });
  }

  private wireListeners(): void {
    const onInit = (data: { model?: string; sessionId?: string }) => {
      if (this.settled) return;
      this._status = 'running';
      this.emit('init', data);
    };
    const onText = (text: string) => {
      if (this.settled) return;
      if (text) this.watchdog?.progress();
      this._output += text;
      this.emit('text', text);
    };
    const onThinking = (text: string) => {
      if (this.settled) return;
      if (text) this.watchdog?.progress();
      this.emit('thinking', text);
    };
    const onToolUse = (data: ToolUseEvent) => {
      if (this.settled) return;
      this.emit('tool_use', data);
    };
    const onPrimaryArtifact = (data: PrimaryArtifactEvent) => {
      if (this.settled) return;
      this.emit('primary_artifact', data);
    };
    const onSystemNotice = (notice: string) => {
      if (this.settled) return;
      this.emit('system_notice', notice);
    };
    const onSettled = (data: { error?: string; result?: TurnSettleData }) => {
      if (this.settled) return;
      if (data.error) {
        this.fail(this.timeoutReason ?? data.error);
        return;
      }
      const r = data.result;
      if (!r) {
        this.fail('turn settled with no result');
        return;
      }
      this.settled = true;
      this._status = 'completed';
      this.unwire();
      // Successful turn — the spawn-failure circuit breaker resets so any
      // earlier intermittent crashes stop counting toward the 3-strike cap.
      resetFailureCount(this.workflowId);
      this.emit('result', {
        text: this._output.length >= r.text.length ? this._output : r.text,
        costUsd: r.costUsd,
        durationMs: r.durationMs,
        ...(r.usage ? { usage: r.usage } : {}),
        ...(typeof r.modelContextWindow === 'number' ? { modelContextWindow: r.modelContextWindow } : {}),
        ...(typeof r.lastPromptTokens === 'number' ? { lastPromptTokens: r.lastPromptTokens } : {}),
        // EFFICIENCY_PLAN.md Phase A — Codex doesn't expose tool_result bytes
        // through the app-server JSON-RPC surface. Sentinel: -1 = unknown.
        thinkingBytes: 0,
        toolResultBytes: -1,
        toolResultBytesRaw: -1,
      });
    };
    const onFatal = (reason: string) => {
      if (this.settled) return;
      // Mark so the .catch on ensureStarted/beginTurn doesn't double-count.
      // The acquireWorker fatal listener already bumped the counter.
      this.fatalSeen = true;
      this.fail(`codex app-server died: ${reason}`);
    };

    this.worker.on('init', onInit);
    this.worker.on('text', onText);
    this.worker.on('thinking', onThinking);
    this.worker.on('tool_use', onToolUse);
    this.worker.on('primary_artifact', onPrimaryArtifact);
    this.worker.on('system_notice', onSystemNotice);
    this.worker.on('turn_settled', onSettled);
    this.worker.on('fatal', onFatal);

    this.wired.push(
      { event: 'init', fn: onInit as (...args: unknown[]) => void },
      { event: 'text', fn: onText as (...args: unknown[]) => void },
      { event: 'thinking', fn: onThinking as (...args: unknown[]) => void },
      { event: 'tool_use', fn: onToolUse as (...args: unknown[]) => void },
      { event: 'primary_artifact', fn: onPrimaryArtifact as (...args: unknown[]) => void },
      { event: 'system_notice', fn: onSystemNotice as (...args: unknown[]) => void },
      { event: 'turn_settled', fn: onSettled as (...args: unknown[]) => void },
      { event: 'fatal', fn: onFatal as (...args: unknown[]) => void },
    );

    // Phase 6a unused but harmless — silences "WorkerConfig.appendSystemPrompt
    // is read-only / accessed once" linter complaint. The field flows
    // through to beginTurn() at spawn time.
    void this.config;
  }

  private unwire(): void {
    this.watchdog?.stop(); this.watchdog = undefined;
    this.stopToolObserver?.(); this.stopToolObserver = undefined;
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

// Long-lived worker accessor. Creates lazily on first turn for a given
// workflow; subsequent turns reuse the cached worker (same `app-server`
// child, same Codex thread).
//
// CLUSTER_MODE_PLAN.md Phase 4 + EFFICIENCY_PLAN.md Phase F9 — when an
// existing cached worker's bootstrapped MCP wiring no longer matches the
// incoming config (operator joined/left a cluster, attached/detached
// codebase-memory, or changed the codebase-memory index path mid-tab),
// dispose the cached worker so the next ensureStarted() rebuilds the
// appserver with the right `-c mcp_servers.*` overrides. Codex thread
// state survives the restart via thread/resume.
function acquireWorker(
  workflowId: string,
  config: WorkerConfig,
  resumeSessionId: string | undefined,
): CodexAppServerWorker {
  const existing = workersByWorkflow.get(workflowId);
  if (existing) {
    const incomingCodebaseMemoryIndexPath = config.codebaseMemoryAttached
      ? config.codebaseMemoryIndexPath
      : undefined;
    const desiredSignature = computeMcpSignature(
      config.clusterId,
      config.clusterTaskBoardAttached === true,
      incomingCodebaseMemoryIndexPath,
      config.providerAccountRef,
      config.codexHome,
      config.clusterAccessMode,
      config.clusterRole,
      config.model,
      config.codexContextPolicy,
      codexContextWindowOverride(config),
      bootstrapSurfaceKey(config),
    );
    if (existing.currentMcpSignature === desiredSignature) return existing;
    console.log(`[appserver:${workflowId.slice(0, 8)}] bootstrap context changed (${existing.currentMcpSignature ?? 'none'} → ${desiredSignature}); recycling appserver child`);
    workersByWorkflow.delete(workflowId);
    retireWorker(workflowId, existing, 'mcp-recycle');
  }
  const fresh = new CodexAppServerWorker(workflowId, config, resumeSessionId);
  workersByWorkflow.set(workflowId, fresh);
  fresh.on('fatal', (reason: string) => {
    // Drop the cache entry so the next operator turn re-spawns. Don't
    // dispose() — the entry is already torn down by `onChildDeath`.
    if (workersByWorkflow.get(workflowId) === fresh) {
      workersByWorkflow.delete(workflowId);
    }
    // Phase 6d — count this toward the spawn-failure circuit breaker. The
    // CodexAppServerTurn that owns this turn observes the same `fatal` and
    // sets `fatalSeen` so its own .catch doesn't double-bump.
    const count = bumpFailureCount(workflowId, reason);
    console.warn(`[appserver:${workflowId.slice(0, 8)}] worker dropped from cache (${reason}); consecutive failures=${count}`);
  });
  return fresh;
}

// Operator-triggered native compaction against the long-lived per-workflow
// thread (the app-server equivalent of `/compact` in Codex CLI). Out-of-band
// vs. the per-turn CodexAppServerTurn wrapper — it talks straight to the
// cached worker. Returns a structured result; the WS handler surfaces the
// notice + refreshes the CTX bar. No cached worker means no thread has been
// created yet (the tab never ran a turn) — nothing to compact.
export async function compactCodexAppServerThread(
  workflowId: string,
  config?: WorkerConfig,
  resumeSessionId?: string,
): Promise<{ ok: boolean; error?: string }> {
  let worker = workersByWorkflow.get(workflowId);
  if (!worker) {
    if (!config || !resumeSessionId) {
      return { ok: false, error: 'no active Codex thread for this workflow — run a turn first' };
    }
    worker = acquireWorker(workflowId, config, resumeSessionId);
    try {
      await awaitRetired(workflowId);
      await worker.ensureStarted();
    } catch (err) {
      return { ok: false, error: `failed to resume Codex thread for compact: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  const result = await worker.compactThread();
  if (result.recycle) {
    if (workersByWorkflow.get(workflowId) === worker) workersByWorkflow.delete(workflowId);
    resetFailureCount(workflowId);
    retireWorker(workflowId, worker, 'post-compact recycle');
  }
  return { ok: result.ok, ...(result.error ? { error: result.error } : {}) };
}

export function disposeCodexAppServerWorker(workflowId: string): void {
  allowVoiceTools(workflowId);
  // Operator-driven dispose (tab close / workflow remove) — clear the spawn-
  // failure breaker so a re-opened tab starts fresh.
  resetFailureCount(workflowId);
  const worker = workersByWorkflow.get(workflowId);
  if (!worker) return;
  workersByWorkflow.delete(workflowId);
  void worker.dispose().catch((err: unknown) => {
    console.warn(`[appserver:${workflowId.slice(0, 8)}] dispose failed:`, err);
  });
}

// Awaitable dispose for callers about to resume this tab's thread from a
// separate `codex exec resume` (handoff / spawn original-worker reflection).
// Newer codex refuses a second writer on a thread ("thread-store conflict:
// thread … already has an active writer"), so the long-lived app-server must
// be fully exited first. The next operator turn rebuilds it via resume.
export async function releaseCodexAppServerWorker(workflowId: string): Promise<void> {
  const worker = workersByWorkflow.get(workflowId);
  if (!worker) return awaitRetired(workflowId);
  workersByWorkflow.delete(workflowId);
  await worker.dispose().catch((err: unknown) => {
    console.warn(`[appserver:${workflowId.slice(0, 8)}] release dispose failed:`, err);
  });
}

// Phase 6d — circuit-broken stub. Returned in place of a real
// CodexAppServerTurn when consecutive spawn failures exceed
// MAX_CONSECUTIVE_SPAWN_FAILURES; surfaces a system_notice and fails the
// turn instead of attempting another spawn. Operator's path forward is to
// Handoff (which mints a new workflow id and resets the breaker).
class CodexAppServerCircuitBrokenTurn extends EventEmitter implements ProviderProcess {
  readonly id: string;
  private _status: WorkerStatus = 'spawning';
  private settled = false;

  constructor(id: string, private readonly notice: string, private readonly errMsg: string) {
    super();
    this.id = id;
  }
  get status(): WorkerStatus { return this._status; }
  get output(): string { return ''; }
  get pid(): number | undefined { return undefined; }
  spawn(_prompt: string): void {
    if (this.settled) return;
    setImmediate(() => {
      if (this.settled) return;
      this.emit('system_notice', this.notice);
      this.settled = true;
      this._status = 'failed';
      this.emit('error', this.errMsg);
    });
  }
  kill(): void {
    if (this.settled) return;
    this.settled = true;
    this._status = 'failed';
    this.emit('error', 'Worker killed');
  }
}

export const CodexAppServerProvider: Provider = {
  create(id, config) {
    const workflowId = config.workflowId;
    if (!workflowId) {
      throw new Error('codex app-server transport requires WorkerConfig.workflowId');
    }
    // Phase 6d — circuit breaker. After N consecutive ensureStarted /
    // onChildDeath failures with no successful turn between, refuse to
    // spawn again and surface a system_notice. Operator can Handoff (new
    // workflow id → fresh breaker) or close the tab (dispose resets too).
    const failure = failureStateByWorkflow.get(workflowId);
    if (failure && failure.count >= MAX_CONSECUTIVE_SPAWN_FAILURES) {
      const notice = `[codex] codex app-server failed to spawn ${failure.count} times in a row — last error: ${failure.lastError}. Use Handoff to start a fresh thread, or check that the Codex CLI is healthy.`;
      return new CodexAppServerCircuitBrokenTurn(id, notice, `codex app-server circuit-broken: ${failure.lastError}`);
    }
    const worker = acquireWorker(workflowId, config, config.resumeSessionId);
    return new CodexAppServerTurn(id, worker, config, config.appendSystemPrompt, workflowId);
  },
};
