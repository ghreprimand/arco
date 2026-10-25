// Phase 7a Track B — Claude model catalog fetched live from Anthropic's
// /v1/models endpoint via the same OAuth subscription scope the worker
// uses. Response is rich (per-model capabilities for effort, thinking
// modes, image/pdf input, structured outputs). Cached in-memory; the
// cached set is the authoritative source for the UI picker.
//
// When auth isn't set up or the fetch fails, the last successful
// snapshot serves as the fallback. On a cold-start with no auth ever
// established, we return an empty list and let the UI fall back to the
// compile-time CLAUDE_MODELS array in shared/.
//
// Refresh cadence: 1 hour. New models surface within that window
// without an Arco restart.

import { ensureLiveTokens } from './oauth.js';
import { CLAUDE_CLI_USER_AGENT } from './wireFingerprint.js';
import {
  claudeAliasFamily,
  CLAUDE_ALIAS_FALLBACK,
  distillCatalogModel,
  type ClaudeCatalogModel,
  type ClaudeCatalogSnapshot,
} from '@arco/shared';

const REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;

// Anthropic's /v1/models response shape. Fields documented as of the
// catalog probe response shipped with Phase 7a Track B; new keys added
// to the API response pass through to the client unchanged because we
// model the capabilities object as Record<string, unknown>.
export interface AnthropicModel {
  type: 'model';
  id: string;
  display_name: string;
  created_at: string;
  max_input_tokens: number;
  max_tokens: number;
  capabilities: Record<string, unknown> & {
    effort?: {
      supported?: boolean;
      low?: { supported?: boolean };
      medium?: { supported?: boolean };
      high?: { supported?: boolean };
      xhigh?: { supported?: boolean };
      max?: { supported?: boolean };
    };
    thinking?: {
      supported?: boolean;
      types?: {
        enabled?: { supported?: boolean };
        adaptive?: { supported?: boolean };
      };
    };
    image_input?: { supported?: boolean };
    pdf_input?: { supported?: boolean };
    context_management?: {
      supported?: boolean;
      clear_thinking_20251015?: { supported?: boolean };
      clear_tool_uses_20250919?: { supported?: boolean };
      compact_20260112?: { supported?: boolean };
    };
  };
}

let cache: ClaudeCatalogSnapshot | null = null;
let inFlight: Promise<ClaudeCatalogSnapshot> | null = null;

// Phase 7c-followup — synchronous catalog-capability lookup for the Native
// worker's per-request beta-header construction. Returns `null` when the
// model isn't in the cached catalog (cold-start, fetch failure, or a
// model id the operator typed manually that Anthropic doesn't expose).
// Worker treats `null` conservatively: skip context-management betas
// rather than risk a 400. The catalog refresh is async and hourly; the
// worker reads the in-memory cache only.
export function getCachedModelCapabilities(modelId: string): {
  supportsClearThinking: boolean;
  supportsClearToolUses: boolean;
  supportsCompact: boolean;
} | null {
  if (!cache) return null;
  const m = cache.models.find((x) => x.id === modelId);
  if (!m) return null;
  return {
    supportsClearThinking: m.supportsClearThinking,
    supportsClearToolUses: m.supportsClearToolUses,
    supportsCompact: m.supportsCompact,
  };
}

// True once a non-empty catalog has been fetched in this process. Callers use
// it to decide whether an alias resolution is catalog-backed or a static guess.
export function hasCatalogCache(): boolean {
  return !!cache && cache.models.length > 0;
}

// 2026-07-28 — resolve a family alias ('opus' / 'opus[1m]' / 'sonnet' /
// 'haiku') to the newest concrete id in that family. The Messages API has no
// alias resolution of its own, so sending the alias verbatim 404s; the Native
// worker calls this to get a real id while the tab's configured model stays
// the alias (so it keeps tracking the newest member as new models ship).
//
// Concrete ids pass through untouched. Falls back to CLAUDE_ALIAS_FALLBACK
// when the catalog is cold — a stale-but-real id beats a guaranteed 404.
export function resolveClaudeAliasFromCatalog(modelId: string): string {
  const family = claudeAliasFamily(modelId);
  if (!family) return modelId;
  const inFamily = (cache?.models ?? []).filter((m) => m.id.includes(family));
  if (inFamily.length === 0) return CLAUDE_ALIAS_FALLBACK[family];
  // Newest by created_at, not catalog order — /v1/models happens to sort
  // newest-first today, but nothing in the contract promises it.
  const newest = inFamily.reduce((a, b) =>
    (Date.parse(b.createdAt ?? '') || 0) > (Date.parse(a.createdAt ?? '') || 0) ? b : a);
  return newest.id;
}

// Public accessor. Returns the cached snapshot; refreshes if older than
// REFRESH_INTERVAL_MS, in-flight request, or never fetched. Failures
// degrade to the last good cache rather than throwing.
export async function getCatalog(force = false): Promise<ClaudeCatalogSnapshot> {
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
      console.warn('[claude-native:catalog] refresh failed; serving stale cache:', err instanceof Error ? err.message : err);
      return { ...cache, fresh: false };
    }
    // No cache to fall back on. Return an empty snapshot; the UI uses
    // the compile-time CLAUDE_MODELS list as a baseline.
    console.warn('[claude-native:catalog] no auth and no cache:', err instanceof Error ? err.message : err);
    return { fetchedAt: now, models: [], fresh: false };
  }
}

async function fetchCatalog(): Promise<ClaudeCatalogSnapshot> {
  const tokens = await ensureLiveTokens();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch('https://api.anthropic.com/v1/models?limit=1000', {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${tokens.accessToken}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
        'user-agent': CLAUDE_CLI_USER_AGENT,
        'x-app': 'cli',
      },
      signal: controller.signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`/v1/models ${resp.status}: ${text.slice(0, 200)}`);
    }
    const body = await resp.json() as { data?: AnthropicModel[] };
    const raw = Array.isArray(body.data) ? body.data : [];
    // Distil into the picker shape (camelCase displayName, supportedEfforts
    // array, etc.) so the client doesn't need to know Anthropic's wire shape.
    const models: ClaudeCatalogModel[] = raw.map((m) => distillCatalogModel(m));
    return { fetchedAt: Date.now(), models, fresh: true };
  } finally {
    clearTimeout(timer);
  }
}
