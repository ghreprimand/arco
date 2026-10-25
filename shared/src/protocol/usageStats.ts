// Workbench Expansion §D3 — Usage analytics over time protocol types.
//
// A deterministic, read-only AGGREGATION of every workflow's existing
// `primary_turn_token_usage` events under one cwd, bucketed per (provider,
// local-day). No new capture, no LLM, never mutates events.jsonl — it just
// sums what's already on disk so the operator can SEE which tab/model is
// eating their rolling window.
//
// FRAMING: quota-pressure / token-volume insight ONLY. There is deliberately
// no USD / cost field anywhere in this surface — the operator is on
// subscriptions, so the load-bearing question is "where did my tokens go this
// window", never "what did it cost".
//
// CACHE-HIT RATIO — the denominator differs by provider shape (see
// shared/src/protocol/usage.ts for the canonical read):
//   Anthropic/Claude: input/cacheRead/cacheCreate are DISJOINT and sum to the
//     prompt size, so prompt = input + cacheRead + cacheCreate and
//     cacheHitRatio = cacheRead / (input + cacheRead + cacheCreate).
//   OpenAI/Codex: input IS the full prompt size and cacheRead is a SUBSET of
//     it, so prompt = input and cacheHitRatio = cacheRead / input.
//   Ollama/llama.cpp: no cache layer → cacheRead is 0 → ratio is 0.
// The aggregator picks the denominator per (provider) bucket so a Claude turn
// and a Codex turn with identical raw numbers yield DIFFERENT ratios.

import type { ProviderName } from './providers.js';

// One (provider, day) bucket of summed token volume. `promptTokens` is the
// provider-correct prompt size (the cache-ratio denominator); `cacheHitRatio`
// is in [0,1] (0 when there's no prompt volume or no cache layer).
export interface UsageDayBucket {
  // Local calendar day, YYYY-MM-DD (server-local timezone — see the route doc).
  day: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  // Count of `primary_turn_token_usage` events folded into this bucket.
  turns: number;
  // Provider-correct prompt size summed across the bucket's turns:
  //   Claude → input + cacheRead + cacheCreate ; Codex/others → input.
  promptTokens: number;
  // cacheRead / promptTokens for the bucket, in [0,1]; 0 when promptTokens===0.
  cacheHitRatio: number;
}

// Bucket-shaped totals without the per-day `day` field.
export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  turns: number;
  promptTokens: number;
  cacheHitRatio: number;
}

export interface UsageProviderStats {
  // Ascending-by-day, sparse (only days this provider had turns).
  byDay: UsageDayBucket[];
  totals: UsageTotals;
}

// GET /api/usage-stats?path=<cwd>[&from=<epochMs>][&to=<epochMs>]
export interface UsageStatsResponse {
  // Union of every provider's active days, ascending YYYY-MM-DD. The client
  // uses this as the shared x-axis so per-provider sparklines line up.
  days: string[];
  // Per-provider breakdown, keyed by ProviderName (only providers with turns
  // in range appear).
  perProvider: Partial<Record<ProviderName, UsageProviderStats>>;
  grandTotals: UsageTotals;
  // Inclusive epoch-ms window actually applied (echoes the query, or the
  // observed min/max turnStartedAt when the query omitted bounds). null when
  // no turns matched.
  from: number | null;
  to: number | null;
  // Number of workflows scanned + number of turn-usage events aggregated.
  // Surfaced so the view can show "12 turns across 3 conversations".
  workflowsScanned: number;
  turnsAggregated: number;
}
