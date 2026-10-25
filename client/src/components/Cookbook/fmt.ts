import type { FitVerdict } from '@archon/shared';

// Workbench Expansion G2 — shared formatters + the FIT verdict palette for the
// Cookbook catalog table. Pure display helpers; no state.

export function fmtBytes(n: number | undefined): string {
  if (!n || n <= 0) return '—';
  const gb = n / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = n / (1024 * 1024);
  return `${mb.toFixed(0)} MB`;
}

export function fmtCtx(tokens: number): string {
  if (!tokens || tokens <= 0) return '—';
  if (tokens >= 1024) return `${Math.round(tokens / 1024)}k`;
  return String(tokens);
}

export function fmtTps(tps: number): string {
  if (!tps || tps <= 0) return '—';
  return `${tps.toFixed(tps < 10 ? 1 : 0)} t/s`;
}

export function fmtParams(b: number): string {
  if (!b || b <= 0) return '—';
  return `${b}B`;
}

// FIT verdict → colour (green/amber/red, matching the screenshots). PERFECT and
// GOOD are green-ish, TIGHT amber, NO red.
export function verdictColor(v: FitVerdict): string {
  switch (v) {
    case 'PERFECT': return 'var(--color-success, #4ade80)';
    case 'GOOD': return 'var(--color-accent-primary)';
    case 'TIGHT': return 'var(--color-warning)';
    case 'NO': return 'var(--color-error, #f87171)';
  }
}
