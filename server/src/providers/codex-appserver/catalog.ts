// Live Codex model catalog, fetched via a short-lived `codex app-server`
// process and the JSON-RPC `model/list` method. Mirrors the Claude catalog
// pattern (claude-native/catalog.ts):
//
//   - 1h in-memory cache, lazy refresh on first request after expiry
//   - On fetch failure, serve the last good cache rather than throw
//   - Cold-start with no successful fetch returns an empty snapshot; the
//     UI falls back to the compile-time CODEX_MODELS list
//
// Each refresh costs one short-lived `codex app-server` spawn (initialize
// + model/list + close, ~1s). The app-server's existing OAuth/auth state is
// reused — no separate auth flow.
//
// Multi-profile: Codex is the only provider with per-account auth profiles
// (HOME / WORK), and model *availability* is entitlement-gated per account
// (e.g. a higher-tier WORK plan sees GPT-5.6 Sol where HOME sees only
// Terra/Luna). So the cache is keyed by `codexHome` — each profile's auth dir
// gets its own snapshot, fetched by spawning app-server with that
// `CODEX_HOME` (the same seam probeCodexLoggedIn / both turn transports use).
// `codexHome === undefined` is the ambient `~/.codex` default (no profiles
// configured). Model *capabilities* (reasoning efforts, image input) are
// account-independent, so getCachedCodexModelCapabilities unions across every
// cached snapshot.
//
// Why we need the catalog: the appserver's per-model capabilities tell us
// (a) the actual `supportedReasoningEfforts` so we don't silently downgrade
// `xhigh` on a model that supports it, (b) per-model image-input support,
// (c) `additionalSpeedTiers` (e.g. 'priority'), (d) personality support.

import { spawn } from 'node:child_process';
import { JsonRpcClient } from './jsonRpc.js';
import type { InitializeResponse } from './bindings/InitializeResponse.js';
import type { ModelListResponse } from './bindings/v2/ModelListResponse.js';
import type { Model } from './bindings/v2/Model.js';
import type { ReasoningEffort } from './bindings/ReasoningEffort.js';
import type { CodexCatalogModel, CodexCatalogSnapshot, CodexReasoningEffort } from '@arco/shared';
import { readCodexContextMetadata } from '../codexContextWindow.js';
import { commandArgs } from '../../windowsCommand.js';

export type { CodexCatalogModel, CodexCatalogSnapshot } from '@arco/shared';

const REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const SPAWN_TIMEOUT_MS = 15_000;
const ARCO_CLIENT_NAME = 'arco';
const ARCO_CLIENT_VERSION = '0.1.0';

// Per-codexHome snapshots. The ambient (~/.codex) default is stored under
// AMBIENT_KEY so callers that pass no codexHome share one entry.
const AMBIENT_KEY = '__ambient__';
const caches = new Map<string, CodexCatalogSnapshot>();
const inFlightByKey = new Map<string, Promise<CodexCatalogSnapshot>>();

function cacheKey(codexHome?: string): string {
  return codexHome ?? AMBIENT_KEY;
}

// Ascending effort order. Every value Codex can return MUST appear here: the
// distilled array is sorted by this rank and both transports treat its LAST
// element as "the highest effort this model supports", so a missing entry ranks
// 0 and silently corrupts that fallback. 'max' and 'ultra' were missing when
// GPT-6 Astra shipped them (2026-09-04), which sorted them to the front.
const EFFORT_RANK: Record<string, number> = {
  none: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6, ultra: 7,
};

function distillModel(m: Model, codexHome?: string): CodexCatalogModel {
  const efforts = (m.supportedReasoningEfforts ?? [])
    .map((opt) => opt.reasoningEffort)
    .filter((e): e is ReasoningEffort => typeof e === 'string')
    .sort((a, b) => (EFFORT_RANK[a] ?? 0) - (EFFORT_RANK[b] ?? 0)) as CodexReasoningEffort[];
  const inputModalities = m.inputModalities ?? [];
  const context = readCodexContextMetadata(m.id, codexHome);
  return {
    id: m.id,
    displayName: m.displayName,
    description: m.description,
    hidden: m.hidden,
    isDefault: m.isDefault,
    supportedReasoningEfforts: efforts,
    defaultReasoningEffort: m.defaultReasoningEffort as CodexReasoningEffort,
    supportsImageInput: inputModalities.some((mod) => mod === 'image'),
    supportsPersonality: m.supportsPersonality,
    additionalSpeedTiers: m.additionalSpeedTiers ?? [],
    ...(context?.contextWindow ? { contextWindow: context.contextWindow } : {}),
    ...(context?.maxContextWindow ? { maxContextWindow: context.maxContextWindow } : {}),
    ...(context?.effectiveContextWindowPercent
      ? { effectiveContextWindowPercent: context.effectiveContextWindowPercent }
      : {}),
  };
}

// Public accessor. Returns the cached snapshot for the given profile
// (`codexHome`); refreshes if older than REFRESH_INTERVAL_MS or never fetched.
// Failures degrade to that profile's stale cache. Omit `codexHome` for the
// ambient ~/.codex default.
export async function getCodexCatalog(force = false, codexHome?: string): Promise<CodexCatalogSnapshot> {
  const key = cacheKey(codexHome);
  const now = Date.now();
  const cache = caches.get(key) ?? null;
  if (!force && cache && now - cache.fetchedAt < REFRESH_INTERVAL_MS) return cache;
  const existing = inFlightByKey.get(key);
  if (existing) return existing;
  const p = fetchCodexCatalog(codexHome).finally(() => { inFlightByKey.delete(key); });
  inFlightByKey.set(key, p);
  try {
    const fresh = await p;
    caches.set(key, fresh);
    return fresh;
  } catch (err) {
    if (cache) {
      console.warn(`[codex:catalog] refresh failed (${key}); serving stale cache:`, err instanceof Error ? err.message : err);
      return { ...cache, fresh: false };
    }
    console.warn(`[codex:catalog] no cache and fetch failed (${key}):`, err instanceof Error ? err.message : err);
    return { fetchedAt: now, models: [], fresh: false };
  }
}

// Synchronous capability lookup for hot paths (mapEffort during turn/start
// param construction). Capabilities are account-independent, so we search
// every profile's cached snapshot. Returns null when no catalog has been
// populated yet; caller should fall back to a hardcoded behavior.
export function getCachedCodexModelCapabilities(modelId: string): CodexCatalogModel | null {
  for (const snap of caches.values()) {
    const found = snap.models.find((m) => m.id === modelId);
    if (found) return found;
  }
  return null;
}

// Kick a background refresh for each given profile (undefined = ambient).
// Idempotent — the per-key inFlight guard prevents overlapping fetches. Used
// at server startup so the picker has data before the first user action.
export function scheduleCodexCatalogPrefetch(codexHomes: (string | undefined)[] = [undefined]): void {
  for (const home of codexHomes) void getCodexCatalog(false, home).catch(() => { /* logged inside */ });
}

async function fetchCodexCatalog(codexHome?: string): Promise<CodexCatalogSnapshot> {
  const proc = spawn(...commandArgs('codex', ['app-server']), {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...(codexHome ? { CODEX_HOME: codexHome } : {}) },
    detached: true,
  });

  // Drain stderr so the pipe doesn't fill and block; only log on real errors.
  let stderrBuf = '';
  proc.stderr?.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString();
    if (stderrBuf.length > 32 * 1024) stderrBuf = stderrBuf.slice(-16 * 1024);
  });

  if (!proc.stdin || !proc.stdout) {
    safeKill(proc);
    throw new Error('codex app-server stdio not available');
  }

  const rpc = new JsonRpcClient(proc.stdin, proc.stdout);
  const cleanup = () => {
    rpc.close('catalog probe done');
    safeKill(proc);
  };

  // Hard ceiling — if app-server hangs on initialize, don't leak.
  const timer = setTimeout(() => {
    cleanup();
  }, SPAWN_TIMEOUT_MS);

  try {
    await rpc.request<InitializeResponse>('initialize', {
      clientInfo: { name: ARCO_CLIENT_NAME, title: 'Arco', version: ARCO_CLIENT_VERSION },
      capabilities: { experimentalApi: true, optOutNotificationMethods: null },
    });
    rpc.notify('initialized');

    const all: Model[] = [];
    let cursor: string | null = null;
    // Paginate until the server stops handing us a cursor. Codex defaults
    // limit to ~50; our list is small but be safe.
    for (let page = 0; page < 20; page++) {
      const reqParams: { cursor: string | null; limit: number | null; includeHidden: boolean } = {
        cursor,
        limit: null,
        includeHidden: true,
      };
      const listResp = await rpc.request<ModelListResponse>('model/list', reqParams);
      all.push(...listResp.data);
      if (!listResp.nextCursor) break;
      cursor = listResp.nextCursor;
    }
    const models = all.map((model) => distillModel(model, codexHome));
    return { fetchedAt: Date.now(), models, fresh: true };
  } finally {
    clearTimeout(timer);
    cleanup();
  }
}

function safeKill(proc: ReturnType<typeof spawn>): void {
  try { proc.kill('SIGTERM'); } catch { /* already gone */ }
  // Belt-and-suspenders: SIGKILL after 2s if SIGTERM didn't take.
  setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}
