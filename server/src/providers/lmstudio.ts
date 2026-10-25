import { parseComputerHistory } from '../voice/history.js';
import { executeComputerTool } from '../voice/toolDefinitions.js';
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
import {
  ollamaToolCallAllowed, ollamaToolCandidates, ollamaToolsAutoExecute,
  ollamaChatWebReminder, ThinkSplitter, parseRenderedTranscript,
} from './ollama.js';
import { addGenSpeed } from './ollamaTokens.js';
import { goalBlock } from './goalBlock.js';
import { awaitModelImages, modelImagePath } from './attachments.js';
import {
  deterministicSummary,
  toolCapContinuationMessage,
} from './llamacppRecovery.js';
import { readSettings } from '../settings.js';
import { resolveConfigValue } from '../configValue.js';
import type { GenerationSpeed, WorkerConfig, WorkerStatus } from '@archon/shared';
import type { Provider, ProviderProcess } from './types.js';

// LM Studio provider (M13 / Excellence LE-7).
//
// STANDING VERDICT (load-bearing, see docs/LOCAL_AI_MASTER_PLAN.md §"Two
// standing verdicts" + LE-7): LM Studio is added as an OpenAI-COMPATIBLE HTTP
// endpoint, NOT via the native `lmstudio.js`/`ws://` SDK. LM Studio's app +
// engine are closed-source; only the client SDKs are public. It exposes an
// OpenAI-compatible REST API on http://localhost:1234/v1 (/chat/completions,
// /models, /embeddings). Talking to that surface reuses Archon's existing
// HTTP-provider plumbing for near-zero cost and avoids a dependency that would
// have to track the app's version for features Archon already owns (its own
// tool-loop). The `lms` CLI is at most an OPTIONAL capability-enrichment side-
// channel (NOT built in v1 — see probeLmstudio).
//
// Implementation note (reuse vs fork): this mirrors the wire-format handling
// of llama.cpp (server/src/providers/llamacpp.ts) — both speak OpenAI
// /v1/chat/completions streaming (SSE `data:` lines, `[DONE]` terminator,
// fragmented tool_calls, `usage` object). It deliberately does NOT import
// llama.cpp's `streamOneTurn`: that method is fused to llama.cpp's lifecycle
// manager (ensureLoaded / slot-erase) and its full auto-recovery state machine,
// so lifting it would either drag that coupling in or force an invasive
// refactor of a load-bearing provider. Instead this module reuses the genuinely
// shared, side-effect-free building blocks both providers already lean on
// (ThinkSplitter, parseRenderedTranscript, ollamaTools, ToolLoopDetector,
// deterministicSummary/toolCapContinuationMessage) and implements the standard
// OpenAI streaming loop directly against a configurable remote base URL. The
// remote endpoint means there is NO slot-erase, NO warmup wait, and NO
// per-spawn model load — LM Studio's app handles JIT loading on its side.

const DEFAULT_BASE = 'http://localhost:1234/v1';

// Resolve the operator-configured base URL. Cascade mirrors Ollama's
// (settings → env → localhost). LM Studio's REST surface lives under /v1, so
// tolerate a bare host:port by appending /v1 when the suffix is absent — an
// operator who pastes "http://workstation:1234" still works.
function normalizeBase(raw: string): string {
  let base = raw.trim().replace(/\/+$/, '');
  if (!/\/v\d+$/.test(base)) base = `${base}/v1`;
  return base;
}

export function lmstudioBaseFromEnv(): string {
  return normalizeBase(process.env.LMSTUDIO_URL_BASE ?? DEFAULT_BASE);
}

export async function getLmstudioBase(): Promise<string> {
  const settings = await readSettings();
  const configured = settings.lmstudio?.baseUrl;
  if (!configured) return lmstudioBaseFromEnv();
  // DD12 — configured may be a literal URL or an unresolved `!cmd` / `${ENV}`
  // ref. Resolve, then normalize/validate AFTER resolution; on a failed/empty
  // resolution fall back to the env default. Never logs the resolved value.
  const resolved = await resolveConfigValue(configured);
  const v = resolved.value?.trim();
  if (v && /^https?:\/\//.test(v)) return normalizeBase(v);
  if (resolved.error) console.warn(`[lmstudio] baseUrl ref did not resolve (${resolved.error}); using default`);
  return lmstudioBaseFromEnv();
}

// Tool-loop cap. Same rationale as llama.cpp's: local thinking models need
// rope for multi-step coding work, but unbounded loops hammer the backend and
// grow the message stack. Tune via ARCHON_LMSTUDIO_MAX_TOOL_TURNS.
const MAX_TOOL_TURNS = (() => {
  const env = process.env.ARCHON_LMSTUDIO_MAX_TOOL_TURNS;
  if (env) {
    const n = parseInt(env, 10);
    if (Number.isFinite(n) && n > 0 && n <= 200) return n;
  }
  return 25;
})();

// Tool-result truncation thresholds — keep the message stack lean across the
// multi-turn loop. Identical defaults/rationale to llama.cpp.
const TOOL_RESULT_HEAD_BYTES = (() => {
  const env = process.env.ARCHON_LMSTUDIO_TOOL_HEAD_BYTES;
  if (env) { const n = parseInt(env, 10); if (Number.isFinite(n) && n >= 0) return n; }
  return 4096;
})();
const TOOL_RESULT_TAIL_BYTES = (() => {
  const env = process.env.ARCHON_LMSTUDIO_TOOL_TAIL_BYTES;
  if (env) { const n = parseInt(env, 10); if (Number.isFinite(n) && n >= 0) return n; }
  return 2048;
})();

// Coalescing window for reasoning deltas (same saturation hazard as llama.cpp;
// see THINKING_FLUSH_MS there). Tune via ARCHON_LMSTUDIO_THINKING_FLUSH_MS.
const THINKING_FLUSH_MS = (() => {
  const env = process.env.ARCHON_LMSTUDIO_THINKING_FLUSH_MS;
  if (env) {
    const n = parseInt(env, 10);
    if (Number.isFinite(n) && n >= 0 && n <= 5000) return n;
  }
  return 100;
})();

const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const IMAGE_EXT: Record<string, true> = {
  '.png': true, '.jpg': true, '.jpeg': true, '.gif': true, '.webp': true,
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

function truncateToolResult(name: string, raw: string): string {
  const total = TOOL_RESULT_HEAD_BYTES + TOOL_RESULT_TAIL_BYTES;
  if (raw.length <= total + 200) return raw;
  if (name === 'Read') {
    const lines = raw.split('\n');
    if (lines.length <= 250) return raw;
    const head = lines.slice(0, 100).join('\n');
    const tail = lines.slice(-100).join('\n');
    const elided = lines.length - 200;
    return `${head}\n\n[... ${elided} lines elided by Arco to keep LM Studio context lean — re-read with explicit line range if needed ...]\n\n${tail}`;
  }
  const head = raw.slice(0, TOOL_RESULT_HEAD_BYTES);
  const tail = raw.slice(-TOOL_RESULT_TAIL_BYTES);
  const elided = raw.length - head.length - tail.length;
  return `${head}\n\n[... ${elided} bytes of tool output elided by Arco to keep LM Studio context lean ...]\n\n${tail}`;
}

// Stub throttle parser for symmetry with the subprocess providers. LM Studio
// is a local/self-hosted runtime; no remote quota to throttle against.
export function parseLmstudioThrottle(_text: string): { resetsAt?: number } | null {
  return null;
}

// OpenAI chat-completion message shape (same as llama.cpp's). Content is a
// string in the common case or an array of typed parts for multimodal.
type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
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
  reasoning_effort?: string;
  tools?: Array<{ type: 'function'; function: OllamaToolDefinition['function'] }>;
  stream_options?: { include_usage: boolean };
}

// Stall timeout: abort a stream that emits no SSE event for this long so a
// wedged backend doesn't hang the turn forever. Generous because a remote
// LM Studio host may pause while JIT-loading a model on first request.
const STALL_TIMEOUT_MS = (() => {
  const env = process.env.ARCHON_LMSTUDIO_STALL_TIMEOUT_MS;
  if (env) { const n = parseInt(env, 10); if (Number.isFinite(n) && n >= 1000) return n; }
  return 120_000;
})();

// Strata shares the OpenAI wire loop while keeping discovery and policy separate.
export interface OpenAIHttpConnection {
  name: 'lmstudio' | 'strata' | 'deepseek';
  label: string;
  base: () => Promise<string>;
  probe: typeof probeLmstudio;
  chatWeb?: boolean;
  // The shared runtime already caps Read at 32K and other tools at 64K.
  // Large-context connections can retain that result without a second trim.
  toolResultPolicy?: 'runtime' | 'compact';
  prepare?: (base: string, model: string, signal: AbortSignal, notice: (text: string) => void) => Promise<void>;
}
const LMSTUDIO_CONNECTION: OpenAIHttpConnection = {
  name: 'lmstudio', label: 'LM Studio', base: getLmstudioBase, probe: probeLmstudio,
};

export class OpenAIHttpWorkerProcess extends EventEmitter implements ProviderProcess {
  readonly id: string;
  readonly config: WorkerConfig;
  private abortController: AbortController | null = null;
  private _status: WorkerStatus = 'spawning';
  private _output = '';
  private outputCapped = false;
  private advertisedTools = new Set<string>();
  private modelContextWindow?: number;
  private thinkingBuf = '';
  private thinkingFlushTimer: NodeJS.Timeout | null = null;

  constructor(id: string, config: WorkerConfig, private readonly connection = LMSTUDIO_CONNECTION) {
    super();
    this.id = id;
    this.config = config;
  }

  private emitThinking(chunk: string, flush = false): void {
    if (chunk) this.thinkingBuf += chunk;
    if (THINKING_FLUSH_MS === 0 || flush) {
      if (this.thinkingFlushTimer) { clearTimeout(this.thinkingFlushTimer); this.thinkingFlushTimer = null; }
      if (this.thinkingBuf.length > 0) {
        const out = this.thinkingBuf; this.thinkingBuf = ''; this.emit('thinking', out);
      }
      return;
    }
    if (this.thinkingFlushTimer) return;
    this.thinkingFlushTimer = setTimeout(() => {
      this.thinkingFlushTimer = null;
      if (this.thinkingBuf.length === 0) return;
      const out = this.thinkingBuf; this.thinkingBuf = ''; this.emit('thinking', out);
    }, THINKING_FLUSH_MS);
  }

  get status(): WorkerStatus { return this._status; }
  get output(): string { return this._output; }

  spawn(prompt: string): void {
    this.abortController = new AbortController();
    void this.run(prompt).catch((err) => {
      if (!this.isAborted(err)) this.fail(`${this.connection.label}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  // Build OpenAI-shaped messages. Same byte-stability rules as the llama.cpp
  // path: system + prior turns unchanged across calls so the backend's prefix
  // cache (if any) hits; only the final user message grows. Effort 'low' →
  // /no_think prefix on the system message for Qwen-family models.
  private buildMessages(userPrompt: string): ChatMessage[] {
    const messages: ChatMessage[] = [];
    const noThink = this.connection.name === 'lmstudio' && this.config.effort === 'low';
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
      if (this.config.voiceOperator) {
        for (const m of parseComputerHistory(this.config.appendSystemPrompt)) messages.push({ ...m,
          ...(m.tool_calls ? { tool_calls: m.tool_calls.map((t) => ({ ...t, function: { ...t.function, arguments: JSON.stringify(t.function.arguments) } })) } : {}),
        } as ChatMessage);
      } else for (const m of parseRenderedTranscript(this.config.appendSystemPrompt)) {
        messages.push({ role: m.role as 'user' | 'assistant', content: m.content });
      }
    }

    // Vision: LM Studio honors the OpenAI multimodal shape for vision-capable
    // models. We can't cheaply probe per-model vision capability over the
    // OpenAI /v1/models surface (it omits that metadata — the gap the optional
    // `lms` enrichment would close), so we forward attached images and let the
    // backend reject/ignore them if the loaded model isn't multimodal. Non-
    // image attachments fold to text path references, same as llama.cpp.
    const imageParts: ContentPart[] = [];
    const nonImagePaths: string[] = [];
    for (const p of this.config.attachments ?? []) {
      if (classifyAttachment(p) !== 'image') { nonImagePaths.push(p); continue; }
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

    let text = userPrompt;
    if (this.connection.chatWeb) {
      const reminder = ollamaChatWebReminder(this.config);
      if (reminder) text += `\n\n${reminder}`;
    }
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
      if (fit) { this._output += fit; this.emit('text', fit); }
      this._output += OUTPUT_TRUNCATION_NOTICE;
      this.emit('text', OUTPUT_TRUNCATION_NOTICE);
      this.outputCapped = true;
      this.kill();
    }
  }

  // One streaming /v1/chat/completions call. Returns the assembled assistant
  // message, finish reason, and usage. `stalled` is set when no SSE event
  // arrived for STALL_TIMEOUT_MS (caller fails the turn). `null` = a hard
  // failure that already emitted 'error'.
  private async streamOneTurn(
    baseUrl: string,
    modelName: string,
    messages: ChatMessage[],
    tools: OllamaToolDefinition[] | undefined,
  ): Promise<{
    assistantMessage: ChatMessage;
    finishReason: string | null;
    usage: { inputTokens: number; outputTokens: number };
    stalled: boolean;
    genSpeed: GenerationSpeed | null;
  } | null> {
    const body: ChatCompletionRequest = {
      model: modelName,
      messages,
      stream: true,
      ...(this.connection.name === 'deepseek' ? { max_tokens: 16384, reasoning_budget_tokens: 8192 } : {}),
      stream_options: { include_usage: true },
      ...((this.connection.name === 'strata' || this.connection.name === 'deepseek') ? { reasoning_effort: ['none', 'low', 'medium'].includes(this.config.effort) ? this.config.effort : 'high' } : {}),
      ...(tools && tools.length > 0 ? {
        tools: tools.map((t) => ({ type: 'function' as const, function: t.function })),
      } : {}),
    };

    let res: Response;
    try {
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: this.abortController!.signal,
      });
    } catch (err) {
      if (this.isAborted(err)) return null;
      this.fail(`${this.connection.label} request failed: ${err instanceof Error ? err.message : String(err)} (base ${baseUrl})`);
      return null;
    }

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      this.fail(`${this.connection.label} HTTP ${res.status}: ${detail.slice(0, 200)}`);
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
    let rawReasoning = '';
    let stalled = false;
    let genSpeed: GenerationSpeed | null = null;
    const partialToolCalls = new Map<number, { id: string; name: string; argFragments: string[] }>();

    // Stall-bounded read: race reader.read() against a per-read timeout so a
    // wedged backend doesn't hang the turn forever.
    const readWithStall = async (): Promise<{ value?: Uint8Array; done: boolean }> => {
      let timer: NodeJS.Timeout | null = null;
      try {
        return await Promise.race([
          reader.read(),
          new Promise<{ value?: undefined; done: true }>((resolve) => {
            timer = setTimeout(() => {
              stalled = true;
              reader.cancel().catch(() => { /* already gone */ });
              resolve({ done: true });
            }, STALL_TIMEOUT_MS);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    try {
      let streamEnded = false;
      while (!streamEnded) {
        if (this.abortController?.signal.aborted) {
          reader.cancel().catch(() => { /* already gone */ });
          break;
        }
        const { value, done } = await readWithStall();
        if (stalled) break;
        if (done) {
          streamEnded = true;
          if (buf.trim().length === 0) break;
          buf += '\n';
        } else {
          buf += decoder.decode(value, { stream: true });
        }
        // SSE framing: each event is one or more `data: ...` lines, blank-line
        // separated. OpenAI servers emit a single data line per event.
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
            timings?: { predicted_n?: unknown; predicted_ms?: unknown; prompt_n?: unknown; prompt_ms?: unknown };
          };
          try { evt = JSON.parse(payload); } catch { continue; }

          if ((this.connection.name === 'strata' || this.connection.name === 'deepseek') && evt.timings) {
            const positive = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
            const timing = evt.timings;
            const sample = {
              decodeTokens: positive(timing.predicted_n), decodeMs: positive(timing.predicted_ms),
              prefillTokens: positive(timing.prompt_n), prefillMs: positive(timing.prompt_ms),
            };
            if (sample.decodeMs > 0 || sample.prefillMs > 0) genSpeed = sample;
          }
          const choice = evt.choices?.[0];
          // Native reasoning split. LM Studio (like llama-server with
          // --reasoning-format auto) surfaces a thinking model's reasoning in
          // delta.reasoning_content, leaving delta.content for the final
          // answer. Route it straight to the thinking channel; ThinkSplitter
          // handles the legacy <think>...</think>-in-content format below.
          if (choice?.delta?.reasoning_content !== undefined && typeof choice.delta.reasoning_content === 'string' && choice.delta.reasoning_content.length > 0) {
            rawReasoning += choice.delta.reasoning_content;
            this.emitThinking(choice.delta.reasoning_content);
          }
          if (choice?.delta?.content !== undefined && typeof choice.delta.content === 'string' && choice.delta.content.length > 0) {
            const { thinking, text } = splitter.push(choice.delta.content);
            if (thinking) this.emitThinking(thinking);
            if (text) { rawContent += text; this.emitText(text); }
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
              if (item.id) entry.id = item.id;
              if (item.function?.name) entry.name = item.function.name;
              if (typeof item.function?.arguments === 'string') entry.argFragments.push(item.function.arguments);
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
      this.emitThinking('', true);
      if (this.isAborted(err)) return null;
      this.fail(`${this.connection.label} stream interrupted: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }

    const drained = splitter.flush();
    if (drained.thinking) this.emitThinking(drained.thinking);
    if (drained.text) { rawContent += drained.text; this.emitText(drained.text); }
    this.emitThinking('', true);

    const assembled: ToolCall[] = [];
    for (const [, entry] of [...partialToolCalls.entries()].sort(([a], [b]) => a - b)) {
      assembled.push({
        id: entry.id,
        type: 'function',
        function: { name: entry.name, arguments: entry.argFragments.join('') },
      });
    }

    const assistantMessage: ChatMessage = { role: 'assistant', content: rawContent };
    if (assembled.length > 0) assistantMessage.tool_calls = assembled;
    if ((this.connection.name === 'strata' || this.connection.name === 'deepseek') && rawReasoning) assistantMessage.reasoning_content = rawReasoning;

    return { assistantMessage, finishReason, usage: { inputTokens, outputTokens }, stalled, genSpeed };
  }

  // Same dispatch contract as the Ollama/llama.cpp paths: AUTO mode executes,
  // SAFE mode refuses with a string the model treats as the tool result so the
  // loop converges without operator-approval ping-pong. Per-turn loop detector
  // intercepts identical (name, args) calls past the threshold.
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
          if (parsed && typeof parsed === 'object') args = parsed as Record<string, unknown>;
          else argError = `arguments JSON parsed to a non-object (${typeof parsed})`;
        } catch (e) {
          const preview = call.function.arguments.slice(0, 80);
          argError = `arguments not JSON-parseable (${(e as Error).message}); received: ${JSON.stringify(preview)}`;
        }
      }

      this.emit('tool_use', { name, input: JSON.stringify(args), toolUseId: call.id,
        ...((this.connection.name === 'strata' || this.connection.name === 'deepseek') ? { id: call.id, status: 'started', provider: this.connection.name } : {}) });

      let result: string;
      if (argError) {
        result = `[error] tool "${name}" arguments rejected: ${argError}`;
      } else if (!this.advertisedTools.has(name) || !ollamaToolCallAllowed(this.config, name)) {
        result = `[error] tool "${name}" is not enabled for this turn.`;
      } else if (this.config.interactionMode === 'chat' && this.config.voiceOperator) {
        result = await executeComputerTool(this.config.workflowId, name, args);
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
        const { coach, terminate, previousCount } = loopDetector.shouldCoach(name, args);
        if (terminate) {
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
      if (this.config.voiceOperator) this.emit('tool_use', { name, input: JSON.stringify(args), toolUseId: call.id, status: result.startsWith('[error]') ? 'failed' : 'completed', output: result });
      const stored = this.connection.toolResultPolicy === 'runtime'
        ? result
        : truncateToolResult(name, result);
      if ((this.connection.name === 'strata' || this.connection.name === 'deepseek') && stored !== result) {
        this.emit('system_notice', `${this.connection.label} ${name} tool result trimmed: ${Buffer.byteLength(result)} → ${Buffer.byteLength(stored)} bytes; re-run with a narrower query or range for omitted content.`);
      }
      if (this.connection.name === 'strata' || this.connection.name === 'deepseek') {
        this.emit('tool_use', { name, input: JSON.stringify(args), id: call.id, toolUseId: call.id, provider: this.connection.name,
          status: result.startsWith('[error]') ? 'failed' : 'completed', output: stored });
      }
      out.push({ role: 'tool', content: stored, tool_call_id: call.id });
    }
    return out;
  }

  private async run(prompt: string): Promise<void> {
    const startedAt = Date.now();

    const baseUrl = await this.connection.base();

    // Resolve the model. The operator's chosen id is forwarded as-is to LM
    // Studio (it loads JIT on its side). An empty selection asks the backend
    // for its first available model so a bare tab still works.
    let modelName = this.config.model?.trim() ?? '';
    if (!modelName) {
      try {
        const probe = await this.connection.probe();
        modelName = probe.models[0] ?? '';
      } catch { /* fall through — empty model name fails below with a clear error */ }
    }
    if (!modelName) {
      this.fail(`no ${this.connection.label} model selected and none discovered at ${baseUrl}/models — load a model in ${this.connection.label} and refresh`);
      return;
    }

    if (this.connection.name === 'deepseek' && (this.config.attachments ?? []).some((p) => classifyAttachment(p) === 'image')) {
      const prepared = await this.connection.probe();
      if (!prepared.capabilities?.[modelName]?.vision) {
        this.fail('The selected Xolotl profile is text-only; prepare its vision encoder before attaching images.'); return;
      }
    }
    if (this.abortController?.signal.aborted) return;
    await this.connection.prepare?.(baseUrl, modelName, this.abortController!.signal, (notice) => this.emit('system_notice', notice));
    if (this.abortController?.signal.aborted) return;
    this._status = 'running';
    markAvailable(this.connection.name);
    if (this.connection.name === 'strata' || this.connection.name === 'deepseek') {
      const probe = await this.connection.probe();
      this.modelContextWindow = probe.capabilities?.[modelName]?.numCtx;
    }
    this.emit('init', { model: modelName });
    if (this.abortController?.signal.aborted) return;

    // Bounded wait for the upload-time downscaled copies; buildMessages reads
    // them synchronously via modelImagePath.
    await awaitModelImages(this.config.attachments);
    if (this.abortController?.signal.aborted) return;
    const messages = this.buildMessages(prompt);

    let tools: OllamaToolDefinition[] | undefined;
    if (this.config.cwd && this.config.interactionMode !== 'chat') {
      const all = getOllamaToolDefinitions({ clusterEnabled: !!this.config.clusterId && !!this.config.workflowId });
      tools = this.config.tools
        ? all.filter((t) => this.config.tools!.includes(t.function.name))
        : all;
    }
    if (this.connection.chatWeb || this.config.voiceOperator) tools = ollamaToolCandidates(this.config);
    this.advertisedTools = new Set(tools?.map((t) => t.function.name) ?? []);
    const autoMode = this.connection.chatWeb ? ollamaToolsAutoExecute(this.config) : this.config.skipPermissions === true;

    // lastInputTokens = prompt_tokens of the FINAL iteration (true context fill
    // at turn end). totalOutputTokens = summed output across iterations (real
    // generation cost). Same accounting rationale as llama.cpp — never sum
    // input across iterations (the OpenAI usage shape returns the full prompt
    // count per call, so summing inflates the CTX bar 3-5x).
    let lastInputTokens = 0;
    let totalOutputTokens = 0;
    let turnGenSpeed: GenerationSpeed | null = null;

    const loopDetector = new ToolLoopDetector();
    let toolTurn = 0;
    // One tool-cap continuation is granted: at MAX_TOOL_TURNS, inject a
    // deterministic recap and reset the counter so a genuinely long task can
    // finish. A second cap hit fails for real.
    let toolCapContinued = false;

    while (toolTurn < MAX_TOOL_TURNS) {
      if (this.abortController?.signal.aborted) return;

      const turnResult = await this.streamOneTurn(baseUrl, modelName, messages, tools);
      if (turnResult === null) return;

      if (turnResult.stalled) {
        this.fail(`${this.connection.label} stream stalled (no event in ${STALL_TIMEOUT_MS}ms) — backend at ${baseUrl} may be loading or stuck`);
        return;
      }

      lastInputTokens = turnResult.usage.inputTokens;
      totalOutputTokens += turnResult.usage.outputTokens;
      turnGenSpeed = addGenSpeed(turnGenSpeed, turnResult.genSpeed);

      messages.push(turnResult.assistantMessage);

      const toolCalls = turnResult.assistantMessage.tool_calls;
      const expectsTools = turnResult.finishReason === 'tool_calls' || (toolCalls && toolCalls.length > 0);

      if (!expectsTools) {
        if (this._output.length === 0 && totalOutputTokens === 0) {
          this.fail(`${this.connection.label} returned no output (model ${modelName})`);
          return;
        }
        this._status = 'completed';
        this.emit('result', {
          text: this._output,
          costUsd: 0,
          modelContextWindow: this.modelContextWindow,
          lastPromptTokens: lastInputTokens,
          ...(turnGenSpeed ? { genSpeed: turnGenSpeed } : {}),
          durationMs: Date.now() - startedAt,
          usage: { input_tokens: lastInputTokens, output_tokens: totalOutputTokens },
        });
        return;
      }

      const toolResults = await this.dispatchToolCalls(toolCalls!, autoMode, loopDetector);
      if (this.abortController?.signal.aborted) return;
      messages.push(...toolResults);
      toolTurn++;

      // Mid-turn steer hook (Phase 5 parity with llama.cpp): drain anything
      // the operator typed while tools were dispatching and append as user
      // messages so the next call sees them.
      const drainSteer = this.config.drainSteer;
      if (drainSteer) {
        for (const item of drainSteer()) {
          let text = item.content;
          if (item.attachments && item.attachments.length > 0) {
            text += '\n\n' + item.attachments.map((p) => `[attached file: ${p}]`).join('\n');
          }
          messages.push({ role: 'user', content: text });
        }
      }

      if (loopDetector.terminationRequested()) {
        this.fail(`tool-loop coaching ignored beyond threshold (model ${modelName})`);
        return;
      }

      if (toolTurn >= MAX_TOOL_TURNS) {
        if (toolCapContinued) {
          this.fail(`${this.connection.label} tool-loop exceeded ${MAX_TOOL_TURNS} iterations twice — terminating (model ${modelName})`);
          return;
        }
        toolCapContinued = true;
        this.emit('system_notice', `auto-continue: hit ${MAX_TOOL_TURNS}-turn tool cap — injecting recap and resetting counter once`);
        const recap = deterministicSummary(messages);
        messages.push({ role: 'user', content: toolCapContinuationMessage(MAX_TOOL_TURNS, recap) });
        toolTurn = 0;
      }
    }

    this.fail(`${this.connection.label} tool-loop exceeded ${MAX_TOOL_TURNS} iterations (model ${modelName})`);
  }

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
    if (this.abortController && this._status !== 'completed') this.abortController.abort();
    // Drop buffered reasoning so the operator sees the last thing the model
    // said before they hit cancel. No slot-erase: the endpoint is remote and
    // owned by LM Studio's app (unlike llama-server, closing the connection
    // is the operator's responsibility on the LM Studio side).
    this.emitThinking('', true);
    if (wasRunning) {
      this._status = 'failed';
      this.emit('error', 'Worker killed');
    }
  }
}

export const LmstudioProvider: Provider = {
  create(id, config) {
    return new OpenAIHttpWorkerProcess(id, config);
  },
};

// Auth-side capability snapshot. Mirrors the Ollama/llama.cpp shape so the
// auth path can splat it into AuthStatus without provider-specific branching.
export interface LmstudioModelCapabilities {
  tools: boolean;
  vision: boolean;
  thinking: boolean;
  numCtx?: number;
}

// Probe LM Studio's OpenAI-compatible /v1/models endpoint to populate the
// model dropdown (so M13 doesn't repeat the M1 empty-dropdown gap). `up` is
// true iff the endpoint responds with a well-formed model list.
//
// Capability metadata: the OpenAI /v1/models surface omits tool/vision/ctx
// flags (the gap LE-7 notes). Optional `lms` CLI enrichment is a documented
// follow-up — NOT built in v1 (it would add a cross-platform shell-out for
// metadata that doesn't gate functionality: the tool list is forwarded
// regardless, and a non-tool model simply ignores the `tools` array). We
// therefore report conservative capability flags (tools:true so the picker
// offers them; vision/thinking unknown ⇒ false). The provider still works
// fully off the HTTP API with `lms` entirely absent.
export async function probeLmstudio(): Promise<{
  up: boolean;
  models: string[];
  capabilities?: Record<string, LmstudioModelCapabilities>;
  error?: string;
}> {
  const baseUrl = await getLmstudioBase();
  let res: Response;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 3000);
    try {
      res = await fetch(`${baseUrl}/models`, { signal: ctl.signal });
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return { up: false, models: [], error: `LM Studio not reachable at ${baseUrl}: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!res.ok) {
    return { up: false, models: [], error: `LM Studio /models HTTP ${res.status}` };
  }
  let json: { data?: Array<{ id?: unknown }> };
  try {
    json = await res.json();
  } catch (err) {
    return { up: false, models: [], error: `LM Studio /models returned non-JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  const models = Array.isArray(json.data)
    ? json.data.map((m) => (typeof m.id === 'string' ? m.id : '')).filter((s) => s.length > 0)
    : [];
  const capabilities: Record<string, LmstudioModelCapabilities> = {};
  for (const m of models) {
    // Conservative defaults — see the doc comment above. tools:true keeps the
    // picker badge on so capable models get the `tools` array; the engine
    // ignores it for non-tool models.
    capabilities[m] = { tools: true, vision: false, thinking: false };
  }
  return { up: true, models, capabilities };
}
