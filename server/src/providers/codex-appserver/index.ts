import { isIsolatedAccessMode } from '@arco/shared';
import { prepareProviderHistory } from '../handoffHistoryBinding.js';
import { providerSessionScope } from '../sessionScope.js';
import { codexSignInFingerprint, codexSignInHome, waitForCodexSignIn } from '../../workers/codexAccessLease.js';
import { setResearcherSignInWaiting } from '../../research/researchRounds.js';
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
import type { PrimaryToolUseMessage, WorkerConfig, WorkerStatus } from '@arco/shared';
import type { Provider, ProviderProcess } from '../types.js';
import { CodexAppServerWorker, computeMcpSignature, bootstrapSurfaceKey, type ToolUseEvent, type PrimaryArtifactEvent, type TurnSettleData } from './worker.js';
import { codexContextWindowOverride } from '../codexContextWindow.js';
import { allowVoiceTools, blockVoiceTools, observeVoiceTools } from '../../voice/operatorTools.js';
import { ComputerTurnWatchdog } from '../../voice/turnWatchdog.js';
import type { SteerItem } from '@arco/shared';
import {
  HELD_BATCH_MS, HELD_CONTINUATION_LIMIT, HELD_WAIT_LIMIT_MS,
  formatDuration, heldResultsNotice, heldResultsMessage, shortCommand,
} from './heldCommands.js';

const workersByWorkflow = new Map<string, CodexAppServerWorker>();
const compactReservations = new Map<string, CodexAppServerWorker>();

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
const isResearchAuthFailure = (message: string): boolean => /\b401\b|unauthorized|invalid[ _-]*(?:access[ _-]*)?token|token.{0,30}expired|authentication.{0,30}failed/i.test(message);

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
export class CodexAppServerTurn extends EventEmitter implements ProviderProcess {
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
  // docs/PROVIDERS.md - the Arco turn stays open while a command the agent
  // started is still running after its Codex turn completed. Each Codex turn
  // inside it adds its cost; the result is reported once, at the end.
  private readonly startedAt = Date.now();
  private costUsd = 0;
  private lastResult?: TurnSettleData;
  private continuations = 0;
  private waitedMs = 0;
  private waitStartedAt = 0;
  private waitTimer?: NodeJS.Timeout;
  private inputTimer?: NodeJS.Timeout;
  private batchTimer?: NodeJS.Timeout;
  private resultSteer?: Promise<void>;
  // STOP: nothing continues, and no later result restarts the turn.
  private stopped = false;
  // Interrupt & send: the wait ends, but the commands stay held so the
  // operator's next turn receives their results.
  private interrupting = false;
  private keepIsolatedWorkerForCommands = false;
  private readonly preparationAbort = new AbortController();
  private researchAuthRetried = false;
  private waitingForSignIn = false;
  private signInFingerprint?: string;

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

    this.startAttempt(prompt);
  }

  private startAttempt(prompt: string): void {
    let bootstrapped = false;
    // kill() during bootstrap settles this wrapper synchronously (synthetic
    // "Worker killed"), but the promise chain kept going: the turn started
    // anyway with nobody listening, and the operator's next send bounced
    // with "already has a turn in flight". Re-check `settled` after each await.
    awaitRetired(this.workflowId)
      .then(async () => {
        if (this.settled) throw new Error('Worker killed');
        await prepareProviderHistory(this.config);
        if (this.settled) return Promise.reject(new Error('Worker killed'));
        if (this.config.clusterAccessMode === 'researcher') this.signInFingerprint = await codexSignInFingerprint(codexSignInHome(this.config.codexHome));
        if (this.settled) return Promise.reject(new Error('Worker killed'));
        if (this.config.voiceOperator) allowVoiceTools(this.workflowId);
        return this.worker.ensureStarted();
      })
      .then(async () => {
        bootstrapped = true;
        if (this.settled) return;
        await this.worker.prepareIsolatedTurn(this.preparationAbort.signal);
        if (this.settled) return;
        if (this.config.clusterAccessMode === 'researcher' && this.config.clusterId) await setResearcherSignInWaiting(this.config.clusterId, this.workflowId, false, 'codex');
        if (this.settled) return;
        await this.worker.beginTurn(prompt, this.config.appendSystemPrompt);
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
        if (this.config.clusterAccessMode === 'isolated') void import('../../clusterStore.js').then(({ setMemberFenceState }) => setMemberFenceState(this.workflowId, 'unavailable', /Codex researchers need Codex/.test(msg) ? msg.replace('Codex researchers', 'Isolated Codex members') : 'Sandbox could not start; check Codex, its sign-in, bubblewrap and socat.')).catch(() => undefined);
        if (this.waitForResearchSignIn(msg, () => this.startAttempt(prompt))) return;
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

  private waitForResearchSignIn(message: string, resume: () => void): boolean {
    if (this.config.clusterAccessMode !== 'researcher' || !this.config.clusterId
      || !/Codex sign-in needs renewing\./.test(message) || this.preparationAbort.signal.aborted) return false;
    if (this.waitingForSignIn) return true;
    this.waitingForSignIn = true;
    const clusterId = this.config.clusterId, home = codexSignInHome(this.config.codexHome);
    void waitForCodexSignIn(home, this.preparationAbort.signal, {
      initial: this.signInFingerprint ?? null,
      onWaiting: async () => {
        await setResearcherSignInWaiting(clusterId, this.workflowId, true, 'codex');
        this.emit('system_notice', 'Codex sign-in needs renewing. Use RE-LOGIN in the research window; the researcher continues after sign-in.');
      },
    }).then(async () => {
      this.waitingForSignIn = false;
      await setResearcherSignInWaiting(clusterId, this.workflowId, false, 'codex');
      if (!this.settled) resume();
    }).catch(error => {
      this.waitingForSignIn = false;
      void setResearcherSignInWaiting(clusterId, this.workflowId, false, 'codex').catch(() => undefined);
      if (!this.settled && !this.preparationAbort.signal.aborted) this.fail(String(error));
    });
    return true;
  }

  private retryResearchAuthentication(message: string): boolean {
    if (!isIsolatedAccessMode(this.config.clusterAccessMode) || this.researchAuthRetried || !isResearchAuthFailure(message)) return false;
    this.researchAuthRetried = true;
    const resume = () => {
      void (async () => {
        this.signInFingerprint = await codexSignInFingerprint(codexSignInHome(this.config.codexHome));
        await this.worker.prepareIsolatedTurn(this.preparationAbort.signal);
        if (!this.settled) await this.worker.beginTurn('[Arco retry] Authentication interrupted this turn. Continue the task without repeating completed tool actions.', this.config.appendSystemPrompt);
      })().catch(error => {
        if (this.settled) return;
        const detail = error instanceof Error ? error.message : String(error);
        if (!this.waitForResearchSignIn(detail, resume)) this.fail(detail);
      });
    };
    resume();
    return true;
  }

  async interrupt(): Promise<void> {
    if (this.settled) return;
    this.preparationAbort.abort();
    this.interrupting = true;
    this.stopWaitClock();
    await this.worker.cancelCurrentTurn();
  }

  kill(): void {
    if (this.settled) return;
    this.preparationAbort.abort();
    this.stopped = true;
    this.stopWaitClock();
    this.worker.abandonHeldCommands();
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
        if (this.retryResearchAuthentication(data.error)) return;
        this.fail(this.timeoutReason ?? data.error);
        return;
      }
      const r = data.result;
      if (!r) {
        this.fail('turn settled with no result');
        return;
      }
      // Successful turn — the spawn-failure circuit breaker resets so any
      // earlier intermittent crashes stop counting toward the 3-strike cap.
      resetFailureCount(this.workflowId);
      this.costUsd += r.costUsd ?? 0;
      this.lastResult = r;
      void this.afterCodexTurn();
    };
    const onHeldCommands = () => {
      if (this.settled || this.stopped) return;
      if (this.waitStartedAt) {
        // Ends that arrive close together go to the agent in one turn.
        if (!this.batchTimer) this.batchTimer = setTimeout(() => { this.batchTimer = undefined; this.reviewWait(); }, HELD_BATCH_MS);
        return;
      }
      // A result that arrives while the final answer is being written waits
      // for the turn to complete and continues it, so it is never lost.
      if (this.worker.hasHeldResults() && !this.resultSteer && !this.lastResult && this.worker.acceptsResultSteer) {
        // A Codex turn is running: the result goes into it, never a second turn.
        this.resultSteer = this.steerResults().finally(() => { this.resultSteer = undefined; });
      }
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
    this.worker.on('held_commands', onHeldCommands);

    this.wired.push(
      { event: 'init', fn: onInit as (...args: unknown[]) => void },
      { event: 'text', fn: onText as (...args: unknown[]) => void },
      { event: 'thinking', fn: onThinking as (...args: unknown[]) => void },
      { event: 'tool_use', fn: onToolUse as (...args: unknown[]) => void },
      { event: 'primary_artifact', fn: onPrimaryArtifact as (...args: unknown[]) => void },
      { event: 'system_notice', fn: onSystemNotice as (...args: unknown[]) => void },
      { event: 'turn_settled', fn: onSettled as (...args: unknown[]) => void },
      { event: 'fatal', fn: onFatal as (...args: unknown[]) => void },
      { event: 'held_commands', fn: onHeldCommands as (...args: unknown[]) => void },
    );

    // Phase 6a unused but harmless — silences "WorkerConfig.appendSystemPrompt
    // is read-only / accessed once" linter complaint. The field flows
    // through to beginTurn() at spawn time.
    void this.config;
  }

  private unwire(): void {
    this.stopWaitClock();
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
    this.worker.releaseIsolatedTurn();
    // After Interrupt & send the operator's message runs next and takes the
    // results; any other failure leaves nobody to deliver them to.
    if (this.worker.runningLateCommands.length > 0) this.keepIsolatedWorkerForCommands = true;
    if (!this.interrupting) this.worker.abandonHeldCommands();
    this.retireIdleIsolatedWorker();
    this.emit('error', reason);
  }

  // ── Waiting on commands the agent started ───────────────────────────

  private async afterCodexTurn(): Promise<void> {
    // A result steer still in flight either landed in the turn that just
    // ended or comes back to the queue of results; wait to know which.
    if (this.resultSteer) await this.resultSteer;
    if (this.settled) return;
    const running = this.worker.heldCommands;
    const ready = this.worker.hasHeldResults();
    if (this.stopped || (!ready && running.length === 0)) return this.finish();
    if (this.continuations >= HELD_CONTINUATION_LIMIT) {
      return this.giveUp(`Arco stopped continuing Codex after ${HELD_CONTINUATION_LIMIT} command results in this turn.`);
    }
    if (ready && (running.length === 0 || this.worker.hasFailedHeldResult())) return this.continueWith([]);
    this.startWait();
  }

  private startWait(): void {
    const remaining = HELD_WAIT_LIMIT_MS - this.waitedMs;
    if (remaining <= 0) return this.giveUp(`Arco stopped waiting after ${formatDuration(HELD_WAIT_LIMIT_MS)} in this turn.`);
    this.waitStartedAt = Date.now();
    this.worker.showHeldUntil(this.waitStartedAt + remaining);
    this.waitTimer = setTimeout(() => {
      this.stopWaitClock();
      this.giveUp(`Arco stopped waiting after ${formatDuration(HELD_WAIT_LIMIT_MS)} in this turn.`);
    }, remaining);
    this.waitTimer.unref?.();
    this.inputTimer = setInterval(() => this.checkInput(), 500);
    this.inputTimer.unref?.();
  }

  private stopWaitClock(): void {
    if (this.waitStartedAt) {
      this.waitedMs += Date.now() - this.waitStartedAt;
      this.worker.releaseHeldWait();
    }
    this.waitStartedAt = 0;
    clearTimeout(this.waitTimer); this.waitTimer = undefined;
    clearInterval(this.inputTimer); this.inputTimer = undefined;
    clearTimeout(this.batchTimer); this.batchTimer = undefined;
  }

  private reviewWait(): void {
    if (this.settled || !this.waitStartedAt) return;
    const running = this.worker.heldCommands;
    const ready = this.worker.hasHeldResults();
    if (ready && (running.length === 0 || this.worker.hasFailedHeldResult())) {
      this.stopWaitClock();
      this.continueWith([]);
    } else if (!ready && running.length === 0) {
      // Codex lost the commands (connection or thread closed); the lost
      // line has already been shown.
      this.stopWaitClock();
      this.finish();
    }
  }

  // Direct operator input or an explicit nudge ends the wait. A steer goes
  // to the agent at once; a follow-up waits for the turn to end, so the
  // turn ends here and the follow-up turn takes over the held commands.
  private checkInput(): void {
    if (this.settled || !this.waitStartedAt) return;
    const pending = this.config.pendingInput?.();
    if (!pending) return;
    const peeked = this.config.peekSteer?.() ?? [];
    if (pending === 'follow-up' || peeked.some(item => item.attachments?.length)) {
      this.stopWaitClock();
      this.emit('system_notice', `Stopped waiting for ${this.runningLabel()}: your message is next. Arco still passes the result on when it ends.`);
      return this.finish();
    }
    const items = this.config.drainSteer?.() ?? [];
    if (!items.length) return;
    this.stopWaitClock();
    this.continueWith(items);
  }

  private continueWith(items: SteerItem[]): void {
    this.continuations += 1;
    const results = this.worker.takeHeldResults();
    const running = this.worker.heldCommands;
    const message = [
      ...(results.length ? [heldResultsMessage(results, running)] : []),
      ...items.map(item => item.content),
      ...(!results.length && running.length ? [`[Arco] Still running: ${running.map(item => shortCommand(item.command)).join('; ')}. Arco tells you when it ends.`] : []),
    ].join('\n\n');
    this._output += this._output ? '\n\n' : '';
    this.lastResult = undefined;
    this.worker.beginTurn(message, undefined, { continuation: true })
      .then(() => {
        const notice = heldResultsNotice(results, true);
        if (notice && !this.settled) this.emit('system_notice', notice);
        if (items.length) this.config.onSteerDelivered?.(items);
        if (this.settled) void this.worker.cancelCurrentTurn().catch(() => {});
      })
      .catch((err: unknown) => {
        if (this.settled) return;
        this.worker.restoreHeldResults(results);
        if (items.length) this.config.requeueSteer?.(items, 'follow-up');
        this.fail(err instanceof Error ? err.message : String(err));
      });
  }

  private async steerResults(): Promise<void> {
    const results = this.worker.takeHeldResults();
    if (!results.length) return;
    const delivered = await this.worker.steerText(heldResultsMessage(results, this.worker.heldCommands));
    if (!delivered) { this.worker.restoreHeldResults(results); return; }
    const notice = heldResultsNotice(results, false);
    if (notice) this.emit('system_notice', notice);
  }

  private runningLabel(): string {
    const running = this.worker.heldCommands;
    return running.length ? running.map(item => `\`${shortCommand(item.command)}\``).join(', ') : 'the command';
  }

  private giveUp(line: string): void {
    const running = this.worker.heldCommands;
    if (running.length > 0) this.keepIsolatedWorkerForCommands = true;
    this.worker.abandonHeldCommands();
    this.emit('system_notice', running.length
      ? `${line} Still running: ${running.map(item => `\`${shortCommand(item.command)}\``).join(', ')}. Its row records how it ends.`
      : line);
    this.finish();
  }

  private retireIdleIsolatedWorker(): void {
    // Researcher shells may have background children after their command item ends.
    // Keep the fenced worker until the research project closes; reissue its pass per turn.
    if (this.config.clusterAccessMode === 'researcher') return;
    if (!isIsolatedAccessMode(this.config.clusterAccessMode) || this.keepIsolatedWorkerForCommands || this.worker.runningLateCommands.length > 0 || this.worker.hasHeldResults()) return;
    if (workersByWorkflow.get(this.workflowId) !== this.worker) return;
    workersByWorkflow.delete(this.workflowId);
    retireWorker(this.workflowId, this.worker, 'isolated turn complete');
  }

  private finish(): void {
    if (this.settled) return;
    const r = this.lastResult;
    if (!r) { this.fail('turn settled with no result'); return; }
    this.settled = true;
    this._status = 'completed';
    this.unwire();
    this.worker.releaseIsolatedTurn();
    this.retireIdleIsolatedWorker();
    this.emit('result', {
      text: this._output.length >= r.text.length ? this._output : r.text,
      costUsd: this.costUsd,
      durationMs: Math.max(r.durationMs ?? 0, Date.now() - this.startedAt),
      ...(r.usage ? { usage: r.usage } : {}),
      ...(typeof r.modelContextWindow === 'number' ? { modelContextWindow: r.modelContextWindow } : {}),
      ...(typeof r.freshContextWindow === 'number' ? { freshContextWindow: r.freshContextWindow } : {}),
      ...(typeof r.lastPromptTokens === 'number' ? { lastPromptTokens: r.lastPromptTokens } : {}),
      // docs/PROVIDERS.md - Codex doesn't expose tool_result bytes
      // through the app-server JSON-RPC surface. Sentinel: -1 = unknown.
      thinkingBytes: 0,
      toolResultBytes: -1,
      toolResultBytesRaw: -1,
    });
  }
}

// Long-lived worker accessor. Creates lazily on first turn for a given
// workflow; subsequent turns reuse the cached worker (same `app-server`
// child, same Codex thread).
//
// docs/PROTOCOL_CLUSTER.md + docs/PROVIDERS.md - when an
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
  fresh.on('late_command', (event: ToolUseEvent, lateCommand: PrimaryToolUseMessage['lateCommand']) => {
    void import('../../server/broadcast.js').then(({ broadcastWorkflow }) => {
      const { name: tool, ...entry } = event;
      broadcastWorkflow(workflowId, {
        ...entry, type: 'primary_tool_use', workflowId, tool, lateCommand,
        ...(lateCommand?.state === 'finished' ? {} : { status: 'in_progress' }),
      });
      if (lateCommand?.state === 'lost') {
        let command = 'A command';
        try { command = JSON.parse(event.input).command || command; } catch { /* use the fallback */ }
        broadcastWorkflow(workflowId, {
          type: 'system_notice', workflowId,
          content: `Codex lost the result for ${command.slice(0, 240)} when its connection closed.`,
        });
      }
    }).catch(error => console.warn('[arco] could not record a late Codex command result', error));
  });
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

export function runningCodexLateCommands(workflowId: string) {
  return workersByWorkflow.get(workflowId)?.runningLateCommands ?? [];
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
  stillOwner?: () => boolean,
): Promise<{ ok: boolean; error?: string }> {
  if (stillOwner && !stillOwner()) return { ok: false, error: 'compaction cancelled before dispatch' };
  if (compactReservations.has(workflowId)) return { ok: false, error: 'a compaction is already running' };
  let worker = workersByWorkflow.get(workflowId);
  const mustStart = !worker;
  if (!worker) {
    if (!config || !resumeSessionId) return { ok: false, error: 'no active Codex thread for this workflow - run a turn first' };
    worker = acquireWorker(workflowId, config, resumeSessionId);
  }
  compactReservations.set(workflowId, worker);
  try {
    if (mustStart) {
      try {
        await awaitRetired(workflowId);
        await worker.ensureStarted();
      } catch (err) {
        if (workersByWorkflow.get(workflowId) === worker) { workersByWorkflow.delete(workflowId); retireWorker(workflowId, worker, 'failed compact startup'); }
        return { ok: false, error: `failed to resume Codex thread for compact: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    if ((stillOwner && !stillOwner()) || compactReservations.get(workflowId) !== worker) {
      if (workersByWorkflow.get(workflowId) === worker) { workersByWorkflow.delete(workflowId); retireWorker(workflowId, worker, 'cancelled compact'); }
      return { ok: false, error: 'compaction cancelled before dispatch' };
    }
    const result = await worker.compactThread();
    if (result.recycle) {
      if (workersByWorkflow.get(workflowId) === worker) workersByWorkflow.delete(workflowId);
      resetFailureCount(workflowId);
      retireWorker(workflowId, worker, 'post-compact recycle');
    }
    return { ok: result.ok, ...(result.error ? { error: result.error } : {}) };
  } finally {
    if (compactReservations.get(workflowId) === worker) compactReservations.delete(workflowId);
  }
}

export function cancelCodexAppServerCompaction(workflowId: string): void {
  const worker = compactReservations.get(workflowId);
  if (!worker) return;
  compactReservations.delete(workflowId);
  worker.cancelCompaction();
  if (workersByWorkflow.get(workflowId) === worker) workersByWorkflow.delete(workflowId);
  retireWorker(workflowId, worker, 'cancelled compact');
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
    const workflowId = providerSessionScope(config);
    if (config.sessionScopeId) config = { ...config, sessionId: undefined, resumeSessionId: undefined };
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
