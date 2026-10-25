// Cursor (ACP) transport entry — docs/CURSOR_TRANSPORT_PLAN.md Phase 1.
//
// The long-lived `CursorAcpWorker` is cached per workflowId (the `cursor-agent
// acp` child + its ACP session stay warm across turns). Each operator turn
// instantiates a `CursorAcpTurn` wrapper that adapts the worker's "events
// stream forever" surface to Archon's "one ProviderProcess per turn" contract.
//
// Structure mirrors codex-appserver/index.ts (per-turn wrapper + worker cache +
// spawn-failure circuit breaker). Cursor's native `/compress` is exposed through
// compactCursorAcpThread; Codex-specific MCP recycling + artifacts stay absent.

import { EventEmitter } from 'events';
import type { WorkerConfig, WorkerStatus } from '@archon/shared';
import type { Provider, ProviderProcess } from '../types.js';
import { CursorAcpWorker, type ToolUseEvent, type TurnSettleData } from './worker.js';

const workersByWorkflow = new Map<string, CursorAcpWorker>();

const CURSOR_AUTH_REQUIRED_TEXT = [
  'please sign in to continue',
  'please log in to continue',
] as const;

function normalizeCursorAuthText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.!:;]+$/g, '');
}

// Cursor ACP reports an expired login as an ordinary assistant message rather
// than a JSON-RPC error. Keep this deliberately narrow so a real answer that
// merely discusses signing in is never converted into an auth failure.
export function isCursorAuthRequiredText(text: string): boolean {
  const normalized = normalizeCursorAuthText(text);
  return CURSOR_AUTH_REQUIRED_TEXT.some((candidate) => normalized === candidate);
}

export function isCursorAuthRequiredPrefix(text: string): boolean {
  const normalized = normalizeCursorAuthText(text);
  return normalized.length === 0
    || CURSOR_AUTH_REQUIRED_TEXT.some((candidate) => candidate.startsWith(normalized));
}

// Circuit breaker for repeated spawn failures. Lives at the dispatcher layer
// (not the worker) because the cache entry is dropped on `fatal`; the counter
// must survive that drop. Reset on a successful settle or operator dispose.
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
// preserved so WorkerManager / seedWorker stay unchanged.
export class CursorAcpTurn extends EventEmitter implements ProviderProcess {
  readonly id: string;
  private _status: WorkerStatus = 'spawning';
  private _output = '';
  private settled = false;
  private wired: Array<{ event: string; fn: (...args: unknown[]) => void }> = [];
  private fatalSeen = false;
  private cancelRequested = false;
  // Hold only the tiny opening span that could be Cursor's auth sentinel. This
  // prevents a misleading assistant bubble without sacrificing normal ACP
  // streaming once the text diverges from the known sentence.
  private heldInitialText = '';
  private holdingAuthCandidate = true;

  constructor(
    id: string,
    private readonly worker: CursorAcpWorker,
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
    // Refresh the shared worker's config to this turn's send before starting.
    this.worker.updateConfig(this.config);
    // Subscribe up-front; ensureStarted() may resolve before we'd otherwise wire.
    this.wireListeners();

    this.worker.ensureStarted()
      .then(() => {
        // kill() during a cold start already settled this turn; don't run it.
        if (this.cancelRequested || this.settled) return;
        return this.worker.beginTurn(prompt, this.appendSystemPrompt);
      })
      .catch((err: unknown) => {
        if (this.settled) return;
        const msg = err instanceof Error ? err.message : String(err);
        // Bootstrap / turn-start failure that didn't arrive via `fatal`
        // (handshake RPC error, session/new throw). `fatal` paths already
        // bumped the breaker via the worker's own listener.
        if (!this.fatalSeen) bumpFailureCount(this.workflowId, msg);
        this.fail(msg);
      });
  }

  kill(): void {
    if (this.settled) return;
    this.cancelRequested = true;
    // Async; the wrapper's `error` fires when `turn_settled` lands. During a
    // cold start no worker turn is active yet, so cancelCurrentTurn resolves
    // immediately — settle here; spawn()'s continuation sees cancelRequested
    // and never begins the turn (the warm child stays for the next one).
    void this.worker.cancelCurrentTurn().then(() => {
      if (!this.settled) this.fail('Worker killed');
    }, (err: unknown) => {
      if (this.settled) return;
      this.fail(`cancel failed: ${err instanceof Error ? err.message : String(err)}`);
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
      this._output += text;
      if (this.holdingAuthCandidate) {
        this.heldInitialText += text;
        if (isCursorAuthRequiredPrefix(this.heldInitialText)) return;
        this.holdingAuthCandidate = false;
        const held = this.heldInitialText;
        this.heldInitialText = '';
        this.emit('text', held);
        return;
      }
      this.emit('text', text);
    };
    const onThinking = (text: string) => {
      if (this.settled) return;
      this.emit('thinking', text);
    };
    const onToolUse = (data: ToolUseEvent) => {
      if (this.settled) return;
      this.emit('tool_use', data);
    };
    const onSystemNotice = (notice: string) => {
      if (this.settled) return;
      this.emit('system_notice', notice);
    };
    const onSettled = (data: { error?: string; result?: TurnSettleData }) => {
      if (this.settled) return;
      if (data.error) {
        this.fail(data.error);
        return;
      }
      const r = data.result;
      if (!r) {
        this.fail('turn settled with no result');
        return;
      }
      const finalText = this._output.length >= r.text.length ? this._output : r.text;
      this.settled = true;
      this._status = 'completed';
      this.unwire();
      resetFailureCount(this.workflowId);
      if (isCursorAuthRequiredText(finalText)) {
        this._output = '';
        this.heldInitialText = '';
        retireCursorWorker(this.workflowId, this.worker, 'authentication required');
        this.emit(
          'system_notice',
          '[AUTH:cursor] Cursor authentication expired in the active session. Re-login, then resend your message; Arco discarded the stale Cursor process and will start a fresh one.',
        );
        this.emit('result', {
          text: '',
          costUsd: r.costUsd,
          durationMs: r.durationMs,
          ...(r.usage ? { usage: r.usage } : {}),
          ...(typeof r.modelContextWindow === 'number' ? { modelContextWindow: r.modelContextWindow } : {}),
          thinkingBytes: 0,
          toolResultBytes: -1,
          toolResultBytesRaw: -1,
        });
        return;
      }
      if (this.holdingAuthCandidate && this.heldInitialText) {
        this.holdingAuthCandidate = false;
        const held = this.heldInitialText;
        this.heldInitialText = '';
        this.emit('text', held);
      }
      this.emit('result', {
        text: finalText,
        costUsd: r.costUsd,
        durationMs: r.durationMs,
        ...(r.usage ? { usage: r.usage } : {}),
        ...(typeof r.modelContextWindow === 'number' ? { modelContextWindow: r.modelContextWindow } : {}),
        // ACP exposes no per-turn tokens or inner tool bytes — sentinels
        // (-1 = unknown) match the CLI/Codex convention. The Usage tab (polled
        // from the dashboard API) is the authoritative token source for Cursor.
        thinkingBytes: 0,
        toolResultBytes: -1,
        toolResultBytesRaw: -1,
      });
    };
    const onFatal = (reason: string) => {
      if (this.settled) return;
      this.fatalSeen = true;
      this.fail(`cursor-agent acp died: ${reason}`);
    };

    this.worker.on('init', onInit);
    this.worker.on('text', onText);
    this.worker.on('thinking', onThinking);
    this.worker.on('tool_use', onToolUse);
    this.worker.on('system_notice', onSystemNotice);
    this.worker.on('turn_settled', onSettled);
    this.worker.on('fatal', onFatal);

    this.wired.push(
      { event: 'init', fn: onInit as (...args: unknown[]) => void },
      { event: 'text', fn: onText as (...args: unknown[]) => void },
      { event: 'thinking', fn: onThinking as (...args: unknown[]) => void },
      { event: 'tool_use', fn: onToolUse as (...args: unknown[]) => void },
      { event: 'system_notice', fn: onSystemNotice as (...args: unknown[]) => void },
      { event: 'turn_settled', fn: onSettled as (...args: unknown[]) => void },
      { event: 'fatal', fn: onFatal as (...args: unknown[]) => void },
    );

    void this.config;
  }

  private unwire(): void {
    for (const { event, fn } of this.wired) this.worker.off(event, fn);
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

function retireCursorWorker(workflowId: string, worker: CursorAcpWorker, reason: string): void {
  if (workersByWorkflow.get(workflowId) === worker) workersByWorkflow.delete(workflowId);
  resetFailureCount(workflowId);
  console.warn(`[cursor:${workflowId.slice(0, 8)}] stale worker retired (${reason})`);
  void worker.dispose().catch((err: unknown) => {
    console.warn(`[cursor:${workflowId.slice(0, 8)}] stale-worker dispose failed:`, err);
  });
}

// Lazily creates the long-lived worker on first turn; subsequent turns reuse it.
function acquireWorker(workflowId: string, config: WorkerConfig, resumeSessionId: string | undefined): CursorAcpWorker {
  const existing = workersByWorkflow.get(workflowId);
  if (existing) return existing;
  const fresh = new CursorAcpWorker(workflowId, config, resumeSessionId);
  workersByWorkflow.set(workflowId, fresh);
  fresh.on('fatal', (reason: string) => {
    // Drop the cache entry so the next turn re-spawns; don't dispose() (the
    // worker already tore itself down in onChildDeath).
    if (workersByWorkflow.get(workflowId) === fresh) workersByWorkflow.delete(workflowId);
    const count = bumpFailureCount(workflowId, reason);
    console.warn(`[cursor:${workflowId.slice(0, 8)}] worker dropped from cache (${reason}); consecutive failures=${count}`);
  });
  return fresh;
}

export function disposeCursorWorker(workflowId: string): void {
  resetFailureCount(workflowId);
  const worker = workersByWorkflow.get(workflowId);
  if (!worker) return;
  workersByWorkflow.delete(workflowId);
  void worker.dispose().catch((err: unknown) => {
    console.warn(`[cursor:${workflowId.slice(0, 8)}] dispose failed:`, err);
  });
}

export async function compactCursorAcpThread(
  workflowId: string,
  config: WorkerConfig,
  resumeSessionId: string | undefined,
): Promise<{ ok: boolean; error?: string }> {
  const cached = workersByWorkflow.get(workflowId);
  if (!cached && !resumeSessionId) {
    return { ok: false, error: 'no saved Cursor session for this workflow — run a turn first' };
  }
  const worker = cached ?? acquireWorker(workflowId, config, resumeSessionId);
  worker.updateConfig(config);
  try {
    await worker.ensureStarted();
    if (resumeSessionId && worker.currentSessionId !== resumeSessionId) {
      return { ok: false, error: 'Cursor could not load the saved ACP session; use Handoff to start fresh' };
    }
    return await worker.compressConversation();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Circuit-broken stub — returned in place of a real turn once consecutive spawn
// failures exceed the cap. Surfaces a system_notice and fails without spawning.
class CursorCircuitBrokenTurn extends EventEmitter implements ProviderProcess {
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

export const CursorProvider: Provider = {
  create(id, config) {
    const workflowId = config.workflowId;
    if (!workflowId) throw new Error('cursor transport requires WorkerConfig.workflowId');
    const failure = failureStateByWorkflow.get(workflowId);
    if (failure && failure.count >= MAX_CONSECUTIVE_SPAWN_FAILURES) {
      const notice = `[cursor] cursor-agent acp failed to spawn ${failure.count} times in a row — last error: ${failure.lastError}. Use Handoff to start fresh, or check that the Cursor CLI is healthy (\`cursor-agent login\`).`;
      return new CursorCircuitBrokenTurn(id, notice, `cursor acp circuit-broken: ${failure.lastError}`);
    }
    const worker = acquireWorker(workflowId, config, config.resumeSessionId);
    return new CursorAcpTurn(id, worker, config, config.appendSystemPrompt, workflowId);
  },
};
