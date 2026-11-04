import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../stores/appStore';
import type { ProviderName } from '@arco/shared';

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
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const throttled = quotaState ? PROVIDER_ORDER.filter((p) => quotaState[p]?.throttled) : [];
  useEffect(() => { if (throttled.length === 0) setOpen(false); }, [throttled.length]);
  if (throttled.length === 0) return null;

  return (
    <div ref={rootRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        data-help="header.workflow-status"
        className="display-font"
        title="Provider throttling (click for details)"
        aria-expanded={open}
        aria-haspopup="dialog"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          background: open ? 'var(--color-accent-primary-a10)' : 'transparent',
          border: '1px solid var(--color-warning)',
          borderRadius: '3px',
          cursor: 'pointer',
          fontSize: '10px',
          letterSpacing: '1px',
          padding: '3px 8px',
        }}
      >
        <span style={{ color: 'var(--color-warning)', whiteSpace: 'nowrap' }}>⚠ PROVIDER THROTTLING ({throttled.length})</span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Provider throttling"
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
          <div className="display-font" style={{ fontSize: '10px', letterSpacing: '1.5px', color: 'var(--color-fg-muted)', marginBottom: '8px' }}>
            PROVIDER THROTTLING
          </div>
          {throttled.map((p) => (
            <div key={p} style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '2px 0', color: 'var(--color-warning)' }}>
              <span>{PROVIDER_LABEL[p]}</span>
              <span>throttled · resets {formatResetsAt(quotaState?.[p]?.resetsAt)}</span>
            </div>
          ))}
          <div style={{ marginTop: '8px', fontSize: '10px', color: 'var(--color-fg-muted)', lineHeight: 1.4 }}>
            The primary agent sees throttle state on its next first-turn context and routes around it. Review fallback uses the cross-family pairing.
          </div>
        </div>
      )}
    </div>
  );
}
