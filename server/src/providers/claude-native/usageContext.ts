// Context size from a Claude Messages response's usage.
//
// A response that ran server tools (web search, web fetch, code execution)
// samples several times inside one request. Its top-level usage fields are
// the SUM over those passes: right for billing, wrong as a prompt size. One
// research round with eleven passes of 90k tokens reads as 990k, so a
// compaction keyed on it fires at "97%" with the real context under 30%.
// `usage.iterations`, when the API sends it, lists each pass; the last
// `message` pass is the real prompt size. Without it the only honest figure
// for a multi-pass round comes from count_tokens, which the worker runs.
//
// Everything here is pure so the rules can be tested without a worker.

import { isServerToolResultType } from './retainedContext.js';

export type UsageIteration = {
  type?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

const PROMPT_KEYS = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const;
const BILLED_KEYS = [...PROMPT_KEYS, 'output_tokens'] as const;

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

// cache_read + cache_creation + input: the prompt the model saw, for ONE pass.
export function promptTokensOf(usage: Record<string, unknown> | undefined): number {
  if (!usage) return 0;
  return PROMPT_KEYS.reduce((sum, k) => sum + num(usage[k]), 0);
}

function iterationList(raw: unknown): UsageIteration[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((it): it is UsageIteration => typeof it === 'object' && it !== null);
}

// The prompt size of the last message pass listed in `usage.iterations`, or
// undefined when the array is absent or holds no message pass. A compaction
// pass (type 'compaction') is a summarizer run, not a prompt size.
export function lastPassPromptTokens(raw: unknown): number | undefined {
  const passes = iterationList(raw).filter((it) => it.type !== 'compaction');
  if (passes.length === 0) return undefined;
  const tokens = promptTokensOf(passes[passes.length - 1] as Record<string, unknown>);
  return tokens > 0 ? tokens : undefined;
}

// True when the response carried a server tool call or result, so the API
// sampled more than once and the top-level usage is a sum over passes.
export function roundUsedServerTools(blocks: readonly { type?: string; [key: string]: unknown }[]): boolean {
  return blocks.some((b) => b.type === 'server_tool_use' || (typeof b.type === 'string' && isServerToolResultType(b.type)));
}

export type RoundPromptMeasure =
  | { tokens: number; source: 'iterations' | 'usage' }
  | { tokens: undefined; source: 'multi-pass' | 'none' };

// The prompt size of one streamed round for context decisions. Order:
// `usage.iterations` (last message pass); the top-level usage, only when the
// round had no server-tool passes; otherwise no number. A caller that gets
// `multi-pass` measures with count_tokens or skips the decision. It never
// reads the multi-pass sum as a context size.
export interface MeasurableRound {
  usage?: Record<string, number> | undefined;
  contentBlocks: readonly { type?: string; [key: string]: unknown }[];
  usageIterations?: unknown;
}

export function roundPromptTokens(round: MeasurableRound): RoundPromptMeasure {
  const fromIterations = lastPassPromptTokens(round.usageIterations);
  if (fromIterations !== undefined) return { tokens: fromIterations, source: 'iterations' };
  if (!round.usage) return { tokens: undefined, source: 'none' };
  if (roundUsedServerTools(round.contentBlocks)) return { tokens: undefined, source: 'multi-pass' };
  const tokens = promptTokensOf(round.usage);
  return tokens > 0 ? { tokens, source: 'usage' } : { tokens: undefined, source: 'none' };
}

// Usage for billing and the USAGE totals. The top-level fields already sum
// the message passes but leave a compaction pass out (Anthropic: "the
// top-level input_tokens and output_tokens do not include compaction
// iteration usage"). When iterations list a compaction pass, the billed
// figures are the sum over every pass; otherwise the top-level fields stand.
export function billableRoundUsage(usage: Record<string, number> | undefined, raw: unknown): Record<string, number> | undefined {
  const iterations = iterationList(raw);
  if (!iterations.some((it) => it.type === 'compaction')) return usage;
  const out: Record<string, number> = { ...(usage ?? {}) };
  for (const k of BILLED_KEYS) out[k] = iterations.reduce((sum, it) => sum + num((it as Record<string, unknown>)[k]), 0);
  return out;
}
