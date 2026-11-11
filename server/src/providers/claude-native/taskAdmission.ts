// Admission belongs to the parent, not each child WorkerManager. A permit
// covers initialization through settlement; the turn budget counts starts.
export interface NativeTaskLimits { maxRunning: number; maxStarts: number }
export function assertNativeTaskAllowed(context: { interactionMode?: string; inCluster?: boolean; taskDisabled?: boolean }): void {
  if (context.interactionMode === 'chat' || context.inCluster || context.taskDisabled) {
    throw new Error('Task not available in Chat, cluster members or depth-capped children.');
  }
}
const aborted = () => new Error('AbortError: Task cancelled');
interface Waiter { enter(): void; cancel(): void }
export class NativeTaskAdmission {
  private turn?: AbortSignal;
  private limits: NativeTaskLimits = { maxRunning: 4, maxStarts: 8 };
  private reserved = 0;
  private active = 0;
  private queue: Waiter[] = [];

  async acquire(turn: AbortSignal, limits: NativeTaskLimits, request: AbortSignal = turn): Promise<{ started(): void; release(): void }> {
    if (turn.aborted || request.aborted) throw aborted();
    if (this.turn !== turn) {
      this.turn = turn;
      for (const queued of [...this.queue]) queued.cancel();
      this.limits = { ...limits };
      this.reserved = 0;
    }
    if (this.reserved >= this.limits.maxStarts) {
      throw new Error(`Task not started: this parent turn has reached its limit of ${this.limits.maxStarts} sub-agent starts. Continue without additional sub-agents; do not retry unless the operator asks.`);
    }
    this.reserved++;
    return await new Promise((resolve, reject) => {
      let finished = false;
      const cleanup = () => { turn.removeEventListener('abort', cancel); request.removeEventListener('abort', cancel); };
      const cancel = () => {
        if (finished) return;
        finished = true; cleanup();
        this.queue = this.queue.filter((q) => q !== waiter);
        if (this.turn === turn) this.reserved--;
        reject(aborted());
        this.drain();
      };
      const waiter: Waiter = { cancel, enter: () => {
        if (finished) return;
        if (turn.aborted || request.aborted || this.turn !== turn) { cancel(); return; }
        finished = true; cleanup(); this.active++;
        let started = false; let released = false;
        resolve({ started: () => { started = true; }, release: () => {
          if (released) return;
          released = true; this.active--;
          if (!started && this.turn === turn) this.reserved--;
          this.drain();
        } });
      } };
      turn.addEventListener('abort', cancel, { once: true });
      if (request !== turn) request.addEventListener('abort', cancel, { once: true });
      this.queue.push(waiter);
      this.drain();
    });
  }
  private drain(): void {
    while (this.queue.length && this.active < this.limits.maxRunning) this.queue.shift()!.enter();
  }
}
