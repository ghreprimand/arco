import type { CatalogRow } from '@archon/shared';
import { useAppStore } from '../../stores/appStore';
import {
  useCookbookStore,
  sendCookbookDownload,
  sendCookbookCancelDownload,
} from '../../stores/cookbookStore';
import { fmtBytes } from './fmt';

// Workbench Expansion G4 — the wired Download / Run / Configure actions for an
// expanded catalog row. Replaces G2's inert placeholders.
//
// Operator-initiated only: nothing fires until the operator clicks DOWNLOAD. A
// pre-flight panel (model size vs free disk) renders once the request is in
// flight; a progress bar + CANCEL during the stream; a success state noting the
// model is now in CONFIG (HF) / pulled (Ollama). A disk refusal shows the
// "won't fit" message instead of starting.
//
// HF pick  → DOWNLOAD streams the GGUF into ~/.archon/models/ + auto-registers a
//            llama.cpp catalog entry (selectable in CONFIG immediately).
// Ollama   → DOWNLOAD runs `ollama pull` over the HTTP /api/pull endpoint
//            (Ollama auto-discovers the tag; no catalog write).

function rowKey(r: CatalogRow): string {
  return `${r.source}:${r.repo}:${r.quant}`;
}

const BTN: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid var(--color-border-hairline)',
  borderRadius: '3px',
  color: 'var(--color-fg-muted)',
  fontSize: '9px',
  letterSpacing: '1px',
  padding: '3px 8px',
  cursor: 'pointer',
};

export function DownloadActions({ row }: { row: CatalogRow }) {
  const activeJobId = useAppStore((s) => s.activeJobId);
  const download = useCookbookStore((s) => s.download);
  const startDownload = useCookbookStore((s) => s.startDownload);
  const clearDownload = useCookbookStore((s) => s.clearDownload);

  const key = rowKey(row);
  const active = download && download.key === key ? download : null;
  // Another row is downloading — disable this row's button so only one runs.
  const otherBusy = Boolean(download) && download!.key !== key
    && download!.phase !== 'done' && download!.phase !== 'error' && download!.phase !== 'cancelled';

  const onDownload = () => {
    if (!activeJobId) return;
    startDownload(key, row.source);
    sendCookbookDownload({
      workflowId: activeJobId,
      source: row.source,
      ...(row.source === 'hf'
        ? {
            repo: row.repo,
            quant: row.quant,
            ctxSize: row.fit.maxContextThatFits || undefined,
            capabilities: { tools: true, ...(row.task === 'image-text-to-text' ? { vision: true } : {}) },
          }
        : { name: row.name }),
    });
  };

  const onCancel = () => {
    if (active?.downloadId && activeJobId) sendCookbookCancelDownload(activeJobId, active.downloadId);
  };

  // Idle / no active download for this row → the action buttons.
  if (!active || active.phase === 'cancelled' || active.phase === 'error' || active.phase === 'done') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', alignItems: 'flex-end' }}>
        {active && active.phase === 'done' && (
          <span data-help="cookbook.download.done" className="display-font" style={{ fontSize: '9px', letterSpacing: '1px', color: 'var(--color-accent-primary)' }}>
            {row.source === 'hf'
              ? `DONE — "${active.alias ?? row.name}" is now in CONFIG`
              : 'PULLED — selectable in CONFIG (Ollama)'}
          </span>
        )}
        {active && active.phase === 'error' && (
          <span data-help="cookbook.download.error" className="display-font" style={{ fontSize: '9px', letterSpacing: '0.5px', color: 'var(--color-warning)', maxWidth: '420px', whiteSpace: 'normal', textAlign: 'right' }}>
            {active.message || 'Download failed.'}
          </span>
        )}
        {active && active.phase === 'cancelled' && (
          <span className="display-font" style={{ fontSize: '9px', letterSpacing: '1px', color: 'var(--color-fg-muted)' }}>CANCELLED — partial file deleted</span>
        )}
        <span style={{ display: 'flex', gap: '6px' }}>
          <button
            data-help="cookbook.action.download"
            onClick={onDownload}
            disabled={!activeJobId || otherBusy}
            title={!activeJobId ? 'Open a workflow first' : otherBusy ? 'Another download is running' : row.source === 'hf' ? 'Download the GGUF and register it in CONFIG' : 'Pull this Ollama model (HTTP /api/pull)'}
            className="display-font"
            style={{
              ...BTN,
              border: '1px solid var(--color-accent-primary)',
              color: 'var(--color-accent-primary)',
              opacity: !activeJobId || otherBusy ? 0.4 : 1,
              cursor: !activeJobId || otherBusy ? 'not-allowed' : 'pointer',
            }}
          >
            {active && active.phase !== 'cancelled' ? 'RE-DOWNLOAD' : 'DOWNLOAD'}
          </button>
          {active && (
            <button data-help="cookbook.download.dismiss" onClick={clearDownload} className="display-font" style={BTN}>
              DISMISS
            </button>
          )}
        </span>
      </div>
    );
  }

  // Active: preflight / downloading / registering → progress + cancel.
  const pct = active.totalBytes && active.receivedBytes
    ? Math.min(100, Math.round((active.receivedBytes / active.totalBytes) * 100))
    : null;

  return (
    <div data-help="cookbook.download.progress" style={{ display: 'flex', flexDirection: 'column', gap: '4px', alignItems: 'flex-end', minWidth: '260px' }}>
      {active.phase === 'preflight' && (
        <span className="display-font" style={{ fontSize: '9px', letterSpacing: '1px', color: 'var(--color-fg-muted)' }}>
          PRE-FLIGHT — size {fmtBytes(active.totalBytes ?? 0)} · free {fmtBytes(active.freeBytes ?? 0)}
        </span>
      )}
      {active.phase === 'registering' && (
        <span className="display-font" style={{ fontSize: '9px', letterSpacing: '1px', color: 'var(--color-fg-muted)' }}>REGISTERING…</span>
      )}
      {active.phase === 'downloading' && (
        <>
          <span className="display-font" style={{ fontSize: '9px', letterSpacing: '1px', color: 'var(--color-fg-muted)' }}>
            {active.message || 'DOWNLOADING'} {pct !== null ? `${pct}%` : ''}
            {active.receivedBytes ? ` · ${fmtBytes(active.receivedBytes)}${active.totalBytes ? ` / ${fmtBytes(active.totalBytes)}` : ''}` : ''}
          </span>
          <div style={{ width: '240px', height: '6px', background: 'var(--color-bg-sunken)', borderRadius: '3px', overflow: 'hidden' }}>
            <div style={{ width: pct !== null ? `${pct}%` : '40%', height: '100%', background: 'var(--color-accent-primary)', transition: 'width 0.2s' }} />
          </div>
        </>
      )}
      <button data-help="cookbook.download.cancel" onClick={onCancel} className="display-font" style={{ ...BTN, border: '1px solid var(--color-warning)', color: 'var(--color-warning)' }}>
        CANCEL
      </button>
    </div>
  );
}
