// §2.2 — tool-result eviction (Claude Native).
//
// Two deterministic, LLM-free mechanisms for keeping tool output from
// monopolizing the context window, sharing one semantic-1-liner extractor:
//
//   • planTurnSpill — the per-turn AGGREGATE spill (the merged delta). After a
//     turn's tool results are gathered, if their summed token cost exceeds a
//     turn budget, the largest results are replaced with a 1-liner digest,
//     largest-first, until the retained sum is back under budget. Cache-safe:
//     it only rewrites the just-finished turn's results, before they are ever
//     sent (and thus before any cache breakpoint forms over them).
//
//   • planTailEviction — the cross-turn TAIL eviction (reused by §2.1 Fold).
//     Keeps the most-recent results (a token-budget tail) verbatim and spills
//     everything older to 1-liners. This DOES rewrite prior turns, so it is a
//     deliberate cache break and only runs inside the Fold path, which already
//     accepts that cost. Built + tested here; applied by §2.1.
//
// The 1-liner is the "re-enables what clear_tool_uses gave up, without its
// regression" piece: never a bare deletion — always an informative receipt
// (`[Bash] npm test → exit 0 · 47 lines`) so the model knows the call happened
// and what it produced, and the raw output is retained (gzipped) + byte-logged
// + reversible by the worker that calls this.
//
// Pure: no I/O, no model calls. The worker handles gzip retention + events.

export interface EvictableResult {
  toolUseId: string;
  // Resolved from the paired tool_use block; '' when unknown (still summarized
  // generically). Drives the `[ToolName]` prefix.
  toolName: string;
  // The tool_use input JSON (for naming the target — file path, command,
  // pattern). Optional; the summary degrades gracefully without it.
  inputJson?: string;
  // The tool_result text content as it currently sits in messages[].
  content: string;
  isError?: boolean;
}

export interface SpillDecision {
  toolUseId: string;
  summary: string;
  originalTokens: number;
  summaryTokens: number;
  savedTokens: number;
}

export interface SpillPlan {
  spill: SpillDecision[];
  // Token totals across ALL input results (spilled summarized, kept verbatim).
  originalTokens: number;
  keptTokens: number;
  savedTokens: number;
}

// Operator-arm gate for the per-turn aggregate spill. Off by default — see the
// header note on the clear_tool_uses regression. ARCO_TOOL_EVICT=on|1 turns
// it on for the whole server process. (§2.1's context-management config will
// add the per-tab CONFIG toggle on top of this floor.)
export function toolEvictEnabled(): boolean {
  const v = process.env.ARCO_TOOL_EVICT;
  return v === 'on' || v === '1' || v === 'true';
}

// Per-batch token budget for the spill. A round's summed tool output above this
// triggers largest-first eviction. Deliberately generous (default ~20K tokens
// ≈ 80 KB) so only genuinely fat batches are touched. Override via
// ARCO_TURN_TOOL_TOKEN_BUDGET; clamped to a sane floor so a typo can't make
// the gate spill everything.
const DEFAULT_TURN_TOOL_TOKEN_BUDGET = 20_000;
export function turnToolTokenBudget(): number {
  const raw = Number(process.env.ARCO_TURN_TOOL_TOKEN_BUDGET);
  if (Number.isFinite(raw) && raw > 0) return Math.max(2_000, Math.round(raw));
  return DEFAULT_TURN_TOOL_TOKEN_BUDGET;
}

// Coarse, deterministic token estimate: UTF-8 bytes / 4. Eviction only needs a
// relative ordering + a budget comparison, so an approximation that slightly
// over-counts large blobs is the right tradeoff (matches the codebase's other
// "coarse over-count so it can't sneak past the gate" estimators).
export function estimateResultTokens(content: string): number {
  return Math.ceil(Buffer.byteLength(content ?? '', 'utf8') / 4);
}

function countLines(s: string): number {
  if (!s) return 0;
  // Trailing newline shouldn't inflate the count by one.
  const trimmed = s.endsWith('\n') ? s.slice(0, -1) : s;
  return trimmed.length === 0 ? 0 : trimmed.split('\n').length;
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function firstField(inputJson: string | undefined, keys: string[]): string | undefined {
  if (!inputJson) return undefined;
  try {
    const obj = JSON.parse(inputJson) as Record<string, unknown>;
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === 'string' && v.length > 0) return v;
    }
  } catch { /* malformed input — fall through to undefined */ }
  return undefined;
}

function shorten(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine;
}

// Build the semantic 1-liner digest for a tool result. Tool-aware where it
// helps the model recall what ran; generic (lines/bytes) otherwise. Always
// returns a single line with the `[Arco evicted]` marker so the model and
// the operator both see it was a deliberate, reversible trim — never silent.
export function summarizeToolResultLine(
  toolName: string,
  inputJson: string | undefined,
  content: string,
  isError?: boolean,
): string {
  const lines = countLines(content);
  const bytes = Buffer.byteLength(content ?? '', 'utf8');
  const label = toolName || 'Tool';
  let head: string;
  switch (toolName) {
    case 'Bash': {
      const cmd = firstField(inputJson, ['command']);
      const status = isError ? 'error' : 'ok';
      head = cmd ? `[Bash] ${shorten(cmd, 80)} → ${status}` : `[Bash] → ${status}`;
      break;
    }
    case 'Read': {
      const f = firstField(inputJson, ['file_path', 'path']);
      head = f ? `[Read] ${f}` : '[Read]';
      break;
    }
    case 'Write':
    case 'Edit':
    case 'NotebookEdit': {
      const f = firstField(inputJson, ['file_path', 'path', 'notebook_path']);
      const status = isError ? 'error' : 'ok';
      head = f ? `[${label}] ${f} → ${status}` : `[${label}] → ${status}`;
      break;
    }
    case 'Grep': {
      const p = firstField(inputJson, ['pattern']);
      head = p ? `[Grep] ${shorten(p, 60)}` : '[Grep]';
      break;
    }
    case 'Glob': {
      const p = firstField(inputJson, ['pattern', 'path']);
      head = p ? `[Glob] ${shorten(p, 60)}` : '[Glob]';
      break;
    }
    case 'WebFetch':
    case 'WebSearch': {
      const u = firstField(inputJson, ['url', 'query']);
      head = u ? `[${label}] ${shorten(u, 80)}` : `[${label}]`;
      break;
    }
    default:
      head = `[${label}]`;
  }
  // Tail metric: always the byte size (so a huge single-line blob — minified
  // JSON, a long log line — can't masquerade as "1 line"), with the line count
  // prepended when it's genuinely multi-line. Gives the model an honest sense
  // of what it's no longer seeing.
  const metric = lines > 1 ? `${lines} lines · ${humanBytes(bytes)}` : humanBytes(bytes);
  const err = isError ? ' [was error]' : '';
  return `[Arco evicted: ${head} · ${metric}${err}; raw retained — re-run or open the raw artifact to recover]`;
}

function decide(r: EvictableResult): SpillDecision {
  const summary = summarizeToolResultLine(r.toolName, r.inputJson, r.content, r.isError);
  const originalTokens = estimateResultTokens(r.content);
  const summaryTokens = estimateResultTokens(summary);
  return {
    toolUseId: r.toolUseId,
    summary,
    originalTokens,
    summaryTokens,
    savedTokens: Math.max(0, originalTokens - summaryTokens),
  };
}

// Per-turn aggregate spill. Sum this turn's results; if over budget, spill
// largest-first until the retained total is back under budget. A result whose
// 1-liner wouldn't actually shrink it (tiny output) is never spilled — no point
// paying a cache rewrite for zero savings.
export function planTurnSpill(results: EvictableResult[], turnTokenBudget: number): SpillPlan {
  const decisions = results.map(decide);
  const originalTokens = decisions.reduce((a, d) => a + d.originalTokens, 0);
  if (turnTokenBudget <= 0 || originalTokens <= turnTokenBudget) {
    return { spill: [], originalTokens, keptTokens: originalTokens, savedTokens: 0 };
  }
  // Largest first; only those that actually save tokens are eligible.
  const eligible = decisions.filter((d) => d.savedTokens > 0).sort((a, b) => b.originalTokens - a.originalTokens);
  const spill: SpillDecision[] = [];
  let retained = originalTokens;
  for (const d of eligible) {
    if (retained <= turnTokenBudget) break;
    spill.push(d);
    retained -= d.savedTokens;
  }
  const savedTokens = spill.reduce((a, d) => a + d.savedTokens, 0);
  return { spill, originalTokens, keptTokens: originalTokens - savedTokens, savedTokens };
}

// Cross-turn tail eviction (reused by §2.1 Fold). `resultsChrono` is oldest →
// newest. The newest results whose summed tokens fit within `tailTokenBudget`
// are kept verbatim; everything older is spilled to 1-liners. A result that
// wouldn't shrink is left verbatim even when "old".
export function planTailEviction(resultsChrono: EvictableResult[], tailTokenBudget: number): SpillPlan {
  const decisions = resultsChrono.map(decide);
  const originalTokens = decisions.reduce((a, d) => a + d.originalTokens, 0);
  // Walk newest → oldest, accumulating into the protected tail.
  let tail = 0;
  let firstOldIdx = decisions.length; // everything at/after this stays; before is candidate
  for (let i = decisions.length - 1; i >= 0; i--) {
    const next = tail + decisions[i].originalTokens;
    if (next > tailTokenBudget) { firstOldIdx = i + 1; break; }
    tail = next;
    firstOldIdx = i;
  }
  const spill: SpillDecision[] = [];
  for (let i = 0; i < firstOldIdx; i++) {
    if (decisions[i].savedTokens > 0) spill.push(decisions[i]);
  }
  const savedTokens = spill.reduce((a, d) => a + d.savedTokens, 0);
  return { spill, originalTokens, keptTokens: originalTokens - savedTokens, savedTokens };
}
