// Tail-reader for Codex rollout files. Used to recover the per-call
// `last_token_usage` and `model_context_window` after a Codex turn settles
// — `codex exec --json`'s `turn.completed.usage` reports input_tokens
// AGGREGATED across all internal LLM calls within one operator turn, which
// is right for billing but wrong for context-window-fill display. The
// rollout file's `event_msg::token_count` payload carries the per-call last
// snapshot AND the model's operational window, both of which the exec --json
// stream omits.
//
// Used after turn.settled in server/src/index.ts to broadcast a
// CodexTokenSnapshotMessage that overrides the inflated lastTurnTokens.
//
// Cheap by design: tails up to TAIL_BYTES bytes from the rollout, scans
// backward for the most recent `event_msg::token_count` line, returns its
// info payload. Falls back to null on any error — this is best-effort
// enrichment, not a load-bearing path.

import { promises as fs } from 'fs';

// Read at most this many bytes from the tail of the rollout. token_count
// payloads are emitted at the end of each turn; for a typical 1-2k-line
// rollout the most recent one is in the last few KB. 64KB is generous.
const TAIL_BYTES = 64 * 1024;

export interface CodexTokenUsageRaw {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

export interface CodexTokenCountInfo {
  total_token_usage?: CodexTokenUsageRaw;
  last_token_usage?: CodexTokenUsageRaw;
  model_context_window?: number;
}

// Read the tail of the rollout file and return the most recent
// event_msg::token_count `info` payload. Returns null if the file's missing,
// unreadable, or has no token_count event.
export async function readLatestCodexTokenCount(rolloutPath: string): Promise<CodexTokenCountInfo | null> {
  let stats: { size: number };
  try {
    stats = await fs.stat(rolloutPath);
  } catch {
    return null;
  }
  if (stats.size === 0) return null;

  const readBytes = Math.min(stats.size, TAIL_BYTES);
  const fh = await fs.open(rolloutPath, 'r').catch(() => null);
  if (!fh) return null;
  try {
    const buf = Buffer.alloc(readBytes);
    await fh.read(buf, 0, readBytes, stats.size - readBytes);
    const text = buf.toString('utf8');
    const lines = text.split('\n').filter((l) => l.trim().length > 0);
    // Walk backward to find the latest token_count payload.
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      // Cheap pre-filter to skip lines that obviously aren't token_count
      // events. Avoids JSON.parse on every line of the tail.
      if (!line.includes('"token_count"')) continue;
      try {
        const entry = JSON.parse(line);
        if (
          entry?.type === 'event_msg' &&
          entry?.payload?.type === 'token_count' &&
          entry?.payload?.info
        ) {
          return entry.payload.info as CodexTokenCountInfo;
        }
      } catch {
        // Malformed line in the tail (we may have truncated mid-line on
        // the read offset). Keep scanning earlier lines.
      }
    }
    return null;
  } finally {
    await fh.close();
  }
}

// Convert raw rollout usage into Archon's TokenUsage shape. Mirrors the
// mapping in server/src/workers/WorkerManager.ts:usageToTokens but works
// directly off the rollout's CodexTokenUsageRaw structure.
export function rawUsageToTokenUsage(u: CodexTokenUsageRaw): {
  input: number;
  output: number;
  cacheRead?: number;
  cacheCreate?: number;
  reasoningOutput?: number;
  total?: number;
} {
  return {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheRead: u.cached_input_tokens,
    // Codex never populates cacheCreate; field omitted intentionally.
    ...(typeof u.reasoning_output_tokens === 'number'
      ? { reasoningOutput: u.reasoning_output_tokens }
      : {}),
    ...(typeof u.total_tokens === 'number' ? { total: u.total_tokens } : {}),
  };
}
