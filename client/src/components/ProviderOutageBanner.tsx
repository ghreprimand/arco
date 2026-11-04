import { parseConnectionStatus } from './Connections/model';
import { useState } from 'react';
import type { AuthStatusByProvider } from '@arco/shared';
import { useAppStore } from '../stores/appStore';
import { useStartupStore } from '../stores/startupStore';
import { disconnectedProviderLines } from '../utils/startupGate';

// Shown inside the workspace when no AI provider is usable. Replaces the old
// behaviour of swapping the whole workspace for the first-run screen: saved
// work, projects and settings stay reachable while the operator fixes the
// connection.
export function ProviderOutageBanner() {
  const authStatus = useAppStore((s) => s.authStatus);
  const setAuthStatus = useAppStore((s) => s.setAuthStatus);
  const isProviderEnabled = useAppStore((s) => s.isProviderEnabled);
  const setShowSettings = useAppStore((s) => s.setShowSettings);
  const setSettingsSection = useStartupStore((s) => s.setSettingsSection);
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState('');
  const [open, setOpen] = useState(false);

  const lines = disconnectedProviderLines(authStatus, isProviderEnabled);

  const retry = async () => {
    if (checking) return;
    setChecking(true);
    setNote('');
    try {
      const res = await fetch('/api/auth-status');
      const data = parseConnectionStatus(res.ok,await res.json());
      if(!data)throw new Error('invalid status response');
      setAuthStatus(data);
      setNote('Checked just now. Still no connected provider.');
    } catch {
      setNote('Could not reach Arco to check. Is it still running?');
    } finally {
      setChecking(false);
    }
  };

  const openProviderSettings = () => {
    setSettingsSection('authentication');
    setShowSettings(true);
  };

  const btn = {
    padding: '4px 12px',
    background: 'transparent',
    border: '1px solid var(--color-accent-primary)',
    borderRadius: '3px',
    color: 'var(--color-accent-primary)',
    cursor: 'pointer',
    fontSize: '11px',
    letterSpacing: '1px',
  } as const;

  return (
    <section
      role="region"
      aria-label="Provider connection status"
      data-help="auth.provider-outage"
      style={{
        margin: '6px 12px 0',
        padding: '8px 12px',
        border: '1px solid var(--color-warning-dim, var(--color-warning))',
        borderRadius: '4px',
        background: 'var(--color-bg-panel)',
        fontFamily: 'var(--font-body)',
        fontSize: '12px',
        color: 'var(--color-fg-muted)',
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <span role="status" style={{ flex: 1, minWidth: '240px', lineHeight: 1.5 }}>
          <strong style={{ color: 'var(--color-warning)' }}>No AI provider is connected.</strong>{' '}
          Your projects and saved work are still here; new turns need a connection.
        </span>
        <button type="button" className="display-font" style={btn} onClick={() => { void retry(); }} disabled={checking} aria-busy={checking}>
          {checking ? 'CHECKING...' : 'RETRY'}
        </button>
        <button type="button" className="display-font" style={btn} onClick={() => useStartupStore.getState().openConnections()}>
          CONNECT A PROVIDER
        </button>
        <button type="button" className="display-font" style={{ ...btn, borderColor: 'var(--color-border-hairline)', color: 'var(--color-fg-muted)' }} onClick={openProviderSettings}>
          PROVIDER SETTINGS
        </button>
        {lines.length > 0 && (
          <button
            type="button"
            className="display-font"
            style={{ ...btn, border: 'none', color: 'var(--color-fg-muted)' }}
            aria-expanded={open}
            aria-controls="provider-outage-details"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? 'HIDE DETAILS' : 'DETAILS'}
          </button>
        )}
      </div>
      <div aria-live="polite" style={{ fontSize: '11px' }}>{note}</div>
      {open && lines.length > 0 && (
        <ul id="provider-outage-details" style={{ margin: 0, paddingLeft: '18px', lineHeight: 1.6, fontSize: '11px' }}>
          {lines.map((line) => (
            <li key={line.provider}><strong>{line.label}</strong>: {line.detail}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
