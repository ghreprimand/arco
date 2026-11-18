import type { CodexLateCommand, PrimaryToolUseMessage } from '@arco/shared';
import type { ToolUseEvent } from './worker.js';

const DISPLAY_MS = 5 * 60_000;
const MAX_COMMANDS = 64;

// A program meant to keep running (a server or a watcher) must never hold a
// turn open. Programs the shell put in the background (`&`, `nohup`) end the
// shell at once, so Codex completes their item inside the turn; only a known
// long-running program started in the foreground needs this pattern. Kept
// narrower than the preview detector's pattern: `vite build` or `deno run
// script.ts` end on their own and must still be waited on.
const LONG_RUNNING_RE = new RegExp([
  String.raw`\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|watch)\b`,
  String.raw`\b(?:vite|next|astro|nuxt|remix|gatsby|docusaurus)\s+(?:dev|develop|start|serve|preview)\b`,
  String.raw`\bvite\s*(?:$|['"]|--(?:host|port)\b)`,
  String.raw`\bpython3?\s+-m\s+http\.server\b`,
  String.raw`\buvicorn\b`, String.raw`\bflask\s+run\b`, String.raw`\brails\s+s(?:erver)?\b`, String.raw`\bphp\s+-S\b`,
  String.raw`(?:^|\s)--watch\b`, String.raw`\bwatch\s+-n\b`, String.raw`\btail\s+(?:-\w+\s+)*-\w*[fF]\b`,
  String.raw`\bsleep\s+infinity\b`,
  String.raw`\bdocker[\s-]compose\s+(?:\S+\s+)*up\b(?![^|;&]*\s(?:-d|--detach)\b)`,
].join('|'));

export function isLongRunningProgram(command: string): boolean {
  return LONG_RUNNING_RE.test(command);
}

export interface HeldCommandResult {
  itemId: string;
  command: string;
  cwd?: string;
  startedAt: number;
  endedAt: number;
  exitCode?: number;
  output?: string;
  failed: boolean;
}

interface Command {
  turnId: string;
  startedAt: number;
  event: ToolUseEvent;
  waitingUntil?: number;
  timer?: NodeJS.Timeout;
  // The agent waits on this command: its result is delivered to the agent
  // once, by the wrapper of the Arco turn that holds it.
  held?: boolean;
  // The Arco turn is open right now only because of this command.
  waiting?: boolean;
}

export function commandText(event: Pick<ToolUseEvent, 'input'>): { command: string; cwd?: string } {
  try {
    const parsed = JSON.parse(event.input) as { command?: unknown; cwd?: unknown };
    return {
      command: typeof parsed.command === 'string' ? parsed.command : 'a shell command',
      ...(typeof parsed.cwd === 'string' ? { cwd: parsed.cwd } : {}),
    };
  } catch { return { command: 'a shell command' }; }
}

export class CodexLateCommands {
  private readonly commands = new Map<string, Command>();
  // Ended held commands whose result has not yet been delivered to the agent.
  private readonly results: HeldCommandResult[] = [];

  constructor(
    private readonly publish: (event: ToolUseEvent, state: NonNullable<PrimaryToolUseMessage['lateCommand']>) => void,
    private readonly onHeldChange: () => void = () => {},
  ) {}

  start(turnId: string, event: ToolUseEvent): void {
    if (!event.itemId || this.commands.has(event.itemId)) return;
    if (this.commands.size >= MAX_COMMANDS) {
      const oldest = this.commands.keys().next().value;
      if (oldest) {
        const previous = this.commands.get(oldest)!;
        if (previous.waitingUntil) this.notify(previous, 'untracked');
        clearTimeout(previous.timer);
        this.commands.delete(oldest);
        if (previous.held) this.onHeldChange();
      }
    }
    this.commands.set(event.itemId, { turnId, event, startedAt: Date.now() });
  }

  /** True once the long-lived publisher owns this completion. */
  complete(turnId: string, event: ToolUseEvent): boolean {
    const id = event.itemId;
    const command = id ? this.commands.get(id) : undefined;
    if (!id || !command || command.turnId !== turnId) return false;
    this.commands.delete(id);
    clearTimeout(command.timer);
    if (!command.waitingUntil) return false;
    this.notify(command, 'finished', event);
    if (command.held) {
      this.results.push(this.result(command, event));
      this.onHeldChange();
    }
    return true;
  }

  /**
   * A command that ended inside its own turn after the agent's final answer
   * had started: the model never saw the result, so it is kept for delivery
   * once that turn has completed. The completion is still shown in the turn.
   * False when the command is unknown, belongs to another turn or has
   * already outlived its turn.
   */
  completeUnseen(turnId: string, event: ToolUseEvent): boolean {
    const id = event.itemId;
    const command = id ? this.commands.get(id) : undefined;
    if (!id || !command || command.turnId !== turnId || command.waitingUntil) return false;
    this.commands.delete(id);
    clearTimeout(command.timer);
    if (!isLongRunningProgram(commandText(command.event).command)) {
      this.results.push(this.result(command, event));
      this.onHeldChange();
    }
    return true;
  }

  settle(turnId: string): void {
    let held = false;
    for (const command of this.commands.values()) {
      if (command.turnId !== turnId || command.waitingUntil) continue;
      command.waitingUntil = Date.now() + DISPLAY_MS;
      command.held = !isLongRunningProgram(commandText(command.event).command);
      held ||= command.held;
      this.notify(command, 'running');
      command.timer = setTimeout(() => this.notify(command, 'untracked'), DISPLAY_MS);
      command.timer.unref();
    }
    if (held) this.onHeldChange();
  }

  /** Commands the agent still waits on, oldest first. */
  running(): Array<{ itemId: string; command: string; startedAt: number }> {
    return [...this.commands.values()].flatMap(command => command.held && command.event.itemId
      ? [{ itemId: command.event.itemId, command: commandText(command.event).command, startedAt: command.startedAt }] : []);
  }

  hasResults(): boolean { return this.results.length > 0; }

  hasFailedResult(): boolean { return this.results.some(result => result.failed); }

  /** Ended results; each is handed out exactly once. */
  takeResults(): HeldCommandResult[] { return this.results.splice(0); }

  /** Put back results whose delivery failed, ahead of any newer ones. */
  restoreResults(results: HeldCommandResult[]): void {
    if (results.length) this.results.unshift(...results);
  }

  /** The Arco turn now waits on the held commands, at most until `until`. */
  hold(until: number): void {
    for (const command of this.commands.values()) {
      if (!command.held || !command.waitingUntil) continue;
      command.waiting = true;
      if (command.waitingUntil < until) {
        command.waitingUntil = until;
        clearTimeout(command.timer);
        command.timer = setTimeout(() => this.notify(command, 'untracked'), Math.max(0, until - Date.now()));
        command.timer.unref();
      }
      this.notify(command, 'running');
    }
  }

  /** The turn no longer waits (it continued, ended or was stopped). */
  release(): void {
    for (const command of this.commands.values()) {
      if (!command.waiting) continue;
      command.waiting = false;
      this.notify(command, 'running');
    }
  }

  /**
   * Nobody waits on these commands any more (STOP, the wait limit, a failed
   * turn). They keep running and their rows still record how they end, but
   * no result reaches the agent.
   */
  abandon(): void {
    this.release();
    this.results.length = 0;
    for (const command of this.commands.values()) command.held = false;
  }

  snapshot(): CodexLateCommand[] {
    const now = Date.now();
    return [...this.commands.values()].flatMap(({ event, startedAt, waitingUntil, waiting }) =>
      event.itemId && waitingUntil && waitingUntil > now
        ? [{ itemId: event.itemId, input: event.input, startedAt, waitingUntil, ...(waiting ? { waiting } : {}) }] : []);
  }

  disconnect(): void {
    const held = this.results.length > 0 || [...this.commands.values()].some(command => command.held);
    for (const command of this.commands.values()) {
      clearTimeout(command.timer);
      this.notify(command, 'lost');
    }
    this.commands.clear();
    this.results.length = 0;
    if (held) this.onHeldChange();
  }

  private result(command: Command, event: ToolUseEvent): HeldCommandResult {
    const { command: text, cwd } = commandText(command.event);
    return {
      itemId: command.event.itemId!, command: text, ...(cwd ? { cwd } : {}),
      startedAt: command.startedAt, endedAt: Date.now(),
      ...(typeof event.exitCode === 'number' ? { exitCode: event.exitCode } : {}),
      ...(typeof event.output === 'string' ? { output: event.output } : {}),
      failed: event.status === 'failed' || (typeof event.exitCode === 'number' && event.exitCode !== 0),
    };
  }

  private notify(command: Command, state: NonNullable<PrimaryToolUseMessage['lateCommand']>['state'], result?: ToolUseEvent): void {
    this.publish(result ?? command.event, {
      state, startedAt: command.startedAt, waitingUntil: command.waitingUntil ?? Date.now(),
      ...(command.waiting && state === 'running' ? { waiting: true } : {}),
    });
  }
}
