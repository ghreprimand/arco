import { useState, useEffect } from 'react';

// Modal for picking the destination project directory when moving a plan.
// Shows one-click chips for every other open tab's cwd, plus a free-text
// input for typing arbitrary paths. The server validates the target — bad
// paths surface as a `window.alert` from the parent's handleMove.
export function MoveTargetModal({
  planTitle,
  sourceCwd,
  tabCwds,
  onConfirm,
  onCancel,
}: {
  planTitle: string;
  sourceCwd: string;
  tabCwds: string[];
  onConfirm: (target: string) => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState('');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);
  return (
    <div
      onClick={onCancel}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 50,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--color-bg-panel)',
          border: '1px solid var(--color-accent-primary-dim)',
          borderRadius: '6px',
          padding: '18px 22px',
          width: 'min(560px, 94vw)',
          maxHeight: '88vh',
          overflowY: 'auto',
          fontFamily: 'var(--font-body)',
        }}
      >
        <div className="display-font" style={{ fontSize: '12px', letterSpacing: '3px', color: 'var(--color-accent-primary)', marginBottom: '6px' }}>
          MOVE PLAN
        </div>
        <div className="display-font" style={{ fontSize: '10px', color: 'var(--color-fg-muted)', marginBottom: '14px', letterSpacing: '0.5px', lineHeight: 1.5 }}>
          Move <strong>"{planTitle}"</strong> to another project directory. The plan's `.md` file relocates; attachments to the current tab are dropped (they refer to a workflow in the source cwd).
        </div>
        <div className="display-font" style={{ fontSize: '9px', letterSpacing: '1.5px', color: 'var(--color-accent-secondary-dim)', marginBottom: '6px' }}>
          FROM
        </div>
        <div style={{ fontSize: '11px', color: 'var(--color-fg-muted)', marginBottom: '14px', wordBreak: 'break-all' }}>
          {sourceCwd || '(none)'}
        </div>
        {tabCwds.length > 0 && (
          <>
            <div className="display-font" style={{ fontSize: '9px', letterSpacing: '1.5px', color: 'var(--color-accent-secondary-dim)', marginBottom: '6px' }}>
              OTHER OPEN TABS
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '14px' }}>
              {tabCwds.map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => onConfirm(d)}
                  className="display-font"
                  style={{
                    textAlign: 'left',
                    padding: '6px 10px',
                    background: 'transparent',
                    border: '1px solid var(--color-border-hairline)',
                    borderRadius: '3px',
                    color: 'var(--color-accent-secondary-dim)',
                    cursor: 'pointer',
                    fontSize: '11px',
                    wordBreak: 'break-all',
                  }}
                >
                  {d}
                </button>
              ))}
            </div>
          </>
        )}
        <div className="display-font" style={{ fontSize: '9px', letterSpacing: '1.5px', color: 'var(--color-accent-secondary-dim)', marginBottom: '6px' }}>
          OR PASTE A PATH
        </div>
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder="/absolute/path/to/project"
          autoFocus={tabCwds.length === 0}
          style={{
            width: '100%',
            padding: '6px 8px',
            fontSize: '12px',
            fontFamily: 'var(--font-body)',
            background: 'var(--color-bg-sunken)',
            border: '1px solid var(--color-border-hairline)',
            borderRadius: '3px',
            color: 'var(--color-fg-default)',
            marginBottom: '14px',
            boxSizing: 'border-box',
          }}
          onKeyDown={(e) => { if (e.key === 'Enter' && typed.trim()) onConfirm(typed); }}
        />
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <button
            type="button"
            onClick={onCancel}
            className="display-font"
            style={{
              padding: '6px 12px',
              background: 'transparent',
              border: '1px solid var(--color-border-hairline)',
              borderRadius: '3px',
              color: 'var(--color-fg-muted)',
              cursor: 'pointer',
              fontSize: '10px',
              letterSpacing: '1px',
            }}
          >
            CANCEL
          </button>
          <button
            type="button"
            onClick={() => onConfirm(typed)}
            disabled={!typed.trim()}
            className="display-font"
            style={{
              padding: '6px 12px',
              background: typed.trim() ? 'var(--color-accent-primary-a10)' : 'transparent',
              border: `1px solid ${typed.trim() ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'}`,
              borderRadius: '3px',
              color: typed.trim() ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
              cursor: typed.trim() ? 'pointer' : 'default',
              fontSize: '10px',
              letterSpacing: '1px',
            }}
          >
            MOVE TO PASTED PATH
          </button>
        </div>
      </div>
    </div>
  );
}
