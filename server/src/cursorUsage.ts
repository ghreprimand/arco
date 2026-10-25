import type { CursorUsageInfo, CursorUsageEventRow, CursorIncludedUsage } from '@archon/shared';
import { readCursorAccessToken } from './providers/cursor/authToken.js';

// Cursor usage, read directly from cursor.com's private dashboard API using the
// session JWT that `cursor-agent` already stores and auto-refreshes. No browser
// scrape (unlike codexUsage.ts) — this is the strictly-cleaner path: same API the
// dashboard itself calls, own account, own token, read-only. See
// docs/CURSOR_TRANSPORT_PLAN.md §0.2 for the reverse-engineered contract.

const DASHBOARD_URL = 'https://cursor.com/dashboard';
const API_BASE = 'https://cursor.com/api';
const CACHE_MS = 3 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 12_000;
const PAGE_SIZE = 100;
// Backstop so a runaway/huge month can't spin forever; 50 pages = 5000 events.
const MAX_PAGES = 50;
// Keep the per-event table bounded — aggregates cover the whole period regardless.
const MAX_ROWS = 50;

interface UsageEvent {
  timestamp?: string;
  model?: string;
  kind?: string;
  chargedCents?: number;
  isTokenBasedCall?: boolean;
  isHeadless?: boolean;
  conversationId?: string;
  tokenUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    totalCents?: number;
  };
}

interface FilteredUsageResponse {
  totalUsageEventsCount?: number;
  usageEventsDisplay?: UsageEvent[];
}

let cached: CursorUsageInfo | null = null;

export async function getCursorUsage(force = false): Promise<CursorUsageInfo> {
  if (!force && cached && Date.now() - cached.fetchedAt < CACHE_MS) return cached;

  // Read the token FRESH every poll so we ride cursor-agent's background refresh
  // — never cache the JWT itself. authToken.ts owns the platform split
  // (auth.json on Linux, login keychain on macOS).
  const result = await readCursorAccessToken();
  if (result.token === null) {
    const missing = result.reason === 'missing';
    return cache({
      available: false,
      fetchedAt: Date.now(),
      source: missing ? 'disabled' : 'unavailable',
      dashboardUrl: DASHBOARD_URL,
      ...(missing ? { needsLogin: true } : {}),
      error: missing
        ? 'Not signed in to Cursor. Run `cursor-agent login`.'
        : (result.detail ?? 'Cursor session token is unreadable. Run `cursor-agent login`.'),
    });
  }

  const token = result.token;
  const sub = decodeJwtSub(token);
  if (!sub) {
    return cache({
      available: false,
      fetchedAt: Date.now(),
      source: 'unavailable',
      dashboardUrl: DASHBOARD_URL,
      needsLogin: true,
      error: 'Cursor session token is present but not usable. Run `cursor-agent login`.',
    });
  }

  const cookie = `WorkosCursorSessionToken=${encodeURIComponent(`${sub}::${token}`)}`;
  const now = Date.now();
  const monthStart = new Date(new Date(now).getFullYear(), new Date(now).getMonth(), 1).getTime();

  try {
    const events = await fetchAllEvents(cookie, monthStart, now);
    const hardCapped = await fetchHardCap(cookie);
    const included = await fetchIncludedUsage(cookie);

    let chargedCents = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    const kindCounts: Record<string, number> = {};
    for (const e of events) {
      chargedCents += e.chargedCents ?? 0;
      inputTokens += e.tokenUsage?.inputTokens ?? 0;
      outputTokens += e.tokenUsage?.outputTokens ?? 0;
      cacheReadTokens += e.tokenUsage?.cacheReadTokens ?? 0;
      const kind = e.kind ?? 'UNKNOWN';
      kindCounts[kind] = (kindCounts[kind] ?? 0) + 1;
    }
    const totalTokens = inputTokens + outputTokens + cacheReadTokens;

    const rows: CursorUsageEventRow[] = events
      .map(toRow)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, MAX_ROWS);

    return cache({
      available: true,
      fetchedAt: Date.now(),
      source: 'dashboard',
      dashboardUrl: DASHBOARD_URL,
      periodStart: monthStart,
      periodEnd: now,
      summary: summarize(chargedCents, totalTokens, events.length),
      chargedCents,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      totalTokens,
      eventCount: events.length,
      kindCounts,
      ...(hardCapped !== null ? { hardCapped } : {}),
      ...(included ? { included } : {}),
      rows,
    });
  } catch (err) {
    const unauthorized = err instanceof HttpError && (err.status === 401 || err.status === 403);
    return cache({
      available: false,
      fetchedAt: Date.now(),
      source: unauthorized ? 'unavailable' : 'error',
      dashboardUrl: DASHBOARD_URL,
      ...(unauthorized ? { needsLogin: true } : {}),
      error: unauthorized
        ? 'Cursor session token was rejected (stale or logged out). Run `cursor-agent login`.'
        : err instanceof Error ? err.message : String(err),
    });
  }
}

function cache(info: CursorUsageInfo): CursorUsageInfo {
  cached = info;
  return info;
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// The POST endpoints enforce a CSRF origin check — without Origin/Referer they
// 403 with "Invalid origin for state-changing request".
function postHeaders(cookie: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Origin: 'https://cursor.com',
    Referer: DASHBOARD_URL,
    Cookie: cookie,
  };
}

async function fetchAllEvents(cookie: string, startDate: number, endDate: number): Promise<UsageEvent[]> {
  const all: UsageEvent[] = [];
  let total = Infinity;
  for (let page = 1; page <= MAX_PAGES && all.length < total; page++) {
    const res = await fetch(`${API_BASE}/dashboard/get-filtered-usage-events`, {
      method: 'POST',
      headers: postHeaders(cookie),
      body: JSON.stringify({
        startDate: String(startDate),
        endDate: String(endDate),
        page,
        pageSize: PAGE_SIZE,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new HttpError(res.status, `get-filtered-usage-events HTTP ${res.status}`);
    const body = (await res.json()) as FilteredUsageResponse;
    const batch = body.usageEventsDisplay ?? [];
    if (typeof body.totalUsageEventsCount === 'number') total = body.totalUsageEventsCount;
    all.push(...batch);
    // Defensive: if a page returns nothing, stop rather than loop to MAX_PAGES.
    if (batch.length === 0) break;
  }
  return all;
}

// null = couldn't determine (endpoint drifted); don't surface a misleading flag.
async function fetchHardCap(cookie: string): Promise<boolean | null> {
  try {
    const res = await fetch(`${API_BASE}/dashboard/get-hard-limit`, {
      method: 'POST',
      headers: postHeaders(cookie),
      body: '{}',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { noUsageBasedAllowed?: boolean };
    return typeof body.noUsageBasedAllowed === 'boolean' ? body.noUsageBasedAllowed : null;
  } catch {
    return null;
  }
}

interface UsageSummaryResponse {
  billingCycleStart?: string;
  billingCycleEnd?: string;
  membershipType?: string;
  isUnlimited?: boolean;
  individualUsage?: {
    plan?: {
      used?: number;
      limit?: number;
      remaining?: number;
      totalPercentUsed?: number;
      autoPercentUsed?: number;
      apiPercentUsed?: number;
    };
    onDemand?: { enabled?: boolean; used?: number };
  };
}

// The "Included in Pro" gauge. GET (not POST) — no CSRF, but Cursor still wants
// the session cookie. null on any drift/failure so the rest of the snapshot
// (tokens, kinds, charged-$) still renders without it.
async function fetchIncludedUsage(cookie: string): Promise<CursorIncludedUsage | null> {
  try {
    const res = await fetch(`${API_BASE}/usage-summary`, {
      headers: { Origin: 'https://cursor.com', Referer: DASHBOARD_URL, Cookie: cookie },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const b = (await res.json()) as UsageSummaryResponse;
    const plan = b.individualUsage?.plan;
    if (!plan || typeof plan.limit !== 'number') return null;
    const used = plan.used ?? 0;
    return {
      usedCents: used,
      limitCents: plan.limit,
      remainingCents: plan.remaining ?? Math.max(0, plan.limit - used),
      totalPercentUsed: plan.totalPercentUsed ?? 0,
      autoPercentUsed: plan.autoPercentUsed ?? 0,
      apiPercentUsed: plan.apiPercentUsed ?? 0,
      billingCycleStart: Date.parse(b.billingCycleStart ?? '') || 0,
      billingCycleEnd: Date.parse(b.billingCycleEnd ?? '') || 0,
      membershipType: b.membershipType ?? 'pro',
      isUnlimited: b.isUnlimited ?? false,
      onDemandEnabled: b.individualUsage?.onDemand?.enabled ?? false,
      onDemandUsedCents: b.individualUsage?.onDemand?.used ?? 0,
    };
  } catch {
    return null;
  }
}

function toRow(e: UsageEvent): CursorUsageEventRow {
  return {
    timestamp: Number(e.timestamp) || 0,
    model: e.model ?? 'unknown',
    kind: e.kind ?? 'UNKNOWN',
    chargedCents: e.chargedCents ?? 0,
    isTokenBasedCall: e.isTokenBasedCall ?? false,
    isHeadless: e.isHeadless ?? false,
    inputTokens: e.tokenUsage?.inputTokens ?? 0,
    outputTokens: e.tokenUsage?.outputTokens ?? 0,
    cacheReadTokens: e.tokenUsage?.cacheReadTokens ?? 0,
    ...(e.conversationId ? { conversationId: e.conversationId } : {}),
  };
}

function summarize(chargedCents: number, totalTokens: number, count: number): string {
  const dollars = `$${(chargedCents / 100).toFixed(2)}`;
  const tokens = totalTokens >= 1000 ? `${(totalTokens / 1000).toFixed(1)}K` : String(totalTokens);
  return `${dollars} · ${tokens} tokens · ${count} event${count === 1 ? '' : 's'} MTD`;
}

// Pull the `sub` claim out of the JWT without a dependency — payload is the
// middle base64url segment. The cookie needs `${sub}::${accessToken}`.
function decodeJwtSub(token: string): string | null {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const json = Buffer.from(payload, 'base64url').toString('utf8');
    const sub = (JSON.parse(json) as { sub?: string }).sub;
    return typeof sub === 'string' && sub.length > 0 ? sub : null;
  } catch {
    return null;
  }
}
