import type { CodexLateCommand, PrimaryToolUseMessage } from '@arco/shared';
import type { ToolUseEvent } from './worker.js';

const DISPLAY_MS = 5 * 60_000;
const MAX_COMMANDS = 64;

interface Command {
  turnId: string;
  startedAt: number;
  event: ToolUseEvent;
  waitingUntil?: number;
  timer?: NodeJS.Timeout;
}

export class CodexLateCommands {
  private readonly commands = new Map<string, Command>();

  constructor(private readonly publish: (event: ToolUseEvent, state: NonNullable<PrimaryToolUseMessage['lateCommand']>) => void) {}

  start(turnId: string, event: ToolUseEvent): void {
    if (!event.itemId || this.commands.has(event.itemId)) return;
    if (this.commands.size >= MAX_COMMANDS) {
      const oldest = this.commands.keys().next().value;
      if (oldest) {
        const previous = this.commands.get(oldest)!;
        if (previous.waitingUntil) this.notify(previous, 'untracked');
        clearTimeout(previous.timer);
        this.commands.delete(oldest);
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
    return true;
  }

  settle(turnId: string): void {
    for (const command of this.commands.values()) {
      if (command.turnId !== turnId || command.waitingUntil) continue;
      command.waitingUntil = Date.now() + DISPLAY_MS;
      this.notify(command, 'running');
      command.timer = setTimeout(() => this.notify(command, 'untracked'), DISPLAY_MS);
      command.timer.unref();
    }
  }

  snapshot(): CodexLateCommand[] {
    const now = Date.now();
    return [...this.commands.values()].flatMap(({ event, startedAt, waitingUntil }) =>
      event.itemId && waitingUntil && waitingUntil > now
        ? [{ itemId: event.itemId, input: event.input, startedAt, waitingUntil }] : []);
  }

  disconnect(): void {
    for (const command of this.commands.values()) {
      clearTimeout(command.timer);
      this.notify(command, 'lost');
    }
    this.commands.clear();
  }

  private notify(command: Command, state: NonNullable<PrimaryToolUseMessage['lateCommand']>['state'], result?: ToolUseEvent): void {
    this.publish(result ?? command.event, {
      state, startedAt: command.startedAt, waitingUntil: command.waitingUntil ?? Date.now(),
    });
  }
}
