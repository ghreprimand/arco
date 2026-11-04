import { useEffect, useState } from 'react';

interface Result { outcome: string; message?: string; finishedAt?: number; attemptId?: string }
export function UpdateResultNotice() {
  const [result, setResult] = useState<Result | null>(null);
  useEffect(() => {
    let alive = true; let request = 0;
    const check = async () => {
      const sequence = ++request;
      try {
        const response = await fetch('/api/update-manager');
        if (!response.ok) return;
        const state = await response.json() as { result?: Result };
        const next = state.result;
        if (!alive || sequence !== request) return;
        if (!next?.finishedAt || !['updated', 'failed', 'unchanged'].includes(next.outcome)) { setResult(null); return; }
        let dismissed = '';
        try { dismissed = localStorage.getItem('arco-update-result-dismissed') ?? ''; } catch { /* storage is optional */ }
        setResult(dismissed !== (next.attemptId || String(next.finishedAt)) ? next : null);
      } catch { /* the server may be restarting */ }
    };
    void check(); const timer = setInterval(() => { void check(); }, 3000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  if (!result) return null;
  return <div role="status" data-help="settings.update-result" style={{ pointerEvents: 'auto', padding: 12, color: 'var(--color-fg)', background: 'var(--color-bg-panel)', border: '1px solid var(--color-accent-primary)' }}>
    <span>{result.message || (result.outcome === 'unchanged' ? 'Already on the newest release.' : 'Update completed.')}</span>{' '}
    <button type="button" onClick={() => { try { localStorage.setItem('arco-update-result-dismissed', result.attemptId || String(result.finishedAt)); } catch { /* storage is optional */ } setResult(null); }}>DISMISS</button>
  </div>;
}
