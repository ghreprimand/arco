import { EventEmitter } from 'events';
import { createInterface, Interface } from 'readline';
import type { Readable } from 'stream';

export interface PermissionDenial {
  tool: string;
  input: string; // JSON-stringified args
}

export interface StreamEvents {
  init: (data: { model?: string; tools?: string[]; sessionId?: string }) => void;
  text: (text: string) => void;
  thinking: (text: string) => void;
  tool_use: (data: { name: string; input: string }) => void;
  result: (data: { text: string; costUsd: number; durationMs: number; usage?: Record<string, number>; permissionDenials?: PermissionDenial[] }) => void;
  error: (error: string) => void;
  // Transient API error captured from a top-level `{"type":"error",...}` line
  // in the stream. Distinct from `error` — the CLI is still running; the
  // caller decides whether to treat the turn as salvageable or retry.
  stream_error: (data: { errorType: string; message: string; transient: boolean }) => void;
  done: () => void;
}

// Error types Anthropic classifies as transient. Retry-eligible; everything
// else (invalid_request_error, authentication_error, permission_error,
// not_found_error) is a hard stop — retrying won't change the outcome.
const TRANSIENT_ERROR_TYPES = new Set([
  'overloaded_error',
  'rate_limit_error',
  'api_error',
  'timeout_error',
]);

// Best-effort detection for the Anthropic error envelope when it arrives in a
// text_delta rather than a top-level stream line. Only returns a result when
// the chunk begins with the envelope shape — substring matches inside normal
// prose would false-positive. Returns null for anything that doesn't parse
// as an object with `type: "error"`.
function tryParseErrorEnvelope(text: string):
  | { errorType: string; message: string; transient: boolean }
  | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('{"type":"error"')) return null;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (parsed.type !== 'error') return null;
    const inner = parsed.error as Record<string, unknown> | undefined;
    const errorType = typeof inner?.type === 'string' ? inner.type : 'unknown_error';
    const message = typeof inner?.message === 'string' ? inner.message : '';
    return { errorType, message, transient: TRANSIENT_ERROR_TYPES.has(errorType) };
  } catch {
    return null;
  }
}

// Claude CLI synthesizes its own error string for upstream auth failures
// instead of forwarding the raw `{"type":"error",...}` envelope — shape is
// `Failed to authenticate. API Error: 401 {<envelope JSON>}`. Without this
// detector it lands in assistant text and the client never sees the
// `[AUTH:claude]` sentinel that triggers the RE-LOGIN notice.
function tryParseCliAuthError(text: string):
  | { errorType: string; message: string; transient: boolean }
  | null {
  const trimmed = text.trimStart();
  if (!/^Failed to authenticate\.?\s+API Error:\s*401\b/i.test(trimmed)) return null;
  let message = 'Invalid authentication credentials';
  const jsonStart = trimmed.indexOf('{');
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(trimmed.slice(jsonStart)) as Record<string, unknown>;
      const inner = parsed.error as Record<string, unknown> | undefined;
      if (typeof inner?.message === 'string') message = inner.message;
    } catch { /* fall through with default message */ }
  }
  return { errorType: 'authentication_error', message, transient: false };
}

// In-flight tool-use block — the Anthropic streaming shape sends tool_use
// metadata in `content_block_start` (with empty `input: {}`) and then streams
// the actual input as a series of `input_json_delta` events terminated by
// `content_block_stop`. We buffer the partial JSON keyed by block index and
// emit a single `tool_use` event once the block closes with the assembled
// input. Without this, the UI shows `{}` for every tool call.
interface PendingToolUse {
  id: string;
  name: string;
  partialJson: string;
}

export class StreamParser extends EventEmitter {
  private rl: Interface | null = null;
  private accumulatedText = '';
  private startTime = Date.now();
  // Keyed by `content_block_start.index`. Cleared on `content_block_stop`.
  private pendingToolUses = new Map<number, PendingToolUse>();
  // Tool-use block ids we've already emitted. Assistant snapshots re-deliver
  // the same blocks periodically; without this set we'd double-count. Also
  // lets the snapshot path act as a fallback when stream_event deltas skip a
  // block entirely (observed with Opus on --include-partial-messages).
  private emittedToolUseIds = new Set<string>();
  // Set once we detect a CLI-formatted 401 from any of the three entry points
  // (text_delta, assistant snapshot, result). Prevents the same auth failure
  // from firing multiple system_notice banners on a single turn.
  private authErrorEmitted = false;

  constructor() {
    super();
  }

  parse(stream: Readable): void {
    this.rl = createInterface({ input: stream });

    this.rl.on('line', (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      try {
        const event = JSON.parse(trimmed);
        this.handleEvent(event);
      } catch {
        // Non-JSON line, skip
      }
    });

    this.rl.on('close', () => {
      this.emit('done');
    });
  }

  private handleEvent(event: Record<string, unknown>): void {
    const type = event.type as string;

    switch (type) {
      case 'system':
        this.handleSystem(event);
        break;

      case 'stream_event':
        this.handleStreamEvent(event);
        break;

      case 'assistant':
        // With --include-partial-messages, assistant events are periodic snapshots.
        // We use them as a fallback if stream_events didn't give us text.
        this.handleAssistantSnapshot(event);
        break;

      case 'result':
        this.handleResult(event);
        break;

      case 'error':
        this.handleStreamError(event);
        break;

      // rate_limit_event, etc. — ignored
    }
  }

  private handleStreamError(event: Record<string, unknown>): void {
    // Shape observed in the wild:
    //   {"type":"error","error":{"type":"overloaded_error","message":"Overloaded",...},"request_id":"..."}
    // The CLI may keep streaming after this; the turn might still complete.
    // We emit stream_error so the provider can decide (suppress from chat,
    // mark-transient-for-retry-on-exit), but do NOT emit `error` here — that
    // would fail the worker immediately and cancel an in-flight recovery.
    const inner = event.error as Record<string, unknown> | undefined;
    const errorType = typeof inner?.type === 'string' ? inner.type : 'unknown_error';
    const message = typeof inner?.message === 'string' ? inner.message : '';
    const transient = TRANSIENT_ERROR_TYPES.has(errorType);
    this.emit('stream_error', { errorType, message, transient });
  }

  private handleSystem(event: Record<string, unknown>): void {
    const subtype = event.subtype as string | undefined;
    if (subtype === 'init') {
      this.emit('init', {
        model: event.model,
        tools: event.tools,
        sessionId: event.session_id,
      });
    }
  }

  private handleStreamEvent(event: Record<string, unknown>): void {
    const inner = event.event as Record<string, unknown> | undefined;
    if (!inner) return;

    const eventType = inner.type as string;

    if (eventType === 'content_block_delta') {
      const delta = inner.delta as Record<string, unknown> | undefined;
      if (!delta) return;

      const deltaType = delta.type as string;

      if (deltaType === 'text_delta') {
        const text = delta.text as string;
        if (text) {
          // Guard against Claude CLI re-serializing a mid-stream API error
          // into assistant text. We observed `{"type":"error","error":{...}}`
          // land as a text delta under ARCO :: PASSTHROUGH instead of as a
          // top-level stream line. If a chunk clearly starts an error
          // envelope, reroute to stream_error and drop the text emit.
          const maybeError = tryParseErrorEnvelope(text);
          const maybeCliAuth = maybeError ? null : tryParseCliAuthError(this.accumulatedText + text);
          if (maybeError) {
            this.emit('stream_error', maybeError);
          } else if (maybeCliAuth) {
            // Suppress from chat — this is an error the CLI wrapped as assistant
            // text, not a real turn. Provider translates stream_error into
            // `[AUTH:claude]` system_notice.
            if (!this.authErrorEmitted) {
              this.authErrorEmitted = true;
              this.emit('stream_error', maybeCliAuth);
            }
          } else {
            this.accumulatedText += text;
            this.emit('text', text);
          }
        }
      } else if (deltaType === 'thinking_delta') {
        const thinking = delta.thinking as string;
        if (thinking) {
          this.emit('thinking', thinking);
        }
      } else if (deltaType === 'input_json_delta') {
        // Append tool-use input fragment to the pending block's buffer.
        const index = typeof inner.index === 'number' ? inner.index : -1;
        const pending = this.pendingToolUses.get(index);
        if (pending) {
          const fragment = delta.partial_json as string | undefined;
          if (typeof fragment === 'string') pending.partialJson += fragment;
        }
      }
    } else if (eventType === 'content_block_start') {
      const block = inner.content_block as Record<string, unknown> | undefined;
      if (block?.type === 'tool_use') {
        // Start buffering input deltas for this block. The initial
        // `block.input` is always `{}` in streaming mode — the real input
        // arrives via `input_json_delta` deltas below.
        const index = typeof inner.index === 'number' ? inner.index : -1;
        this.pendingToolUses.set(index, {
          id: (block.id as string) ?? '',
          name: block.name as string,
          partialJson: '',
        });
      }
    } else if (eventType === 'content_block_stop') {
      const index = typeof inner.index === 'number' ? inner.index : -1;
      const pending = this.pendingToolUses.get(index);
      if (pending) {
        this.pendingToolUses.delete(index);
        // Validate the accumulated JSON; fall back to empty object on parse
        // failure (shouldn't happen in practice — the CLI sends valid JSON).
        let input = pending.partialJson;
        if (!input) {
          input = '{}';
        } else {
          try {
            JSON.parse(input);
          } catch {
            input = JSON.stringify({ _raw: pending.partialJson.slice(0, 500) });
          }
        }
        if (pending.id) this.emittedToolUseIds.add(pending.id);
        this.emit('tool_use', { name: pending.name, input });
      }
    }
  }

  private handleAssistantSnapshot(event: Record<string, unknown>): void {
    // Fallback: if stream_events missed text, extract it from the snapshot
    const message = event.message as Record<string, unknown> | undefined;
    if (!message) return;

    const content = message.content as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(content)) return;

    for (const block of content) {
      if (block.type === 'text') {
        const fullText = block.text as string;
        if (fullText && fullText.length > this.accumulatedText.length) {
          const maybeCliAuth = tryParseCliAuthError(fullText);
          if (maybeCliAuth) {
            // Don't let the snapshot fallback smuggle a CLI-formatted auth
            // error into assistant text when the delta path already dropped it.
            if (!this.authErrorEmitted) {
              this.authErrorEmitted = true;
              this.emit('stream_error', maybeCliAuth);
            }
            continue;
          }
          const delta = fullText.slice(this.accumulatedText.length);
          this.accumulatedText = fullText;
          this.emit('text', delta);
        }
      } else if (block.type === 'tool_use') {
        // Snapshot fallback. If the stream_event path already emitted this
        // block (tracked by id), skip. Otherwise emit now — observed with
        // Opus where some tool_use blocks arrive only via snapshots.
        const id = block.id as string | undefined;
        if (!id || this.emittedToolUseIds.has(id)) continue;
        const name = block.name as string | undefined;
        if (!name) continue;
        const rawInput = block.input;
        let input: string;
        try {
          input = rawInput === undefined ? '{}' : JSON.stringify(rawInput);
        } catch {
          input = '{}';
        }
        this.emittedToolUseIds.add(id);
        this.emit('tool_use', { name, input });
      }
    }
  }

  private handleResult(event: Record<string, unknown>): void {
    const result = event.result as string | undefined;
    const costUsd = (event.total_cost_usd ?? event.cost_usd ?? 0) as number;
    const durationMs = (event.duration_ms ?? (Date.now() - this.startTime)) as number;
    const usage = event.usage as Record<string, number> | undefined;

    // Auth-error 401s from the CLI land here as a `result` string (often the
    // only place they appear — no top-level error line, no prior text_delta).
    // Route through stream_error and zero the text so the final `result` event
    // doesn't render the raw 401 as an assistant turn.
    const authFromResult = result ? tryParseCliAuthError(result) : null;
    const authFromAccum = !authFromResult ? tryParseCliAuthError(this.accumulatedText) : null;
    const authErr = authFromResult ?? authFromAccum;
    if (authErr) {
      if (!this.authErrorEmitted) {
        this.authErrorEmitted = true;
        this.emit('stream_error', authErr);
      }
      this.accumulatedText = '';
      this.emit('result', { text: '', costUsd, durationMs, usage });
      return;
    }

    // Catch any text that wasn't emitted via stream_events
    if (result && result.length > this.accumulatedText.length) {
      const delta = result.slice(this.accumulatedText.length);
      this.accumulatedText = result;
      this.emit('text', delta);
    }

    // The CLI auto-denies tool calls that would normally prompt when
    // running in -p mode without --dangerously-skip-permissions. Collect
    // them so the UI can surface what was blocked (true interactive
    // approval would require a pty / settings.json hook — out of scope).
    const rawDenials = Array.isArray(event.permission_denials) ? event.permission_denials : [];
    const permissionDenials: PermissionDenial[] = rawDenials.map((d: unknown) => {
      const rec = (d && typeof d === 'object') ? d as Record<string, unknown> : {};
      return {
        tool: typeof rec.tool_name === 'string' ? rec.tool_name : 'unknown',
        input: rec.tool_input !== undefined ? JSON.stringify(rec.tool_input) : '',
      };
    });

    this.emit('result', {
      text: this.accumulatedText || result || '',
      costUsd,
      durationMs,
      usage,
      ...(permissionDenials.length > 0 && { permissionDenials }),
    });
  }

  getAccumulatedText(): string {
    return this.accumulatedText;
  }

  destroy(): void {
    this.rl?.close();
    this.removeAllListeners();
  }
}
