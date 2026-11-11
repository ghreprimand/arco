import { useCloseHeaderPopover } from './headerPopoverState';
import { useEffect, useRef, useState } from 'react';
import type { AuthLoginResult, AuthStatusByProvider } from '@arco/shared';
import { useAppStore } from '../stores/appStore';
import { LoginCommand } from './LoginCommand';
import { claudeAuthPresentation, selectedClaudeTransport } from '../utils/claudeAuth';
import { useStartupStore } from '../stores/startupStore';
import { useKeepInWindow } from '../layout/keepInWindow';

// Recovery follows the selected Claude transport. Unknown/stale probes never
// become logout warnings. Native opens its existing settings; CLI sign-in uses
// the headless command and the existing bounded status poll.
const FAST_POLL_MS = 1500;
const FAST_POLL_TIMEOUT_MS = 10 * 60 * 1000;

export function HeaderAuthChip() {
  const authStatus = useAppStore((s) => s.authStatus);
  const setAuthStatus = useAppStore((s) => s.setAuthStatus);
  const enabled = useAppStore((s) => s.settings?.enabledProviders?.claude !== false);
  const tabTransport = useAppStore(s => s.activeJobId ? s.jobs[s.activeJobId]?.config.claudeTransport : undefined);
  const settingTransport = useAppStore(s => s.settings?.claude?.transport);
  const forceCli = useAppStore(s => {
    const config = s.activeJobId ? s.jobs[s.activeJobId]?.config : undefined;
    return (config?.primaryProvider ?? 'claude') === 'claude' && config?.ultracode === true;
  });
  const [open, setOpen] = useState(false);
  useCloseHeaderPopover(setOpen);
  const placeRef = useKeepInWindow();
  const [state, setState] = useState<'idle' | 'pending' | 'sent' | 'error'>('idle');
  const [hint, setHint] = useState<string | null>(null);
  const [command, setCommand] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollStartedAtRef = useRef<number | null>(null);

  const attention = enabled ? claudeAuthPresentation(authStatus?.claude, selectedClaudeTransport(tabTransport, settingTransport, forceCli)).attention : undefined;

  // Stop fast-poll once Claude flips back to loggedIn.
  useEffect(() => {
    if (attention !== 'cli') {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
      pollStartedAtRef.current = null;
      setOpen(false);
      setState('idle');
      setHint(null);
      setCommand(null);
    }
  }, [attention]);

  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current);
  }, []);

  // Like the other top-bar popovers: a click outside or Escape closes the
  // panel. Escape returns focus to the chip. A sign-in already started keeps
  // polling; reopening the chip shows its command again.
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => { if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); buttonRef.current?.focus(); } };
    document.addEventListener('mousedown', away); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', key); };
  }, [open]);

  if (!attention) return null;

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
    <div ref={rootRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        ref={buttonRef}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="display-font"
        title={attention === 'native' ? 'Claude Native credentials need attention' : 'Claude CLI is signed out'}
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
        {attention === 'native' ? '[AUTH: CLAUDE NATIVE]' : '[AUTH: CLAUDE CLI]'}
      </button>
      {open && (
        <div
          ref={placeRef}
          data-testid="header-auth-popover"
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
            {attention === 'native'
              ? 'Claude Native credentials need attention. Review Native sign-in in provider settings.'
              : 'Claude CLI is signed out. CLI sign-in is separate from Native execution credentials.'}
          </div>
          <button
            onClick={attention === 'native' ? () => { useStartupStore.getState().setSettingsSection('claude-signin'); useAppStore.getState().setShowSettings(true); } : startLogin}
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
            {attention === 'native' ? 'OPEN NATIVE SIGN-IN SETTINGS' : state === 'pending' ? 'STARTING...' : state === 'sent' ? 'WAITING FOR CLI LOGIN...' : 'SIGN IN TO CLAUDE CLI'}
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
