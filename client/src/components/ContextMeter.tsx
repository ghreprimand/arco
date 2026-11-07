import { useEffect, useState } from 'react';
import type { JobState } from '../stores/appStore';
import { useCodexCatalogFor } from '../hooks/useCodexCatalog';
import { GenerationSpeedReadout } from './GenerationSpeedReadout';
import { cacheHitPercent, codexPublishedMaxOutput, contextPercentColor, contextTokens, providerOperationalWindow, providerPublishedContextWindow } from '../utils/format';

const HANDOFF_GUIDE = 'HANDOFF can help for an unrelated task, a worker on a wrong track, a provider or model switch, or a provider without compaction. Compaction is lossy but has no fixed limit; plans, board, goal, artifacts and Git remain outside the conversation. QUICK builds a deterministic seed; ORIGINAL WORKER writes a reflection; FRESH SUMMARIZER uses a separate worker.';

const CACHE_TTL_MS = 5 * 60 * 1000;

function CacheWarmthTimer({ endedAt }: { endedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const remainingMs = CACHE_TTL_MS - (now - endedAt);
  const cold = remainingMs <= 0;
  const remainingSec = Math.max(0, Math.ceil(remainingMs / 1000));
  const mm = Math.floor(remainingSec / 60);
  const ss = remainingSec % 60;
  const color = cold
    ? 'var(--color-fg-muted)'
    : remainingSec > 120
      ? 'var(--color-accent-secondary)'
      : remainingSec > 30
        ? 'var(--color-warning)'
        : 'var(--color-danger)';
  const label = cold ? 'cache cold' : `cache ${mm}:${ss.toString().padStart(2, '0')}`;
  const tooltip = cold
    ? 'Prompt cache likely cold: next turn pays full input rate on the entire prefix. Anthropic\'s 5-min idle TTL has elapsed since the last turn ended.\n\nApproximate: doesn\'t account for prefix invalidation (model swap, tools/skills change, system-prompt edits) which kill the cache early.'
    : `Prompt cache likely warm for ~${mm}m ${ss}s more. Each cached turn resets the 5-min TTL. Walking away past 0:00 means the next turn pays full input rate on the entire prefix.\n\nApproximate: doesn\'t account for prefix invalidation (model swap, tools/skills change, system-prompt edits) which kill the cache early.`;
  return (
    <>
      <span style={{ color: 'var(--color-fg-muted)', opacity: 0.6 }}>·</span>
      <span title={tooltip} style={{ color, opacity: cold ? 0.7 : 1 }}>
        {label}
      </span>
    </>
  );
}

// Compact token readout for the worker header.
// Phase 2: for Claude sessions, shows the byte-count context fill estimate
// (CTX: NNK / NNK  NN%) color-coded green/amber/red. Falls back to the
// per-turn ctx figure for non-Claude providers. ↑ OUT is cumulative output.
export function ContextMeter({ job, onRecalibrate }: { job: JobState; onRecalibrate?: () => void }) {
  const codexCatalog = useCodexCatalogFor(job.config.providerAccountRef);
  const cu = job.contextUsage;
  const outCumulative = job.totalTokens.output;

  if (cu) {
    const fillColor = contextPercentColor(cu.percentOfWindow);
    const estK = compact(cu.estimatedTokens);
    const winK = compact(cu.windowSize);
    // Method marker: empty dot = byte-count (estimate only), half dot =
    // calibrated (zone-calibrated ratio from past /context reading), full dot
    // = ground-truth (freshest /context reading). Hover for details.
    const methodGlyph = cu.method === 'ground-truth' ? '●' : cu.method === 'calibrated' ? '◐' : '○';
    const methodColor =
      cu.method === 'ground-truth' ? 'var(--color-accent-primary)' :
      cu.method === 'calibrated' ? 'var(--color-accent-primary)' :
      'var(--color-fg-muted)';
    const calibratedAgo = cu.calibratedAt
      ? `${Math.max(1, Math.round((Date.now() - cu.calibratedAt) / 60000))}m ago`
      : 'never';
    // Only Claude sessions support ground-truth calibration, and only while
    // idle (server refuses during a primary turn — two claude processes
    // hitting the same JSONL corrupts state). Gate the click affordance on
    // the same conditions so we don't advertise a button that'll just bounce.
    const canRecalibrate =
      typeof onRecalibrate === 'function' &&
      job.config.primaryProvider !== 'codex' && job.config.primaryProvider !== 'ollama' && job.busy !== true;
    const isGroundTruth = cu.method === 'ground-truth';
    const headline = isGroundTruth
      ? 'Context fill (provider ground-truth)'
      : `Context fill estimate (${cu.method})`;
    const tokensLine = isGroundTruth
      ? `${cu.estimatedTokens.toLocaleString()} / ${cu.windowSize.toLocaleString()} tokens (${cu.percentOfWindow}%)`
      : `~${cu.estimatedTokens.toLocaleString()} / ${cu.windowSize.toLocaleString()} tokens (${cu.percentOfWindow}%)`;
    const lastLine = isGroundTruth
      ? `Last turn read: ${calibratedAgo}`
      : `Last calibration: ${calibratedAgo}`;
    const hoverText = [
      headline,
      HANDOFF_GUIDE,
      tokensLine,
      `Messages: ~${cu.messagesTokens.toLocaleString()} tokens (${compact(cu.jsonlBytes)} JSONL)`,
      `Overhead: ~${cu.overheadTokens.toLocaleString()} tokens`,
      lastLine,
      outCumulative > 0 ? `Output (cumulative): ${outCumulative.toLocaleString()} tokens` : '',
      canRecalibrate && !isGroundTruth ? 'Click to force a fresh /context calibration.' : '',
    ].filter(Boolean).join('\n');
    return (
      <span style={{ whiteSpace: 'nowrap', display: 'inline-flex', gap: '8px', alignItems: 'center' }}>
        <span
          title={hoverText}
          onClick={canRecalibrate ? onRecalibrate : undefined}
          style={{
            color: fillColor,
            cursor: canRecalibrate ? 'pointer' : 'default',
            textDecoration: canRecalibrate ? 'underline dotted transparent' : 'none',
            textUnderlineOffset: '3px',
            transition: 'text-decoration-color 0.15s',
          }}
          onMouseEnter={(e) => { if (canRecalibrate) (e.currentTarget as HTMLSpanElement).style.textDecorationColor = 'currentColor'; }}
          onMouseLeave={(e) => { if (canRecalibrate) (e.currentTarget as HTMLSpanElement).style.textDecorationColor = 'transparent'; }}
        >
          CTX: {estK} / {winK}
          {' '}
          <span style={{ fontWeight: 600 }}>{cu.percentOfWindow}%</span>
          {' '}
          <span style={{ color: methodColor, opacity: 0.9 }}>{methodGlyph}</span>
        </span>
        {/* Cache-warmth countdown — Claude only, idle only, and only when the
            context is large enough that a cold start would actually hurt
            (cache-miss cost scales linearly with prefix size). Below ~50k the
            miss is pennies; the timer would be alarmist noise. */}
        {!job.busy && job.lastTurnEndedAt && cu.estimatedTokens >= 50_000 && (
          <CacheWarmthTimer endedAt={job.lastTurnEndedAt} />
        )}
        <span style={{ color: 'var(--color-fg-muted)', opacity: 0.6 }}>·</span>
        <span data-help="worker.header.tokens" style={{ color: 'var(--color-fg-muted)', opacity: 0.8 }}>
          ↑ {outCumulative > 0 ? compact(outCumulative) : '-'} OUT
        </span>
        <GenerationSpeedReadout job={job} />
      </span>
    );
  }

  // Fallback path: no server-emitted contextUsage (non-Claude providers, or
  // Claude pre-first-turn). For Codex we have actual token counts from the
  // turn.completed.usage event, so we can render a real CTX: NN / NN  NN%
  // bar against the model's known window. ctx for Codex is just `input`
  // (cacheRead is a subset, not additive — see contextTokens).
  const last = job.lastTurnTokens;
  const provider = job.config.primaryProvider;
  if (provider === 'cursor') {
    return (
      <span
        title={`Cursor manages its own context; no live retained-token count is available.\n${HANDOFF_GUIDE}`}
        style={{ opacity: 0.75, whiteSpace: 'nowrap' }}
      >
        CTX: Cursor-managed
        <span style={{ color: 'var(--color-fg-muted)', opacity: 0.6 }}> · </span>
        ↑ {outCumulative > 0 ? compact(outCumulative) : '-'} OUT
      </span>
    );
  }

  if (last && (provider === 'codex')) {
    const ctx = contextTokens(last, provider);
    // Prefer the provider-reported context window (set when Codex emits
    // model_context_window via primary_complete.modelContextWindow). Falls
    // back to provider-specific static metadata when the stream hasn't
    const observedWindow = job.modelContextWindow;
    const catalogModel = provider === 'codex'
      ? codexCatalog?.models?.find((model) => model.id === job.config.primaryModel)
      : undefined;
    const catalogRawWindow = job.config.codexContextPolicy === 'standard'
      ? catalogModel?.contextWindow
      : catalogModel?.maxContextWindow;
    const catalogWindow = catalogRawWindow
      ? Math.floor(catalogRawWindow * (catalogModel?.effectiveContextWindowPercent ?? 95) / 100)
      : undefined;
    const window = observedWindow ?? catalogWindow ?? providerOperationalWindow(provider, job.config.primaryModel);
    const windowSource = observedWindow ? 'reported' : 'estimate';
    const percent = Math.min(100, Math.round((ctx / window) * 100));
    const fillColor = contextPercentColor(percent);
    const reasoningOutput = last.reasoningOutput ?? 0;
    const totalReported = last.total;
    const cachePct = cacheHitPercent(last);
    const publishedWindow = providerPublishedContextWindow(provider, job.config.primaryModel);
    const maxOutput = codexPublishedMaxOutput(job.config.primaryModel);
    const providerLabel = 'Codex';
    const hover = [
      HANDOFF_GUIDE,
      `${providerLabel} context fill: last turn's input_tokens (already the full prompt)`,
      `~${ctx.toLocaleString()} / ${window.toLocaleString()} tokens (${percent}%) · window: ${windowSource}`,
      maxOutput === null
        ? `Configured model window: ${publishedWindow.toLocaleString()} context`
        : `Published model window: ${publishedWindow.toLocaleString()} context · ${maxOutput.toLocaleString()} max output`,
      `${last.input.toLocaleString()} input (of which ${(last.cacheRead ?? 0).toLocaleString()} served from prefix cache)`,
      cachePct !== null ? `Prompt-cache hit rate: ${cachePct}%` : '',
      reasoningOutput > 0
        ? `${last.output.toLocaleString()} output (of which ${reasoningOutput.toLocaleString()} reasoning trace: carries forward into next turn's prompt)`
        : `${last.output.toLocaleString()} output`,
      typeof totalReported === 'number'
        ? `Total reported by ${providerLabel}: ${totalReported.toLocaleString()}`
        : '',
      outCumulative > 0 ? `Output (cumulative): ${outCumulative.toLocaleString()} tokens` : '',
      windowSource === 'reported'
        ? `Window reported by ${providerLabel} via model_context_window: honest operational limit.`
        : `Window is a client-side operational estimate until ${providerLabel} reports model_context_window. The public model window includes output budget; this bar tracks usable input/context fill.`,
      `${providerLabel} manages its own compaction internally: no Arco auto-handoff fires on this bar.`,
    ].filter(Boolean).join('\n');
    return (
      <span style={{ whiteSpace: 'nowrap', display: 'inline-flex', gap: '8px', alignItems: 'center' }}>
        <span title={hover} style={{ color: fillColor }}>
          CTX: {compact(ctx)} / {compact(window)}
          {' '}
          <span style={{ fontWeight: 600 }}>{percent}%</span>
          {' '}
          <span style={{ color: 'var(--color-fg-muted)', opacity: 0.6, fontSize: '9px' }}>
            {observedWindow ? '●' : '○'}
          </span>
        </span>
        <span style={{ color: 'var(--color-fg-muted)', opacity: 0.6 }}>·</span>
        <span style={{ color: 'var(--color-fg-muted)', opacity: 0.8 }}>
          ↑ {outCumulative > 0 ? compact(outCumulative) : '-'} OUT
        </span>
      </span>
    );
  }

  const ctx = last ? contextTokens(last, provider) : 0;
  return (
    <span style={{ whiteSpace: 'nowrap', display: 'inline-flex', gap: '8px', alignItems: 'center' }}>
      <span
        title={`Last turn ctx (${provider === 'codex' ? 'input' : 'input + cacheCreate'}): ${ctx.toLocaleString()} · cumulative output across this tab: ${outCumulative.toLocaleString()}\n${HANDOFF_GUIDE}`}
        style={{ opacity: 0.7, whiteSpace: 'nowrap', color: 'var(--color-fg)' }}
      >
        ↓ {ctx > 0 ? compact(ctx) : '-'} CTX · ↑ {outCumulative > 0 ? compact(outCumulative) : '-'} OUT
      </span>
      <GenerationSpeedReadout job={job} />
    </span>
  );
}

function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return Math.round(n / 1000) + 'k';
}
