import { useAppStore } from '../stores/appStore';

interface Props {
  onReconnect: () => void;
  onRestartServer: () => void;
}

export function ShutdownOverlay({ onReconnect, onRestartServer }: Props) {
  const reason = useAppStore((s) => s.shutdownReason);
  const restarting = reason === 'server_restarting';

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
          color: restarting ? 'var(--color-accent-primary)' : 'var(--color-warning)',
          animation: 'pulse-glow 1.8s ease-in-out infinite',
        }}
      >
        {restarting ? 'RESTARTING…' : 'SERVICE STOPPED'}
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
        {restarting
          ? 'Waiting for the Arco server to come back up. This should take a few seconds — the tab will reconnect automatically.'
          : 'The Arco server has shut down. You can close this tab — if it didn\'t auto-close, your browser blocks scripts from closing user-opened tabs.'}
      </div>
      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', justifyContent: 'center' }}>
        <button
          onClick={onReconnect}
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
          RECONNECT
        </button>
        <button
          onClick={onRestartServer}
          className="display-font"
          style={{
            marginTop: '8px',
            padding: '8px 18px',
            background: 'transparent',
            border: '1px solid var(--color-warning)',
            borderRadius: '4px',
            color: 'var(--color-warning)',
            cursor: 'pointer',
            fontSize: '11px',
            letterSpacing: '2px',
          }}
        >
          RESTART SERVER
        </button>
      </div>
      {!restarting && (
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
      )}
    </div>
  );
}
