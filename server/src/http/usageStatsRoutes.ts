import { IncomingMessage, ServerResponse } from 'http';
import { createReadStream } from 'fs';
import { promises as fs } from 'fs';
import { createInterface } from 'readline';
import path from 'path';
import { PORT } from '../server/constants.js';
import type {
  PrimaryTurnTokenUsageMessage,
  ProviderName,
  UsageDayBucket,
  UsageProviderStats,
  UsageStatsResponse,
  UsageTotals,
} from '@archon/shared';

// Workbench Expansion §D3 — Usage analytics over time.
//
//   GET /api/usage-stats?path=<cwd>[&from=<epochMs>][&to=<epochMs>]
//     → aggregate every workflow's existing `primary_turn_token_usage` events
//       under <cwd>/.archon/workflows/, bucketed per (provider, local-day).
//
// DETERMINISTIC, READ-ONLY, NO NEW CAPTURE: this only sums events already on
// disk; it never spawns an LLM, never writes, never mutates events.jsonl. The
// four-question test clears trivially — operator opens the view, sees
// deterministic sums of source events that are already in events.jsonl,
// nothing to undo. (CLAUDE.md fences.)
//
// FRAMING: quota-pressure / token-volume insight only. NO USD anywhere — the
// operator is on subscriptions, so the question is "which tab/model ate my
// rolling window", never cost.
//
// CACHE-HIT RATIO denominator differs by provider shape (see
// shared/src/protocol/usage.ts):
//   Claude/Anthropic: input/cacheRead/cacheCreate are DISJOINT → prompt =
//     input + cacheRead + cacheCreate, ratio = cacheRead / that sum.
//   Codex/OpenAI: input IS the full prompt, cacheRead is a SUBSET → prompt =
//     input, ratio = cacheRead / input.
//   Ollama/llama.cpp/others: no cache layer → cacheRead 0 → ratio 0.
// So a Claude turn and a Codex turn with identical raw numbers yield DIFFERENT
// ratios. The aggregator picks the denominator per (provider) bucket.

// Day bucketing uses the SERVER-LOCAL timezone: turnStartedAt (epoch ms) is
// formatted to YYYY-MM-DD via the local calendar. This matches the operator's
// own "what did I do today" mental model when Archon runs on their machine.
const WFID_PATTERN = /^[a-zA-Z0-9-]{1,64}$/;

// Providers whose token shape is Anthropic-style (input/cacheRead/cacheCreate
// disjoint). Everything else is treated OpenAI-style (input is the full
// prompt). Codex/Ollama/llamacpp/gemini all fall through to the OpenAI branch;
// gemini/ollama/llamacpp report cacheRead 0 so their ratio is 0 regardless.
function promptTokensFor(provider: ProviderName, ev: PrimaryTurnTokenUsageMessage): number {
  if (provider === 'claude') {
    return ev.input + ev.cacheRead + ev.cacheCreate;
  }
  // Codex/OpenAI shape and the no-cache locals: the prompt size is `input`.
  return ev.input;
}

function localDay(epochMs: number): string {
  const d = new Date(epochMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function emptyTotals(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, turns: 0, promptTokens: 0, cacheHitRatio: 0 };
}

function ratio(cacheRead: number, promptTokens: number): number {
  return promptTokens > 0 ? cacheRead / promptTokens : 0;
}

export interface AggregateUsageOptions {
  // Inclusive epoch-ms window on turnStartedAt. Either may be omitted.
  from?: number;
  to?: number;
  // Count of workflows scanned, threaded through for the response. The pure
  // function doesn't scan fs itself, so the caller passes what it found.
  workflowsScanned?: number;
}

// Pure aggregation over a flat array of `primary_turn_token_usage` events.
// Extracted from the HTTP/fs layer so the smoke can unit-test the sums + the
// per-provider cache-ratio denominator without touching the network or disk.
// Malformed entries (missing numeric fields, unknown provider) are skipped, so
// a caller can hand it raw parsed JSONL lines without pre-filtering.
export function aggregateUsage(
  events: unknown[],
  opts: AggregateUsageOptions = {},
): UsageStatsResponse {
  const perProvider: Partial<Record<ProviderName, UsageProviderStats>> = {};
  // (provider → (day → bucket)) working maps; flattened + sorted at the end.
  const byDayMaps = new Map<ProviderName, Map<string, UsageDayBucket>>();
  const grand = emptyTotals();
  const allDays = new Set<string>();
  let turnsAggregated = 0;
  let minTs = Number.POSITIVE_INFINITY;
  let maxTs = Number.NEGATIVE_INFINITY;

  for (const raw of events) {
    const ev = raw as Partial<PrimaryTurnTokenUsageMessage> | null;
    if (!ev || typeof ev !== 'object') continue;
    if (ev.type !== 'primary_turn_token_usage') continue;
    const provider = ev.provider as ProviderName | undefined;
    if (!provider || typeof provider !== 'string') continue;
    // The four token fields + turnStartedAt must all be finite numbers, else
    // the line is malformed/partial and we skip it rather than poison a sum.
    const ts = ev.turnStartedAt;
    if (typeof ts !== 'number' || !Number.isFinite(ts)) continue;
    const input = ev.input;
    const output = ev.output;
    const cacheRead = ev.cacheRead;
    const cacheCreate = ev.cacheCreate;
    if (
      typeof input !== 'number' || !Number.isFinite(input) ||
      typeof output !== 'number' || !Number.isFinite(output) ||
      typeof cacheRead !== 'number' || !Number.isFinite(cacheRead) ||
      typeof cacheCreate !== 'number' || !Number.isFinite(cacheCreate)
    ) {
      continue;
    }
    if (opts.from !== undefined && ts < opts.from) continue;
    if (opts.to !== undefined && ts > opts.to) continue;

    const full = ev as PrimaryTurnTokenUsageMessage;
    const promptTokens = promptTokensFor(provider, full);
    const day = localDay(ts);
    allDays.add(day);
    if (ts < minTs) minTs = ts;
    if (ts > maxTs) maxTs = ts;
    turnsAggregated++;

    let dayMap = byDayMaps.get(provider);
    if (!dayMap) {
      dayMap = new Map();
      byDayMaps.set(provider, dayMap);
    }
    let bucket = dayMap.get(day);
    if (!bucket) {
      bucket = { day, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, turns: 0, promptTokens: 0, cacheHitRatio: 0 };
      dayMap.set(day, bucket);
    }
    bucket.input += input;
    bucket.output += output;
    bucket.cacheRead += cacheRead;
    bucket.cacheCreate += cacheCreate;
    bucket.promptTokens += promptTokens;
    bucket.turns += 1;

    let stats = perProvider[provider];
    if (!stats) {
      stats = { byDay: [], totals: emptyTotals() };
      perProvider[provider] = stats;
    }
    stats.totals.input += input;
    stats.totals.output += output;
    stats.totals.cacheRead += cacheRead;
    stats.totals.cacheCreate += cacheCreate;
    stats.totals.promptTokens += promptTokens;
    stats.totals.turns += 1;

    grand.input += input;
    grand.output += output;
    grand.cacheRead += cacheRead;
    grand.cacheCreate += cacheCreate;
    grand.promptTokens += promptTokens;
    grand.turns += 1;
  }

  // Flatten the per-day maps into ascending-by-day arrays + finalize ratios.
  for (const [provider, dayMap] of byDayMaps) {
    const stats = perProvider[provider]!;
    const days = [...dayMap.keys()].sort();
    stats.byDay = days.map((d) => {
      const b = dayMap.get(d)!;
      b.cacheHitRatio = ratio(b.cacheRead, b.promptTokens);
      return b;
    });
    stats.totals.cacheHitRatio = ratio(stats.totals.cacheRead, stats.totals.promptTokens);
  }
  grand.cacheHitRatio = ratio(grand.cacheRead, grand.promptTokens);

  return {
    days: [...allDays].sort(),
    perProvider,
    grandTotals: grand,
    from: turnsAggregated > 0 ? (opts.from !== undefined ? opts.from : minTs) : null,
    to: turnsAggregated > 0 ? (opts.to !== undefined ? opts.to : maxTs) : null,
    workflowsScanned: opts.workflowsScanned ?? 0,
    turnsAggregated,
  };
}

// Stream one workflow's events.jsonl line-by-line, pushing parsed
// primary_turn_token_usage objects into `out`. Read line-by-line (not
// wholesale) because a long-lived workflow's events.jsonl can grow large and
// this route may scan many of them; a bad JSON line is skipped, not thrown
// (mirrors recall/index.ts's tolerant read).
async function collectWorkflowUsage(cwd: string, wfid: string, out: unknown[]): Promise<void> {
  if (!WFID_PATTERN.test(wfid)) return;
  const eventsPath = path.join(cwd, '.archon', 'workflows', wfid, 'events.jsonl');
  let stream;
  try {
    stream = createReadStream(eventsPath, { encoding: 'utf8' });
  } catch {
    return;
  }
  try {
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      // Cheap pre-filter before JSON.parse — most lines aren't usage events.
      if (!line || !line.includes('"primary_turn_token_usage"')) continue;
      let entry: unknown;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry && typeof entry === 'object' && (entry as { type?: unknown }).type === 'primary_turn_token_usage') {
        out.push(entry);
      }
    }
  } catch {
    // A mid-stream read error (truncated file, races with a live writer) just
    // ends this workflow's contribution — never a 500.
  }
}

// Scan every workflow under <cwd>/.archon/workflows/, collect their usage
// events, and aggregate. Exported so the smoke can drive the fs path against a
// temp cwd without booting HTTP.
export async function aggregateUsageForCwd(
  cwd: string,
  opts: { from?: number; to?: number } = {},
): Promise<UsageStatsResponse> {
  const events: unknown[] = [];
  let workflowsScanned = 0;
  if (cwd) {
    const workflowsDir = path.join(cwd, '.archon', 'workflows');
    let names: string[] = [];
    try {
      names = await fs.readdir(workflowsDir);
    } catch {
      names = [];
    }
    for (const name of names) {
      if (!WFID_PATTERN.test(name)) continue;
      const before = events.length;
      await collectWorkflowUsage(cwd, name, events);
      // Count a workflow as scanned even if it had no usage events — the
      // operator's "across N conversations" read should reflect the directory
      // count, not just contributors. (We still skip non-wfid entries above.)
      void before;
      workflowsScanned++;
    }
  }
  return aggregateUsage(events, { ...opts, workflowsScanned });
}

function parseEpoch(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

export async function tryHandleUsageStatsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const send = (code: number, body: unknown): true => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
    return true;
  };

  if (req.url?.startsWith('/api/usage-stats') && req.method === 'GET') {
    try {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const cwd = url.searchParams.get('path') || '';
      if (!cwd) {
        return send(400, { error: 'path query required' });
      }
      const from = parseEpoch(url.searchParams.get('from'));
      const to = parseEpoch(url.searchParams.get('to'));
      const body = await aggregateUsageForCwd(cwd, { from, to });
      return send(200, body);
    } catch (err) {
      // Degrade to an empty aggregation rather than a 500 so the analytics
      // view renders an empty state instead of an error (mirrors recall).
      console.error('[archon] usage-stats aggregation failed:', err);
      const empty: UsageStatsResponse = {
        days: [],
        perProvider: {},
        grandTotals: emptyTotals(),
        from: null,
        to: null,
        workflowsScanned: 0,
        turnsAggregated: 0,
      };
      return send(200, empty);
    }
  }

  return false;
}
