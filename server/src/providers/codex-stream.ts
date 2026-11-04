import { EventEmitter } from 'events';
import type { Readable } from 'stream';
import { outputHash } from './outputSignature.js';

// Parses Codex's `codex exec --json` JSONL stream into the same event shape
// the other providers emit (init / text / tool_use / result / error / done).
//
// Observed event types from a 2026-04-16 probe (codex-cli 0.121.0):
//   { type: "thread.started", thread_id: "<uuid>" }
//   { type: "turn.started" }
//   { type: "item.completed", item: { id, type: "agent_message", text } }
//   { type: "item.completed", item: { id, type: "function_call"|"shell_call"|..., ... } }
//   { type: "turn.completed", usage: { input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens?, total_tokens? } }
//
// TUI rollouts also emit richer envelopes that we accept defensively in case
// they ever appear in --json mode (or the operator pipes a TUI rollout
// through the same parser):
//   { type: "event_msg", payload: { type: "token_count",
//       info: { total_token_usage, last_token_usage, model_context_window } } }
//
// The agent_message item carries the FULL turn text — Codex doesn't seem to
// stream deltas in --json mode (each item is an atomic completion). So we
// emit one big text event per agent_message rather than chunked deltas.
// Worker-card UI still updates fine; just less granular than Claude.

interface CodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

interface CodexEvent {
  type?: string;
  thread_id?: string;
  item?: {
    id?: string;
    type?: string;
    text?: string;
    name?: string;
    arguments?: unknown;
    command?: unknown;
    status?: string;
    output?: unknown;
    result?: unknown;
    exit_code?: unknown;
    exitCode?: unknown;
    [key: string]: unknown;
  };
  usage?: CodexUsage;
  // Codex TUI's `event_msg::token_count` envelope — includes
  // model_context_window, which is the only honest source of the operational
  // window (the catalog's published 400K for GPT-5.5 is a 272K-input-+-128K-
  // output split, not a unified usable window). When this lands, prefer it
  // over the client's hardcoded codexModelWindow() fallback.
  payload?: {
    type?: string;
    info?: {
      total_token_usage?: CodexUsage;
      last_token_usage?: CodexUsage;
      model_context_window?: number;
    };
  };
  message?: string;
  error?: { message?: string } | string;
}

export class CodexStreamParser extends EventEmitter {
  private buffer = '';
  private threadId: string | null = null;
  private accumulatedText = '';
  private resultUsage: Record<string, number> | undefined;
  private startedAt = Date.now();
  // Sticks once the stream reports it (via turn.completed metadata or an
  // event_msg::token_count payload). Forwarded onto the result event so the
  // server can broadcast it via primary_complete.modelContextWindow and the
  // client can use it as the actual CTX-bar denominator.
  private observedContextWindow: number | undefined;

  parse(stream: Readable): void {
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => this.consume(chunk));
    stream.on('end', () => {
      // Flush any trailing partial line.
      if (this.buffer.trim()) {
        this.handleLine(this.buffer.trim());
        this.buffer = '';
      }
      this.emit('done');
    });
  }

  destroy(): void {
    this.removeAllListeners();
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this.handleLine(trimmed);
    }
  }

  private handleLine(line: string): void {
    let evt: CodexEvent;
    try {
      evt = JSON.parse(line);
    } catch {
      // Codex prints occasional non-JSON status lines ("Reading prompt from
      // stdin...", "Shell cwd was reset...") — ignore them.
      return;
    }

    switch (evt.type) {
      case 'thread.started': {
        if (typeof evt.thread_id === 'string') {
          this.threadId = evt.thread_id;
        }
        this.emit('init', { sessionId: this.threadId ?? undefined });
        return;
      }
      case 'turn.started': {
        return;
      }
      case 'item.started':
      case 'item.in_progress': {
        const item = evt.item ?? {};
        const itemType = item.type ?? '';
        if (isToolLike(itemType)) {
          this.emitToolUse(item, itemType, evt.type === 'item.started' ? 'started' : 'in_progress');
        }
        return;
      }
      case 'item.completed': {
        const item = evt.item ?? {};
        const itemType = item.type ?? '';
        if (itemType === 'agent_message' && typeof item.text === 'string') {
          this.accumulatedText += item.text;
          this.emit('text', item.text);
          return;
        }
        // Tool-flavoured items — anything that looks like a function/shell
        // call. Surface as tool_use so the worker card shows activity.
        // Codex 0.121.0 emits `command_execution` for bash calls in --json
        // mode; older / internal envelopes use `function_call` / `shell_call`
        // / `tool_use` / `custom_tool_call`. Matching by substring keeps
        // forward-compat when Codex adds new `*_call` or `*_execution` flavours.
        if (isToolLike(itemType)) {
          this.emitToolUse(item, itemType, 'completed');
          return;
        }
        if (itemType === 'reasoning' && typeof item.text === 'string') {
          this.emit('thinking', item.text);
          return;
        }
        return;
      }
      case 'turn.completed': {
        const u = evt.usage ?? {};
        const usage: Record<string, number> = {};
        if (typeof u.input_tokens === 'number') usage.input_tokens = u.input_tokens;
        if (typeof u.output_tokens === 'number') usage.output_tokens = u.output_tokens;
        if (typeof u.cached_input_tokens === 'number') usage.cache_read_input_tokens = u.cached_input_tokens;
        if (typeof u.reasoning_output_tokens === 'number') usage.reasoning_output_tokens = u.reasoning_output_tokens;
        if (typeof u.total_tokens === 'number') usage.total_tokens = u.total_tokens;
        this.resultUsage = usage;
        this.emit('result', {
          text: this.accumulatedText,
          costUsd: 0,
          durationMs: Date.now() - this.startedAt,
          usage,
          modelContextWindow: this.observedContextWindow,
        });
        return;
      }
      case 'event_msg': {
        // Codex TUI envelope. The exec --json path doesn't typically emit this,
        // but we accept it defensively — and it's the only place we've seen
        // model_context_window reported in the wild. When present, capture it
        // for the next result emission. Also pulls richer last_token_usage
        // fields if turn.completed.usage was sparse.
        const payload = evt.payload;
        if (payload?.type === 'token_count') {
          const info = payload.info ?? {};
          if (typeof info.model_context_window === 'number') {
            this.observedContextWindow = info.model_context_window;
          }
          // If this fires before turn.completed (some Codex versions interleave
          // them), stash usage so the result event picks it up. The ?? cascade
          // prefers last_token_usage (per-turn) over total_token_usage
          // (cumulative across the rollout) for ctx-bar purposes.
          const tu = info.last_token_usage ?? info.total_token_usage;
          if (tu) {
            const usage: Record<string, number> = { ...(this.resultUsage ?? {}) };
            if (typeof tu.input_tokens === 'number') usage.input_tokens = tu.input_tokens;
            if (typeof tu.output_tokens === 'number') usage.output_tokens = tu.output_tokens;
            if (typeof tu.cached_input_tokens === 'number') usage.cache_read_input_tokens = tu.cached_input_tokens;
            if (typeof tu.reasoning_output_tokens === 'number') usage.reasoning_output_tokens = tu.reasoning_output_tokens;
            if (typeof tu.total_tokens === 'number') usage.total_tokens = tu.total_tokens;
            this.resultUsage = usage;
          }
        }
        return;
      }
      case 'error':
      case 'turn.failed':
      case 'thread.failed': {
        const message = (typeof evt.error === 'string' ? evt.error : evt.error?.message)
          ?? evt.message
          ?? `Codex ${evt.type}`;
        this.emit('error', message);
        return;
      }
      default: {
        // Unknown event type — ignore gracefully for forward-compat.
        return;
      }
    }
  }

  getThreadId(): string | null {
    return this.threadId;
  }

  getAccumulatedText(): string {
    return this.accumulatedText;
  }

  getUsage(): Record<string, number> | undefined {
    return this.resultUsage;
  }

  private emitToolUse(
    item: NonNullable<CodexEvent['item']>,
    itemType: string,
    status: 'started' | 'in_progress' | 'completed' | 'failed',
  ): void {
    // Prefer a human-readable name for the activity pill. For
    // command_execution we show "Bash" (matches Claude's verb map so the
    // ACTIVITY tab reads consistently); for everything else use the item's own
    // name / type.
    let name: string;
    if (itemType === 'command_execution') name = 'Bash';
    else if (typeof item.name === 'string' && item.name) name = item.name;
    else name = itemType;

    let input = '';
    if (item.command !== undefined) input = stringifyToolInput(item.command);
    else if (item.arguments !== undefined) input = stringifyToolInput(item.arguments);
    else input = stringifyToolInput({ ...item, type: undefined, id: undefined });

    const exitCode = typeof item.exit_code === 'number'
      ? item.exit_code
      : typeof item.exitCode === 'number'
        ? item.exitCode
        : undefined;
    const output = item.output !== undefined
      ? stringify(item.output)
      : item.result !== undefined
        ? stringify(item.result)
        : undefined;

    this.emit('tool_use', {
      name,
      input,
      status: exitCode && exitCode !== 0 ? 'failed' : status,
      provider: 'codex',
      itemType,
      itemId: typeof item.id === 'string' ? item.id : undefined,
      ...(output ? { output } : {}),
      ...(typeof exitCode === 'number' ? { exitCode } : {}),
      // Watchdog instrumentation — see server/src/providers/outputSignature.ts.
      ...(output ? { outputHash: outputHash(output) } : {}),
    });
  }
}

function isToolLike(itemType: string): boolean {
  return (
    itemType === 'command_execution' ||
    itemType === 'function_call' ||
    itemType === 'shell_call' ||
    itemType === 'tool_use' ||
    itemType === 'custom_tool_call' ||
    itemType.includes('call') ||
    itemType.includes('execution')
  );
}

function stringifyToolInput(v: unknown): string {
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) return v;
    return JSON.stringify({ command: v });
  }
  return stringify(v);
}

function stringify(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
