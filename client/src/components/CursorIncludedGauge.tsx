import type { CursorIncludedUsage } from '@archon/shared';

// The "Included in Pro" allocation gauge — the same meter cursor.com's Spending
// page shows. Bar fill is Cursor's own blended `totalPercentUsed` (NOT
// used/limit — Cursor weights first-party vs API differently), so it matches the
// dashboard exactly rather than a number we synthesize. `used`/`limit` cents give
// the concrete dollar caption. In the tight header-hover variant, `compact`
// replaces the detail sub-line with Cursor's separate Other Models meter so
// both included quotas remain visible from the R status dot.
export function CursorIncludedGauge({ inc, compact }: { inc: CursorIncludedUsage; compact?: boolean }) {
  const pct = Math.max(0, Math.min(100, inc.totalPercentUsed));
  // Floor a non-zero fraction to a visible sliver so "used something" doesn't
  // render as an empty bar (mirrors the dashboard's thin blue sliver).
  const fill = inc.usedCents > 0 ? Math.max(pct, 1.5) : 0;
  const color = pct >= 90 ? 'var(--color-danger)' : pct >= 70 ? 'var(--color-warning)' : 'var(--color-accent-secondary)';
  const resets = inc.billingCycleEnd
    ? new Date(inc.billingCycleEnd).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', fontSize: '10px', color: 'var(--color-fg-muted)' }}>
        <span>Included in {planLabel(inc.membershipType)}</span>
        <span style={{ color: 'var(--color-fg-default)', fontVariantNumeric: 'tabular-nums' }}>
          {dollars(inc.usedCents)} / {inc.isUnlimited ? '∞' : dollars(inc.limitCents)}
        </span>
      </div>
      <div style={{ height: '6px', background: 'var(--color-accent-primary-a08)', borderRadius: '3px', overflow: 'hidden' }}>
        <div style={{ width: `${fill}%`, height: '100%', background: color, transition: 'width 0.3s ease' }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', fontSize: '9px', color: 'var(--color-fg-muted)', fontVariantNumeric: 'tabular-nums' }}>
        <span>{fmtPct(inc.totalPercentUsed)} used{inc.isUnlimited ? ' · unlimited plan' : ''}</span>
        {resets && <span>resets {resets}</span>}
      </div>
      {compact ? (
        <CursorOtherModelsGauge percentageUsed={inc.apiPercentUsed} />
      ) : (
        <div style={{ fontSize: '9px', color: 'var(--color-fg-muted)' }}>
          {fmtPct(inc.autoPercentUsed)} first-party · {fmtPct(inc.apiPercentUsed)} API
          {inc.onDemandEnabled ? ` · on-demand ${dollars(inc.onDemandUsedCents)}` : ' · on-demand off'}
        </div>
      )}
    </div>
  );
}

function CursorOtherModelsGauge({ percentageUsed }: { percentageUsed: number }) {
  const pct = Math.max(0, Math.min(100, percentageUsed));
  const fill = pct > 0 ? Math.max(pct, 1.5) : 0;
  const color = pct >= 90 ? 'var(--color-danger)' : pct >= 70 ? 'var(--color-warning)' : 'var(--color-accent-secondary)';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', marginTop: '5px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', fontSize: '10px', color: 'var(--color-fg-muted)' }}>
        <span>Other Models</span>
        <span style={{ color: 'var(--color-fg-default)', fontVariantNumeric: 'tabular-nums' }}>{fmtPct(percentageUsed)} used</span>
      </div>
      <div style={{ height: '6px', background: 'var(--color-accent-primary-a08)', borderRadius: '3px', overflow: 'hidden' }}>
        <div style={{ width: `${fill}%`, height: '100%', background: color, transition: 'width 0.3s ease' }} />
      </div>
    </div>
  );
}

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function planLabel(t: string): string {
  if (t === 'pro_plus') return 'Pro+';
  if (!t) return 'plan';
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// Cursor's own percentages are tiny fractions of a percent early in the cycle;
// show "<1%" rather than rounding a real-but-small usage down to 0%.
function fmtPct(p: number): string {
  if (p <= 0) return '0%';
  if (p < 1) return '<1%';
  return `${Math.round(p)}%`;
}
