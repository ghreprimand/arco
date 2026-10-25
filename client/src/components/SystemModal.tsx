import { useEffect, useState } from 'react';
import { useAppStore } from '../stores/appStore';
import { DiagnosticsTab } from './DiagnosticsTab';
import { ModelHealthPanel } from './ModelHealthPanel';
import { ServicesTab } from './ServicesTab';

interface Props {
  onClose: () => void;
  // L3 — threaded through to ServicesTab for "Open in Live Preview".
  onSetPreviewPort: (workflowId: string, port: number, framework?: string) => void;
}

type SystemTab = 'actions' | 'diagnostics' | 'model-health' | 'services';

export function SystemModal({ onClose, onSetPreviewPort }: Props) {
  const [tab, setTab] = useState<SystemTab>('actions');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const quit = async () => {
    const hasJobs = Object.keys(useAppStore.getState().jobs).length > 0;
    const confirmMsg = hasJobs
      ? 'Quit Arco? Any running workflows will be cancelled, the server will stop, and this tab should close.'
      : 'Quit Arco? The server will stop and this tab should close.';
    if (!window.confirm(confirmMsg)) return;
    try {
      const res = await fetch('/api/shutdown', { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      window.alert(`Could not reach the Arco server to quit it: ${err instanceof Error ? err.message : String(err)}`);
    }
    onClose();
  };

  const restart = async () => {
    const hasJobs = Object.keys(useAppStore.getState().jobs).length > 0;
    const confirmMsg = hasJobs
      ? 'Restart Arco? Any running workflows will be cancelled. The server will stop and come back up in a few seconds; this tab will reconnect automatically.'
      : 'Restart Arco? The server will stop and come back up in a few seconds; this tab will reconnect automatically.';
    if (!window.confirm(confirmMsg)) return;
    try {
      const res = await fetch('/api/restart', { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      window.alert(`Could not reach the Arco server to restart it: ${err instanceof Error ? err.message : String(err)}. Use the launcher once if the process is fully stopped.`);
    }
    onClose();
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.75)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9500,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--color-bg-panel)',
          border: '1px solid var(--color-border-hairline)',
          borderRadius: '6px',
          padding: '24px 28px',
          width: tab === 'diagnostics' || tab === 'model-health' || tab === 'services' ? '560px' : 'auto',
          minWidth: '320px',
          maxWidth: '90vw',
          maxHeight: '85vh',
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: '18px',
        }}
      >
        <div
          className="display-font"
          style={{
            fontSize: '12px',
            letterSpacing: '3px',
            color: 'var(--color-accent-primary)',
            textAlign: 'center',
          }}
        >
          SYSTEM
        </div>
        {/* Tab header — Actions (RESTART/QUIT) · Diagnostics (status checks) ·
            Model Health (Ollama / llama.cpp / Cookbook readout) · Services
            (machine-wide local web/dev service browser — project-agnostic, so
            it lives here rather than the per-workflow right panel). */}
        <div style={{ display: 'flex', gap: '4px', borderBottom: '1px solid var(--color-border-hairline)' }}>
          {(['actions', 'diagnostics', 'model-health', 'services'] as const).map((t) => (
            <button
              key={t}
              type="button"
              data-help={`system.tab.${t}`}
              onClick={() => setTab(t)}
              className="display-font"
              style={{
                flex: 1,
                background: 'transparent',
                border: 'none',
                borderBottom: tab === t ? '2px solid var(--color-accent-primary)' : '2px solid transparent',
                color: tab === t ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
                cursor: 'pointer',
                fontSize: '11px',
                letterSpacing: '2px',
                padding: '6px 4px',
              }}
            >
              {t === 'model-health' ? 'MODELS' : t.toUpperCase()}
            </button>
          ))}
        </div>
        {tab === 'diagnostics' && <DiagnosticsTab />}
        {tab === 'model-health' && <ModelHealthPanel />}
        {tab === 'services' && <ServicesTab onSetPreviewPort={onSetPreviewPort} onClose={onClose} />}
        {tab === 'actions' && (
        <div style={{ display: 'flex', gap: '12px' }}>
          <button
            onClick={restart}
            className="display-font"
            style={{
              flex: 1,
              padding: '14px 10px',
              background: 'transparent',
              border: '1px solid var(--color-accent-primary)',
              borderRadius: '4px',
              color: 'var(--color-accent-primary)',
              cursor: 'pointer',
              fontSize: '13px',
              letterSpacing: '2px',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '4px',
            }}
          >
            <span style={{ fontSize: '20px', lineHeight: 1 }}>↻</span>
            <span>RESTART</span>
          </button>
          <button
            onClick={quit}
            className="display-font"
            style={{
              flex: 1,
              padding: '14px 10px',
              background: 'transparent',
              border: '1px solid var(--color-warning)',
              borderRadius: '4px',
              color: 'var(--color-warning)',
              cursor: 'pointer',
              fontSize: '13px',
              letterSpacing: '2px',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '4px',
            }}
          >
            <span style={{ fontSize: '20px', lineHeight: 1 }}>⏻</span>
            <span>QUIT</span>
          </button>
        </div>
        )}
        <button
          onClick={onClose}
          className="display-font"
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--color-fg-muted)',
            cursor: 'pointer',
            fontSize: '10px',
            letterSpacing: '2px',
            padding: '4px',
          }}
        >
          CANCEL (ESC)
        </button>
      </div>
    </div>
  );
}
