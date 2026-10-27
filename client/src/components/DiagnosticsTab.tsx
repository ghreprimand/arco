import { useCallback, useEffect, useState } from 'react';
import type {
  DiagnosticCheck,
  DiagnosticStatus,
  DiagnosticsReport,
  SupportBundleResponse,
} from '@arco/shared';

// docs/ARCHITECTURE.md - Diagnostics tab inside the System modal.
//
// Fetches GET /api/diagnostics on mount + on Refresh and renders the grouped,
// compact status rows (green/amber/red/grey), each expandable to its detail +
// hint. Pure readout — operator-triggered, no polling, no mutation. Colours
// come from theme tokens (--color-success / --color-warning / --color-danger /
// --color-fg-muted), never hardcoded, so themes stay in control.

const STATUS_COLOR: Record<DiagnosticStatus, string> = {
  ok: 'var(--color-success)',
  warn: 'var(--color-warning)',
  error: 'var(--color-danger)',
  skipped: 'var(--color-fg-muted)',
};

const STATUS_GLYPH: Record<DiagnosticStatus, string> = {
  ok: '●',
  warn: '▲',
  error: '✕',
  skipped: '○',
};

function CheckRow({ check }: { check: DiagnosticCheck }) {
  const [open, setOpen] = useState(false);
  const color = STATUS_COLOR[check.status];
  return (
    <div style={{ borderBottom: '1px solid var(--color-border-hairline)' }}>
      <button
        type="button"
        data-help="diagnostics.check-row"
        onClick={() => setOpen((v) => !v)}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          background: 'transparent',
          border: 'none',
          padding: '6px 4px',
          cursor: 'pointer',
          textAlign: 'left',
          color: 'var(--color-fg-default)',
          fontSize: '12px',
        }}
      >
        <span style={{ color, fontSize: '11px', width: '12px', flexShrink: 0 }}>
          {STATUS_GLYPH[check.status]}
        </span>
        <span style={{ flex: 1 }}>{check.label}</span>
        <span
          className="display-font"
          style={{ color, fontSize: '9px', letterSpacing: '1px', flexShrink: 0 }}
        >
          {check.status.toUpperCase()}
        </span>
        <span style={{ color: 'var(--color-fg-muted)', fontSize: '10px', flexShrink: 0 }}>
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open && (
        <div
          style={{
            padding: '2px 4px 10px 24px',
            fontSize: '11px',
            color: 'var(--color-fg-muted)',
            lineHeight: 1.5,
          }}
        >
          <div>{check.detail}</div>
          {check.hint && (
            <div style={{ marginTop: '4px', fontStyle: 'italic' }}>Hint: {check.hint}</div>
          )}
          <div style={{ marginTop: '4px', opacity: 0.5, fontSize: '10px' }}>{check.id}</div>
        </div>
      )}
    </div>
  );
}

export function DiagnosticsTab() {
  const [report, setReport] = useState<DiagnosticsReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Support-bundle (A2) state. `bundleState` drives the button label; `fallback`
  // holds the text when the clipboard API is unavailable (insecure context /
  // permission denied) so the operator can select-all + copy manually.
  const [bundleState, setBundleState] = useState<'idle' | 'working' | 'copied' | 'error'>('idle');
  const [fallback, setFallback] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch('/api/diagnostics')
      .then((r) => r.json() as Promise<DiagnosticsReport>)
      .then((data) => setReport(data))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, []);

  const copyBundle = useCallback(() => {
    setBundleState('working');
    setFallback(null);
    fetch('/api/diagnostics/support-bundle')
      .then((r) => r.json() as Promise<SupportBundleResponse>)
      .then(async (data) => {
        const text = data.text;
        try {
          if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            await navigator.clipboard.writeText(text);
            setBundleState('copied');
            setTimeout(() => setBundleState('idle'), 2000);
            return;
          }
          throw new Error('clipboard API unavailable');
        } catch {
          // Clipboard blocked (insecure context, permission) — show the text in a
          // selectable textarea so the operator copies it by hand.
          setFallback(text);
          setBundleState('idle');
        }
      })
      .catch(() => setBundleState('error'));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)' }}>
          {report ? (
            <>
              v{report.arcoVersion} · {report.platform} ·{' '}
              {new Date(report.generatedAt).toLocaleTimeString()}
            </>
          ) : (
            'Read-only status checks'
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button
            type="button"
            data-help="diagnostics.support-bundle"
            onClick={copyBundle}
            disabled={bundleState === 'working'}
            className="display-font"
            style={{
              background: 'transparent',
              border: '1px solid var(--color-border-default)',
              borderRadius: '4px',
              color: bundleState === 'copied' ? 'var(--color-success)' : 'var(--color-fg-muted)',
              cursor: bundleState === 'working' ? 'default' : 'pointer',
              fontSize: '10px',
              letterSpacing: '2px',
              padding: '5px 12px',
              opacity: bundleState === 'working' ? 0.5 : 1,
            }}
          >
            {bundleState === 'working'
              ? 'BUILDING…'
              : bundleState === 'copied'
                ? '✓ COPIED'
                : bundleState === 'error'
                  ? 'FAILED — RETRY'
                  : '⧉ COPY SUPPORT BUNDLE'}
          </button>
          <button
            type="button"
            data-help="diagnostics.refresh"
            onClick={refresh}
            disabled={loading}
            className="display-font"
            style={{
              background: 'transparent',
              border: '1px solid var(--color-accent-primary)',
              borderRadius: '4px',
              color: 'var(--color-accent-primary)',
              cursor: loading ? 'default' : 'pointer',
              fontSize: '10px',
              letterSpacing: '2px',
              padding: '5px 12px',
              opacity: loading ? 0.5 : 1,
            }}
          >
            {loading ? 'REFRESHING…' : '↻ REFRESH'}
          </button>
        </div>
      </div>

      {error && (
        <div style={{ color: 'var(--color-danger)', fontSize: '12px' }}>
          Could not load diagnostics: {error}
        </div>
      )}

      {fallback !== null && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)' }}>
            Clipboard unavailable — select all and copy manually:
          </div>
          <textarea
            readOnly
            value={fallback}
            onFocus={(e) => e.currentTarget.select()}
            style={{
              width: '100%',
              minHeight: '160px',
              background: 'var(--color-bg-inset)',
              border: '1px solid var(--color-border-default)',
              borderRadius: '4px',
              color: 'var(--color-fg-default)',
              fontFamily: 'monospace',
              fontSize: '11px',
              padding: '8px',
              resize: 'vertical',
            }}
          />
        </div>
      )}

      {report &&
        report.groups.map((group) => (
          <div key={group.id}>
            <div
              className="display-font"
              style={{
                fontSize: '10px',
                letterSpacing: '2px',
                color: 'var(--color-fg-muted)',
                marginBottom: '4px',
              }}
            >
              {group.label.toUpperCase()}
            </div>
            <div>
              {group.checks.map((check) => (
                <CheckRow key={check.id} check={check} />
              ))}
            </div>
          </div>
        ))}

      {!report && !error && !loading && (
        <div style={{ color: 'var(--color-fg-muted)', fontSize: '12px' }}>No report.</div>
      )}
    </div>
  );
}
