import type { ZaiUsageInfo, ZaiUsageWindow } from '@archon/shared';
import { ZAI_MODELS } from '@archon/shared';
import { readZaiApiKey } from './providerSecrets.js';

export const ZAI_CODING_BASE_URL = 'https://api.z.ai/api/coding/paas/v4';
const ZAI_MONITOR_QUOTA_URL = 'https://api.z.ai/api/monitor/usage/quota/limit';

const USAGE_CACHE_MS = 60_000;
const MODELS_CACHE_MS = 60 * 60_000;

let usageCache: ZaiUsageInfo | null = null;
let modelsCache: { fetchedAt: number; models: string[] } | null = null;

type ZaiQuotaResponse = {
  code?: number;
  msg?: string;
  success?: boolean;
  data?: {
    level?: string;
    limits?: Array<{
      type?: string;
      unit?: number;
      number?: number;
      usage?: number;
      currentValue?: number;
      remaining?: number;
      percentage?: number;
      nextResetTime?: number;
    }>;
  };
};

type ZaiModelsResponse = {
  data?: Array<{ id?: string }>;
};

export async function getZaiUsage(force = false): Promise<ZaiUsageInfo> {
  if (!force && usageCache && Date.now() - usageCache.fetchedAt < USAGE_CACHE_MS) return usageCache;

  const key = await readZaiApiKey();
  if (!key) {
    return cacheUsage({
      available: false,
      fetchedAt: Date.now(),
      source: 'disabled',
      windows: [],
      error: 'Z.ai API key is not configured.',
    });
  }

  try {
    const res = await fetch(ZAI_MONITOR_QUOTA_URL, {
      headers: {
        authorization: `Bearer ${key}`,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    let body: ZaiQuotaResponse;
    try {
      body = JSON.parse(text) as ZaiQuotaResponse;
    } catch {
      throw new Error(`Z.ai quota returned non-JSON HTTP ${res.status}`);
    }
    if (!res.ok || body.success === false) {
      throw new Error(body.msg || `Z.ai quota HTTP ${res.status}`);
    }
    const windows = (body.data?.limits ?? [])
      .filter((limit) => limit.type === 'TOKENS_LIMIT')
      .map(normalizeQuotaWindow)
      .sort((a, b) => windowRank(a) - windowRank(b));
    return cacheUsage({
      available: windows.length > 0,
      fetchedAt: Date.now(),
      source: 'monitor',
      level: body.data?.level,
      windows,
      ...(windows.length === 0 ? { error: 'Z.ai quota response did not include token quota windows.' } : {}),
    });
  } catch (err) {
    return cacheUsage({
      available: false,
      fetchedAt: Date.now(),
      source: 'unavailable',
      windows: [],
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function getZaiModels(force = false): Promise<string[]> {
  if (!force && modelsCache && Date.now() - modelsCache.fetchedAt < MODELS_CACHE_MS) return modelsCache.models;
  const key = await readZaiApiKey();
  if (!key) return [...ZAI_MODELS];
  try {
    const res = await fetch(`${ZAI_CODING_BASE_URL}/models`, {
      headers: {
        authorization: `Bearer ${key}`,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const parsed = await res.json() as ZaiModelsResponse;
    const models = (parsed.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string' && id.trim().length > 0);
    if (models.length > 0) {
      modelsCache = { fetchedAt: Date.now(), models };
      return models;
    }
  } catch {
    // Auth status should not fail just because live model discovery drifted.
  }
  return [...ZAI_MODELS];
}

function cacheUsage(info: ZaiUsageInfo): ZaiUsageInfo {
  usageCache = info;
  return info;
}

type ZaiQuotaLimit = NonNullable<NonNullable<ZaiQuotaResponse['data']>['limits']>[number];

function normalizeQuotaWindow(limit: ZaiQuotaLimit): ZaiUsageWindow {
  const used = clampPercent(typeof limit.percentage === 'number' ? limit.percentage : 0);
  const remaining = clampPercent(typeof limit.remaining === 'number' ? limit.remaining : 100 - used);
  const resetAt = typeof limit.nextResetTime === 'number'
    ? new Date(limit.nextResetTime).toISOString()
    : null;
  return {
    type: limit.type ?? 'TOKENS_LIMIT',
    label: quotaLabel(limit),
    percentageUsed: used,
    remainingPercentage: remaining,
    resetAt,
    ...(typeof limit.unit === 'number' ? { unit: limit.unit } : {}),
    ...(typeof limit.number === 'number' ? { number: limit.number } : {}),
  };
}

function quotaLabel(limit: { type?: string; unit?: number; number?: number }): string {
  if (limit.type !== 'TOKENS_LIMIT') return limit.type ?? 'Quota';
  if (limit.unit === 3 && typeof limit.number === 'number') return `${limit.number} hour`;
  if (limit.unit === 6) return 'Weekly';
  if (limit.unit === 5) return 'Monthly';
  return 'Token';
}

function windowRank(w: ZaiUsageWindow): number {
  const label = w.label.toLowerCase();
  if (label.includes('hour')) return 0;
  if (label.includes('week')) return 1;
  if (label.includes('month')) return 2;
  return 3;
}

function clampPercent(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}
