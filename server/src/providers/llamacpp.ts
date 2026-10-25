import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { readFileSync, statSync } from 'fs';
import { extname } from 'path';
import { MAX_WORKER_OUTPUT_BYTES, OUTPUT_TRUNCATION_NOTICE } from '../workers/limits.js';
import { markAvailable } from '../quota.js';
import {
  executeOllamaTool,
  getOllamaToolDefinitions,
  isKnownOllamaTool,
  ToolLoopDetector,
  type OllamaToolDefinition,
} from './ollamaTools.js';
import { ThinkSplitter, parseRenderedTranscript } from './ollama.js';
import { llamacppManager, type LlamacppLoadedState } from './llamacppManager.js';
import { goalBlock } from './goalBlock.js';
import { awaitModelImages, modelImagePath } from './attachments.js';
import { readCatalog, findModel, defaultModel } from '../llamacppCatalog.js';
import {
  defaultRecoveryConfig,
  deterministicSummary,
  toolCapContinuationMessage,
  finalSummaryDemandMessage,
  reasoningInterruptionPair,
  shouldAutoCompact,
  reasoningBudgetExceeded,
  type RecoveryConfig,
} from './llamacppRecovery.js';
import type { WorkerConfig, WorkerStatus, LlamacppModelDef } from '@archon/shared';
import type { Provider, ProviderProcess } from './types.js';

// llama.cpp via llama-server's OpenAI-compatible HTTP endpoint. Different
// wire format from Ollama (SSE chunks, OpenAI message shape, fragmented
// tool_calls) but same conceptual loop:
//   1. ensureLoaded(alias) via the lifecycle manager (spawns/switches as
//      needed; subsequent calls within KEEP_ALIVE skip the 20-30s warmup)
//   2. POST /v1/chat/completions stream=true
//   3. Parse SSE events; reassemble fragmented tool_calls; route reasoning
//      via ThinkSplitter (qwen-style <think>...</think>)
//   4. If finish_reason === 'tool_calls', dispatch via ollamaTools (same
//      local runtime as the Ollama path) and append role:'tool' messages,
//      loop. Cap at MAX_TOOL_TURNS.
//
// Vision: OpenAI multimodal shape — user message content becomes an array
// of {type:"text"} + {type:"image_url", image_url:{url:"data:..."}} blocks.
// Image-capable iff the operator's model def has mmprojPath and
// capabilities.vision; otherwise any attached image is dropped with a
// system_notice (mirrors Ollama's silent-ignore-but-warn pattern).

// Stub throttle parser for symmetry with the subprocess providers. llama.cpp
// is local; there is no remote quota to throttle against.
export function parseLlamacppThrottle(_text: string): { resetsAt?: number } | null {
  return null;
}

// Tool-loop cap for llama.cpp. Local thinking models need more rope than
// Claude/Codex on multi-step coding work (exact-string-match retries on
// Edit, narrate-then-act loops, etc.) but unbounded loops are a real
// hazard — each turn re-feeds the full context to llama-server, which
// hammers the GPU and grows the message stack. 25 is the sweet spot:
// enough for genuinely complex multi-file work, low enough that a stuck
// loop costs ~25 × stall_timeout instead of unbounded time. Combined with
// the auto-continue recovery (which resets the counter once with a recap)
// the worst-case bound is ~50 turns of bounded work. Tune via
// ARCHON_LLAMACPP_MAX_TOOL_TURNS.
const MAX_TOOL_TURNS = (() => {
  const env = process.env.ARCHON_LLAMACPP_MAX_TOOL_TURNS;
  if (env) {
    const n = parseInt(env, 10);
    if (Number.isFinite(n) && n > 0 && n <= 200) return n;
  }
  return 25;
})();

// Tool-result truncation thresholds. Local thinking models accumulate
// tool history across the operator turn (and a deterministic summary
// across turns); large `Read` blobs and verbose `Bash` output crowd the
// context window faster than anything else. Truncating at the boundary
// where the model would normally start losing track keeps the message
// stack lean enough to actually converge.
//
// Read: head + tail of the file; if it's small, the model gets it all.
// Bash/Grep/etc: head + tail of stdout; same pattern.
// Tune via env if a workflow legitimately needs full results (e.g. the
// model is doing log analysis).
const TOOL_RESULT_HEAD_BYTES = (() => {
  const env = process.env.ARCHON_LLAMACPP_TOOL_HEAD_BYTES;
  if (env) { const n = parseInt(env, 10); if (Number.isFinite(n) && n >= 0) return n; }
  return 4096;
})();
const TOOL_RESULT_TAIL_BYTES = (() => {
  const env = process.env.ARCHON_LLAMACPP_TOOL_TAIL_BYTES;
  if (env) { const n = parseInt(env, 10); if (Number.isFinite(n) && n >= 0) return n; }
  return 2048;
})();

// Coerce string-shaped values into the typed primitives the tool runtime
// expects (offset/limit are ints, etc.). Shared by both XML extractors.
function coerceToolArgValue(rawVal: string): unknown {
  if (/^-?\d+$/.test(rawVal)) return parseInt(rawVal, 10);
  if (/^-?\d+\.\d+$/.test(rawVal)) return parseFloat(rawVal);
  if (rawVal === 'true' || rawVal === 'false') return rawVal === 'true';
  return rawVal;
}

// XML tool call extractor for both Qwen-native and GLM-native formats.
// Local thinking models with --jinja occasionally drop out of OpenAI
// tool_call format and emit native XML inside reasoning_content during
// long thinking passes (or when the chat template parser regresses, e.g.
// llama.cpp #19009 affecting GLM-4.5/4.7). When this happens the OpenAI
// tool_calls array stays empty, finish_reason is "stop", and from the
// operator's view the worker emits an empty turn.
//
// Two formats handled:
//
//   Qwen3.x:
//     <tool_call>
//     <function=Read>
//     <parameter=file_path>/some/path</parameter>
//     <parameter=offset>130</parameter>
//     </function>
//     </tool_call>
//
//   GLM-4.5/4.7:
//     <tool_call>Read<arg_key>file_path</arg_key><arg_value>/some/path</arg_value><arg_key>offset</arg_key><arg_value>130</arg_value></tool_call>
//
// Distinguished by inner shape: Qwen has `<function=` after the opener,
// GLM has bare function name as the first text node followed by alternating
// arg_key/arg_value tags. Both share the `<tool_call>...</tool_call>` outer
// markers so detection is the same.
function extractXmlToolCalls(text: string): ToolCall[] {
  if (!text || text.indexOf('<tool_call>') === -1) return [];
  const calls: ToolCall[] = [];
  const blockRe = /<tool_call>([\s\S]*?)<\/tool_call>/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(text)) !== null) {
    const block = m[1];

    // Qwen-style: <function=NAME>...<parameter=KEY>VALUE</parameter>...</function>
    const qwenFn = /<function=([^>]+)>([\s\S]*?)<\/function>/.exec(block);
    if (qwenFn) {
      const name = qwenFn[1].trim();
      const args: Record<string, unknown> = {};
      const paramRe = /<parameter=([^>]+)>([\s\S]*?)<\/parameter>/g;
      let p: RegExpExecArray | null;
      while ((p = paramRe.exec(qwenFn[2])) !== null) {
        args[p[1].trim()] = coerceToolArgValue(p[2].trim());
      }
      calls.push({
        id: randomUUID(),
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      });
      continue;
    }

    // GLM-style: bare function name first, then alternating <arg_key>K</arg_key><arg_value>V</arg_value>
    const glmHeadRe = /^\s*([A-Za-z_][\w.\-]*)\s*(<arg_key>[\s\S]*)/;
    const head = glmHeadRe.exec(block);
    if (head) {
      const name = head[1].trim();
      const args: Record<string, unknown> = {};
      const pairRe = /<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/g;
      let p: RegExpExecArray | null;
      while ((p = pairRe.exec(head[2])) !== null) {
        args[p[1].trim()] = coerceToolArgValue(p[2].trim());
      }
      calls.push({
        id: randomUUID(),
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      });
      continue;
    }
  }
  return calls;
}

function truncateToolResult(name: string, raw: string): string {
  const total = TOOL_RESULT_HEAD_BYTES + TOOL_RESULT_TAIL_BYTES;
  if (raw.length <= total + 200) return raw; // small enough; +200 avoids truncating to save almost nothing
  // Read tool: line-aware truncation reads better in chat than byte-aware.
  if (name === 'Read') {
    const lines = raw.split('\n');
    if (lines.length <= 250) return raw;
    const head = lines.slice(0, 100).join('\n');
    const tail = lines.slice(-100).join('\n');
    const elided = lines.length - 200;
    return `${head}\n\n[... ${elided} lines elided by Arco to keep llama.cpp context lean — re-read with explicit line range if needed ...]\n\n${tail}`;
  }
  // Generic byte-aware truncation for Bash, Grep, WebFetch, etc.
  const head = raw.slice(0, TOOL_RESULT_HEAD_BYTES);
  const tail = raw.slice(-TOOL_RESULT_TAIL_BYTES);
  const elided = raw.length - head.length - tail.length;
  return `${head}\n\n[... ${elided} bytes of tool output elided by Arco to keep llama.cpp context lean ...]\n\n${tail}`;
}

// Coalescing window for `emit('thinking', ...)` calls. Reasoning deltas
// arrive token-by-token from llama-server; without coalescing each token
// becomes a synchronous JSON.stringify + ws.send + events.jsonl write at
// the WorkerManager → server → persistAndStampSeq layer. Under runaway
// (30+ tokens/s with multi-hundred-byte deltas), this saturates the Node
// event loop, blows the WS send buffer, and locks up the browser.
//
// 100ms gives a smooth thinking stream in the UI (~10 updates/sec, which
// already feels live) while reducing the per-token cost by ~10x. Tune via
// ARCHON_LLAMACPP_THINKING_FLUSH_MS; set to 0 to disable.
const THINKING_FLUSH_MS = (() => {
  const env = process.env.ARCHON_LLAMACPP_THINKING_FLUSH_MS;
  if (env) {
    const n = parseInt(env, 10);
    if (Number.isFinite(n) && n >= 0 && n <= 5000) return n;
  }
  return 100;
})();
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const IMAGE_EXT: Record<string, true> = {
  '.png': true,
  '.jpg': true,
  '.jpeg': true,
  '.gif': true,
  '.webp': true,
};

function classifyAttachment(p: string): 'image' | 'other' {
  return IMAGE_EXT[extname(p).toLowerCase()] ? 'image' : 'other';
}

function mediaTypeFor(p: string): string {
  const ext = extname(p).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  return 'application/octet-stream';
}

// OpenAI chat-completion message shape. Content is either a string (the
// common case) or an array of typed parts (multimodal). System / assistant
// / tool messages are always strings; user messages are arrays when images
// are attached.
type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[];
  // OpenAI-compat: tool_calls live on assistant messages; tool messages
  // carry tool_call_id pointing back at the call they answer.
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string }; // OpenAI sends arguments as a JSON string
}

interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream: true;
  tools?: Array<{ type: 'function'; function: OllamaToolDefinition['function'] }>;
  // include_usage on the streaming spec means the final delta carries usage.
  stream_options?: { include_usage: boolean };
}

class LlamacppWorkerProcess extends EventEmitter implements ProviderProcess {
  readonly id: string;
  readonly config: WorkerConfig;
  private abortController: AbortController | null = null;
  private _status: WorkerStatus = 'spawning';
  private _output = '';
  private outputCapped = false;
  // Stashed at the start of each streamOneTurn so kill() can fire the
  // slot-erase POST against the right server. llama-server has a known
  // upstream bug (ggml-org/llama.cpp#9273 et al) where simply closing the
  // HTTP connection doesn't immediately stop generation — the slot stays
  // wedged until the next sink write. The /slots/<id>?action=erase
  // endpoint forces it free, freeing VRAM and unblocking subsequent turns.
  private currentBaseUrl: string | null = null;
  private currentSlotId = 0;
  // Thinking coalescer state. See THINKING_FLUSH_MS for rationale.
  private thinkingBuf = '';
  private thinkingFlushTimer: NodeJS.Timeout | null = null;

  constructor(id: string, config: WorkerConfig) {
    super();
    this.id = id;
    this.config = config;
  }

  // Coalesce reasoning-content deltas into ≤10 events/sec. Caller can
  // pass `flush:true` to bypass the timer (used at stream end / interrupt
  // so trailing reasoning isn't dropped).
  private emitThinking(chunk: string, flush = false): void {
    if (chunk) this.thinkingBuf += chunk;
    if (THINKING_FLUSH_MS === 0 || flush) {
      if (this.thinkingFlushTimer) {
        clearTimeout(this.thinkingFlushTimer);
        this.thinkingFlushTimer = null;
      }
      if (this.thinkingBuf.length > 0) {
        const out = this.thinkingBuf;
        this.thinkingBuf = '';
        this.emit('thinking', out);
      }
      return;
    }
    if (this.thinkingFlushTimer) return;
    this.thinkingFlushTimer = setTimeout(() => {
      this.thinkingFlushTimer = null;
      if (this.thinkingBuf.length === 0) return;
      const out = this.thinkingBuf;
      this.thinkingBuf = '';
      this.emit('thinking', out);
    }, THINKING_FLUSH_MS);
  }

  get status(): WorkerStatus { return this._status; }
  get output(): string { return this._output; }

  spawn(prompt: string): void {
    this.abortController = new AbortController();
    void this.run(prompt);
  }

  // Build OpenAI-shaped messages. Same byte-stability rules as the Ollama
  // path: system + prior turns must be unchanged across calls so the
  // server's prefix cache hits. Only the final user message grows.
  //
  // Effort handling mirrors Ollama (effort 'low' → /no_think prefix on the
  // system message). llama-server with --jinja respects the same Qwen-family
  // convention.
  private buildMessages(userPrompt: string, modelDef: LlamacppModelDef): ChatMessage[] {
    const messages: ChatMessage[] = [];
    const noThink = this.config.effort === 'low';
    // GOAL_NORTHSTAR_PLAN.md G2 — fold the operator's north-star at the top of the
    // system message. Covers operator turns AND primitive seeds. Blank ⇒ unchanged.
    const northStarBlock = goalBlock(this.config.goal);
    const baseSystem = northStarBlock
      ? (this.config.systemPrompt ? `${northStarBlock}\n\n${this.config.systemPrompt}` : northStarBlock)
      : (this.config.systemPrompt ?? '');
    const systemContent = noThink
      ? (baseSystem ? `/no_think\n${baseSystem}` : '/no_think')
      : baseSystem;
    if (systemContent) messages.push({ role: 'system', content: systemContent });

    if (this.config.appendSystemPrompt) {
      // Reuse Ollama's transcript parser — the rendered "USER: ...\nAGENT: ..."
      // format is provider-agnostic.
      for (const m of parseRenderedTranscript(this.config.appendSystemPrompt)) {
        messages.push({ role: m.role as 'user' | 'assistant', content: m.content });
      }
    }

    const visionCapable = modelDef.capabilities?.vision === true && !!modelDef.mmprojPath;
    const imageParts: ContentPart[] = [];
    const nonImagePaths: string[] = [];
    const skippedImagePaths: string[] = [];
    for (const p of this.config.attachments ?? []) {
      if (classifyAttachment(p) !== 'image') { nonImagePaths.push(p); continue; }
      if (!visionCapable) { skippedImagePaths.push(p); continue; }
      try {
        // Downscaled sibling when present; data-URI type follows its ext.
        const src = modelImagePath(p);
        const size = statSync(src).size;
        if (size > IMAGE_MAX_BYTES) {
          this.emit('system_notice', `attachment "${p}" exceeds ${Math.round(IMAGE_MAX_BYTES / 1024 / 1024)}MB image limit — skipped`);
          continue;
        }
        const b64 = readFileSync(src).toString('base64');
        imageParts.push({ type: 'image_url', image_url: { url: `data:${mediaTypeFor(src)};base64,${b64}` } });
      } catch (err) {
        this.emit('system_notice', `attachment "${p}" unreadable: ${err instanceof Error ? err.message : String(err)} — skipped`);
      }
    }
    if (skippedImagePaths.length > 0) {
      this.emit('system_notice', `model "${modelDef.alias}" has no mmproj configured — ${skippedImagePaths.length} image attachment(s) ignored`);
    }

    let text = userPrompt;
    if (nonImagePaths.length > 0) {
      text += '\n\n' + nonImagePaths.map((p) => `[attached file: ${p}]`).join('\n');
    }

    if (imageParts.length > 0) {
      messages.push({ role: 'user', content: [{ type: 'text', text }, ...imageParts] });
    } else {
      messages.push({ role: 'user', content: text });
    }
    return messages;
  }

  private emitText(chunk: string): void {
    if (!chunk || this.outputCapped) return;
    const remaining = MAX_WORKER_OUTPUT_BYTES - this._output.length;
    if (chunk.length <= remaining) {
      this._output += chunk;
      this.emit('text', chunk);
    } else {
      const fit = remaining > 0 ? chunk.slice(0, remaining) : '';
      if (fit) {
        this._output += fit;
        this.emit('text', fit);
      }
      this._output += OUTPUT_TRUNCATION_NOTICE;
      this.emit('text', OUTPUT_TRUNCATION_NOTICE);
      this.outputCapped = true;
      this.kill();
    }
  }

  // Reason a streaming call ended early. `null` = normal completion (model
  // emitted finish_reason). The other values let the run loop decide how
  // to recover instead of treating the call as a hard failure.
  private async streamOneTurn(
    baseUrl: string,
    modelName: string,
    messages: ChatMessage[],
    tools: OllamaToolDefinition[] | undefined,
    recovery: RecoveryConfig,
  ): Promise<{
    assistantMessage: ChatMessage;
    finishReason: string | null;
    usage: { inputTokens: number; outputTokens: number };
    // Set when the stream was aborted by recovery logic. Caller decides what
    // to inject in response. `null` for normal completions.
    interruption: 'reasoning_runaway' | 'stall' | 'wall_clock' | null;
    // Reasoning chars accumulated during this call. Used by the run loop to
    // surface to the operator and to track whether we crossed the budget.
    reasoningChars: number;
  } | null> {
    // Stash for kill() — slot-erase needs the same baseUrl as the in-flight
    // request. Cleared in finally below so a subsequent kill after the call
    // returns naturally won't re-erase a different model's slot.
    this.currentBaseUrl = baseUrl;
    const turnStart = Date.now();
    const body: ChatCompletionRequest = {
      model: modelName,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      ...(tools && tools.length > 0 ? {
        tools: tools.map((t) => ({ type: 'function' as const, function: t.function })),
      } : {}),
    };

    let res: Response;
    try {
      res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: this.abortController!.signal,
      });
    } catch (err) {
      this.currentBaseUrl = null;
      if (this.isAborted(err)) return null;
      this.fail(`llama-server request failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      this.fail(`llama-server HTTP ${res.status}: ${detail.slice(0, 200)}`);
      return null;
    }

    const splitter = new ThinkSplitter();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let finishReason: string | null = null;
    let rawContent = '';
    let reasoningChars = 0;
    // Bounded buffer of reasoning text. Used at end-of-stream to scan for
    // Qwen-native XML tool_call markup that may have leaked into thinking
    // instead of being emitted as proper OpenAI tool_calls. Capped at 200KB
    // so a runaway reasoning pass can't blow memory; tool calls always
    // appear at the end of the thinking block, so the tail is what matters.
    let reasoningTail = '';
    const REASONING_BUFFER_CAP = 200_000;
    let interruption: 'reasoning_runaway' | 'stall' | 'wall_clock' | null = null;
    // Tool calls fragment across SSE events. Index → assembled call.
    // Declared up here (instead of after the SSE loop) because the runaway
    // detector inside the loop reads `partialToolCalls.size` to decide
    // whether the model has emitted ANY tool call yet — declaring later
    // would be a TDZ reference error.
    const partialToolCalls = new Map<number, { id: string; name: string; argFragments: string[] }>();
    // Approximate tokens from chars at 4 chars/token for English. Used to
    // compare against the reasoning budget without per-event token counts
    // (llama-server's stream_options.include_usage only fires on the final
    // event, not deltas).
    const charsToTokens = (chars: number): number => Math.ceil(chars / 4);

    // Recovery-bounded stream read. Wraps reader.read() in a stall timeout
    // and a per-iteration runaway check. Aborts the upstream call cleanly
    // when either trips so the run loop can recover.
    const readWithGuards = async (): Promise<{ value?: Uint8Array; done: boolean }> => {
      if (!recovery.enabled) return reader.read();
      let stallTimer: NodeJS.Timeout | null = null;
      try {
        return await Promise.race([
          reader.read(),
          new Promise<{ value?: undefined; done: true }>((resolve) => {
            stallTimer = setTimeout(() => {
              interruption = 'stall';
              // Cancel the underlying body reader so the next read() resolves
              // with done:true; resolve our race so the outer loop exits.
              reader.cancel().catch(() => { /* already gone */ });
              resolve({ done: true });
            }, recovery.stallTimeoutMs);
          }),
        ]);
      } finally {
        if (stallTimer) clearTimeout(stallTimer);
      }
    };

    try {
      let streamEnded = false;
      while (!streamEnded) {
        // Per-event abort check. Cancel propagation from this.kill() needs
        // to land BEFORE the next read() so we don't process one more giant
        // chunk after the operator hit cancel. Without this, a runaway
        // turn ignores cancel for as long as it takes to drain the current
        // SSE chunk through JSON.parse + emit + ws.send.
        if (this.abortController?.signal.aborted) {
          reader.cancel().catch(() => { /* already gone */ });
          break;
        }
        // Wall-clock cap: hard ceiling regardless of what's being emitted.
        // Catches the "tool_calls + reasoning + content pumping endlessly"
        // mode that the runaway detector misses (model looks productive by
        // every per-signal metric but isn't converging).
        if (recovery.enabled && Date.now() - turnStart > recovery.turnBudgetMs) {
          interruption = 'wall_clock';
          reader.cancel().catch(() => { /* already gone */ });
          break;
        }
        // Reasoning runaway check: pumping reasoning tokens past the budget
        // is a strong stuck-signal even if some content/tool_calls have
        // been emitted (the model often emits a token of content then dives
        // back into thousands of reasoning tokens). The wall-clock cap is
        // the broader safety net; this fires faster on the specific
        // reasoning-heavy failure mode so the operator gets a sharper
        // diagnostic.
        if (
          recovery.enabled
          && reasoningBudgetExceeded(charsToTokens(reasoningChars), recovery.reasoningBudgetTokens)
        ) {
          interruption = 'reasoning_runaway';
          reader.cancel().catch(() => { /* already gone */ });
          break;
        }

        const { value, done } = await readWithGuards();
        if (interruption === 'stall') break;
        if (done) {
          streamEnded = true;
          if (buf.trim().length === 0) break;
          buf += '\n';
        } else {
          buf += decoder.decode(value, { stream: true });
        }
        // SSE framing: events separated by blank lines; each event is one
        // or more `data: ...` lines. llama-server only ever emits a single
        // data line per event, so a per-line scan suffices.
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === '[DONE]') continue;
          let evt: {
            choices?: Array<{
              delta?: { content?: unknown; reasoning_content?: unknown; tool_calls?: unknown };
              finish_reason?: string | null;
            }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          };
          try {
            evt = JSON.parse(payload);
          } catch { continue; }

          const choice = evt.choices?.[0];
          // Native reasoning split. llama-server's `--reasoning-format auto`
          // (the default in recent builds) extracts a thinking model's
          // reasoning into `delta.reasoning_content`, leaving `delta.content`
          // for the final answer. Without this branch, Qwen3.6 (and any
          // other thinking-aware model) emits everything to reasoning_content
          // and our `content`-only reader sees an empty stream — nothing
          // shows in the chat OR the Activity tab. Pass straight through to
          // the thinking event channel; ThinkSplitter still handles the
          // legacy `<think>...</think>`-in-content format below as a fallback.
          if (choice?.delta?.reasoning_content !== undefined && typeof choice.delta.reasoning_content === 'string' && choice.delta.reasoning_content.length > 0) {
            reasoningChars += choice.delta.reasoning_content.length;
            reasoningTail += choice.delta.reasoning_content;
            if (reasoningTail.length > REASONING_BUFFER_CAP) {
              reasoningTail = reasoningTail.slice(-REASONING_BUFFER_CAP);
            }
            this.emitThinking(choice.delta.reasoning_content);
          }
          if (choice?.delta?.content !== undefined && typeof choice.delta.content === 'string' && choice.delta.content.length > 0) {
            // Only the splitter's `text` output goes into rawContent (which
            // becomes the assistant message preserved across turns). Raw
            // delta.content includes `<think>...</think>` markers when the
            // model uses the legacy reasoning format; preserving those in
            // history feeds the model's own internal monologue back to it
            // on the next turn, which on Qwen3.6 triggers exactly the
            // verbose-narration loops we're trying to bound. Reasoning_content
            // (the modern format) is already handled separately above and
            // never enters rawContent.
            const { thinking, text } = splitter.push(choice.delta.content);
            if (thinking) this.emitThinking(thinking);
            if (text) {
              rawContent += text;
              this.emitText(text);
            }
          }
          if (Array.isArray(choice?.delta?.tool_calls)) {
            for (const tc of choice.delta.tool_calls) {
              const item = tc as { index?: number; id?: string; function?: { name?: string; arguments?: string } };
              const idx = typeof item.index === 'number' ? item.index : 0;
              let entry = partialToolCalls.get(idx);
              if (!entry) {
                entry = { id: item.id ?? randomUUID(), name: item.function?.name ?? '', argFragments: [] };
                partialToolCalls.set(idx, entry);
              }
              if (item.id && !entry.id) entry.id = item.id;
              if (item.function?.name) entry.name = item.function.name;
              if (typeof item.function?.arguments === 'string') {
                entry.argFragments.push(item.function.arguments);
              }
            }
          }
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          if (evt.usage) {
            if (typeof evt.usage.prompt_tokens === 'number') inputTokens = evt.usage.prompt_tokens;
            if (typeof evt.usage.completion_tokens === 'number') outputTokens = evt.usage.completion_tokens;
          }
        }
      }
    } catch (err) {
      this.currentBaseUrl = null;
      this.emitThinking('', true); // flush any buffered reasoning before bailing
      if (this.isAborted(err)) return null;
      this.fail(`llama-server stream interrupted: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }

    const drained = splitter.flush();
    if (drained.thinking) this.emitThinking(drained.thinking);
    if (drained.text) {
      rawContent += drained.text;
      this.emitText(drained.text);
    }
    // Force-flush any coalesced reasoning before the run loop processes
    // the assistant message. Otherwise the trailing reasoning token would
    // sit in the buffer until the next turn or get dropped if the worker
    // completes immediately.
    this.emitThinking('', true);
    this.currentBaseUrl = null;

    const assembled: ToolCall[] = [];
    for (const [, entry] of [...partialToolCalls.entries()].sort(([a], [b]) => a - b)) {
      assembled.push({
        id: entry.id,
        type: 'function',
        function: { name: entry.name, arguments: entry.argFragments.join('') },
      });
    }

    // Qwen-XML fallback: if the model didn't use OpenAI tool format but
    // emitted Qwen-native <tool_call>...</tool_call> markup in reasoning
    // (or content), extract and dispatch those instead. Without this the
    // turn looks empty to the operator even though the model did intend
    // to take an action — see the 2026-05-06 incident where Qwen3.6 put
    // a Read call inside its <think> block and the worker silently
    // completed with no output.
    if (assembled.length === 0 && finishReason !== 'tool_calls') {
      const haystack = `${reasoningTail}\n${rawContent}`;
      const xmlCalls = extractXmlToolCalls(haystack);
      if (xmlCalls.length > 0) {
        assembled.push(...xmlCalls);
        finishReason = 'tool_calls';
        this.emit('system_notice', `extracted ${xmlCalls.length} XML tool call(s) from reasoning — model emitted native format instead of OpenAI tool_calls`);
      }
    }

    const assistantMessage: ChatMessage = { role: 'assistant', content: rawContent };
    if (assembled.length > 0) assistantMessage.tool_calls = assembled;

    return {
      assistantMessage,
      finishReason,
      usage: { inputTokens, outputTokens },
      interruption,
      reasoningChars,
    };
  }

  // Same dispatch contract as the Ollama path: AUTO mode executes, SAFE
  // mode refuses with a string the model treats as the tool result so the
  // loop converges without operator-approval ping-pong.
  //
  // Loop detection: per-turn ToolLoopDetector intercepts identical
  // (name, args) calls past the threshold and returns a coaching message
  // instead of dispatching. Threshold defaults to coaching on the 3rd
  // attempt — tuned for local thinking models that get stuck in
  // read-and-narrate cycles.
  private async dispatchToolCalls(
    calls: ToolCall[],
    autoMode: boolean,
    loopDetector: ToolLoopDetector,
  ): Promise<ChatMessage[]> {
    const cwd = this.config.cwd;
    const out: ChatMessage[] = [];
    for (const call of calls) {
      // Cancel mid-batch: Write/Edit ignore the abort signal, so without this
      // a batch cancelled during an earlier Bash still mutates files after
      // "Worker killed". The caller re-checks the signal and bails.
      if (this.abortController?.signal.aborted) break;
      const name = call.function.name;
      let args: Record<string, unknown> = {};
      let argError: string | undefined;
      if (call.function.arguments) {
        try {
          const parsed = JSON.parse(call.function.arguments);
          if (parsed && typeof parsed === 'object') {
            args = parsed as Record<string, unknown>;
          } else {
            argError = `arguments JSON parsed to a non-object (${typeof parsed})`;
          }
        } catch (e) {
          const preview = call.function.arguments.slice(0, 80);
          argError = `arguments not JSON-parseable (${(e as Error).message}); received: ${JSON.stringify(preview)}`;
        }
      }

      this.emit('tool_use', {
        name,
        input: JSON.stringify(args),
        toolUseId: call.id,
      });

      let result: string;
      if (argError) {
        result = `[error] tool "${name}" arguments rejected: ${argError}`;
      } else if (!autoMode) {
        result =
          `[Archon SAFE mode] tool "${name}" was not executed. ` +
          'The local provider runs tools server-side only when AUTO mode is enabled on this workflow. ' +
          'Tell the operator what you were going to do, or answer from what they have shown you.';
      } else if (!cwd) {
        result = `[error] tool "${name}" requires a workflow cwd; this spawn has none.`;
      } else if (!isKnownOllamaTool(name)) {
        result = `[error] unknown tool "${name}". The local-tool runtime is on a strict allowlist; see docs/PROVIDERS.md.`;
      } else {
        // Coach before executing: if this exact (name, args) has been
        // dispatched past the threshold, return a coaching message instead
        // of running the tool again. The model gets told exactly why and
        // what to do next on its following turn.
        const { coach, terminate, previousCount } = loopDetector.shouldCoach(name, args);
        if (terminate) {
          // Coaching has been ignored MAX_COACHED_REPEATS times for this
          // exact (name, args) key. Stop coaching and signal the run loop
          // to abort the turn — the post-dispatch check in run() will see
          // loopDetector.terminationRequested() and route to the
          // final-summary path. Emit the termination string as the tool
          // result so the model sees a concrete reason if a subsequent
          // streamOneTurn call somehow happens before the abort fires.
          result = loopDetector.terminationMessage(name, previousCount + 1);
          this.emit('system_notice', `tool-loop terminating: "${name}" called ${previousCount + 1}x with identical args after coaching ignored — ending turn`);
        } else if (coach) {
          result = loopDetector.coachingMessage(name, previousCount + 1);
          this.emit('system_notice', `tool-loop coach: "${name}" called ${previousCount + 1}x with identical args — injected coaching message instead of re-executing`);
        } else {
          result = await executeOllamaTool(name, args, {
            cwd,
            abortSignal: this.abortController?.signal,
            workflowId: this.config.workflowId,
            clusterId: this.config.clusterId,
          });
        }
      }
      // Truncate large tool results before they enter the message stack.
      // Keeps llama.cpp's context lean across the multi-turn loop without
      // hiding anything from the operator (the truncated marker tells the
      // model what to do if it needs more, and events.jsonl always has the
      // full output for replay/audit).
      const stored = truncateToolResult(name, result);
      out.push({ role: 'tool', content: stored, tool_call_id: call.id });
    }
    return out;
  }

  private async run(prompt: string): Promise<void> {
    const startedAt = Date.now();

    // Resolve the operator's chosen alias against the catalog. An empty
    // string falls back to the first entry — matches Ollama's "pick
    // anything reasonable" default behavior.
    const catalog = await readCatalog();
    const requested = this.config.model?.trim();
    const def: LlamacppModelDef | undefined = requested
      ? findModel(catalog, requested)
      : defaultModel(catalog);
    if (!def) {
      const reason = requested
        ? `model "${requested}" not in ~/.archon/llamacpp.json`
        : 'no models configured in ~/.archon/llamacpp.json';
      this.fail(reason);
      return;
    }

    this._status = 'running';
    markAvailable('llamacpp');
    this.emit('init', { model: def.alias });

    // Block until the lifecycle manager has the right model loaded. This
    // is where the 20-30s warmup happens on the first turn after a switch.
    let loaded: LlamacppLoadedState;
    try {
      loaded = await llamacppManager.ensureLoaded(def.alias);
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
      return;
    }
    if (this.abortController?.signal.aborted) return;

    // Hold the model for the whole turn so the manager's idle evictor can't
    // SIGTERM llama-server under a tool loop that outlasts the keepalive.
    const release = llamacppManager.acquire();
    try {
      await this.runLoaded(prompt, def, loaded, startedAt);
    } finally {
      release();
    }
  }

  private async runLoaded(
    prompt: string,
    def: LlamacppModelDef,
    loaded: LlamacppLoadedState,
    startedAt: number,
  ): Promise<void> {

    const baseUrl = `http://${loaded.host}:${loaded.port}`;
    // Bounded wait for the upload-time downscaled copies; buildMessages reads
    // them synchronously via modelImagePath.
    await awaitModelImages(this.config.attachments);
    const messages = this.buildMessages(prompt, def);

    let tools: OllamaToolDefinition[] | undefined;
    if (this.config.cwd && this.config.interactionMode !== 'chat' && def.capabilities?.tools !== false) {
      const all = getOllamaToolDefinitions({ clusterEnabled: !!this.config.clusterId && !!this.config.workflowId });
      tools = this.config.tools
        ? all.filter((t) => this.config.tools!.includes(t.function.name))
        : all;
    }
    const autoMode = this.config.skipPermissions === true;

    // Tracking two separate token totals because they answer different
    // questions and llama.cpp's OpenAI usage shape doesn't let us derive
    // one from the other.
    //
    // - lastInputTokens: prompt_tokens of the FINAL iteration. This is the
    //   true context-window fill at the end of the operator turn — what the
    //   CTX bar should display so "111k / 98k" never lies. Earlier
    //   iterations' prompts were smaller and don't matter for the cap.
    //
    // - totalOutputTokens: summed output across iterations. This is real
    //   per-turn generation cost — every output token went over the wire.
    //
    // (We don't sum input across iterations: llama-server returns the FULL
    // prompt count per call, not Ollama's post-cache delta. Summing gives
    // a number 3-5x larger than any actual context window — exactly the
    // bug the operator hit when "111k CTX" appeared on a 98k-cap model.)
    let lastInputTokens = 0;
    let totalOutputTokens = 0;

    // One detector per operator turn. Reset implicitly because `run()` is
    // called fresh per turn; the next operator message gets a clean slate.
    const loopDetector = new ToolLoopDetector();

    // Auto-recovery state. Counts every recovery action (reasoning
    // intervention, tool-cap continuation, stall retry, empty completion)
    // against the same budget so a workflow that's hitting multiple failure
    // modes still terminates instead of looping forever. See
    // RecoveryConfig.maxAutoRecoveries for the cap rationale.
    const recovery = defaultRecoveryConfig();
    let recoveriesUsed = 0;
    // Final-summary mode: when recoveries are exhausted at any failure point,
    // we grant ONE more turn with strong "no tools, produce handoff" wording
    // before terminating. Operator gets a clean artifact instead of a dead
    // worker mid-thrash. Toggles to true once the demand message is injected;
    // any subsequent exhaustion fails for real (the model ignored the
    // directive or the next turn also blew up).
    let finalSummaryAttempted = false;
    let toolTurn = 0;

    // Try to inject a final-summary demand instead of failing. Returns true
    // if injected (caller should `continue`), false if already attempted
    // (caller should fail for real). Resetting toolTurn here means the
    // model gets a full MAX_TOOL_TURNS budget for its summary turn, not
    // whatever was left.
    const tryFinalSummary = async (reason: string): Promise<boolean> => {
      if (finalSummaryAttempted) return false;
      finalSummaryAttempted = true;
      this.emit('system_notice', `auto-recovery exhausted (${reason}) — demanding one final summary turn before terminating`);
      await this.eraseLlamaSlot(baseUrl);
      const recap = deterministicSummary(messages);
      messages.push({
        role: 'user',
        content: finalSummaryDemandMessage(reason, recap),
      });
      toolTurn = 0;
      return true;
    };
    while (toolTurn < MAX_TOOL_TURNS) {
      if (this.abortController?.signal.aborted) return;

      const turnResult = await this.streamOneTurn(baseUrl, def.alias, messages, tools, recovery);
      if (turnResult === null) return;

      // Don't update lastInputTokens on interrupted streams — the usage
      // event only fires on normal completion, so an interrupted call
      // leaves the field at 0 and would falsely "reset" the CTX bar.
      if (!turnResult.interruption) {
        lastInputTokens = turnResult.usage.inputTokens;
        totalOutputTokens += turnResult.usage.outputTokens;
      }

      // ---- Recovery path: reasoning runaway --------------------------------
      if (turnResult.interruption === 'reasoning_runaway') {
        if (recoveriesUsed >= recovery.maxAutoRecoveries) {
          if (await tryFinalSummary('reasoning runaway')) continue;
          this.fail(`reasoning runaway after exhausting ${recovery.maxAutoRecoveries} auto-recoveries (model ${def.alias})`);
          return;
        }
        recoveriesUsed++;
        const tokens = Math.ceil(turnResult.reasoningChars / 4);
        this.emit('system_notice', `auto-recovery: reasoning runaway (~${tokens} reasoning tokens past budget) — injecting commit-now coaching (recovery ${recoveriesUsed}/${recovery.maxAutoRecoveries})`);
        await this.eraseLlamaSlot(baseUrl);
        const pair = reasoningInterruptionPair(tokens);
        // Append the partial assistant message we got (preserves whatever
        // text/tool_calls did arrive, even if nothing usually does in this
        // case), then a fake assistant + user pair that ends the runaway
        // and gives the model an explicit instruction.
        messages.push(turnResult.assistantMessage);
        messages.push({ role: 'assistant', content: pair.assistant });
        messages.push({ role: 'user', content: pair.user });
        continue; // retry without incrementing toolTurn (this isn't a tool round)
      }

      // ---- Recovery path: stream stall ------------------------------------
      if (turnResult.interruption === 'stall') {
        if (recoveriesUsed >= recovery.maxAutoRecoveries) {
          if (await tryFinalSummary('stream stall')) continue;
          this.fail(`stream stalled after exhausting ${recovery.maxAutoRecoveries} auto-recoveries (model ${def.alias})`);
          return;
        }
        recoveriesUsed++;
        this.emit('system_notice', `auto-recovery: stream stalled (no SSE event in ${recovery.stallTimeoutMs}ms) — re-prompting with deterministic recap (recovery ${recoveriesUsed}/${recovery.maxAutoRecoveries})`);
        await this.eraseLlamaSlot(baseUrl); // free the wedged slot before retrying
        const recap = deterministicSummary(messages);
        messages.push({
          role: 'user',
          content: `[Archon stall recovery] The previous generation hung. Here is a recap of the work done so far so you don't have to re-derive it:\n\n${recap}\n\nResume from this state. Make ONE concrete next action.`,
        });
        continue;
      }

      // ---- Recovery path: wall-clock cap ----------------------------------
      // Hard ceiling tripped — model was emitting (anything: tool_calls,
      // content, reasoning) but ran past the per-turn budget without
      // committing to an answer. Treated like a stall but with a sharper
      // operator-facing message.
      if (turnResult.interruption === 'wall_clock') {
        if (recoveriesUsed >= recovery.maxAutoRecoveries) {
          if (await tryFinalSummary('wall-clock budget exceeded')) continue;
          this.fail(`turn exceeded ${recovery.turnBudgetMs}ms wall-clock budget after exhausting ${recovery.maxAutoRecoveries} auto-recoveries (model ${def.alias})`);
          return;
        }
        recoveriesUsed++;
        this.emit('system_notice', `auto-recovery: turn exceeded ${recovery.turnBudgetMs}ms budget — re-prompting with deterministic recap (recovery ${recoveriesUsed}/${recovery.maxAutoRecoveries})`);
        await this.eraseLlamaSlot(baseUrl);
        const recap = deterministicSummary(messages);
        messages.push({
          role: 'user',
          content: `[Archon wall-clock recovery] The previous generation ran past its time budget without producing a final answer. Here is a recap of the work done so far:\n\n${recap}\n\nResume from this state. Make ONE concrete next action — either call a single tool, or write the final answer for the operator. Do not enter a long planning phase.`,
        });
        continue;
      }

      // Normal turn — append assistant message, evaluate tool calls.
      messages.push(turnResult.assistantMessage);

      const toolCalls = turnResult.assistantMessage.tool_calls;
      const expectsTools = turnResult.finishReason === 'tool_calls' || (toolCalls && toolCalls.length > 0);

      if (!expectsTools) {
        if (this._output.length === 0 && totalOutputTokens === 0) {
          this.fail(`llama-server returned no output (model ${def.alias})`);
          return;
        }

        // ---- Recovery path: empty completion --------------------------------
        // Model finished the turn (finish_reason=stop) but emitted only
        // reasoning — no user-facing content, no tool_calls. The usage event
        // counts reasoning toward output_tokens so totalOutputTokens > 0,
        // but the operator sees nothing in chat. Without recovery the worker
        // emits an empty `result` and the workflow appears "stopped working."
        //
        // Trigger requires toolTurn > 0: if the FIRST turn in this run is
        // also empty, that's a different problem (model misconfigured /
        // refused / system prompt issue) and the user-message is unlikely
        // to be salvageable by coaching. Coaching only when the model has
        // already taken concrete action this turn.
        if (
          recovery.enabled
          && this._output.length === 0
          && toolTurn > 0
          && recoveriesUsed < recovery.maxAutoRecoveries
        ) {
          recoveriesUsed++;
          const reasoningTokens = Math.ceil(turnResult.reasoningChars / 4);
          this.emit('system_notice', `auto-recovery: empty completion (${reasoningTokens} reasoning tokens, no user text) after ${toolTurn} tool calls — coaching to commit (recovery ${recoveriesUsed}/${recovery.maxAutoRecoveries})`);
          await this.eraseLlamaSlot(baseUrl);
          messages.push({
            role: 'user',
            content: (
              `[Archon empty-completion recovery] You ended the previous response with reasoning only — no user-facing text and no tool call. ` +
              `That looks like nothing happened from the operator's view. ` +
              `Choose ONE of these now: ` +
              `(a) write a brief summary for the operator describing what you found, what you changed, and what's next; or ` +
              `(b) call one more tool to make a concrete next step. ` +
              `Do not enter a long planning phase. Be terse.`
            ),
          });
          continue;
        }

        // ---- Context-fill warning (was: auto-compaction) -----------------
        // The old in-place compaction was dead weight: it replaced this
        // per-turn process's local `messages` (the next turn rebuilds the
        // full transcript via buildMessages() and overflows again), streamed
        // the summary through emitText so it was appended to the persisted
        // answer, and paid an extra generation on every over-threshold turn.
        // Making it stick would need a persisted compaction boundary in the
        // transcript — the job Handoff already does, operator-initiated (Fold is
        // Native-only). So warn at clean turn boundaries and point there.
        if (
          recovery.enabled
          && shouldAutoCompact(lastInputTokens, def.ctxSize, recovery.contextFillThreshold)
        ) {
          const fillPct = Math.round((lastInputTokens / (def.ctxSize ?? 1)) * 100);
          this.emit('system_notice', `context ${fillPct}% full (${lastInputTokens}/${def.ctxSize}) — the next turn may overflow; Handoff to continue in a fresh context`);
        }

        this._status = 'completed';
        this.emit('result', {
          text: this._output,
          costUsd: 0,
          durationMs: Date.now() - startedAt,
          usage: {
            input_tokens: lastInputTokens,
            output_tokens: totalOutputTokens,
          },
          ...(typeof def.ctxSize === 'number' && def.ctxSize > 0
            ? { modelContextWindow: def.ctxSize }
            : {}),
        });
        return;
      }

      const toolResults = await this.dispatchToolCalls(toolCalls!, autoMode, loopDetector);
      if (this.abortController?.signal.aborted) return;
      messages.push(...toolResults);
      toolTurn++;

      // Phase 5 — mid-turn steer hook. Drain anything the operator typed
      // while the tool calls were dispatching and append as user messages
      // so the next /v1/chat/completions call sees them. Server side
      // already broadcasts queue_update + queued_messages_drained; we just
      // inject the text. Attachments fold to `[attached file: <path>]`
      // text references (mid-turn image re-encoding into the OpenAI
      // multimodal shape is out of scope for v1).
      //
      // Placed BEFORE the recovery checks (tool-loop terminate, tool-cap
      // auto-continue) so a steer that arrives just as the loop is about
      // to terminate-recover gets a chance to redirect — operators who
      // see the model thrashing should be able to step in. Recovery paths
      // that fire below either `return` (give-up) or `continue` (after
      // injecting their own synthetic user message), neither of which
      // re-enters the drain hook within the same iteration, so a flushed
      // queue item cannot double-deliver. Recovery paths above (reasoning
      // runaway / stall / wall_clock / empty_completion) `continue` from
      // their own arms before reaching this point — by design they don't
      // see the steer either; they're their own conversation-repair flow.
      const drainSteer = this.config.drainSteer;
      if (drainSteer) {
        const steerItems = drainSteer();
        for (const item of steerItems) {
          let text = item.content;
          if (item.attachments && item.attachments.length > 0) {
            text += '\n\n' + item.attachments.map((p) => `[attached file: ${p}]`).join('\n');
          }
          messages.push({ role: 'user', content: text });
        }
      }

      // ---- Recovery path: tool-loop coach ignored ------------------------
      // The dispatcher sets terminationRequested() once a single (name, args)
      // key has been coached past MAX_COACHED_REPEATS. Continuing to coach
      // is unproductive — the model is stuck. Skip the rest of the turn
      // and route to the final-summary path so the operator gets a clean
      // handoff instead of a slow grind to the tool-cap exhaustion.
      if (loopDetector.terminationRequested()) {
        if (await tryFinalSummary('tool-loop coaching ignored')) continue;
        this.fail(`tool-loop coaching ignored beyond threshold (model ${def.alias})`);
        return;
      }

      // ---- Recovery path: tool-cap auto-continue --------------------------
      // Loop ran to MAX_TOOL_TURNS without the model producing a final
      // answer. Instead of failing, summarize what the tool history looks
      // like, inject as a fresh user message, reset the tool counter, and
      // let the model continue from the recap.
      if (toolTurn >= MAX_TOOL_TURNS) {
        if (!recovery.enabled || recoveriesUsed >= recovery.maxAutoRecoveries) {
          if (recovery.enabled && await tryFinalSummary(`tool-loop hit ${MAX_TOOL_TURNS}-turn cap`)) continue;
          this.fail(`llama-server tool-loop exceeded ${MAX_TOOL_TURNS} iterations and ${recovery.maxAutoRecoveries} auto-recoveries are exhausted`);
          return;
        }
        recoveriesUsed++;
        this.emit('system_notice', `auto-continue: hit ${MAX_TOOL_TURNS}-turn tool cap — injecting recap and resetting counter (recovery ${recoveriesUsed}/${recovery.maxAutoRecoveries})`);
        const recap = deterministicSummary(messages);
        messages.push({
          role: 'user',
          content: toolCapContinuationMessage(MAX_TOOL_TURNS, recap),
        });
        toolTurn = 0;
      }
    }

    // Unreachable in normal flow — the loop bodies above all return or
    // continue. Keep as a defensive backstop in case a future edit breaks
    // the invariant; same shape as the pre-recovery failure.
    this.fail(`llama-server tool-loop exceeded ${MAX_TOOL_TURNS} iterations (recovery state exhausted)`);
  }

  // No-op suppress — placeholder for future hooks. Removed.

  private isAborted(err: unknown): boolean {
    if (!err) return false;
    if (err instanceof Error && (err.name === 'AbortError' || err.message.includes('aborted'))) return true;
    return false;
  }

  private fail(message: string): void {
    if (this._status === 'failed') return;
    this._status = 'failed';
    this.emit('error', message);
  }

  kill(): void {
    const wasRunning = this._status === 'running' || this._status === 'spawning';
    const baseUrl = this.currentBaseUrl;
    if (this.abortController && this._status !== 'completed') {
      this.abortController.abort();
    }
    // Force the llama-server slot free. Closing the HTTP connection alone
    // doesn't stop generation per upstream (ggml-org/llama.cpp#9273,
    // text-generation-webui#6966) — server keeps decoding until the next
    // sink write. /slots/<id>?action=erase wipes the slot's KV cache so
    // the next turn starts clean and the GPU isn't pinned by a phantom
    // generation. Fire-and-forget; we don't block kill on it.
    if (baseUrl) {
      void this.eraseLlamaSlot(baseUrl);
    }
    // Drop any buffered reasoning so the operator sees the last thing
    // the model said before they hit cancel.
    this.emitThinking('', true);
    if (wasRunning) {
      this._status = 'failed';
      this.emit('error', 'Worker killed');
    }
  }

  // POST /slots/<id>?action=erase to free a wedged slot. Best-effort: the
  // endpoint can itself hang in some rare states (ggml-org/llama.cpp#17387)
  // so we wrap in a hard 2s timeout via AbortSignal and swallow errors.
  // Logging via system_notice would be noise on every cancel — kept silent.
  private async eraseLlamaSlot(baseUrl: string): Promise<void> {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 2000);
      try {
        await fetch(`${baseUrl}/slots/${this.currentSlotId}?action=erase`, {
          method: 'POST',
          signal: ctl.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch { /* best-effort */ }
  }
}

export const LlamacppProvider: Provider = {
  create(id, config) {
    return new LlamacppWorkerProcess(id, config);
  },
};

// Auth-side capability snapshot, mirrored to AuthStatus.installedModelCapabilities
// so the model picker UI shows the same tools/vision/thinking badges Ollama
// models get.
export interface LlamacppModelCapabilities {
  tools: boolean;
  vision: boolean;
  thinking: boolean;
  numCtx?: number;
}

// Reads the operator's catalog and returns the same shape Ollama's
// probeOllama() returns, so the auth path can splat it into AuthStatus
// without provider-specific branching downstream.
export async function probeLlamacpp(): Promise<{
  up: boolean;
  models: string[];
  capabilities?: Record<string, LlamacppModelCapabilities>;
  error?: string;
}> {
  // Binary check: if llama-server isn't on PATH, the catalog is moot.
  // Cheap stat via execFile-equivalent — but to keep this tight we just
  // look for /usr/local/bin/llama-server which is where the PKGBUILD
  // installs it. Operators on a other box can override via
  // ARCHON_LLAMACPP_BIN.
  const binPath = process.env.ARCHON_LLAMACPP_BIN ?? '/usr/local/bin/llama-server';
  try {
    statSync(binPath);
  } catch {
    return { up: false, models: [], error: `llama-server binary not found at ${binPath}` };
  }

  const catalog = await readCatalog();
  const models = catalog.models.map((m) => m.alias);
  const capabilities: Record<string, LlamacppModelCapabilities> = {};
  for (const m of catalog.models) {
    capabilities[m.alias] = {
      tools: m.capabilities?.tools ?? false,
      vision: m.capabilities?.vision === true && !!m.mmprojPath,
      thinking: m.capabilities?.thinking ?? false,
      ...(typeof m.ctxSize === 'number' && m.ctxSize > 0 ? { numCtx: m.ctxSize } : {}),
    };
  }
  return { up: true, models, capabilities };
}

// Live snapshot for the header chip + settings panel. Version is read from
// `llama-server --version`, cached by binary mtime — a fresh build (e.g.
// a package rebuild updating the package mid-session) bumps the inode's mtime
// and invalidates the cache so the next poll re-probes. Currently-loaded
// model + port come from the lifecycle manager.
let cachedVersion: { version: string | undefined; mtimeMs: number } | null = null;

async function probeBinaryVersion(): Promise<string | undefined> {
  const binPath = process.env.ARCHON_LLAMACPP_BIN ?? '/usr/local/bin/llama-server';
  let mtimeMs = 0;
  try { mtimeMs = statSync(binPath).mtimeMs; } catch { /* binary missing — fall through */ }
  if (cachedVersion && cachedVersion.mtimeMs === mtimeMs) return cachedVersion.version;
  let version: string | undefined;
  try {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const exec = promisify(execFile);
    const { stdout, stderr } = await exec(binPath, ['--version'], { timeout: 3000 });
    // llama-server prints "version: 9037 (bbeb89d76)" to stderr.
    const text = (stderr + stdout).trim();
    const m = /version:\s*(\S+)/i.exec(text);
    version = m ? m[1] : undefined;
  } catch {
    version = undefined;
  }
  cachedVersion = { version, mtimeMs };
  return version;
}

export async function probeLlamacppLive(): Promise<{
  up: boolean;
  version?: string;
  loadedModel: string | null;
  port?: number;
  pid?: number;
  error?: string;
}> {
  const binPath = process.env.ARCHON_LLAMACPP_BIN ?? '/usr/local/bin/llama-server';
  try {
    statSync(binPath);
  } catch {
    return { up: false, loadedModel: null, error: 'llama-server binary not found' };
  }
  const version = await probeBinaryVersion();
  const status = llamacppManager.getStatus();
  return {
    up: true,
    ...(version ? { version } : {}),
    loadedModel: status.alias ?? null,
    ...(typeof status.port === 'number' ? { port: status.port } : {}),
    ...(typeof status.pid === 'number' ? { pid: status.pid } : {}),
  };
}
