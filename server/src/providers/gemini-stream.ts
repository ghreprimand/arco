import { EventEmitter } from 'events';
import { createInterface, Interface } from 'readline';
import type { Readable } from 'stream';

// Gemini CLI (0.38.x) stream-json event shapes observed:
//   {"type":"init","session_id":"<uuid>","model":"gemini-2.5-pro"}
//   {"type":"message","role":"user","content":"..."}               // echo; ignore
//   {"type":"message","role":"assistant","content":"...","delta":true}
//   {"type":"tool_use","tool_name":"...","tool_id":"...","parameters":{...}}
//   {"type":"tool_result","tool_id":"...","status":"success"}
//   {"type":"result","status":"success","stats":{total_tokens,input_tokens,
//       output_tokens,cached,input,duration_ms,tool_calls,models:{...}}}
//
// Assistant messages carry the cumulative content each emit, not per-token
// deltas — we treat them as monotonic snapshots and compute the tail against
// accumulated text, mirroring how ClaudeStreamParser handles its fallback
// `assistant` snapshots. Tolerant of non-JSON noise on stdout (Gemini prints
// a "YOLO mode is enabled" banner and retry chatter in some conditions).
export class GeminiStreamParser extends EventEmitter {
  private rl: Interface | null = null;
  private accumulatedText = '';
  private startTime = Date.now();

  parse(stream: Readable): void {
    this.rl = createInterface({ input: stream });

    this.rl.on('line', (line: string) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed[0] !== '{') return;
      try {
        const event = JSON.parse(trimmed);
        this.handleEvent(event);
      } catch {
        // Non-JSON noise, skip
      }
    });

    this.rl.on('close', () => {
      this.emit('done');
    });
  }

  private handleEvent(event: Record<string, unknown>): void {
    const type = event.type as string;

    switch (type) {
      case 'init':
        this.emit('init', {
          model: event.model as string | undefined,
          sessionId: event.session_id as string | undefined,
        });
        break;

      case 'message': {
        if (event.role !== 'assistant') return;
        const content = typeof event.content === 'string' ? event.content : '';
        if (!content) return;
        // Gemini in agent mode emits MULTIPLE discrete assistant messages
        // across a turn (one before each tool call, one final report). They
        // are NOT cumulative snapshots — assuming so caused earlier messages
        // to get replaced and lost when the next message didn't share a
        // prefix. Three cases now:
        //   1. delta:true → explicit token-stream chunk; append directly.
        //   2. content extends accumulatedText (snapshot mode) → emit tail.
        //   3. content is divergent → APPEND with separator (never drop).
        const isDelta = event.delta === true;
        if (isDelta) {
          this.accumulatedText += content;
          this.emit('text', content);
          return;
        }
        if (content === this.accumulatedText) return;
        if (content.length > this.accumulatedText.length && content.startsWith(this.accumulatedText)) {
          const delta = content.slice(this.accumulatedText.length);
          this.accumulatedText = content;
          this.emit('text', delta);
        } else {
          const separator = this.accumulatedText ? '\n\n' : '';
          this.accumulatedText += separator + content;
          this.emit('text', separator + content);
        }
        break;
      }

      case 'tool_use': {
        const toolName = (event.tool_name as string) || 'unknown';
        const params = event.parameters ?? {};
        this.emit('tool_use', {
          name: toolName,
          input: JSON.stringify(params),
        });
        break;
      }

      case 'result': {
        const stats = (event.stats as Record<string, unknown>) ?? {};
        const durationMs = (stats.duration_ms as number) ?? (Date.now() - this.startTime);
        // Gemini exposes tokens, not cost. Keep costUsd at 0 — UI is
        // token-first anyway.
        const usage: Record<string, number> = {
          input_tokens: (stats.input as number) ?? 0,
          output_tokens: (stats.output_tokens as number) ?? 0,
          cache_read_input_tokens: (stats.cached as number) ?? 0,
        };
        const status = event.status as string | undefined;
        if (status && status !== 'success') {
          const message = typeof event.message === 'string' ? event.message : `Gemini run ended with status: ${status}`;
          this.emit('error', message);
        }
        this.emit('result', {
          text: this.accumulatedText,
          costUsd: 0,
          durationMs,
          usage,
        });
        break;
      }

      // tool_result: ignored — Claude parser also doesn't surface these
      // directly; tool outcomes show up in subsequent assistant text.
    }
  }

  destroy(): void {
    this.rl?.close();
    this.removeAllListeners();
  }
}
