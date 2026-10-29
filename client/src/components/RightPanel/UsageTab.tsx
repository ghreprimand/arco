import { useEffect, useMemo, useState } from 'react';
import type { JobState } from '../../stores/appStore';
import { useAppStore } from '../../stores/appStore';
import type { CursorUsageInfo, ProviderName, UsageProviderStats, UsageStatsResponse } from '@arco/shared';
import { EmptyState } from './FilesTab';
import { formatTokens, cacheUnreported } from './format';
import { CursorIncludedGauge } from '../CursorIncludedGauge';

// Workbench Expansion §D3 — Usage analytics over time.
//
// Per-project / per-provider / per-day token volume + cache-hit ratio, framed
// as QUOTA-PRESSURE insight (which tab/model is eating my rolling window), not
// cost. There is deliberately NO USD / dollar framing anywhere here — the
// operator is on subscriptions.
//
// Read-only: this fetches GET /api/usage-stats?path=<cwd>, which deterministically
// sums the existing primary_turn_token_usage events already in events.jsonl.
// No new capture, no LLM, nothing to mutate. Charts are hand-rolled inline SVG
// (sparklines + bars) — no chart-library dependency.

const PROVIDER_COLORS: Partial<Record<ProviderName, string>> = {
  claude: '#d97757',
  codex: '#10a37f',
  gemini: '#4285f4',
  ollama: '#a78bfa',
  llamacpp: '#e0a030',
  lmstudio: '#8b95f2',
  strata: '#e5ae71',
  deepseek: '#64a8fa',

  cursor: '#6cc6d6',
};

function providerColor(p: ProviderName): string {
  return PROVIDER_COLORS[p] ?? 'var(--color-accent-primary)';
}

export function UsageTab({ job }: { job: JobState }) {
  const cwd = job.config.workingDirectory;
  // Cursor is the one provider whose usage is POLLED from the authed dashboard
  // API rather than summed from per-turn events (ACP carries no token counts).
  // Its card rides on top of the per-project aggregation and renders even when
  // that aggregation is empty — a Cursor-only project has no per-turn events.
  const cursorUsage = useAppStore((s) => s.cursorUsage);
  const cursorLoggedIn = useAppStore((s) => s.authStatus?.cursor?.loggedIn ?? false);
  const setCursorUsage = useAppStore((s) => s.setCursorUsage);
  const showCursor = cursorLoggedIn && !!cursorUsage;
  const [data, setData] = useState<UsageStatsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bump to refetch.
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!cwd) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const q = new URLSearchParams({ path: cwd });
    fetch(`/api/usage-stats?${q.toString()}`)
      .then((r) => r.json())
      .then((body: UsageStatsResponse) => {
        if (cancelled) return;
        setData(body);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [cwd, nonce]);

  const providers = useMemo<ProviderName[]>(() => {
    if (!data) return [];
    return (Object.keys(data.perProvider) as ProviderName[])
      // Heaviest token volume first — the "what ate my window" ordering.
      .sort((a, b) => (data.perProvider[b]!.totals.promptTokens) - (data.perProvider[a]!.totals.promptTokens));
  }, [data]);

  const cursorCard = showCursor ? <CursorUsageCard usage={cursorUsage!} onUsage={setCursorUsage} /> : null;

  if (!cwd) {
    return <EmptyState text="No working directory for this workflow." />;
  }
  if (loading && !data && !cursorCard) {
    return <EmptyState text="Aggregating token usage from this project's conversations…" />;
  }
  if (error && !cursorCard) {
    return <EmptyState text={`Couldn't load usage stats: ${error}`} />;
  }
  const aggregationEmpty = !data || data.turnsAggregated === 0;
  if (aggregationEmpty && !cursorCard) {
    return (
      <EmptyState text="No token-usage turns recorded under this project yet. Run a few primary turns and the per-provider / per-day breakdown appears here." />
    );
  }

  // Cursor-only (or aggregation still loading/errored) — show the polled card
  // alone with a muted note in place of the per-project breakdown.
  if (aggregationEmpty) {
    return (
      <div style={{ overflowY: 'auto', flex: 1, padding: '8px 0' }}>
        {cursorCard}
        <div style={{ padding: '4px 14px', fontSize: '10px', color: 'var(--color-fg-muted)', lineHeight: 1.5 }}>
          {error
            ? `Per-project token aggregation couldn't load: ${error}`
            : 'No per-turn token aggregation for this project yet. Cursor spend is polled above; other providers appear here once they run a turn.'}
        </div>
      </div>
    );
  }

  return (
    <div style={{ overflowY: 'auto', flex: 1, padding: '8px 0' }}>
      {cursorCard}
      <SectionHeader
        label="USAGE"
        right={`${data.turnsAggregated} turn${data.turnsAggregated === 1 ? '' : 's'} · ${data.workflowsScanned} conversation${data.workflowsScanned === 1 ? '' : 's'}`}
        onRefresh={() => setNonce((n) => n + 1)}
      />

      {/* Grand totals — the at-a-glance quota-pressure summary. */}
      <div style={{ padding: '4px 14px 10px', fontSize: '11px', fontFamily: 'var(--font-body)', color: 'var(--color-fg)', lineHeight: 1.5 }}>
        <div>
          {formatTokens(data.grandTotals.promptTokens)} prompt
          {' · '}{formatTokens(data.grandTotals.output)} out
          {data.grandTotals.promptTokens > 0 ? ` · ${Math.round(data.grandTotals.cacheHitRatio * 100)}% cache-hit` : ''}
        </div>
        <div style={{ color: 'var(--color-fg-muted)', fontSize: '10px', marginTop: '2px' }}>
          {formatTokens(data.grandTotals.input)} fresh · {formatTokens(data.grandTotals.cacheRead)} cache-read · {formatTokens(data.grandTotals.cacheCreate)} cache-write
        </div>
      </div>

      {providers.map((p) => (
        <ProviderBlock key={p} provider={p} stats={data.perProvider[p]!} days={data.days} />
      ))}
    </div>
  );
}

function SectionHeader({ label, right, onRefresh }: { label: string; right: string; onRefresh: () => void }) {
  return (
    <div
      className="display-font"
      style={{
        display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'space-between',
        padding: '2px 14px 6px', fontSize: '10px', letterSpacing: '1.5px', color: 'var(--color-fg-muted)',
      }}
    >
      <span>{label}</span>
      <span style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
        <span>{right}</span>
        <button
          onClick={onRefresh}
          data-help="rightpanel.usage.refresh"
          title="Re-aggregate from disk"
          style={{
            background: 'transparent', border: '1px solid var(--color-border-hairline)',
            color: 'var(--color-fg-muted)', cursor: 'pointer', fontSize: '9px',
            letterSpacing: '1px', padding: '2px 6px', fontFamily: 'var(--font-display)',
          }}
        >
          ↻
        </button>
      </span>
    </div>
  );
}

function ProviderBlock({ provider, stats, days }: { provider: ProviderName; stats: UsageProviderStats; days: string[] }) {
  const color = providerColor(provider);
  // Align this provider's per-day prompt volume onto the shared day axis so
  // sparse days render as gaps rather than shifting the curve.
  const byDay = new Map(stats.byDay.map((b) => [b.day, b]));
  const series = days.map((d) => byDay.get(d)?.promptTokens ?? 0);
  const ratioPct = Math.round(stats.totals.cacheHitRatio * 100);
  const noCacheData = cacheUnreported(provider);

  return (
    <div style={{ marginBottom: '12px' }}>
      <div
        className="display-font"
        style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '2px 14px 4px', fontSize: '10px', letterSpacing: '1px', color: 'var(--color-fg-muted)' }}
      >
        <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: color, display: 'inline-block' }} />
        <span style={{ color: 'var(--color-fg)' }}>{provider.toUpperCase()}</span>
        <span>· {formatTokens(stats.totals.promptTokens)} prompt · {formatTokens(stats.totals.output)} out</span>
      </div>

      {/* Per-day prompt-volume sparkline (hand-rolled SVG). */}
      <div style={{ padding: '2px 14px' }}>
        <Sparkline values={series} color={color} />
      </div>

      {/* Cache-hit ratio bar — provider-correct denominator computed server-side. */}
      <div style={{ padding: '4px 14px 0', display: 'flex', alignItems: 'center', gap: '8px' }}>
        {!noCacheData && <RatioBar ratio={stats.totals.cacheHitRatio} color={color} />}
        <span style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontVariantNumeric: 'tabular-nums', minWidth: '78px' }}>
          {noCacheData ? 'cache n/r' : stats.totals.promptTokens > 0 ? `${ratioPct}% cache-hit` : 'no cache'}
        </span>
      </div>

      {/* Per-day rows — newest last (matches the sparkline left→right). */}
      <div style={{ padding: '4px 14px 0' }}>
        {stats.byDay.map((b) => (
          <div
            key={b.day}
            style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', fontVariantNumeric: 'tabular-nums', padding: '1px 0' }}
          >
            <span>{b.day}</span>
            <span>
              {formatTokens(b.promptTokens)} prompt · {formatTokens(b.output)} out · {b.turns} turn{b.turns === 1 ? '' : 's'}
              {b.promptTokens > 0 && !noCacheData ? ` · ${Math.round(b.cacheHitRatio * 100)}%` : ''}
            </span>
          </div>
        ))}
      </div>
      <div style={{ height: '1px', margin: '8px 14px 0', background: 'var(--color-border-hairline)' }} />
    </div>
  );
}

// Hand-rolled SVG sparkline. Renders the per-day series as a polyline scaled to
// the local max, plus a faint baseline. No chart library. A single point (one
// active day) renders as a dot so it isn't an invisible zero-length line.
function Sparkline({ values, color }: { values: number[]; color: string }) {
  const W = 240;
  const H = 28;
  const pad = 2;
  const max = Math.max(1, ...values);
  const n = values.length;
  if (n === 0) return null;
  const x = (i: number) => (n === 1 ? W / 2 : pad + (i * (W - 2 * pad)) / (n - 1));
  const y = (v: number) => H - pad - (v / max) * (H - 2 * pad);
  const points = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ display: 'block' }} role="img" aria-label="per-day prompt token volume">
      <line x1={0} y1={H - pad} x2={W} y2={H - pad} stroke="var(--color-border-hairline)" strokeWidth={1} />
      {n === 1 ? (
        <circle cx={x(0)} cy={y(values[0])} r={2.5} fill={color} />
      ) : (
        <polyline points={points} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      )}
    </svg>
  );
}

const CURSOR_COLOR = PROVIDER_COLORS.cursor!;
const CURSOR_DASHBOARD_URL = 'https://cursor.com/dashboard?tab=usage';

// Cursor's polled month-to-date card. Unlike every other provider block (summed
// from per-turn events), this reads the authed dashboard API snapshot in the
// store — ACP exposes no per-turn tokens, so this is the ONLY place Cursor spend
// surfaces. Framed as "polled · not live" so a blank in-tab live meter doesn't
// read as a bug. Lead with tokens (quota-pressure framing); charged-$ is
// secondary and typically $0 while hard-capped (included in Pro, no overage).
function CursorUsageCard({ usage, onUsage }: { usage: CursorUsageInfo; onUsage: (u: CursorUsageInfo) => void }) {
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    setRefreshing(true);
    try {
      const r = await fetch('/api/cursor-usage?force=1');
      onUsage((await r.json()) as CursorUsageInfo);
    } catch { /* leave previous value */ }
    setRefreshing(false);
  };

  const kinds = usage.kindCounts ? Object.entries(usage.kindCounts).sort((a, b) => b[1] - a[1]) : [];
  const cents = usage.chargedCents ?? 0;

  return (
    <div style={{ marginBottom: '12px' }}>
      <div
        className="display-font"
        style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '2px 14px 4px', fontSize: '10px', letterSpacing: '1px', color: 'var(--color-fg-muted)' }}
      >
        <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: CURSOR_COLOR, display: 'inline-block' }} />
        <span style={{ color: 'var(--color-fg)' }}>CURSOR</span>
        <span title="Polled from the Cursor dashboard API, not per-turn (ACP reports no tokens).">· polled · not live</span>
        <span style={{ flex: 1 }} />
        <button
          onClick={refresh}
          disabled={refreshing}
          title="Re-poll cursor.com dashboard"
          style={{
            background: 'transparent', border: '1px solid var(--color-border-hairline)',
            color: 'var(--color-fg-muted)', cursor: refreshing ? 'default' : 'pointer', fontSize: '9px',
            letterSpacing: '1px', padding: '2px 6px', fontFamily: 'var(--font-display)',
          }}
        >
          {refreshing ? '…' : '↻'}
        </button>
      </div>

      {usage.available ? (
        <div style={{ padding: '2px 14px 0', fontFamily: 'var(--font-body)', fontVariantNumeric: 'tabular-nums' }}>
          {/* The included-allocation gauge — the headline signal (same meter as
              cursor.com's Spending page). Only when usage-summary resolved. */}
          {usage.included && (
            <div style={{ marginBottom: '8px' }}>
              <CursorIncludedGauge inc={usage.included} />
            </div>
          )}
          {/* Primary: tokens + events MTD (quota-pressure framing). */}
          <div style={{ fontSize: '11px', color: 'var(--color-fg)' }}>
            {formatTokens(usage.totalTokens ?? 0)} tokens · {usage.eventCount ?? 0} event{usage.eventCount === 1 ? '' : 's'} MTD
          </div>
          {/* Token split. */}
          <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', marginTop: '2px' }}>
            {formatTokens(usage.inputTokens ?? 0)} in · {formatTokens(usage.outputTokens ?? 0)} out · {formatTokens(usage.cacheReadTokens ?? 0)} cache-read
          </div>
          {/* Secondary: charged-$ / hard-cap posture — only as a fallback when the
              richer included gauge didn't resolve (the gauge already carries $ +
              on-demand state). */}
          {!usage.included && (
            <div style={{ fontSize: '10px', marginTop: '3px', color: usage.hardCapped ? 'var(--color-accent-secondary)' : 'var(--color-fg-muted)' }}>
              {usage.hardCapped
                ? `included in plan · no overage${cents > 0 ? ` · ${formatCents(cents)} charged` : ''}`
                : cents > 0
                  ? `${formatCents(cents)} charged MTD (usage-based overage enabled)`
                  : 'usage-based overage enabled · nothing charged yet'}
            </div>
          )}
          {/* Per-kind event breakdown as chips. */}
          {kinds.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '6px' }}>
              {kinds.map(([kind, count]) => (
                <span
                  key={kind}
                  title={kind}
                  style={{
                    fontSize: '9px', letterSpacing: '0.3px', padding: '1px 5px', borderRadius: '2px',
                    background: 'var(--color-border-hairline)', color: 'var(--color-fg-muted)', whiteSpace: 'nowrap',
                  }}
                >
                  {prettyKind(kind)} ×{count}
                </span>
              ))}
            </div>
          )}
          <a
            href={CURSOR_DASHBOARD_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="display-font"
            style={{ display: 'inline-block', marginTop: '7px', fontSize: '9px', letterSpacing: '1px', color: CURSOR_COLOR, textDecoration: 'none' }}
          >
            OPEN CURSOR DASHBOARD ↗
          </a>
        </div>
      ) : (
        <div style={{ padding: '2px 14px 0', fontSize: '10px', color: 'var(--color-fg-muted)', lineHeight: 1.5 }}>
          <div>
            {usage.needsLogin
              ? <>Not signed in to Cursor. Run <code style={{ fontFamily: 'var(--font-mono)' }}>cursor-agent login</code>, then ↻.</>
              : (usage.error ?? 'Cursor usage has not loaded yet.')}
          </div>
          <a
            href={CURSOR_DASHBOARD_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="display-font"
            style={{ display: 'inline-block', marginTop: '6px', fontSize: '9px', letterSpacing: '1px', color: CURSOR_COLOR, textDecoration: 'none' }}
          >
            OPEN CURSOR DASHBOARD ↗
          </a>
        </div>
      )}
      <div style={{ height: '1px', margin: '10px 14px 0', background: 'var(--color-border-hairline)' }} />
    </div>
  );
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// USAGE_EVENT_KIND_INCLUDED_IN_PRO → "included in pro". Raw kind stays on the
// chip's title for the curious.
function prettyKind(raw: string): string {
  return raw.replace(/^USAGE_EVENT_KIND_/, '').replace(/_/g, ' ').toLowerCase();
}

// Hand-rolled SVG horizontal bar for the cache-hit ratio (0..1).
function RatioBar({ ratio, color }: { ratio: number; color: string }) {
  const W = 120;
  const H = 8;
  const w = Math.max(0, Math.min(1, ratio)) * W;
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="cache-hit ratio">
      <rect x={0} y={0} width={W} height={H} rx={2} fill="var(--color-border-hairline)" />
      {w > 0 && <rect x={0} y={0} width={w} height={H} rx={2} fill={color} />}
    </svg>
  );
}
