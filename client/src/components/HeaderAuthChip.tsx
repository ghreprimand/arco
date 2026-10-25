import { useEffect, useRef, useState } from 'react';
import type { AuthLoginResult, AuthStatusByProvider } from '@arco/shared';
import { useAppStore } from '../stores/appStore';
import { LoginCommand } from './LoginCommand';

// Header-mounted companion to AuthReloginNotice, driven by the CLI login
// (`claude auth status`). Shows only on a PARSED loggedIn=false — a failed
// probe (probeFailed) is "unknown", never "logged out"; that distinction is
// what stopped the near-daily false re-login prompt. App.tsx keeps polling
// while this is up, so a recovered login clears the chip by itself. RE-LOGIN
// fetches the headless login command and hands it to LoginCommand (run in
// Arco's terminal), then fast-polls /api/auth-status until Claude is back.
const FAST_POLL_MS = 1500;
const FAST_POLL_TIMEOUT_MS = 10 * 60 * 1000;

export function HeaderAuthChip() {
  const authStatus = useAppStore((s) => s.authStatus);
  const setAuthStatus = useAppStore((s) => s.setAuthStatus);
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<'idle' | 'pending' | 'sent' | 'error'>('idle');
  const [hint, setHint] = useState<string | null>(null);
  const [command, setCommand] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollStartedAtRef = useRef<number | null>(null);

  const claudeLoggedOut = authStatus ? !authStatus.claude.loggedIn && !authStatus.claude.probeFailed : false;

  // Stop fast-poll once Claude flips back to loggedIn.
  useEffect(() => {
    if (!claudeLoggedOut) {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
      pollStartedAtRef.current = null;
      setOpen(false);
      setState('idle');
      setHint(null);
      setCommand(null);
    }
  }, [claudeLoggedOut]);

  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current);
  }, []);

  if (!claudeLoggedOut) return null;

  const startLogin = async () => {
    setState('pending');
    setHint(null);
    try {
      const res = await fetch('/api/auth-login?provider=claude', { method: 'POST' });
      const data = (await res.json()) as AuthLoginResult;
      if (data.command) {
        setState('sent');
        setCommand(data.command);
        setHint('Sign in via the link it prints, then paste the code back into the terminal. This chip clears on its own.');
      } else if (data.manual) {
        setState('sent');
        setHint(data.manual);
      } else {
        setState('error');
        setHint('Could not start login. Try the AUTH button in Settings.');
        return;
      }
    } catch {
      setState('error');
      setHint('Could not start login. Try the AUTH button in Settings.');
      return;
    }
    if (pollRef.current) clearInterval(pollRef.current);
    pollStartedAtRef.current = Date.now();
    pollRef.current = setInterval(async () => {
      if (pollStartedAtRef.current && Date.now() - pollStartedAtRef.current > FAST_POLL_TIMEOUT_MS) {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = null;
        pollStartedAtRef.current = null;
        return;
      }
      try {
        const r = await fetch('/api/auth-status');
        const d = (await r.json()) as AuthStatusByProvider;
        setAuthStatus(d);
      } catch { /* keep polling */ }
    }, FAST_POLL_MS);
  };

  return (
    <div style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="display-font"
        title="Claude authentication expired — click to re-login"
        style={{
          background: open ? 'var(--color-warning-a10, rgba(255,170,0,0.1))' : 'transparent',
          border: '1px solid var(--color-warning)',
          borderRadius: '3px',
          color: 'var(--color-warning)',
          cursor: 'pointer',
          fontSize: '10px',
          letterSpacing: '1px',
          padding: '3px 8px',
          display: 'inline-flex',
          alignItems: 'center',
          gap: '6px',
        }}
      >
        <span
          className="status-dot status-dot--failed"
          style={{ width: '6px', height: '6px' }}
        />
        [AUTH: CLAUDE]
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            zIndex: 100,
            minWidth: '280px',
            maxWidth: '360px',
            padding: '10px 12px',
            borderLeft: '2px solid var(--color-warning)',
            border: '1px solid var(--color-border-hairline)',
            borderRadius: '3px',
            background: 'var(--color-bg-panel)',
            boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
          }}
        >
          <div
            style={{
              fontSize: '12px',
              fontFamily: 'var(--font-body)',
              lineHeight: 1.5,
              color: 'var(--color-warning-dim)',
            }}
          >
            Claude CLI is not authenticated. Re-login to continue.
          </div>
          <button
            onClick={startLogin}
            disabled={state === 'pending' || state === 'sent'}
            className="display-font glow-border"
            style={{
              padding: '6px 12px',
              background: state === 'idle' ? 'var(--color-accent-primary-a10)' : 'transparent',
              border: '1px solid var(--color-accent-primary)',
              borderRadius: '3px',
              color: 'var(--color-accent-primary)',
              cursor: state === 'idle' ? 'pointer' : 'default',
              fontSize: '10px',
              letterSpacing: '2px',
              opacity: state === 'pending' ? 0.7 : 1,
              alignSelf: 'flex-start',
            }}
          >
            {state === 'pending' ? 'STARTING…' : state === 'sent' ? 'WAITING FOR LOGIN…' : 'RE-LOGIN CLAUDE ↻'}
          </button>
          {command && <LoginCommand command={command} />}
          {hint && (
            <div
              style={{
                fontSize: '11px',
                color: state === 'error' ? 'var(--color-warning-dim)' : 'var(--color-accent-secondary-dim)',
                fontFamily: 'var(--font-body)',
                lineHeight: 1.5,
              }}
            >
              {hint}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
