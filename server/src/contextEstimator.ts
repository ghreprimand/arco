import { readFile, stat } from 'fs/promises';
import { lastPassPromptTokens, promptTokensOf, roundUsedServerTools } from './providers/claude-native/usageContext.js';
import { resolveSessionJsonlPath } from './sessionJsonl.js';

// Context window sizes by model family / known model id (tokens). Keep this
// static fallback in sync with the live `/v1/models` catalog for models that
// affect auto-handoff / CTX denominators before the catalog can help.
const MODEL_WINDOWS: Record<string, number> = {
  fable: 1_000_000,
  mythos: 1_000_000,
  opus: 1_000_000,
  sonnet: 1_000_000,
  haiku: 200_000,
};
const DEFAULT_WINDOW = 200_000;

const KNOWN_MODEL_WINDOWS: Record<string, number> = {
  'claude-fable-5-2': 1_000_000,
  'claude-mythos-5-2': 1_000_000,
  'claude-fable-5-1': 1_000_000,
  'claude-mythos-5-1': 1_000_000,
  'claude-fable-5': 1_000_000,
  'claude-mythos-5': 1_000_000,
  'claude-opus-5-5': 1_000_000,
  'claude-opus-5': 1_000_000,
  'claude-opus-4-8': 1_000_000,
  'claude-opus-4-7': 1_000_000,
  'claude-opus-4-6': 1_000_000,
  'claude-sonnet-5': 1_000_000,
  'claude-sonnet-4-6': 1_000_000,
  'claude-sonnet-4-5': 200_000,
  'claude-haiku-5-5': 1_000_000,
  'claude-haiku-4-5-20251001': 200_000,
};

// Static byte-to-token fallback used until per-session calibration is available.
export const BYTES_PER_TOKEN_DEFAULT = 9.0;
export const BYTES_PER_TOKEN_OPUS = 8.0;

// Static token overhead fallback used until per-session calibration is available.
export const OVERHEAD_TOKENS_DEFAULT = 17_000;
export const OVERHEAD_TOKENS_OPUS = 30_000;

function windowForModel(model: string): number {
  const lower = model.toLowerCase();
  if (lower in KNOWN_MODEL_WINDOWS) return KNOWN_MODEL_WINDOWS[lower];
  // Older Sonnet/Opus 4 releases use 200K; do not catch 4.6+ or future IDs.
  if (/^claude-(?:sonnet-4(?:-[05])?|opus-4(?:-[015])?)(?:-\d{8})?$/.test(lower)) return 200_000;
  if (/^claude-haiku-5-5(?:-\d{8})?$/.test(lower)) return 1_000_000;
  if (lower.includes('fable')) return MODEL_WINDOWS.fable ?? DEFAULT_WINDOW;
  if (lower.includes('mythos')) return MODEL_WINDOWS.mythos ?? DEFAULT_WINDOW;
  if (lower.includes('opus')) return MODEL_WINDOWS.opus ?? DEFAULT_WINDOW;
  if (lower.includes('haiku')) return MODEL_WINDOWS.haiku ?? DEFAULT_WINDOW;
  return MODEL_WINDOWS.sonnet ?? DEFAULT_WINDOW;
}

function defaultRatioForModel(model: string): number {
  const lower = model.toLowerCase();
  return (lower.includes('fable') || lower.includes('mythos') || lower.includes('opus'))
    ? BYTES_PER_TOKEN_OPUS
    : BYTES_PER_TOKEN_DEFAULT;
}

function defaultOverheadForModel(model: string): number {
  const lower = model.toLowerCase();
  return (lower.includes('fable') || lower.includes('mythos') || lower.includes('opus'))
    ? OVERHEAD_TOKENS_OPUS
    : OVERHEAD_TOKENS_DEFAULT;
}

// Build a ContextEstimate from a Claude Native worker's retained prompt size.
// Native workers do not write Claude CLI JSONL, so worker.ts computes this
// directly from the Messages API count_tokens endpoint after post-turn
// pruning. Do not substitute response.usage here: Anthropic server tools can
// report huge internal web-search/fetch processing tokens that are billing
// telemetry, not the retained next-turn context footprint.
// Returns null when lastPromptTokens is missing or zero.
export function nativeContextEstimate(
  model: string,
  lastPromptTokens: number | undefined,
  calibratedAt?: number,
): ContextEstimate | null {
  if (typeof lastPromptTokens !== 'number' || lastPromptTokens <= 0) return null;
  const windowSize = windowForModel(model);
  const overheadTokens = defaultOverheadForModel(model);
  const messagesTokens = Math.max(0, lastPromptTokens - overheadTokens);
  const percentOfWindow = Math.min(100, Math.round((lastPromptTokens / windowSize) * 100));
  return {
    estimatedTokens: lastPromptTokens,
    percentOfWindow,
    windowSize,
    method: 'ground-truth',
    ...(typeof calibratedAt === 'number' ? { calibratedAt } : {}),
    messagesTokens,
    overheadTokens,
    jsonlBytes: 0,
  };
}

// Build a ContextEstimate from a provider-reported full prompt size and an
// explicit context window. Use for non-Claude native/API providers where the
// response usage already reports the rendered prompt size and there is no
// Claude JSONL/session overhead model to add.
export function promptContextEstimate(
  lastPromptTokens: number | undefined,
  windowSize: number | undefined,
  calibratedAt?: number,
): ContextEstimate | null {
  if (typeof lastPromptTokens !== 'number' || lastPromptTokens <= 0) return null;
  if (typeof windowSize !== 'number' || windowSize <= 0) return null;
  const percentOfWindow = Math.min(100, Math.round((lastPromptTokens / windowSize) * 100));
  return {
    estimatedTokens: lastPromptTokens,
    percentOfWindow,
    windowSize,
    method: 'ground-truth',
    ...(typeof calibratedAt === 'number' ? { calibratedAt } : {}),
    messagesTokens: lastPromptTokens,
    overheadTokens: 0,
    jsonlBytes: 0,
  };
}

export interface ContextEstimate {
  estimatedTokens: number;
  percentOfWindow: number;
  windowSize: number;
  method: 'byte-count' | 'calibrated' | 'ground-truth';
  calibratedAt?: number;  // epoch ms of last ground-truth calibration
  messagesTokens: number;
  overheadTokens: number;
  jsonlBytes: number;
}

// Read the latest assistant turn's `usage` block from the session JSONL.
// Claude reports the exact number of tokens it sent on the request — that's
// `cache_read + cache_creation + input_tokens` (the fresh + cached prompt
// content). This is ground truth: it's what Claude itself decided was in
// context for the most recent turn, so no calibration is needed.
//
// One exception: a response that ran server tools (web search, web fetch,
// code execution) was sampled several times and its top-level usage is the
// SUM over those passes, not a prompt size. When the entry lists its passes
// (`usage.iterations`) the last message pass is the prompt; when it does not,
// no ground truth exists for that message and the caller falls back to the
// byte estimate rather than reading the sum (usageContext.ts has the rule).
//
// Returns null if the file is missing or has no assistant entries with usage
// (e.g. a brand-new session that hasn't received a turn yet).
async function readLatestUsageTokens(
  path: string,
): Promise<{ tokens: number; timestamp?: number } | null> {
  let buf: Buffer;
  try {
    buf = await readFile(path);
  } catch {
    return null;
  }
  return latestUsageTokensFromJsonl(buf.toString('utf-8'));
}

type JsonlAssistantLine = {
  type?: string;
  timestamp?: string;
  message?: { id?: string; usage?: Record<string, unknown>; content?: unknown };
};

function lineUsedServerTools(obj: JsonlAssistantLine): boolean {
  const counts = obj.message?.usage?.server_tool_use;
  if (counts && typeof counts === 'object') {
    for (const v of Object.values(counts as Record<string, unknown>)) if (typeof v === 'number' && v > 0) return true;
  }
  const content = obj.message?.content;
  return Array.isArray(content) && roundUsedServerTools(content as Array<{ type?: string }>);
}

// Pure core of readLatestUsageTokens, exported for tests.
export function latestUsageTokensFromJsonl(text: string): { tokens: number; timestamp?: number } | null {
  // Scan backward — the latest assistant entry is near the end. JSONL is
  // line-delimited, so split and walk from the tail.
  const lines = text.split('\n');
  const parsed = new Map<number, JsonlAssistantLine | null>();
  const parse = (i: number): JsonlAssistantLine | null => {
    const cached = parsed.get(i);
    if (cached !== undefined) return cached;
    const line = lines[i];
    let obj: JsonlAssistantLine | null = null;
    if (line && line.includes('"type":"assistant"')) {
      try { obj = JSON.parse(line) as JsonlAssistantLine; } catch { obj = null; }
    }
    parsed.set(i, obj);
    return obj;
  };
  for (let i = lines.length - 1; i >= 0; i--) {
    const obj = parse(i);
    const u = obj?.message?.usage;
    if (!obj || !u) continue;
    const ts = obj.timestamp ? Date.parse(obj.timestamp) : undefined;
    const timestamp = Number.isFinite(ts) ? (ts as number) : undefined;
    const fromIterations = lastPassPromptTokens(u.iterations);
    if (fromIterations !== undefined) return { tokens: fromIterations, timestamp };
    // Claude Code writes one line per content block of a response; the lines
    // share `message.id`. A server tool call on any of them makes the usage
    // a multi-pass sum.
    const id = obj.message?.id;
    let multiPass = lineUsedServerTools(obj);
    if (!multiPass && typeof id === 'string') {
      for (let j = i - 1; j >= 0 && !multiPass; j--) {
        const other = parse(j);
        if (!other || other.message?.id !== id) continue;
        multiPass = lineUsedServerTools(other);
      }
    }
    if (multiPass) return null;
    const tokens = promptTokensOf(u);
    if (tokens <= 0) continue;
    return { tokens, timestamp };
  }
  return null;
}

// Estimate context fill from the Claude session JSONL byte size.
// When `calibration` is provided, uses per-session ratio/overhead values and
// sets method: 'calibrated'. Falls back to global constants otherwise.
// Returns null when the JSONL file doesn't exist yet (new session).
export async function estimateContextFill(
  cwd: string,
  sessionId: string,
  model: string,
  calibration?: { ratio: number; overhead: number; lastGroundTruth?: number } | null,
): Promise<ContextEstimate | null> {
  const path = resolveSessionJsonlPath(cwd, sessionId);
  let bytes: number;
  try {
    const s = await stat(path);
    bytes = s.size;
  } catch {
    return null;
  }

  const windowSize = windowForModel(model);

  // Ground truth: read the latest assistant turn's usage block from the JSONL.
  // Claude's CLI records exact prompt tokens it submitted on each turn, so for
  // any session past its first assistant reply we can skip the bytes/ratio
  // heuristic entirely. This was added after a session reported 110% fill
  // while real context was 24% — the byte-count ratio drifts by 3-4× on
  // tool-heavy Opus sessions because JSONL accumulates structural overhead
  // (parentUuid, gitBranch, requestId, full usage blocks per turn) that never
  // enters the context window.
  const groundTruth = await readLatestUsageTokens(path);
  if (groundTruth) {
    const overheadTokens = defaultOverheadForModel(model);
    const messagesTokens = Math.max(0, groundTruth.tokens - overheadTokens);
    const percentOfWindow = Math.min(100, Math.round((groundTruth.tokens / windowSize) * 100));
    return {
      estimatedTokens: groundTruth.tokens,
      percentOfWindow,
      windowSize,
      method: 'ground-truth',
      calibratedAt: groundTruth.timestamp,
      messagesTokens,
      overheadTokens,
      jsonlBytes: bytes,
    };
  }

  const ratio = calibration?.ratio ?? defaultRatioForModel(model);
  const overheadTokens = calibration?.overhead ?? defaultOverheadForModel(model);
  const method: 'byte-count' | 'calibrated' = calibration ? 'calibrated' : 'byte-count';

  const messagesTokens = Math.round(bytes / ratio);
  const estimatedTokens = messagesTokens + overheadTokens;
  const percentOfWindow = Math.min(100, Math.round((estimatedTokens / windowSize) * 100));

  return {
    estimatedTokens,
    percentOfWindow,
    windowSize,
    method,
    calibratedAt: calibration?.lastGroundTruth,
    messagesTokens,
    overheadTokens,
    jsonlBytes: bytes,
  };
}
