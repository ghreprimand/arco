import type { VoiceOperatorTool } from '@arco/shared';

const READS = new Set<VoiceOperatorTool>(['arco_targets', 'arco_status', 'arco_screen', 'arco_read_text', 'arco_read_latest', 'arco_read_recent']);
export const COMPUTER_TIMEOUT = '[COMPUTER TIMEOUT]';
export const COMPUTER_DEADLINES = { startup: 90_000, idle: 60_000, total: 300_000 };

// CPU ticks, token accounting, and code-runner wait calls are not progress.
// This clock follows actual text generation and browser-tool round trips.
export class ComputerTurnWatchdog {
  private idleTimer?: ReturnType<typeof setTimeout>;
  private totalTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private mayHaveActed = false;
  constructor(private expire: (reason: string) => void, private deadlines = COMPUTER_DEADLINES) {
    this.arm(deadlines.startup);
    this.totalTimer = setTimeout(() => this.trip('time limit'), deadlines.total);
    this.totalTimer.unref?.();
  }
  progress(): void { this.arm(this.deadlines.idle); }
  tool(event: { tool: VoiceOperatorTool; phase: 'requested' | 'answered' }): void {
    if (event.phase === 'requested' && !READS.has(event.tool)) this.mayHaveActed = true;
    this.progress();
  }
  stop(): void { this.stopped = true; clearTimeout(this.idleTimer); clearTimeout(this.totalTimer); }
  private arm(ms: number): void {
    if (this.stopped) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.trip('no progress'), ms);
    this.idleTimer.unref?.();
  }
  private trip(reason: string): void {
    if (this.stopped) return;
    this.stop();
    this.expire(`${COMPUTER_TIMEOUT} Computer stopped responding (${reason}). Its connection was replaced. Nothing was retried automatically. ${this.mayHaveActed ? 'Some actions may already have happened; check before repeating the request.' : 'No action tools were dispatched; you can repeat the request.'}`);
  }
}
