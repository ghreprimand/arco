import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../stores/appStore';
import type { ProviderName } from '@arco/shared';

// I1 — one compact "workflow status" chip folding the two pieces of urgent,
// always-visible runtime state that used to live as separate header widgets:
//   • context fill for the ACTIVE workflow (was an implicit right-panel/composer
//     readout — now glanceable from the header), and
//   • per-provider quota/throttle (was the standalone QuotaBadge, which only
//     appeared when throttled).
// The chip shows the high-signal token (context % or a ⚠ when throttled) and
// opens a details popover on click (exact context numbers + per-provider quota
// reset times). Renders nothing when there's neither an active-workflow context
// reading nor a throttle — a fresh boot / cluster tab stays clean.

const PROVIDER_ORDER: ProviderName[] = ['claude',  'codex', 'cursor', 'ollama', 'llamacpp', 'lmstudio', 'strata', 'deepseek'];
const PROVIDER_LABEL: Record<ProviderName, string> = {
  claude: 'CLAUDE',

  codex: 'CODEX',
  cursor: 'CURSOR',
  ollama: 'OLLAMA',
  llamacpp: 'LLAMA',
  lmstudio: 'LMSTUDIO',
  strata: 'STRATA',
  deepseek: 'XOLOTL',

};

function formatResetsAt(resetsAt: number | undefined): string {
  if (!resetsAt) return 'no known reset';
  const deltaMs = resetsAt - Date.now();
  if (deltaMs <= 0) return 'any moment';
  const mins = Math.round(deltaMs / 60_000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMin = mins % 60;
  if (hours < 24) return remMin > 0 ? `in ${hours}h ${remMin}m` : `in ${hours}h`;
  const days = Math.floor(hours / 24);
  return `in ${days}d`;
}

export function WorkflowStatusChip() {
  const quotaState = useAppStore((s) => s.quotaState);
  const activeJobId = useAppStore((s) => s.activeJobId);
  const context = useAppStore((s) => (s.activeJobId ? s.jobs[s.activeJobId]?.contextUsage : undefined));
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const throttled = quotaState ? PROVIDER_ORDER.filter((p) => quotaState[p]?.throttled) : [];
  const hasThrottle = throttled.length > 0;
  const pct = context ? Math.round(context.percentOfWindow) : null;
  // Nothing urgent to show — keep the header clean.
  if (pct === null && !hasThrottle) return null;

  // Color escalates with context fill; a throttle always forces warning so it
  // can't hide behind a low-context-fill green.
  const ctxColor = pct === null ? 'var(--color-fg-muted)'
    : pct >= 85 ? 'var(--color-danger)'
    : pct >= 65 ? 'var(--color-warning)'
    : 'var(--color-accent-primary-dim)';
  const borderColor = hasThrottle ? 'var(--color-warning)'
    : pct !== null && pct >= 85 ? 'var(--color-danger)'
    : 'var(--color-border-hairline)';

  const label = pct !== null ? `◔ ${pct}%` : '';
  const warn = hasThrottle ? `⚠ ${throttled.length}` : '';

  return (
    <div ref={rootRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        data-help="header.workflow-status"
        className="display-font"
        title="Workflow status — context fill + provider quota (click for details)"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          background: open ? 'var(--color-accent-primary-a10)' : 'transparent',
          border: `1px solid ${borderColor}`,
          borderRadius: '3px',
          cursor: 'pointer',
          fontSize: '10px',
          letterSpacing: '1px',
          padding: '3px 8px',
        }}
      >
        {label && <span style={{ color: ctxColor, whiteSpace: 'nowrap' }}>{label}</span>}
        {warn && <span style={{ color: 'var(--color-warning)', whiteSpace: 'nowrap' }}>{warn}</span>}
      </button>

      {open && (
        <div
          role="dialog"
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            minWidth: '260px',
            padding: '10px 12px',
            background: 'var(--color-bg-panel)',
            border: '1px solid var(--color-border-hairline)',
            borderRadius: '4px',
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.45)',
            fontFamily: 'var(--font-content)',
            fontSize: '11px',
            zIndex: 20,
          }}
        >
          {/* Context fill — active workflow only. */}
          <div className="display-font" style={{ fontSize: '10px', letterSpacing: '1.5px', color: 'var(--color-fg-muted)', marginBottom: '8px' }}>
            CONTEXT FILL
          </div>
          {context && activeJobId ? (
            <div style={{ lineHeight: 1.5 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px' }}>
                <span style={{ color: 'var(--color-accent-primary-dim)' }}>{Math.round(context.percentOfWindow)}% of window</span>
                <span style={{ color: 'var(--color-fg-muted)' }}>
                  {context.estimatedTokens.toLocaleString()} / {context.windowSize.toLocaleString()} tok
                </span>
              </div>
              {/* Thin fill bar mirroring the readout. */}
              <div style={{ marginTop: '6px', height: '4px', borderRadius: '2px', background: 'var(--color-border-hairline)', overflow: 'hidden' }}>
                <div style={{ width: `${Math.min(100, context.percentOfWindow)}%`, height: '100%', background: ctxColor }} />
              </div>
            </div>
          ) : (
            <div style={{ color: 'var(--color-fg-muted)' }}>No active workflow context reading.</div>
          )}

          {/* Provider quota — folded in from the former standalone QuotaBadge. */}
          <div className="display-font" style={{ fontSize: '10px', letterSpacing: '1.5px', color: 'var(--color-fg-muted)', margin: '12px 0 8px' }}>
            PROVIDER QUOTA
          </div>
          {PROVIDER_ORDER.map((p) => {
            const s = quotaState?.[p];
            const isThrottled = !!s?.throttled;
            return (
              <div key={p} style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '2px 0' }}>
                <span style={{ color: isThrottled ? 'var(--color-warning)' : 'var(--color-accent-primary-dim)', minWidth: '58px' }}>
                  {PROVIDER_LABEL[p]}
                </span>
                <span style={{ color: isThrottled ? 'var(--color-warning)' : 'var(--color-fg-muted)' }}>
                  {isThrottled ? `throttled · resets ${formatResetsAt(s?.resetsAt)}` : 'available'}
                </span>
              </div>
            );
          })}
          <div style={{ marginTop: '8px', fontSize: '10px', color: 'var(--color-fg-muted)', lineHeight: 1.4 }}>
            The primary agent sees throttle state on its next first-turn context and routes around it. Review fallback uses the cross-family pairing.
          </div>
        </div>
      )}
    </div>
  );
}
