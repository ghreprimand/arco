import { EventEmitter } from 'events';
import type { ServerMessage, WorkerConfig, WorkerStatus } from '@archon/shared';
import type { Provider, ProviderProcess } from '../types.js';
import { ZaiNativeWorker, replayZaiNativeMessages } from './worker.js';

const workersByWorkflow = new Map<string, ZaiNativeWorker>();

let workflowEventBroadcast: ((workflowId: string, msg: ServerMessage) => void) | null = null;
export function setZaiNativeWorkflowEventBroadcast(fn: (workflowId: string, msg: ServerMessage) => void): void {
  workflowEventBroadcast = fn;
}

class ZaiNativeTurn extends EventEmitter implements ProviderProcess {
  private _status: WorkerStatus = 'spawning';
  private _output = '';
  private settled = false;
  private wired: Array<{ event: string; fn: (...args: unknown[]) => void }> = [];

  constructor(
    readonly id: string,
    private readonly worker: ZaiNativeWorker,
    private readonly config: WorkerConfig,
  ) {
    super();
  }

  get status(): WorkerStatus { return this._status; }
  get output(): string { return this._output; }
  get pid(): number | undefined { return undefined; }

  spawn(prompt: string): void {
    this.worker.updateConfig(this.config);
    this.wire();
    this.worker.runTurn(prompt).catch((err: unknown) => {
      if (this.settled) return;
      this.fail(err instanceof Error ? err.message : String(err));
    });
  }

  kill(): void {
    if (this.settled) return;
    this.worker.cancel();
  }

  private wire(): void {
    const onInit = (arg: unknown) => {
      if (this.settled) return;
      const data = (arg && typeof arg === 'object' ? arg : {}) as { model?: string; sessionId?: string };
      this._status = 'running';
      this.emit('init', data);
    };
    const onText = (arg: unknown) => {
      if (this.settled) return;
      const text = typeof arg === 'string' ? arg : String(arg ?? '');
      this._output += text;
      this.emit('text', text);
    };
    const onThinking = (arg: unknown) => { if (!this.settled) this.emit('thinking', typeof arg === 'string' ? arg : String(arg ?? '')); };
    const onToolUse = (data: unknown) => { if (!this.settled) this.emit('tool_use', data); };
    const onNotice = (arg: unknown) => { if (!this.settled) this.emit('system_notice', typeof arg === 'string' ? arg : String(arg ?? '')); };
    const onResult = (data: unknown) => {
      if (this.settled) return;
      this.settled = true;
      this._status = 'completed';
      this.unwire();
      this.emit('result', data);
    };
    const onError = (arg: unknown) => this.fail(typeof arg === 'string' ? arg : String(arg ?? ''));
    this.onWorker('init', onInit);
    this.onWorker('text', onText);
    this.onWorker('thinking', onThinking);
    this.onWorker('tool_use', onToolUse);
    this.onWorker('system_notice', onNotice);
    this.onWorker('result', onResult);
    this.onWorker('error', onError);
  }

  private onWorker(event: string, fn: (...args: unknown[]) => void): void {
    this.worker.on(event, fn);
    this.wired.push({ event, fn });
  }

  private unwire(): void {
    for (const { event, fn } of this.wired) this.worker.off(event, fn);
    this.wired = [];
  }

  private fail(error: string): void {
    if (this.settled) return;
    this.settled = true;
    this._status = 'failed';
    this.unwire();
    this.emit('error', error);
  }
}

export const ZaiNativeProvider: Provider = {
  create(id: string, config: WorkerConfig): ProviderProcess {
    const workflowId = config.workflowId;
    if (!workflowId) {
      const worker = new ZaiNativeWorker(config);
      return new ZaiNativeTurn(id, worker, config);
    }
    let worker = workersByWorkflow.get(workflowId);
    if (!worker) {
      worker = new ZaiNativeWorker(config);
      if (workflowEventBroadcast) {
        worker.setWorkflowEventBroadcast((msg) => workflowEventBroadcast?.(workflowId, msg));
      }
      workersByWorkflow.set(workflowId, worker);
    }
    return new ZaiNativeTurn(id, worker, config);
  },
};

function acquireZaiNativeWorker(workflowId: string, config: WorkerConfig): ZaiNativeWorker {
  let worker = workersByWorkflow.get(workflowId);
  if (!worker) {
    worker = new ZaiNativeWorker(config);
    if (workflowEventBroadcast) {
      worker.setWorkflowEventBroadcast((msg) => workflowEventBroadcast?.(workflowId, msg));
    }
    workersByWorkflow.set(workflowId, worker);
  }
  return worker;
}

export async function compactZaiNativeWorker(
  workflowId: string,
  config?: WorkerConfig,
): Promise<{ ok: boolean; error?: string; foldedTurns?: number }> {
  const worker = workersByWorkflow.get(workflowId) ?? (config ? acquireZaiNativeWorker(workflowId, config) : undefined);
  if (!worker) {
    return { ok: false, error: 'no active Z.ai Native worker for this workflow — run a turn first' };
  }
  if (config) worker.updateConfig(config);
  return worker.compactInPlace();
}

export function disposeZaiNativeWorker(workflowId: string): void {
  const worker = workersByWorkflow.get(workflowId);
  if (!worker) return;
  worker.dispose();
  workersByWorkflow.delete(workflowId);
}

export { replayZaiNativeMessages };
