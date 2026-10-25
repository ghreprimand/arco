import { useState } from 'react';

// Conversation purge modal (HISTORY tab → PURGE). Two tiers:
//   arco  — delete everything Arco wrote for this workflow.
//   nuclear — also delete the bound provider session files (Claude/Codex), so
//             the conversation is gone from those CLIs too. Irreversible, so the
//             nuclear tier requires typing the workflow name to confirm.
// Hits DELETE /api/workflows/<wfid>?path=<cwd>&mode=arco|nuclear.

interface Props {
  workflowId: string;
  cwd: string;
  name: string;
  onClose: () => void;
  onPurged: () => void;
}

export function PurgeConversationModal({ workflowId, cwd, name, onClose, onPurged }: Props) {
  const [mode, setMode] = useState<'arco' | 'nuclear'>('arco');
  const [confirmName, setConfirmName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameMatches = confirmName.trim() === name;
  const canPurge = mode === 'arco' || nameMatches;

  const purge = async () => {
    if (!canPurge || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/workflows/${encodeURIComponent(workflowId)}?path=${encodeURIComponent(cwd)}&mode=${mode}`,
        {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirm: true, ...(mode === 'nuclear' ? { confirmName: confirmName.trim() } : {}) }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !body.ok) {
        setError(body.error || `Purge failed (${res.status})`);
        setSubmitting(false);
        return;
      }
      onPurged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  const Radio = ({ value, title, desc }: { value: 'arco' | 'nuclear'; title: string; desc: string }) => (
    <label
      style={{
        display: 'flex', gap: '8px', alignItems: 'flex-start', padding: '8px 10px', cursor: 'pointer',
        border: `1px solid ${mode === value ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'}`,
        borderRadius: '4px', background: mode === value ? 'var(--color-accent-primary-a08)' : 'transparent',
      }}
    >
      <input type="radio" name="purge-mode" checked={mode === value} onChange={() => { setMode(value); setError(null); }} style={{ marginTop: '2px' }} />
      <span>
        <span className="display-font" style={{ fontSize: '11px', letterSpacing: '1px', color: 'var(--color-fg)' }}>{title}</span>
        <span style={{ display: 'block', fontSize: '11px', color: 'var(--color-fg-muted)', marginTop: '2px' }}>{desc}</span>
      </span>
    </label>
  );

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(520px, 92vw)', background: 'var(--color-bg)', border: '1px solid var(--color-border-bright)',
          borderRadius: '6px', padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: '12px',
        }}
      >
        <div className="display-font glow-text-bright" style={{ fontSize: '13px', letterSpacing: '2px', color: 'var(--color-warning)' }}>
          ⌦ PURGE CONVERSATION
        </div>
        <div style={{ fontSize: '12px', color: 'var(--color-fg-muted)', lineHeight: 1.5 }}>
          Permanently delete <strong style={{ color: 'var(--color-fg)' }}>{name}</strong> and everything
          associated with it — transcript, events, checkpoints, artifacts, recall entry. <strong style={{ color: 'var(--color-warning)' }}>This cannot be undone.</strong>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <Radio value="arco" title="ARCO DATA ONLY" desc="Everything Arco wrote. The provider's own session file is left, so the bare CLI could still resume it." />
          <Radio value="nuclear" title="☢ NUCLEAR — EVERYTHING" desc="Also deletes the underlying Claude/Codex session files. Gone from those tools too." />
        </div>

        {mode === 'nuclear' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label style={{ fontSize: '11px', color: 'var(--color-fg-muted)' }}>
              Type the conversation name <strong style={{ color: 'var(--color-fg)' }}>{name}</strong> to confirm:
            </label>
            <input
              type="text"
              value={confirmName}
              onChange={(e) => setConfirmName(e.target.value)}
              placeholder={name}
              autoFocus
              style={{
                padding: '6px 8px', background: 'transparent', borderRadius: '3px', color: 'var(--color-fg)',
                border: `1px solid ${nameMatches ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'}`,
                fontFamily: 'var(--font-body)', fontSize: '12px',
              }}
            />
          </div>
        )}

        {error && <div style={{ fontSize: '11px', color: 'var(--color-error, var(--color-warning))' }}>{error}</div>}

        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '4px' }}>
          <button onClick={onClose} disabled={submitting} className="display-font"
            style={{ padding: '6px 14px', background: 'transparent', border: '1px solid var(--color-border-hairline)', borderRadius: '3px', color: 'var(--color-fg-muted)', cursor: 'pointer', fontSize: '11px', letterSpacing: '1px' }}>
            CANCEL
          </button>
          <button onClick={purge} disabled={!canPurge || submitting} className="display-font"
            style={{
              padding: '6px 14px', borderRadius: '3px', cursor: canPurge && !submitting ? 'pointer' : 'not-allowed',
              fontSize: '11px', letterSpacing: '1px',
              background: canPurge ? 'var(--color-warning)' : 'transparent',
              border: `1px solid ${canPurge ? 'var(--color-warning)' : 'var(--color-border-hairline)'}`,
              color: canPurge ? 'var(--color-bg)' : 'var(--color-fg-muted)',
              opacity: submitting ? 0.6 : 1,
            }}>
            {submitting ? 'PURGING…' : mode === 'nuclear' ? '☢ PURGE EVERYTHING' : 'PURGE'}
          </button>
        </div>
      </div>
    </div>
  );
}
