import { useEffect, useRef, useState } from 'react';
import { useClaudeNativeLogin } from '../hooks/useClaudeNativeLogin';
import { NativeLoginControls } from './NativeLoginControls';
import { nativeAuthText } from '../utils/claudeAuth';

// Claude Native sign-in shares its flow lifecycle with inline recovery. POST /api/auth/claude-native/login kicks off PKCE; on a
// machine where the local callback (port 53692) can bind, the operator's
// browser hits it directly. When EADDRINUSE / sandbox-block lands, we
// surface a manual-paste field so the operator can hand back the
// redirected URL.
export function ClaudeNativeAuthRow() {
  const [status, setStatus] = useState<(import('@arco/shared').ClaudeNativeAuthStatus & { loggedIn: boolean }) | null>(null);
  const [busy, setBusy] = useState<'logout' | null>(null);
  const login = useClaudeNativeLogin('settings-native', undefined, status?.binding);
  const [error, setError] = useState<string | null>(null);

  const request = useRef(0);
  const refresh = async () => {
    const id = ++request.current;
    try {
      const res = await fetch('/api/auth/claude-native', { cache: 'no-store' });
      if (!res.ok) return;
      const data = (await res.json()) as import('@arco/shared').ClaudeNativeAuthStatus & { loggedIn: boolean };
      if (id === request.current) setStatus(data);
    } catch { /* leave stale */ }
  };

  useEffect(() => { void refresh(); return () => { request.current++; }; }, []);

  useEffect(() => { if (login.session?.flow?.status === 'complete') void refresh(); }, [login.session?.flow?.id, login.session?.flow?.status]);

  const logout = async () => {
    if (busy) return;
    setBusy('logout');
    setError(null);
    try {
      const res = await fetch('/api/auth/claude-native/logout', { method: 'POST' });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error || `HTTP ${res.status}`);
        return;
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(null); }
  };

  const nativeNeedsAttention = status?.state === 'needs-attention';
  const subline = !status ? 'Checking Native credentials...' : nativeAuthText(status);

  return (
    <div style={{ padding: '8px 10px', border: '1px solid var(--color-border-hairline)', borderRadius: '3px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <span className="display-font" style={{ fontSize: '11px', letterSpacing: '1.5px', color: 'var(--color-accent-primary)' }}>
            CLAUDE NATIVE (OAUTH)
          </span>
          <span style={{ fontSize: '10px', color: status?.loggedIn ? 'var(--color-accent-primary-dim)' : 'var(--color-warning-dim)', fontFamily: 'var(--font-body)' }}>
            {subline}
          </span>
          <span style={{ fontSize: '10px', color: 'var(--color-fg-muted)' }}>One Native credential store per Arco home. Profile names do not select separate Native credentials.</span>
          {status?.expiresAt && <span style={{ fontSize: '10px', color: 'var(--color-fg-muted)' }}>Local expiry metadata: {new Date(status.expiresAt).toLocaleString()}</span>}
        </div>
        <div style={{ display: 'flex', gap: '6px' }}>
          {status?.loggedIn && (
            <button onClick={logout} disabled={!!busy} className="display-font" style={{ padding: '4px 10px', fontSize: '10px', letterSpacing: '1px', background: 'transparent', border: '1px solid var(--color-border-hairline)', color: 'var(--color-fg-muted)', borderRadius: '3px', cursor: busy ? 'default' : 'pointer' }}>
              {busy === 'logout' ? '...' : 'LOGOUT'}
            </button>
          )}
          {(!status?.loggedIn || nativeNeedsAttention) && (
            <button onClick={() => { void login.start(); }} disabled={!!busy || login.session?.busy} className="display-font" style={{ padding: '4px 10px', fontSize: '10px', letterSpacing: '1px', background: 'transparent', border: '1px solid var(--color-accent-primary)', color: 'var(--color-accent-primary)', borderRadius: '3px', cursor: busy ? 'default' : 'pointer' }}>
              {login.session?.busy ? 'STARTING...' : 'LOGIN'}
            </button>
          )}
        </div>
      </div>
      <NativeLoginControls key={login.session?.flow?.id} login={login} />
      {error && (
        <div style={{ fontSize: '10px', color: 'var(--color-warning-dim)', fontFamily: 'var(--font-body)' }}>
          {error}
        </div>
      )}
    </div>
  );
}
