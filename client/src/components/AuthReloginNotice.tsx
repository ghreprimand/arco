import { useState } from 'react';
import type { AuthLoginResult, ProviderName } from '@arco/shared';
import { LoginCommand } from './LoginCommand';
import { useAppStore } from '../stores/appStore';

// Recognize `[AUTH:<provider>] <body>` sentinel lines produced by:
//   - server/src/providers/claude.ts (Anthropic 401 from the stream)
//   - server/src/providers/claude-native/worker.ts (no-auth + 401 paths)
//   - server/src/providers/cursor/index.ts (ACP auth text + stale-worker recycle)
//   - client/src/components/TerminalInput.tsx (TUI /login guard)
// Keep in sync with all emitters — the prefix is the contract.
const AUTH_NOTICE_RE = /^\[AUTH:([a-z]+)\]\s+(.*)$/s;

export function parseAuthNotice(content: string): { provider: ProviderName; body: string } | null {
  const m = content.match(AUTH_NOTICE_RE);
  if (!m) return null;
  const raw = m[1];
  if (raw !== 'claude' && raw !== 'gemini' && raw !== 'codex' && raw !== 'zai' && raw !== 'ollama' && raw !== 'github' && raw !== 'antigravity' && raw !== 'cursor') {
    return null;
  }
  return { provider: raw as ProviderName, body: m[2] };
}

interface Props {
  provider: ProviderName;
  body: string;
}

export function AuthReloginNotice({ provider, body }: Props) {
  const [state, setState] = useState<'idle' | 'pending' | 'sent' | 'error'>('idle');
  const [hint, setHint] = useState<string | null>(null);
  const [manualMode, setManualMode] = useState(false);
  const [manualValue, setManualValue] = useState('');
  const [command, setCommand] = useState<string | null>(null);

  // Resolve the active workflow's Claude transport so RE-LOGIN routes to
  // the right OAuth path. Native uses PKCE bootstrap (Phase 7); CLI uses
  // the legacy `claude auth login` shell-out. Cascade default: per-tab >
  // global setting > 'cli'.
  const claudeNative = useAppStore((s) => {
    if (provider !== 'claude') return false;
    const job = s.activeJobId ? s.jobs[s.activeJobId] : undefined;
    const tabPick = job?.config.claudeTransport;
    if (tabPick) return tabPick === 'native';
    return s.settings?.claude?.transport === 'native';
  });

  const label = provider === 'claude'
    ? (claudeNative ? 'CLAUDE NATIVE' : 'CLAUDE')
    : provider === 'gemini' ? 'GEMINI'
    : provider === 'codex' ? 'CODEX'
    : provider === 'zai' ? 'Z.AI'
    : provider.toUpperCase();

  const startLoginNative = async () => {
    const res = await fetch('/api/auth/claude-native/login', { method: 'POST' });
    const data = (await res.json()) as { authorizationUrl?: string; manualFallback?: boolean; manualReason?: string; error?: string };
    if (!res.ok || !data.authorizationUrl) {
      setState('error');
      setHint(data.error || 'Could not start Native login.');
      return;
    }
    try { window.open(data.authorizationUrl, '_blank', 'noopener'); } catch { /* user can copy below */ }
    setState('sent');
    // The paste box is ALWAYS offered. The redirect targets localhost:53692,
    // which only resolves to the Arco server when the browser runs on that
    // same machine — from a laptop/phone over the tailnet it lands on a
    // "can't connect" page whose URL still carries the code. Gating the box on
    // manualFallback (server couldn't bind) left remote logins stuck.
    setManualMode(true);
    setHint(data.manualFallback
      ? `${data.manualReason ?? 'Local callback unavailable.'} Approve in the tab that opened, then paste the redirected localhost URL below. If it didn't open: ${data.authorizationUrl}`
      : `Approve in the tab that opened. If it finishes on a "can't connect" localhost page (you're on another device), paste that page's URL below. If it didn't open: ${data.authorizationUrl}`);
  };

  const startLogin = async () => {
    setState('pending');
    setHint(null);
    setManualMode(false);
    setCommand(null);
    try {
      if (claudeNative) {
        await startLoginNative();
        return;
      }
      const res = await fetch(`/api/auth-login?provider=${provider}`, { method: 'POST' });
      const data = (await res.json()) as AuthLoginResult;
      if (data.command) {
        setState('sent');
        setCommand(data.command);
        setHint('Finish the login in the terminal, then re-send your prompt.');
      } else if (data.started) {
        setState('sent');
        setHint('Complete the OAuth flow in the browser tab that just opened, then try again.');
      } else if (data.manual) {
        setState('sent');
        setHint(data.manual);
      } else {
        setState('error');
        setHint('Could not start login. Try the AUTH button in the header.');
      }
    } catch {
      setState('error');
      setHint('Could not start login. Try the AUTH button in the header.');
    }
  };

  const submitManual = async () => {
    if (!manualValue.trim()) return;
    setState('pending');
    try {
      const res = await fetch('/api/auth/claude-native/callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: manualValue.trim() }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setState('error');
        setHint(data.error || 'Manual paste failed.');
        return;
      }
      setState('sent');
      setManualMode(false);
      setManualValue('');
      setHint('Authenticated. Re-send your prompt to continue.');
    } catch (err) {
      setState('error');
      setHint(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div
      style={{
        animation: 'fade-in-up 0.3s ease-out',
        marginBottom: '16px',
        maxWidth: '100%',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          marginBottom: '4px',
          fontSize: '11px',
          fontFamily: 'var(--font-display)',
          letterSpacing: '1px',
          color: 'var(--color-warning)',
        }}
      >
        <span>[AUTH]</span>
      </div>
      <div
        style={{
          padding: '10px 12px',
          borderLeft: '2px solid var(--color-warning)',
          marginLeft: '4px',
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: '12px',
          background: 'var(--color-bg-sunken)',
        }}
      >
        <span
          style={{
            flex: 1,
            minWidth: '220px',
            color: 'var(--color-warning-dim)',
            fontSize: '13px',
            fontFamily: 'var(--font-body)',
            lineHeight: '1.5',
          }}
        >
          {body}
        </span>
        <button
          onClick={startLogin}
          disabled={state === 'pending'}
          className="display-font glow-border"
          style={{
            padding: '6px 14px',
            background: state === 'pending' ? 'transparent' : 'var(--color-accent-primary-a10)',
            border: '1px solid var(--color-accent-primary)',
            borderRadius: '3px',
            color: 'var(--color-accent-primary)',
            cursor: state === 'pending' ? 'default' : 'pointer',
            fontSize: '10px',
            letterSpacing: '2px',
            opacity: state === 'pending' ? 0.7 : 1,
            whiteSpace: 'nowrap',
          }}
        >
          {state === 'pending' ? 'STARTING…' : state === 'sent' ? `RE-LOGIN ${label} ↻` : `RE-LOGIN ${label}`}
        </button>
      </div>
      {hint && (
        <div
          style={{
            marginLeft: '4px',
            marginTop: '6px',
            padding: '0 12px',
            fontSize: '11px',
            color: state === 'error' ? 'var(--color-warning-dim)' : 'var(--color-accent-secondary-dim)',
            fontFamily: 'var(--font-body)',
            lineHeight: '1.5',
            wordBreak: 'break-all',
          }}
        >
          {hint}
        </div>
      )}
      {command && (
        <div style={{ marginLeft: '4px', marginTop: '6px', padding: '0 12px' }}>
          <LoginCommand command={command} />
        </div>
      )}
      {manualMode && (
        <div style={{ marginLeft: '4px', marginTop: '6px', padding: '0 12px', display: 'flex', gap: '6px' }}>
          <input
            type="text"
            value={manualValue}
            onChange={(e) => setManualValue(e.target.value)}
            placeholder="http://localhost:53692/callback?code=…&state=…"
            style={{ flex: 1, padding: '4px 6px', fontSize: '11px', fontFamily: 'var(--font-code)', background: 'var(--color-bg-sunken)', border: '1px solid var(--color-border-hairline)', color: 'var(--color-accent-primary)', borderRadius: '3px', outline: 'none' }}
          />
          <button
            onClick={submitManual}
            disabled={!manualValue.trim() || state === 'pending'}
            className="display-font"
            style={{ padding: '4px 10px', fontSize: '10px', letterSpacing: '1px', background: 'transparent', border: '1px solid var(--color-accent-primary)', color: 'var(--color-accent-primary)', borderRadius: '3px', cursor: state === 'pending' || !manualValue.trim() ? 'default' : 'pointer' }}
          >
            SUBMIT
          </button>
        </div>
      )}
    </div>
  );
}
