import { useState } from 'react';

/** Reusable operator KEEP action. The server validates the conversation and path. */
export function KeepButton({ cwd, workflowId, itemPath, reason = 'operator', onKept, onError, disabled = false, children = 'KEEP', help = 'storage.keep-artifact', confirmMessage, className, style }: {
  cwd?: string; workflowId: string; itemPath: string; reason?: 'operator' | 'size-warning';
  onKept?: () => void; onError?: (message: string) => void; disabled?: boolean; children?: React.ReactNode; help?: string; confirmMessage?: string; className?: string; style?: React.CSSProperties;
}) {
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState('');
  const report = (message: string) => { if (onError) onError(message); else setLocalError(message); };
  async function keep() {
    if (confirmMessage && !window.confirm(confirmMessage)) return;
    if (!cwd) { report('The conversation is unavailable. Open it to keep this item.'); return; }
    setBusy(true); report('');
    try {
      const response = await fetch('/api/storage/keep', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: cwd, workflowId, itemPath, reason, confirm: true }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || result.error || 'Could not keep this item.');
      onKept?.();
    } catch (err) { report(err instanceof Error ? err.message : 'Could not keep this item.'); } finally { setBusy(false); }
  }
  return <span><button type="button" className={className} style={style} data-help={help} disabled={disabled || busy} onClick={() => void keep()}>{busy ? 'KEEPING...' : children}</button>{!onError && localError && <span role="alert">{localError}</span>}</span>;
}

/** UNKEEP: remove one KEEP mark (`itemPath`) or every mark of the conversation (`all`), after confirmation. */
export function UnkeepButton({ cwd, workflowId, itemPath, all = false, confirmMessage, onDone, onError, disabled = false, children = 'UNKEEP', help = 'storage.unkeep', className, style, label }: {
  cwd?: string; workflowId: string; itemPath?: string; all?: boolean; confirmMessage: string;
  onDone?: () => void; onError?: (message: string) => void; disabled?: boolean; children?: React.ReactNode; help?: string; className?: string; style?: React.CSSProperties; label?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState('');
  const report = (message: string) => { if (onError) onError(message); else setLocalError(message); };
  async function unkeep() {
    if (!window.confirm(confirmMessage)) return;
    if (!cwd) { report('The conversation is unavailable. Open it to change KEEP.'); return; }
    setBusy(true); report('');
    try {
      const response = await fetch('/api/storage/unkeep', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: cwd, workflowId, ...(all ? { all: true } : { itemPath }), confirm: true }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || result.error || 'Could not remove KEEP.');
      onDone?.();
    } catch (err) { report(err instanceof Error ? err.message : 'Could not remove KEEP.'); } finally { setBusy(false); }
  }
  return <span><button type="button" className={className} style={style} data-help={help} aria-label={label} disabled={disabled || busy} onClick={() => void unkeep()}>{busy ? 'UNKEEPING...' : children}</button>{!onError && localError && <span role="alert">{localError}</span>}</span>;
}
