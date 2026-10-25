import { useEffect } from 'react';

export function DuplicateTabOverlay() {
  useEffect(() => {
    // One best-effort auto-close attempt. Modern browsers block
    // window.close() on tabs that weren't opened by a script (xdg-open
    // tabs count as user-opened), so this usually fails silently — the
    // overlay stays visible and the user closes the tab manually.
    const id = setTimeout(() => {
      try { window.close(); } catch { /* ignore */ }
    }, 300);
    return () => clearTimeout(id);
  }, []);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.92)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'column',
        gap: '16px',
        zIndex: 10000,
        padding: '20px',
      }}
    >
      <div
        className="display-font glow-text-bright"
        style={{ fontSize: '28px', letterSpacing: '8px', color: 'var(--color-accent-primary)' }}
      >
        ARCO
      </div>
      <div
        className="display-font"
        style={{
          fontSize: '14px',
          letterSpacing: '3px',
          color: 'var(--color-warning)',
          animation: 'pulse-glow 1.8s ease-in-out infinite',
        }}
      >
        ALREADY OPEN
      </div>
      <div
        style={{
          fontSize: '12px',
          color: 'var(--color-fg-muted)',
          fontFamily: 'var(--font-body)',
          textAlign: 'center',
          maxWidth: '380px',
          lineHeight: '1.6',
        }}
      >
        Arco is live in another tab. Close this duplicate — if it didn't
        auto-close, your browser blocks scripts from closing user-opened tabs.
      </div>
      <button
        onClick={() => { try { window.close(); } catch { /* ignore */ } }}
        className="display-font"
        style={{
          marginTop: '8px',
          padding: '8px 18px',
          background: 'transparent',
          border: '1px solid var(--color-accent-primary)',
          borderRadius: '4px',
          color: 'var(--color-accent-primary)',
          cursor: 'pointer',
          fontSize: '11px',
          letterSpacing: '2px',
        }}
      >
        CLOSE TAB
      </button>
    </div>
  );
}
