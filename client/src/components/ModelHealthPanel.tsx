import { useCallback, useEffect, useState } from 'react';
import type {
  CookbookHealth,
  DiagnosticStatus,
  LlamacppHealth,
  LlamacppModelDef,
  LlamacppServeFix,
  ModelHealthReport,
  OllamaHealth,
} from '@archon/shared';

// ARCHON_OPS_PLAN.md §A3 — Local model health panel inside the System modal.
//
// Fetches GET /api/diagnostics/model-health on mount + on Refresh and renders the
// three subsystems (Ollama / llama.cpp / Cookbook), each with a roll-up status
// badge + concrete fields. Pure readout — operator-triggered, no polling, no
// mutation. Colours come from theme tokens only (matching DiagnosticsTab), never
// hardcoded.

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

function fmtBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

function SubHeader({ label, status, detail }: { label: string; status: DiagnosticStatus; detail: string }) {
  const color = STATUS_COLOR[status];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', marginBottom: '6px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span style={{ color, fontSize: '11px', width: '12px', flexShrink: 0 }}>{STATUS_GLYPH[status]}</span>
        <span
          className="display-font"
          style={{ fontSize: '11px', letterSpacing: '2px', color: 'var(--color-fg-default)', flex: 1 }}
        >
          {label.toUpperCase()}
        </span>
        <span className="display-font" style={{ color, fontSize: '9px', letterSpacing: '1px' }}>
          {status.toUpperCase()}
        </span>
      </div>
      <div style={{ fontSize: '11px', color: 'var(--color-fg-muted)', paddingLeft: '20px', lineHeight: 1.5 }}>
        {detail}
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: '8px', fontSize: '11px', padding: '1px 0' }}>
      <span style={{ color: 'var(--color-fg-muted)', minWidth: '110px', flexShrink: 0 }}>{label}</span>
      <span style={{ color: 'var(--color-fg-default)', wordBreak: 'break-word' }}>{value}</span>
    </div>
  );
}

function ModelList({ models }: { models: Array<{ name: string; detail?: string }> }) {
  if (models.length === 0) return <span style={{ color: 'var(--color-fg-muted)' }}>none</span>;
  return (
    <span>
      {models.map((m, i) => (
        <span key={m.name + i}>
          {i > 0 && ', '}
          <span style={{ color: 'var(--color-fg-default)' }}>{m.name}</span>
          {m.detail && <span style={{ color: 'var(--color-fg-muted)' }}> ({m.detail})</span>}
        </span>
      ))}
    </span>
  );
}

const SECTION_STYLE: React.CSSProperties = {
  border: '1px solid var(--color-border-hairline)',
  borderRadius: '4px',
  padding: '10px 12px',
};

function OllamaSection({ h }: { h: OllamaHealth }) {
  return (
    <div style={SECTION_STYLE} data-help="model-health.ollama">
      <SubHeader label="Ollama" status={h.status} detail={h.detail} />
      <Field label="base URL" value={h.baseUrl} />
      <Field label="reachable" value={h.reachable ? 'yes' : 'no'} />
      {h.version && <Field label="version" value={h.version} />}
      <Field label="models" value={`${h.modelCount}`} />
      {h.models.length > 0 && <Field label="installed" value={<ModelList models={h.models} />} />}
      {h.hint && <Field label="hint" value={<em>{h.hint}</em>} />}
    </div>
  );
}

// DD13 — apply a one-click serve-failure fix. Mirrors LlamacppCatalogEditor's
// apply+reload path EXACTLY: GET the catalog, mutate the failed loadout's
// ctxSize / ngl / extraArgs, POST the full catalog (wholesale replace), then
// reload the alias. Reversible — it's an ordinary catalog edit the operator can
// re-edit in CONFIG. Throws on any HTTP failure so the caller surfaces it.
async function applyLlamacppFix(alias: string, fix: LlamacppServeFix): Promise<void> {
  const res = await fetch('/api/llamacpp/catalog');
  if (!res.ok) throw new Error(`could not read catalog (HTTP ${res.status})`);
  const { models } = (await res.json()) as { models: LlamacppModelDef[] };
  const target = models.find((m) => m.alias === alias);
  if (!target) throw new Error(`loadout "${alias}" not found in the catalog`);

  if (fix.kind === 'set-ctx-size') target.ctxSize = fix.ctxSize;
  else if (fix.kind === 'set-ngl') target.ngl = fix.ngl;
  else if (fix.kind === 'add-extra-arg') {
    // Split the flag into argv tokens (e.g. "--port 8081" → ["--port","8081"]),
    // appending only tokens not already present so re-applying is idempotent.
    const tokens = fix.arg.split(/\s+/).filter(Boolean);
    const existing = target.extraArgs ?? [];
    target.extraArgs = [...existing, ...tokens.filter((t) => !existing.includes(t))];
  }

  const save = await fetch('/api/llamacpp/catalog', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ models }),
  });
  if (!save.ok) {
    const err = await save.json().catch(() => ({ error: `HTTP ${save.status}` }));
    throw new Error(err.error ?? `HTTP ${save.status}`);
  }
  // Reload the loadout so the new ctx/ngl/flags take effect.
  const load = await fetch(`/api/llamacpp-load?alias=${encodeURIComponent(alias)}`, { method: 'POST' });
  if (!load.ok) {
    const err = await load.json().catch(() => ({ error: `HTTP ${load.status}` }));
    throw new Error(err.error ?? `HTTP ${load.status}`);
  }
}

function DiagnosisBox({ h, onApplied }: { h: LlamacppHealth; onApplied: () => void }) {
  const d = h.diagnosis;
  const [pending, setPending] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (!d) return null;
  const alias = h.loadedAlias;

  const apply = async (fix: LlamacppServeFix, idx: number) => {
    if (!alias) return;
    setPending(idx);
    setErr(null);
    try {
      await applyLlamacppFix(alias, fix);
      onApplied();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(null);
    }
  };

  return (
    <div
      data-help="model-health.llamacpp-diagnosis"
      style={{
        marginTop: '8px',
        border: '1px solid var(--color-warning)',
        borderRadius: '4px',
        padding: '8px 10px',
        background: 'var(--color-bg-inset)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
        <span className="display-font" style={{ fontSize: '9px', letterSpacing: '1px', color: 'var(--color-warning)' }}>
          DIAGNOSIS
        </span>
        <span className="display-font" style={{ fontSize: '9px', letterSpacing: '1px', color: 'var(--color-fg-muted)' }}>
          {d.cause}
        </span>
      </div>
      <div style={{ fontSize: '11px', color: 'var(--color-fg-default)', marginBottom: d.suggestions.length ? '4px' : 0 }}>{d.message}</div>
      {d.suggestions.length > 0 && (
        <ul style={{ margin: '0 0 4px', paddingLeft: '16px', fontSize: '11px', color: 'var(--color-fg-muted)', lineHeight: 1.5 }}>
          {d.suggestions.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
      )}
      {d.fixes.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '4px' }}>
          {d.fixes.map((fix, i) => (
            <button
              key={i}
              type="button"
              data-help="model-health.llamacpp-fix"
              disabled={!alias || pending !== null}
              title={alias ? 'Apply to the catalog entry and reload' : 'No loaded alias to apply against'}
              onClick={() => void apply(fix, i)}
              className="display-font"
              style={{
                background: 'transparent',
                border: '1px solid var(--color-accent-primary)',
                borderRadius: '4px',
                color: 'var(--color-accent-primary)',
                cursor: !alias || pending !== null ? 'default' : 'pointer',
                fontSize: '10px',
                letterSpacing: '1px',
                padding: '4px 8px',
                opacity: !alias || (pending !== null && pending !== i) ? 0.5 : 1,
              }}
            >
              {pending === i ? 'APPLYING…' : fix.label}
            </button>
          ))}
        </div>
      )}
      {!alias && d.fixes.length > 0 && (
        <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', marginTop: '4px' }}>
          No loaded alias recorded — apply the fix manually in CONFIG → llama.cpp.
        </div>
      )}
      {err && <div style={{ fontSize: '10px', color: 'var(--color-danger)', marginTop: '4px' }}>{err}</div>}
    </div>
  );
}

function LlamacppSection({ h, onRefresh }: { h: LlamacppHealth; onRefresh: () => void }) {
  return (
    <div style={SECTION_STYLE} data-help="model-health.llamacpp">
      <SubHeader label="llama.cpp" status={h.status} detail={h.detail} />
      <Field label="binary" value={h.binaryPath ?? 'not on PATH'} />
      <Field label="manager" value={h.managerState} />
      {h.loadedAlias && <Field label="loaded" value={`${h.loadedAlias}${h.port ? ` on :${h.port}` : ''}${h.pid ? ` (pid ${h.pid})` : ''}`} />}
      {h.portReachable !== undefined && <Field label="port" value={h.portReachable ? 'reachable' : 'not listening'} />}
      <Field label="registered" value={`${h.modelCount}`} />
      {h.models.length > 0 && <Field label="models" value={<ModelList models={h.models} />} />}
      {h.lastLaunchArgs && h.lastLaunchArgs.length > 0 && (
        <Field
          label="last launch"
          value={<code style={{ fontSize: '10px' }}>llama-server {h.lastLaunchArgs.join(' ')}</code>}
        />
      )}
      {h.error && <Field label="error" value={<span style={{ color: 'var(--color-danger)' }}>{h.error}</span>} />}
      {h.hint && <Field label="hint" value={<em>{h.hint}</em>} />}
      <DiagnosisBox h={h} onApplied={onRefresh} />
      {h.lastStderrTail && (
        <div style={{ marginTop: '6px' }}>
          <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', marginBottom: '2px' }}>last stderr (tail)</div>
          <pre
            style={{
              margin: 0,
              background: 'var(--color-bg-inset)',
              border: '1px solid var(--color-border-default)',
              borderRadius: '4px',
              color: 'var(--color-fg-muted)',
              fontSize: '10px',
              lineHeight: 1.4,
              padding: '6px 8px',
              maxHeight: '140px',
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {h.lastStderrTail}
          </pre>
        </div>
      )}
    </div>
  );
}

function CookbookSection({ h }: { h: CookbookHealth }) {
  const hw = h.hardware;
  const vram = hw.totalVramBytes > 0 ? `${fmtBytes(hw.totalVramBytes)} across ${hw.gpus.length} GPU(s)` : 'none (CPU/Metal)';
  return (
    <div style={SECTION_STYLE} data-help="model-health.cookbook">
      <SubHeader label="Cookbook" status={h.status} detail={h.detail} />
      <Field label="backend" value={hw.backend} />
      <Field label="VRAM" value={vram} />
      <Field label="system RAM" value={fmtBytes(hw.systemRamBytes)} />
      <Field label="cores" value={`${hw.cores}`} />
      {hw.gpus.length > 0 && <Field label="GPUs" value={hw.gpus.map((g) => `${g.name} (${fmtBytes(g.vramBytes)})`).join(', ')} />}
      <Field label="downloaded" value={`${h.downloadedModelCount}`} />
      {h.downloadedModels.length > 0 && <Field label="GGUFs" value={<ModelList models={h.downloadedModels} />} />}
      {h.fitWarnings.length > 0 && (
        <div style={{ marginTop: '6px', display: 'flex', flexDirection: 'column', gap: '3px' }}>
          <div style={{ fontSize: '10px', color: 'var(--color-warning)' }}>fit-score mismatches</div>
          {h.fitWarnings.map((w) => (
            <div key={w.alias} style={{ fontSize: '11px', color: 'var(--color-fg-muted)', paddingLeft: '8px' }}>
              <span className="display-font" style={{ color: STATUS_COLOR[w.verdict === 'NO' ? 'error' : 'warn'], fontSize: '9px', letterSpacing: '1px', marginRight: '6px' }}>
                {w.verdict}
              </span>
              {w.detail}
            </div>
          ))}
        </div>
      )}
      {h.hint && <Field label="hint" value={<em>{h.hint}</em>} />}
    </div>
  );
}

export function ModelHealthPanel() {
  const [report, setReport] = useState<ModelHealthReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch('/api/diagnostics/model-health')
      .then((r) => r.json() as Promise<ModelHealthReport>)
      .then((data) => setReport(data))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
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
              {report.platform} · {new Date(report.generatedAt).toLocaleTimeString()}
            </>
          ) : (
            'Local model health — Ollama / llama.cpp / Cookbook'
          )}
        </div>
        <button
          type="button"
          data-help="model-health.refresh"
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

      {error && (
        <div style={{ color: 'var(--color-danger)', fontSize: '12px' }}>Could not load model health: {error}</div>
      )}

      {report && (
        <>
          <OllamaSection h={report.ollama} />
          <LlamacppSection h={report.llamacpp} onRefresh={refresh} />
          <CookbookSection h={report.cookbook} />
        </>
      )}

      {!report && !error && !loading && (
        <div style={{ color: 'var(--color-fg-muted)', fontSize: '12px' }}>No report.</div>
      )}
    </div>
  );
}
