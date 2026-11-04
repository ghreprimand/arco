// Server Fold — operator-armed on-demand compaction via Anthropic's
// `compact-2026-09-04` beta (top-level `compaction: {type:'summarize'}`).
// https://platform.claude.com/docs/en/build-with-claude/compaction-on-demand
//
// The third rung between the deterministic Fold (free, instant, lossy digest)
// and COMPACT/Handoff: ONE server summarization call that returns a signed
// `{type:'compaction', content, signature}` block. The block goes FIRST in
// `messages`, replacing everything it summarized; the last few turns are kept
// verbatim after it (thinking included — the API accepts the swap under
// preserved thinking because it wrote the summary, as long as system/tools
// don't change). Pure helpers live here so the worker stays stateful-only and
// the request/cut/fallback logic is unit-testable (serverFold.test.ts).
//
// Fence B (CLAUDE.md): operator-initiated (composer button, no auto trigger),
// cost-visible (compaction `usage.iterations` surfaced in the notice + client
// token accounting), deterministic fallback (any failure → deterministic Fold,
// never fail closed), logged (`context_folded {engine:'server', …}` with byte
// counts), reversible (pre-fold transcript stays in events.jsonl; HISTORY
// rewind / leaf_move to a seq before the marker replays it back).

import type { MessageParam } from './contentBlocks.js';
import { isRecord } from './contentBlocks.js';
import { isArcoSystemMessage, toWireMessages, toolKey, type ToolDefLike } from './appendOnlyPrefix.js';

export const SERVER_FOLD_BETA = 'compact-2026-09-04';

// Keep the last 2 operator turns verbatim after the block. The active working
// set (the files just read, the edit in progress) lives in the last turn or
// two; a Native coding turn is tool-heavy, so keeping more quickly erodes what
// the fold frees ("kept turns go back at full length" — compaction docs).
export const SERVER_FOLD_KEEP_TURNS = 2;

// Byte ceiling on the verbatim tail. The raw tail (thinking signatures, tool
// blocks) is persisted INSIDE the context_folded event so replay reseeds the
// exact same messages; one huge Read result would otherwise bloat events.jsonl
// and push the marker out of the 1 MB exact-replay window. Over budget → keep
// fewer turns, down to zero (summarize everything).
export const SERVER_FOLD_TAIL_MAX_BYTES = 256 * 1024;

// max_tokens caps the whole summarization call INCLUDING thinking (Opus 5.5 /
// Fable 5.1 can't disable it), so allow well beyond the summary itself. The
// call streams, so a large cap has no HTTP-timeout cost.
export const SERVER_FOLD_MAX_TOKENS = 32_000;

// Models listed on the on-demand compaction page (2026-09-25). Anything else
// skips straight to the deterministic Fold instead of spending a 400.
const SERVER_FOLD_MODEL_PREFIXES = [
  'claude-fable-5-1', 'claude-mythos-5-1', 'claude-fable-5', 'claude-mythos-5', 'claude-mythos-preview',
  'claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6',
  'claude-sonnet-5', 'claude-sonnet-4-6',
];

export function supportsServerFold(modelId: string): boolean {
  const id = modelId.replace(/\[1m\]$/i, '');
  return SERVER_FOLD_MODEL_PREFIXES.some((p) => id === p || id.startsWith(`${p}-`) || id.startsWith(`${p}[`));
}

export type ServerCompactionBlock = { type: 'compaction'; content: string; signature?: string; [key: string]: unknown };

function firstBlock(m: unknown): unknown {
  if (!isRecord(m) || !Array.isArray(m.content)) return undefined;
  return m.content[0];
}

// An on-demand block is always FIRST in messages (API rule —
// compaction_block_misplaced otherwise); a threshold (`compact_20260112`)
// block always follows the messages it summarized inside a live turn's
// assistant reply, so position alone tells them apart.
export function hasLeadingServerFoldBlock(messages: readonly unknown[]): boolean {
  const m = messages[0];
  const b = firstBlock(m);
  return isRecord(m) && m.role === 'assistant' && isRecord(b) && b.type === 'compaction';
}

// Threshold-compaction detection that ignores the leading on-demand block, so
// the `compact-2026-01-12` beta keeps its old meaning.
export function historyHasThresholdCompactionBlock(messages: readonly { role?: string; content?: unknown }[]): boolean {
  const lead = hasLeadingServerFoldBlock(messages);
  return messages.some((m, i) => m.role === 'assistant' && Array.isArray(m.content)
    && m.content.some((b, j) => isRecord(b) && b.type === 'compaction' && !(lead && i === 0 && j === 0)));
}

function isTurnStart(m: unknown): boolean {
  if (!isRecord(m) || m.role !== 'user') return false;
  if (typeof m.content === 'string') return true;
  return Array.isArray(m.content) && !m.content.some((b) => isRecord(b) && b.type === 'tool_result');
}

export interface ServerFoldCut {
  cut: number;        // messages[0, cut) are summarized; [cut, len) kept verbatim
  keptTurns: number;
  tailBytes: number;
}

// Cut only between a finished assistant reply and the next OPERATOR user
// message: no tool call straddles the cut, and the first kept message has a
// different role from the last summarized one (the docs' condition for kept
// thinking to stay valid — same-role would be merged into the summary).
// Returns null when there is nothing older than the kept tail to summarize.
export function chooseServerFoldCut(
  messages: readonly unknown[],
  keepTurns = SERVER_FOLD_KEEP_TURNS,
  maxTailBytes = SERVER_FOLD_TAIL_MAX_BYTES,
): ServerFoldCut | null {
  const minCut = hasLeadingServerFoldBlock(messages) ? 2 : 1;
  const candidates: number[] = [];
  for (let i = minCut; i < messages.length; i++) {
    const prev = messages[i - 1];
    if (isTurnStart(messages[i]) && isRecord(prev) && prev.role === 'assistant') candidates.push(i);
  }
  for (let k = Math.min(keepTurns, candidates.length); k >= 1; k--) {
    const cut = candidates[candidates.length - k];
    const tailBytes = Buffer.byteLength(JSON.stringify(messages.slice(cut)), 'utf8');
    if (tailBytes <= maxTailBytes) return { cut, keptTurns: k, tailBytes };
  }
  // Keep nothing: the whole history is summarized. Needs something beyond an
  // existing block, or the call would only re-summarize a summary.
  if (messages.length < minCut) return null;
  return { cut: messages.length, keptTurns: 0, tailBytes: 0 };
}

export interface ServerFoldRequestInput {
  model: string;
  system: unknown[];
  tools: unknown[];
  thinkingParams: Record<string, unknown>;
  messages: readonly unknown[];
  maxTokens?: number;
}

// The compaction request: the SAME model / system / tools / thinking as the
// conversation's normal rounds (kept thinking stays valid only if system and
// tools match), with `compaction` added and every field the API rejects on a
// summarization call left out: context_management (can't combine), tool_choice
// any/tool, stop_sequences, output_config.format, task_budget.remaining.
export function buildServerFoldRequest(input: ServerFoldRequestInput): Record<string, unknown> {
  const thinking = { ...input.thinkingParams };
  if (isRecord(thinking.output_config)) {
    const oc = { ...(thinking.output_config as Record<string, unknown>) };
    delete oc.format;
    if (isRecord(oc.task_budget)) {
      const tb = { ...(oc.task_budget as Record<string, unknown>) };
      delete tb.remaining;
      oc.task_budget = tb;
    }
    thinking.output_config = oc;
  }
  delete thinking.context_management;
  delete thinking.tool_choice;
  delete thinking.stop_sequences;
  return {
    model: input.model,
    max_tokens: input.maxTokens ?? SERVER_FOLD_MAX_TOKENS,
    // Reads the conversation's warm cache; verified accepted on the OAuth path.
    cache_control: { type: 'ephemeral' },
    system: input.system,
    messages: toWireMessages(input.messages),
    ...(input.tools.length > 0 ? { tools: input.tools } : {}),
    stream: true,
    ...thinking,
    compaction: { type: 'summarize' },
  };
}

export interface ServerFoldUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

export interface ServerFoldResult {
  stopReason: string | null;
  block: ServerCompactionBlock | null;
  usage: ServerFoldUsage;
}

// Top-level usage is ZERO on a compaction response ("no reply was generated");
// the summarizer's real spend is the `{type:'compaction'}` entry in
// usage.iterations. Fall back to top-level only when iterations are absent.
export function compactionUsageFrom(usage: unknown): ServerFoldUsage {
  const out: ServerFoldUsage = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  if (!isRecord(usage)) return out;
  const add = (u: Record<string, unknown>): void => {
    if (typeof u.input_tokens === 'number') out.input += u.input_tokens;
    if (typeof u.output_tokens === 'number') out.output += u.output_tokens;
    if (typeof u.cache_read_input_tokens === 'number') out.cacheRead += u.cache_read_input_tokens;
    if (typeof u.cache_creation_input_tokens === 'number') out.cacheCreate += u.cache_creation_input_tokens;
  };
  const its = Array.isArray(usage.iterations) ? usage.iterations.filter((it) => isRecord(it) && it.type === 'compaction') : [];
  if (its.length > 0) for (const it of its) add(it as Record<string, unknown>);
  else add(usage);
  return out;
}

// Streamed compaction responses deliver the block WHOLE in one
// content_block_start (no deltas); tolerate compaction_delta anyway.
export async function consumeServerFoldStream(stream: AsyncIterable<unknown>): Promise<ServerFoldResult> {
  let block: ServerCompactionBlock | null = null;
  let stopReason: string | null = null;
  let usage: unknown;
  for await (const raw of stream) {
    if (!isRecord(raw)) continue;
    const ev = raw as Record<string, unknown>;
    if (ev.type === 'message_start' && isRecord(ev.message)) {
      usage = (ev.message as Record<string, unknown>).usage;
    } else if (ev.type === 'content_block_start' && isRecord(ev.content_block) && ev.content_block.type === 'compaction') {
      const cb = ev.content_block as Record<string, unknown>;
      block = { ...cb, type: 'compaction', content: typeof cb.content === 'string' ? cb.content : '' };
    } else if (ev.type === 'content_block_delta' && isRecord(ev.delta) && block) {
      const d = ev.delta as Record<string, unknown>;
      if (d.type === 'compaction_delta' && typeof d.content === 'string') block.content += d.content;
      if (typeof d.signature === 'string') block.signature = d.signature;
    } else if (ev.type === 'message_delta') {
      if (isRecord(ev.delta) && typeof ev.delta.stop_reason === 'string') stopReason = ev.delta.stop_reason;
      // Cumulative per message — take the latest, never sum.
      if (isRecord(ev.usage)) usage = { ...(isRecord(usage) ? usage : {}), ...ev.usage };
    }
  }
  if (block && !block.content.trim()) block = null;
  return { stopReason, block, usage: compactionUsageFrom(usage) };
}

// Any non-`compaction` stop leaves history untouched (docs § Handle a missing
// summary). Readable reason for the operator notice.
export function serverFoldMissingReason(stopReason: string | null): string {
  switch (stopReason) {
    case 'max_tokens': return 'summary was cut off (max_tokens)';
    case 'model_context_window_exceeded': return 'no room left in the context window for the summarization prompt';
    case 'tool_use': return 'the summarizer called a tool instead of writing a summary';
    case 'refusal': return 'the summarization request was declined';
    case 'compaction': return 'compaction block came back empty';
    default: return `no summary returned (stop_reason=${stopReason ?? 'none'})`;
  }
}

export type ServerFoldFailureKind = 'unsupported' | 'failed';

// 4xx that names the beta / parameter / block type → this account, model or
// surface doesn't take on-demand compaction (OAuth availability is not
// documented). Everything else (429, 5xx, network, missing summary) is a
// one-off failure. Both fall back to the deterministic Fold; the kind only
// shapes the notice.
export function classifyServerFoldError(err: unknown): { kind: ServerFoldFailureKind; detail: string } {
  const status = isRecord(err) && typeof err.status === 'number' ? err.status : undefined;
  const detail = (err instanceof Error ? err.message : String(err)).slice(0, 300);
  const m = detail.toLowerCase();
  const namesFeature = m.includes('compaction') || m.includes('compact-2026-09-04') || m.includes('anthropic-beta')
    || m.includes('extra inputs are not permitted');
  if (status !== undefined && status >= 400 && status < 500 && status !== 429 && namesFeature) {
    return { kind: 'unsupported', detail };
  }
  return { kind: 'failed', detail };
}

// Live AND replay seed. Both sites feed it the SAME persisted block + kept
// messages, so a restarted worker lands byte-identical to the live one.
export function serverFoldSeed(block: ServerCompactionBlock, keptMessages: readonly unknown[] = []): MessageParam[] {
  return [
    { role: 'assistant', content: [structuredClone(block)] } as unknown as MessageParam,
    ...(structuredClone(keptMessages) as MessageParam[]),
  ];
}

// COMPACT and the deterministic Fold summarize a clean text projection and
// reseed via compactSummarySeed. Turn a leading on-demand block into plain
// summary text first so those paths neither drop it (it's a non-text block)
// nor send a signed block they no longer need the beta for.
export function demoteLeadingServerFoldBlock(
  messages: MessageParam[],
  seed: (summary: string) => MessageParam[],
): boolean {
  if (!hasLeadingServerFoldBlock(messages)) return false;
  const b = firstBlock(messages[0]) as ServerCompactionBlock;
  const rest = (messages[0].content as unknown[]).slice(1);
  const replacement = seed(typeof b.content === 'string' ? b.content : '');
  if (rest.length > 0) replacement.push({ role: 'assistant', content: rest } as MessageParam);
  messages.splice(0, 1, ...replacement);
  return true;
}

// Mid-conversation tool changes in the summarized range are gone with it
// (docs § Change the system prompt or tools: restate them). Rebuild the active
// set from the frozen base (non-deferred tools) plus the tool_addition /
// tool_removal blocks that survive in the kept tail; the worker's next
// prefix diff then re-appends whatever the live set still differs by.
export function activeToolKeysAfterServerFold(frozenTools: readonly ToolDefLike[], keptMessages: readonly unknown[]): Set<string> {
  const active = new Set(frozenTools.filter((t) => t.defer_loading !== true).map(toolKey));
  const byName = new Map<string, string>();
  for (const t of frozenTools) {
    const key = toolKey(t);
    const idx = key.indexOf(':');
    byName.set(idx >= 0 ? key.slice(idx + 1) : key, key);
  }
  for (const m of keptMessages) {
    if (!isArcoSystemMessage(m)) continue;
    for (const b of m.content) {
      if (b.type !== 'tool_addition' && b.type !== 'tool_removal') continue;
      const key = byName.get(b.tool.name);
      if (!key) continue;
      if (b.type === 'tool_addition') active.add(key);
      else active.delete(key);
    }
  }
  return active;
}

export function countTurnStarts(messages: readonly unknown[]): number {
  return messages.filter(isTurnStart).length;
}
