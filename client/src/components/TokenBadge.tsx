import type { TokenUsage, ProviderName } from '@arco/shared';
import {
  formatTokenCount,
  contextTokens,
  contextFillColor,
  tokenHoverTitle,
  DEFAULT_AUTO_COMPACT_THRESHOLD,
} from '../utils/format';

interface Props {
  // Provider usage for this worker. Claude turn totals are not a context reading.
  turnTokens?: TokenUsage;
  // Cumulative output across the whole workflow / worker. Used for the `out`
  // half of the pair. Falls back to turnTokens.output if omitted.
  cumulativeOutput?: number;
  // For the hover-title; aggregates the full kitchen-sink cumulative counters.
  cumulativeTokens?: TokenUsage;
  // Effective auto-compact threshold; drives the context-fill bar. Pass
  // `settings.autoCompactInputTokens` (clamped on the server); falls back to
  // 80K if unset. Claude-shape; for Codex use a model window instead (see
  // codexModelWindow + the TokensFooter footer fallback).
  threshold?: number;
  // When true, render the thin context-fill bar beneath the numbers. Off by
  // default so tight tile footers stay compact.
  showBar?: boolean;
  // Suppresses the "out" half; useful in places where only ctx is meaningful.
  hideOut?: boolean;
  provider?: ProviderName;
  // Optional style overrides for the container span.
  style?: React.CSSProperties;
}

// Output remains available as usage. Claude worker usage does not carry a
// retained-context reading, so the badge shows an unknown context.
export function TokenBadge({
  turnTokens,
  cumulativeOutput,
  cumulativeTokens,
  threshold,
  showBar,
  hideOut,
  provider,
  style,
}: Props) {
  if (!turnTokens) return null;
  const effectiveProvider = provider ?? 'claude';
  const ctx = effectiveProvider === 'claude' ? undefined : contextTokens(turnTokens, effectiveProvider);
  if (ctx === 0 && !cumulativeOutput && !turnTokens.output) return null;

  const out = cumulativeOutput ?? turnTokens.output ?? 0;
  const effectiveThreshold = threshold && threshold > 0 ? threshold : DEFAULT_AUTO_COMPACT_THRESHOLD;
  const fraction = ctx === undefined ? 0 : Math.min(1, ctx / effectiveThreshold);
  const barColor = contextFillColor(fraction);

  const ctxFormula = provider === 'codex' ? 'input' : 'input+cacheCreate';
  const hoverSource = cumulativeTokens ?? turnTokens;
  const hoverTitle = tokenHoverTitle(hoverSource, cumulativeTokens
    ? `cumulative (all turns + workers):`
    : `last turn:`, effectiveProvider)
    + (ctx === undefined ? '\n\nContext reading unavailable for this worker.' : cumulativeTokens ? `\n\nctx (last turn ${ctxFormula}): ${ctx.toLocaleString()} / ${effectiveThreshold.toLocaleString()} (${Math.round(fraction * 100)}%)` : '');

  return (
    <span
      title={hoverTitle}
      style={{
        display: 'inline-flex',
        flexDirection: 'column',
        gap: '2px',
        fontFamily: 'var(--font-display)',
        ...style,
      }}
    >
      <span style={{ display: 'inline-flex', gap: '6px', alignItems: 'baseline' }}>
        {!hideOut && (
          <span style={{ color: 'var(--color-fg-muted)' }}>
            {formatTokenCount(out)} <span style={{ opacity: 0.7 }}>out</span>
          </span>
        )}
        {!hideOut && (
          <span style={{ color: 'var(--color-fg-muted)', opacity: 0.5 }}>·</span>
        )}
        <span style={{ color: barColor }}>
          {ctx === undefined ? '-' : formatTokenCount(ctx)} <span style={{ opacity: 0.7 }}>ctx</span>
        </span>
      </span>
      {showBar && ctx !== undefined && (
        <span
          aria-hidden
          style={{
            display: 'block',
            width: '100%',
            height: '2px',
            background: 'var(--color-accent-primary-a08)',
            borderRadius: '1px',
            overflow: 'hidden',
          }}
        >
          <span
            style={{
              display: 'block',
              height: '100%',
              width: `${Math.max(2, fraction * 100)}%`,
              background: barColor,
              transition: 'width 0.3s ease, background 0.3s ease',
            }}
          />
        </span>
      )}
    </span>
  );
}
