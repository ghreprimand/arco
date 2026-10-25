// Gemini Native model catalog — resolves auth state + project ID via the
// cloudcode-pa.googleapis.com loadCodeAssist probe, then returns a curated
// model list based on what the Gemini CLI's bundle exposes.
//
// cloudcode-pa has no model-listing endpoint (we probed listModels,
// listAvailableModels — all 404). The curated list below is derived from the
// CLI bundle (chunk-DMWX7UP6.js) and cross-checked against live probe calls.
// Update when a new CLI version adds models. The catalog snapshot includes the
// resolved projectId so the G2 worker doesn't need a separate loadCodeAssist.
//
// Same lazy-1h-cache pattern as claude-native/catalog.ts and
// codex-appserver/catalog.ts.

import { ensureLiveTokens, ensureProjectId } from './auth.js';
import type { GeminiCatalogModel, GeminiCatalogSnapshot } from '@arco/shared';

const REFRESH_INTERVAL_MS = 60 * 60 * 1000;

// Models sourced from CLI bundle + live probe (May 2026).
// thinkingSchema: 'budget' → thinkingBudget (2.x), 'level' → thinkingLevel (3.x).
// inputTokenLimit / outputTokenLimit: from Gemini API docs; 0 = not confirmed.
const CURATED_MODELS: Omit<GeminiCatalogModel, never>[] = [
  {
    id: 'gemini-2.5-flash',
    displayName: 'Gemini 2.5 Flash',
    description: 'Best price-performance model with thinking',
    inputTokenLimit: 1_048_576,
    outputTokenLimit: 65_536,
    supportsThinking: true,
    thinkingSchema: 'budget',
  },
  {
    id: 'gemini-2.5-pro',
    displayName: 'Gemini 2.5 Pro',
    description: 'Most capable 2.x model with extended thinking',
    inputTokenLimit: 1_048_576,
    outputTokenLimit: 65_536,
    supportsThinking: true,
    thinkingSchema: 'budget',
  },
  {
    id: 'gemini-2.5-flash-lite',
    displayName: 'Gemini 2.5 Flash Lite',
    description: 'Lightweight 2.x model for fast, low-cost tasks',
    inputTokenLimit: 1_048_576,
    outputTokenLimit: 65_536,
    supportsThinking: true,
    thinkingSchema: 'budget',
  },
  {
    id: 'gemini-3-flash-preview',
    displayName: 'Gemini 3 Flash Preview',
    description: 'Preview 3.x Flash model',
    inputTokenLimit: 1_048_576,
    outputTokenLimit: 65_536,
    supportsThinking: true,
    thinkingSchema: 'level',
  },
  {
    id: 'gemini-3.1-flash-lite-preview',
    displayName: 'Gemini 3.1 Flash Lite Preview',
    description: 'Lightweight 3.1 preview model',
    inputTokenLimit: 1_048_576,
    outputTokenLimit: 65_536,
    supportsThinking: true,
    thinkingSchema: 'level',
  },
  {
    id: 'gemini-3.1-pro-preview',
    displayName: 'Gemini 3.1 Pro Preview',
    description: 'Most capable 3.1 preview model',
    inputTokenLimit: 1_048_576,
    outputTokenLimit: 65_536,
    supportsThinking: true,
    thinkingSchema: 'level',
  },
];

let cache: GeminiCatalogSnapshot | null = null;
let inFlight: Promise<GeminiCatalogSnapshot> | null = null;

export async function getCatalog(force = false): Promise<GeminiCatalogSnapshot> {
  const now = Date.now();
  if (!force && cache && now - cache.fetchedAt < REFRESH_INTERVAL_MS) return cache;
  if (inFlight) return inFlight;
  inFlight = fetchCatalog().finally(() => { inFlight = null; });
  try {
    const fresh = await inFlight;
    cache = fresh;
    return fresh;
  } catch (err) {
    if (cache) {
      console.warn(
        '[gemini-native:catalog] refresh failed; serving stale cache:',
        err instanceof Error ? err.message : err
      );
      return { ...cache, fresh: false };
    }
    console.warn(
      '[gemini-native:catalog] no auth and no cache:',
      err instanceof Error ? err.message : err
    );
    return { fetchedAt: now, models: [], fresh: false, projectId: '' };
  }
}

// Kick a background refresh at server startup. Idempotent — the inFlight
// guard prevents overlapping fetches. No crash if creds are missing.
export function scheduleGeminiNativeCatalogPrefetch(): void {
  void getCatalog().catch(() => { /* logged inside getCatalog */ });
}

async function fetchCatalog(): Promise<GeminiCatalogSnapshot> {
  // ensureProjectId calls ensureLiveTokens internally and then probes
  // cloudcode-pa to confirm auth is working. If this throws, the catalog
  // degrades gracefully in getCatalog().
  const projectId = await ensureProjectId();
  return {
    fetchedAt: Date.now(),
    models: CURATED_MODELS,
    fresh: true,
    projectId,
  };
}

// Synchronous accessor for the cached project ID — used by the worker
// without triggering a new probe. Returns null on cold-start.
export function getCachedProjectId(): string | null {
  return cache?.projectId || null;
}
