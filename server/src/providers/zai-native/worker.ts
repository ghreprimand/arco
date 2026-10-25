import { EventEmitter } from 'events';
import type { ServerMessage, WorkerConfig, ZaiNativeHistoryMessage } from '@arco/shared';
import { zaiModelContextWindow } from '@arco/shared';
import { readZaiApiKey } from '../../providerSecrets.js';
import { replayEvents as replayWorkflowEvents } from '../../workflowStore.js';
import { MAX_WORKER_OUTPUT_BYTES, OUTPUT_TRUNCATION_NOTICE } from '../../workers/limits.js';
import { outputStyleAddendum } from '../outputStyle.js';
import { goalBlock } from '../goalBlock.js';
import { acquireZaiSlot, isRetryableZai429, maxZaiRetries, recordZai429, zaiErrorCode } from './rateLimit.js';
import { executeZaiNativeTool, getZaiNativeToolDefinitions } from './tools.js';
import { splitAttachmentPaths, withAttachmentRefs } from '../attachments.js';

const ZAI_CODING_CHAT_URL = 'https://api.z.ai/api/coding/paas/v4/chat/completions';
const MAX_TOOL_ROUNDS = 50;
// Per-round output ceiling. z.ai's hosted default when unset is 65536; 32768 is
// a generous coding cap that stops long edits truncating mid-stream while
// keeping runaway generations bounded. Truncation (finish_reason:'length') is
// surfaced as a system_notice rather than dropped silently.
const MAX_OUTPUT_TOKENS = 32768;
const COMPACT_SUMMARY_MAX_TOKENS = 8192;
const COMPACT_KEEP_LAST_MESSAGES = 6;
const COMPACT_SUMMARIZER_SYSTEM = [
  'You are compacting a coding-agent conversation so the same agent can continue in the same workspace.',
  'Write a dense continuation summary. Preserve current objective, files touched, decisions made, commands/results that matter, open risks, and exact next steps.',
  'Do not add advice, do not evaluate the work, and do not mention that you are a separate summarizer.',
].join('\n');
const COMPACT_SUMMARIZER_PROMPT = 'Summarize the transcript above for continuation. Keep it concise but complete enough that the next turn can proceed without rereading old context.';

type ZaiToolCall = NonNullable<ZaiNativeHistoryMessage['tool_calls']>[number];
type Usage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
};

type RoundResult = {
  assistant: ZaiNativeHistoryMessage;
  toolCalls: ZaiToolCall[];
  usage?: Usage;
  finishReason?: string;
  ttfbMs: number;
  totalMs: number;
  retryCount: number;
  waitMs: number;
};

export class ZaiNativeWorker extends EventEmitter {
  private config: WorkerConfig;
  private messages: ZaiNativeHistoryMessage[] = [];
  private started = false;
  private inFlight: AbortController | null = null;
  private turnAbort: AbortController | null = null;
  private loopDone: Promise<void> | null = null;
  private output = '';
  private thinkingBytes = 0;
  private toolResultBytes = 0;
  private workflowEventBroadcast: (msg: ServerMessage) => void = () => { /* no-op */ };

  constructor(config: WorkerConfig) {
    super();
    this.config = config;
  }

  updateConfig(config: WorkerConfig): void {
    this.config = config;
  }

  setWorkflowEventBroadcast(fn: (msg: ServerMessage) => void): void {
    this.workflowEventBroadcast = fn;
  }

  async ensureStarted(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.messages = await replayZaiNativeMessages(this.config.cwd ?? '', this.config.workflowId ?? '');
    console.log(`[zai-native:${(this.config.workflowId ?? '').slice(0, 8)}] replayed ${this.messages.length} native history messages`);
  }

  // Each turn owns an AbortController. cancel() settles the Turn wrapper
  // immediately, so the loop it aborted can still be mid-tool; the next
  // runTurn aborts + awaits that loop before touching `messages`, and a loop
  // whose signal is aborted never mutates history or emits again. Previously a
  // shared `cancelled` flag was reset by the next turn and the stale loop
  // appended role:'tool' after the new user message (400 on the next request)
  // while interleaving events into the new turn.
  async runTurn(prompt: string): Promise<void> {
    while (this.loopDone) {
      this.turnAbort?.abort();
      await this.loopDone;
    }
    const ac = new AbortController();
    this.turnAbort = ac;
    const run = this.runLoop(prompt, ac.signal);
    const done: Promise<void> = run.then(() => undefined, () => undefined).finally(() => {
      if (this.loopDone === done) this.loopDone = null;
      if (this.turnAbort === ac) this.turnAbort = null;
    });
    this.loopDone = done;
    return run;
  }

  private async runLoop(prompt: string, signal: AbortSignal): Promise<void> {
    await this.ensureStarted();
    this.output = '';
    this.thinkingBytes = 0;
    this.toolResultBytes = 0;
    const startedAt = Date.now();
    const key = await readZaiApiKey();
    if (!key) throw new Error('Z.ai API key is not configured');
    if (signal.aborted) throw new Error('Z.ai native turn cancelled');
    const workflowId = this.config.workflowId ?? '';
    const cwd = this.config.cwd ?? process.cwd();

    // A turn aborted mid-tool-round leaves an assistant tool_calls message
    // with missing results; prune it before appending the new user message.
    this.messages = sanitizeHistory(this.messages);
    this.emit('init', { model: this.config.model });
    this.messages.push({ role: 'user', content: this.withAttachments(prompt, this.config.attachments) });
    this.persistHistory();

    let mergedUsage: Record<string, number> = {};
    let rounds = 0;
    while (!signal.aborted) {
      rounds += 1;
      if (rounds > MAX_TOOL_ROUNDS) {
        throw new Error(`Z.ai native exceeded ${MAX_TOOL_ROUNDS} tool rounds`);
      }
      const round = await this.streamOneRound(key, signal);
      if (signal.aborted) break;
      mergedUsage = mergeUsage(mergedUsage, usageToRecord(round.usage));
      this.messages.push(round.assistant);
      this.persistHistory();
      this.logRound(round, rounds);

      if (round.finishReason === 'length') {
        this.emit('system_notice', `[zai] response hit the ${MAX_OUTPUT_TOKENS}-token output cap (finish_reason=length) — this turn was truncated. Ask GLM to continue, or raise MAX_OUTPUT_TOKENS.`);
      }

      if (round.toolCalls.length === 0) {
        this.emit('result', {
          text: this.output,
          costUsd: 0,
          durationMs: Date.now() - startedAt,
          usage: mergedUsage,
          modelContextWindow: zaiModelContextWindow(this.config.model),
          lastPromptTokens: round.usage?.prompt_tokens,
          thinkingBytes: this.thinkingBytes,
          toolResultBytes: this.toolResultBytes,
          toolResultBytesRaw: this.toolResultBytes,
        });
        return;
      }

      for (const call of round.toolCalls) {
        if (signal.aborted) break;
        const args = parseArgs(call.function.arguments);
        this.emit('tool_use', {
          id: call.id,
          name: call.function.name,
          input: call.function.arguments || '{}',
          status: 'started',
          provider: 'zai',
        });
        const result = await executeZaiNativeTool(call.function.name, args, {
          cwd,
          workflowId,
          clusterId: this.config.clusterId,
          abortSignal: signal,
        });
        if (signal.aborted) break;
        this.toolResultBytes += Buffer.byteLength(result);
        this.emit('tool_use', {
          id: call.id,
          name: call.function.name,
          input: call.function.arguments || '{}',
          status: result.startsWith('[error]') ? 'failed' : 'completed',
          provider: 'zai',
          output: result,
        });
        this.messages.push({ role: 'tool', tool_call_id: call.id, content: result });
      }
      if (signal.aborted) break;
      this.persistHistory();

      const steers = this.config.drainSteer?.() ?? [];
      for (const steer of steers) {
        this.messages.push({ role: 'user', content: this.withAttachments(steer.content, steer.attachments) });
      }
      if (steers.length > 0) this.persistHistory();
    }
    throw new Error('Z.ai native turn cancelled');
  }

  // Every Z.ai native catalog model is text-only GLM, so attachments fold as
  // `[attached file: …]` refs (agent-mode file tools can open non-image
  // files). Images can't be seen at all — say so instead of letting the model
  // guess at a path. Previously attachments were dropped without a trace.
  private withAttachments(prompt: string, attachments: string[] | undefined): string {
    const { imagePaths } = splitAttachmentPaths(attachments);
    if (imagePaths.length > 0) {
      this.emit('system_notice', `[zai] ${this.config.model} can't view images — ${imagePaths.length} image attachment(s) passed as file paths only. Use Claude, Codex, or a vision-capable local model to discuss an image.`);
    }
    return withAttachmentRefs(prompt, attachments ?? []);
  }

  cancel(): void {
    this.turnAbort?.abort();
    this.inFlight?.abort();
    this.emit('error', 'Z.ai native worker cancelled');
  }

  dispose(): void {
    this.turnAbort?.abort();
    this.inFlight?.abort();
    this.removeAllListeners();
  }

  async compactInPlace(): Promise<{ ok: boolean; error?: string; foldedTurns?: number }> {
    try {
      await this.ensureStarted();
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (this.loopDone || (this.inFlight && !this.inFlight.signal.aborted)) {
      return { ok: false, error: 'a turn is in flight — wait for it to finish' };
    }
    this.messages = sanitizeHistory(this.messages);
    const foldedTurns = this.messages.filter((m) => m.role === 'user').length;
    if (this.messages.length === 0) return { ok: false, error: 'nothing to compact yet' };

    const keptTail = projectZaiKeptTail(this.messages, COMPACT_KEEP_LAST_MESSAGES);
    const rawPrefix = keptTail.length > 0 && keptTail.length < this.messages.length
      ? this.messages.slice(0, this.messages.length - keptTail.length)
      : this.messages;
    const tailForSeed = rawPrefix.length === this.messages.length ? [] : keptTail;
    const transcript = projectCompactTranscript(rawPrefix);
    if (!transcript.trim()) return { ok: false, error: 'nothing compactable in native history' };

    const workflowId = this.config.workflowId;
    if (workflowId) {
      this.workflowEventBroadcast({ type: 'native_compacting', workflowId, foldedTurns });
    }

    let summary: string;
    try {
      summary = await this.generateCompactSummary(transcript);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (!summary.trim()) return { ok: false, error: 'summary came back empty' };

    this.messages = zaiCompactSummarySeed(summary, tailForSeed);
    if (workflowId) {
      this.workflowEventBroadcast({
        type: 'native_compacted',
        workflowId,
        summary,
        foldedTurns,
        ...(tailForSeed.length > 0 ? { keptTail: tailForSeed.map(stripZaiTailForNativeCompacted) } : {}),
      });
    }
    this.persistHistory();
    return { ok: true, foldedTurns };
  }

  private async streamOneRound(key: string, turnSignal: AbortSignal): Promise<RoundResult> {
    const tools = this.config.interactionMode === 'chat' ? [] : getZaiNativeToolDefinitions({
      clusterEnabled: !!this.config.clusterId,
      mailboxOnly: this.config.clusterAccessMode !== undefined && this.config.clusterAccessMode !== 'standard',
    });
    const system = buildSystemPrompt(this.config);
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: [{ role: 'system', content: system }, ...this.messages],
      ...(tools.length > 0 ? { tools } : {}),
      stream: true,
      stream_options: { include_usage: true },
      thinking: { type: 'enabled', clear_thinking: false },
      max_tokens: MAX_OUTPUT_TOKENS,
    };
    // reasoning_effort is only honored on GLM-5.2; older GLMs ignore it and
    // treat thinking as binary. Only send it where it maps to something real.
    if (zaiSupportsReasoningEffort(this.config.model)) {
      body.reasoning_effort = effortForZai(this.config.effort);
    }

    let retryCount = 0;
    for (let attempt = 0; ; attempt += 1) {
      const slot = await acquireZaiSlot();
      if (turnSignal.aborted) {
        slot.release();
        throw new Error('Z.ai native turn cancelled');
      }
      const controller = new AbortController();
      const onTurnAbort = (): void => controller.abort();
      turnSignal.addEventListener('abort', onTurnAbort, { once: true });
      this.inFlight = controller;
      const start = Date.now();
      let firstByteAt = 0;
      try {
        const res = await fetch(ZAI_CODING_CHAT_URL, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${key}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          const detail = await res.text().catch(() => '');
          if (res.status === 429 && isRetryableZai429(detail) && attempt < maxZaiRetries() && !turnSignal.aborted) {
            const backoff = recordZai429(res.headers.get('retry-after'), attempt);
            retryCount += 1;
            const code = zaiErrorCode(detail);
            this.emit('system_notice', `[zai] upstream 429${code ? ` code=${code}` : ''}; retry ${retryCount}/${maxZaiRetries()} after ${Math.ceil(backoff / 1000)}s`);
            slot.release();
            continue;
          }
          throw new Error(`Z.ai HTTP ${res.status}: ${detail.slice(0, 1000)}`);
        }
        const parsed = await this.readStream(res.body, turnSignal, () => {
          if (!firstByteAt) firstByteAt = Date.now();
        });
        return {
          ...parsed,
          ttfbMs: firstByteAt ? firstByteAt - start : Date.now() - start,
          totalMs: Date.now() - start,
          retryCount,
          waitMs: slot.waitMs,
        };
      } finally {
        turnSignal.removeEventListener('abort', onTurnAbort);
        if (this.inFlight === controller) this.inFlight = null;
        slot.release();
      }
    }
  }

  private async readStream(body: ReadableStream<Uint8Array>, turnSignal: AbortSignal, onFirstByte: () => void): Promise<Omit<RoundResult, 'ttfbMs' | 'totalMs' | 'retryCount' | 'waitMs'>> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let reasoning = '';
    let usage: Usage | undefined;
    let finishReason: string | undefined;
    const toolParts = new Map<number, ZaiToolCall>();
    let sawByte = false;

    const processLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) return;
      const data = trimmed.slice(5).trim();
      if (!data || data === '[DONE]') return;
      let evt: { choices?: Array<{ delta?: Record<string, unknown>; finish_reason?: string | null }>; usage?: Usage };
      try {
        evt = JSON.parse(data) as typeof evt;
      } catch {
        return;
      }
      if (evt.usage) usage = evt.usage;
      const fr = evt.choices?.[0]?.finish_reason;
      if (typeof fr === 'string' && fr) finishReason = fr;
      const delta = evt.choices?.[0]?.delta;
      if (!delta) return;
      if (typeof delta.content === 'string' && delta.content) {
        content += delta.content;
        // A chunk already buffered when the turn aborted must not leak into
        // the next turn's listeners.
        if (!turnSignal.aborted) this.appendOutput(delta.content);
      }
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
        // GLM's reasoning_content is hidden provider state. Preserve it exactly
        // for the next request, but never stream it into operator-visible
        // Activity as primary_thinking.
        reasoning += delta.reasoning_content;
        this.thinkingBytes += Buffer.byteLength(delta.reasoning_content);
      }
      const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      for (const raw of calls) {
        if (!raw || typeof raw !== 'object') continue;
        const rec = raw as Record<string, unknown>;
        const index = typeof rec.index === 'number' ? rec.index : toolParts.size;
        const fn = rec.function && typeof rec.function === 'object' ? rec.function as Record<string, unknown> : {};
        const prior = toolParts.get(index) ?? {
          id: typeof rec.id === 'string' ? rec.id : `call_${index}`,
          type: 'function',
          function: { name: '', arguments: '' },
        };
        if (typeof rec.id === 'string') prior.id = rec.id;
        if (typeof fn.name === 'string') prior.function.name += fn.name;
        if (typeof fn.arguments === 'string') prior.function.arguments += fn.arguments;
        toolParts.set(index, prior);
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!sawByte) {
        sawByte = true;
        onFirstByte();
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) processLine(line);
    }
    if (buffer.trim()) processLine(buffer);

    const toolCalls = [...toolParts.keys()]
      .sort((a, b) => a - b)
      .map((i) => toolParts.get(i)!)
      .filter((call) => call.function.name);
    const assistant: ZaiNativeHistoryMessage = {
      role: 'assistant',
      content,
      ...(reasoning ? { reasoning_content: reasoning } : {}),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };
    return { assistant, toolCalls, usage, finishReason };
  }

  private async generateCompactSummary(transcript: string): Promise<string> {
    if (process.env.ARCO_TEST === '1' && process.env.ARCO_TEST_COMPACT_CANNED_SUMMARY) {
      return process.env.ARCO_TEST_COMPACT_CANNED_SUMMARY;
    }
    const key = await readZaiApiKey();
    if (!key) throw new Error('Z.ai API key is not configured');
    const body = {
      model: this.config.model,
      messages: [
        { role: 'system', content: COMPACT_SUMMARIZER_SYSTEM },
        { role: 'user', content: `${transcript}\n\n${COMPACT_SUMMARIZER_PROMPT}` },
      ],
      stream: true,
      stream_options: { include_usage: true },
      thinking: { type: 'disabled' },
      reasoning_effort: 'low',
      max_tokens: COMPACT_SUMMARY_MAX_TOKENS,
    };
    let retryCount = 0;
    for (let attempt = 0; ; attempt += 1) {
      const slot = await acquireZaiSlot();
      const controller = new AbortController();
      this.inFlight = controller;
      const start = Date.now();
      let firstByteAt = 0;
      try {
        const res = await fetch(ZAI_CODING_CHAT_URL, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${key}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          const detail = await res.text().catch(() => '');
          if (res.status === 429 && isRetryableZai429(detail) && attempt < maxZaiRetries()) {
            const backoff = recordZai429(res.headers.get('retry-after'), attempt);
            retryCount += 1;
            const code = zaiErrorCode(detail);
            this.emit('system_notice', `[zai] compact upstream 429${code ? ` code=${code}` : ''}; retry ${retryCount}/${maxZaiRetries()} after ${Math.ceil(backoff / 1000)}s`);
            slot.release();
            continue;
          }
          throw new Error(`Z.ai compact HTTP ${res.status}: ${detail.slice(0, 1000)}`);
        }
        const parsed = await readTextSummaryStream(res.body, () => {
          if (!firstByteAt) firstByteAt = Date.now();
        });
        const usage = parsed.usage ?? {};
        console.log(
          `[zai-native:${(this.config.workflowId ?? '').slice(0, 8)}] compact` +
          ` wait=${slot.waitMs}ms ttfb=${firstByteAt ? firstByteAt - start : Date.now() - start}ms total=${Date.now() - start}ms` +
          ` prompt=${usage.prompt_tokens ?? 0} output=${usage.completion_tokens ?? 0}` +
          ` cached=${usage.prompt_tokens_details?.cached_tokens ?? 0} retries=${retryCount}`,
        );
        return parsed.text;
      } finally {
        if (this.inFlight === controller) this.inFlight = null;
        slot.release();
      }
    }
  }

  private appendOutput(text: string): void {
    if (this.output.length >= MAX_WORKER_OUTPUT_BYTES) return;
    const remaining = MAX_WORKER_OUTPUT_BYTES - this.output.length;
    if (text.length <= remaining) {
      this.output += text;
      this.emit('text', text);
      return;
    }
    const fit = text.slice(0, remaining);
    this.output += fit + OUTPUT_TRUNCATION_NOTICE;
    this.emit('text', fit + OUTPUT_TRUNCATION_NOTICE);
    this.emit('system_notice', '[zai] worker output truncated by Arco cap');
  }

  private persistHistory(): void {
    const workflowId = this.config.workflowId;
    if (!workflowId) return;
    this.workflowEventBroadcast({
      type: 'zai_native_history',
      workflowId,
      messages: this.messages,
    });
  }

  private logRound(round: RoundResult, roundNo: number): void {
    const usage = round.usage ?? {};
    console.log(
      `[zai-native:${(this.config.workflowId ?? '').slice(0, 8)}] round=${roundNo}` +
      ` wait=${round.waitMs}ms ttfb=${round.ttfbMs}ms total=${round.totalMs}ms` +
      ` prompt=${usage.prompt_tokens ?? 0} output=${usage.completion_tokens ?? 0}` +
      ` cached=${usage.prompt_tokens_details?.cached_tokens ?? 0}` +
      ` tools=${round.toolCalls.length}` +
      ` effort=${zaiSupportsReasoningEffort(this.config.model) ? effortForZai(this.config.effort) : 'n/a'}` +
      ` finish=${round.finishReason ?? '?'}` +
      ` retries=${round.retryCount}`,
    );
  }
}

export async function replayZaiNativeMessages(cwd: string, workflowId: string): Promise<ZaiNativeHistoryMessage[]> {
  if (!cwd || !workflowId) return [];
  const events = await replayWorkflowEvents(cwd, workflowId, 0).catch(() => []);
  let messages: ZaiNativeHistoryMessage[] = [];
  for (const ev of events) {
    if (ev.type === 'handoff_artifact_ready') {
      messages = [];
      continue;
    }
    if (ev.type === 'native_compacted' && typeof ev.summary === 'string') {
      const tail = Array.isArray(ev.keptTail) ? ev.keptTail : [];
      messages = zaiCompactSummarySeed(ev.summary, tail.map(coerceReplayTailMessage).filter((m): m is ZaiNativeHistoryMessage => !!m));
      continue;
    }
    if (ev.type !== 'zai_native_history') continue;
    if (ev.reset) {
      messages = [];
    }
    messages = ev.messages.map((m) => ({ ...m }));
  }
  return sanitizeHistory(messages);
}

export function zaiCompactSummarySeed(summary: string, keptTail: ZaiNativeHistoryMessage[] = []): ZaiNativeHistoryMessage[] {
  const trimmed = summary.trim();
  if (!trimmed) return [];
  return [
    {
      role: 'user',
      content: [
        'Summary of the conversation so far (the full transcript was compacted to free context):',
        '',
        trimmed,
      ].join('\n'),
    },
    { role: 'assistant', content: "Understood. I'll continue from this summary." },
    ...keptTail.map(cloneZaiMessage),
  ];
}

function sanitizeHistory(messages: ZaiNativeHistoryMessage[]): ZaiNativeHistoryMessage[] {
  const out: ZaiNativeHistoryMessage[] = [];
  const pendingToolIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      if (pendingToolIds.size > 0) {
        pruneDanglingToolRound(out, pendingToolIds);
        pendingToolIds.clear();
      }
      out.push(msg);
      for (const call of msg.tool_calls) pendingToolIds.add(call.id);
      continue;
    }
    if (msg.role === 'tool') {
      if (!pendingToolIds.has(msg.tool_call_id ?? '')) continue;
      out.push(msg);
      pendingToolIds.delete(msg.tool_call_id ?? '');
      continue;
    }
    if (pendingToolIds.size > 0) {
      pruneDanglingToolRound(out, pendingToolIds);
      pendingToolIds.clear();
    }
    out.push(msg);
  }
  if (pendingToolIds.size > 0) pruneDanglingToolRound(out, pendingToolIds);
  return out;
}

function pruneDanglingToolRound(out: ZaiNativeHistoryMessage[], pendingToolIds: Set<string>): void {
  for (let i = out.length - 1; i >= 0; i -= 1) {
    const msg = out[i];
    if (msg.role === 'assistant' && msg.tool_calls?.some((call) => pendingToolIds.has(call.id))) {
      out.splice(i);
      return;
    }
  }
}

function projectZaiKeptTail(messages: ZaiNativeHistoryMessage[], keepLast: number): ZaiNativeHistoryMessage[] {
  if (keepLast <= 0) return [];
  const collected: ZaiNativeHistoryMessage[] = [];
  let lastRole: 'user' | 'assistant' | null = null;
  for (let i = messages.length - 1; i >= 0 && collected.length < keepLast; i -= 1) {
    const msg = messages[i];
    if (msg.role !== 'user' && msg.role !== 'assistant') continue;
    if (msg.tool_calls?.length) continue;
    if (!msg.content.trim()) continue;
    if (msg.role === lastRole) continue;
    collected.unshift(cloneZaiMessage(msg));
    lastRole = msg.role;
  }
  while (collected.length > 0 && collected[0].role !== 'user') collected.shift();
  return collected;
}

function projectCompactTranscript(messages: ZaiNativeHistoryMessage[]): string {
  const lines: string[] = ['Conversation transcript to compact:', ''];
  for (const msg of sanitizeHistory(messages)) {
    if (msg.role === 'user') {
      lines.push('USER:', msg.content, '');
    } else if (msg.role === 'assistant') {
      if (msg.content.trim()) lines.push('ASSISTANT:', msg.content, '');
      if (msg.tool_calls?.length) {
        lines.push('ASSISTANT TOOL CALLS:');
        for (const call of msg.tool_calls) {
          lines.push(`- ${call.function.name}(${call.function.arguments}) [id=${call.id}]`);
        }
        lines.push('');
      }
    } else if (msg.role === 'tool') {
      lines.push(`TOOL RESULT ${msg.tool_call_id ?? ''}:`, msg.content.slice(0, 20_000), '');
    }
  }
  return lines.join('\n');
}

function stripZaiTailForNativeCompacted(msg: ZaiNativeHistoryMessage): { role: 'user' | 'assistant'; content: string } {
  return { role: msg.role === 'assistant' ? 'assistant' : 'user', content: msg.content };
}

function coerceReplayTailMessage(raw: unknown): ZaiNativeHistoryMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  if (rec.role !== 'user' && rec.role !== 'assistant') return null;
  const content = typeof rec.content === 'string'
    ? rec.content
    : Array.isArray(rec.content)
      ? rec.content.map((p) => p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : '').filter(Boolean).join('\n')
      : '';
  return content.trim() ? { role: rec.role, content } : null;
}

function cloneZaiMessage(msg: ZaiNativeHistoryMessage): ZaiNativeHistoryMessage {
  return {
    ...msg,
    ...(msg.tool_calls ? { tool_calls: msg.tool_calls.map((call) => ({ ...call, function: { ...call.function } })) } : {}),
  };
}

async function readTextSummaryStream(body: ReadableStream<Uint8Array>, onFirstByte: () => void): Promise<{ text: string; usage?: Usage }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let usage: Usage | undefined;
  let sawByte = false;
  const processLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') return;
    try {
      const evt = JSON.parse(data) as { choices?: Array<{ delta?: { content?: unknown } }>; usage?: Usage };
      if (evt.usage) usage = evt.usage;
      const content = evt.choices?.[0]?.delta?.content;
      if (typeof content === 'string') text += content;
    } catch {
      // Ignore malformed stream fragments; upstream will either continue or end empty.
    }
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!sawByte) {
      sawByte = true;
      onFirstByte();
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) processLine(line);
  }
  if (buffer.trim()) processLine(buffer);
  return { text, usage };
}

// The primary GLM system block. Kept cache-stable (cwd is per-workflow-stable,
// platform is static, no timestamps/random) so z.ai's implicit prefix cache
// stays warm across rounds. Deliberately NOT terse — the prior one-liner ended
// with "keep answers concise", which capped GLM's usefulness as a coding agent;
// this gives it the explore->plan->edit->verify doctrine the Claude/Codex tabs
// already carry. See docs/ZAI_INTEGRATION_AUDIT.md.
function zaiPrimarySystemPrompt(config: WorkerConfig): string {
  const cwd = config.cwd ?? process.cwd();
  return [
    "You are Arco Z.ai, a GLM coding agent working directly in the operator's workspace through tools. Your role is the same as Claude Code or Codex: you explore, edit, run, and verify real code in a real repository — you are not a chat assistant.",
    '',
    `Environment: working directory ${cwd} on ${process.platform}.`,
    '',
    'How to work:',
    "- Explore before you edit. Read the files you're about to change and use Grep/Glob to ground your work in how this project actually does things. Prefer reading over guessing.",
    '- Follow the project\'s own conventions. If a CLAUDE.md, AGENTS.md, or README is present (or folded into this prompt), treat its instructions as binding and match the surrounding code\'s style.',
    '- For anything non-trivial, think first, then act: form a short plan and carry it out step by step with tools rather than in one leap.',
    '- Make focused edits with Edit/Write. After changing code, verify with Bash — run the build, tests, type-checker, or the specific command — and read the output. Fix what you broke before you report done.',
    '- Use WebSearch/WebFetch when you need current information or external documentation.',
    "- Use each tool for its real purpose; don't describe tool calls you haven't actually made.",
    '',
    'Reporting: be direct and specific. Reference files and line numbers, state what you actually changed and what you verified, and surface failures, assumptions, and open risks honestly instead of claiming success.',
  ].join('\n');
}

function buildSystemPrompt(config: WorkerConfig): string {
  if (config.interactionMode === 'chat') {
    return [config.systemPrompt, config.appendSystemPrompt, outputStyleAddendum(config.outputStyle)]
      .filter(Boolean)
      .join('\n\n');
  }
  const blocks = [
    zaiPrimarySystemPrompt(config),
    // GOAL_NORTHSTAR_PLAN.md G2 — north-star immediately after the identity block,
    // above the cluster plan (broad-to-narrow). Covers operator turns AND primitive
    // seeds (both carry config.goal). Blank ⇒ '' ⇒ filtered out.
    goalBlock(config.goal) ?? '',
    config.clusterPlan ? `--- Shared cluster plan ---\n${config.clusterPlan}` : '',
    config.clusterRole ? `Your role in this cluster: ${config.clusterRole}` : '',
    config.clusterEfficiencyDoctrine ?? '',
    config.clusterProgressDoctrine ?? '',
    config.appendSystemPrompt ?? '',
    outputStyleAddendum(config.outputStyle) ?? '',
    config.systemPrompt ?? '',
  ].filter(Boolean);
  return blocks.join('\n\n');
}

function effortForZai(effort: WorkerConfig['effort']): string {
  if (effort === 'low') return 'low';
  if (effort === 'medium') return 'medium';
  if (effort === 'xhigh' || effort === 'max') return 'max';
  return 'high';
}

// Whether the model honors `reasoning_effort`. Documented as GLM-5.2-only; on
// glm-4.7 / glm-5-turbo / glm-4.5* it is a no-op (thinking is binary via
// `thinking:{type}`), so we omit the param rather than send inert noise.
function zaiSupportsReasoningEffort(model: string | undefined): boolean {
  return (model ?? '').toLowerCase().startsWith('glm-5.2');
}

function parseArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch (err) {
    return { _parse_error: err instanceof Error ? err.message : String(err), _raw: raw };
  }
}

function usageToRecord(usage?: Usage): Record<string, number> {
  if (!usage) return {};
  return {
    input_tokens: usage.prompt_tokens ?? 0,
    output_tokens: usage.completion_tokens ?? 0,
    total_tokens: usage.total_tokens ?? ((usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0)),
    cache_read_input_tokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
  };
}

function mergeUsage(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = (out[k] ?? 0) + v;
  return out;
}
