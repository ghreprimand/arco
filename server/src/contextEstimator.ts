import { readFile, stat } from 'fs/promises';
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
  'claude-sonnet-4-5': 1_000_000,
  'claude-haiku-4-5-20251001': 200_000,
};

// Bytes-per-message-token ratio, used as the fallback before per-session
// calibration runs. Calibrated from measured sessions:
//   Sonnet #1: 478 KB → 49.4K msg tokens → 9.7 B/T (prose-heavy)
//   Sonnet #2: 300 KB → 34.9K msg tokens → 8.6 B/T (code/tool-heavy)
//   Opus 1M  : 486 KB → 71.0K msg tokens → 6.8 B/T (tool+thinking-heavy, 2026-04-20)
// Opus sessions trend lower — thinking blocks + more tool-use metadata inflate
// msg-token counts per JSONL byte. Pty-based calibration (contextCalibrator.ts)
// corrects this per-session at zones E/A/B/C.
export const BYTES_PER_TOKEN_DEFAULT = 9.0;
export const BYTES_PER_TOKEN_OPUS = 8.0;

// Fixed session overhead: system prompt + tool definitions + memory + skills.
// Sonnet ground truth: 6.1K + 9.1K + 1.1K + 0.8K ≈ 17K.
// Opus 1M ground truth (2026-04-20): 8.9K + 13K + 6.9K + 0.8K ≈ 30K. Opus runs
// a larger default toolset + bigger memory surface. (The 33K autocompact
// buffer Opus /context reports is NOT included — it's a reserve, never
// consumed, so modeling it as overhead would over-count.)
export const OVERHEAD_TOKENS_DEFAULT = 17_000;
export const OVERHEAD_TOKENS_OPUS = 30_000;

function windowForModel(model: string): number {
  const lower = model.toLowerCase();
  if (lower in KNOWN_MODEL_WINDOWS) return KNOWN_MODEL_WINDOWS[lower];
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
  // Scan backward — the latest assistant entry is near the end. JSONL is
  // line-delimited, so split and walk from the tail.
  const lines = buf.toString('utf-8').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.includes('"type":"assistant"')) continue;
    try {
      const obj = JSON.parse(line);
      const u = obj?.message?.usage;
      if (!u) continue;
      const tokens =
        (u.cache_read_input_tokens ?? 0) +
        (u.cache_creation_input_tokens ?? 0) +
        (u.input_tokens ?? 0);
      if (tokens <= 0) continue;
      const ts = obj.timestamp ? Date.parse(obj.timestamp) : undefined;
      return { tokens, timestamp: Number.isFinite(ts) ? (ts as number) : undefined };
    } catch { /* skip malformed line */ }
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
