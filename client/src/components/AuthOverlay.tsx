import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../stores/appStore';
import type { AuthLoginResult, AuthStatusByProvider, AuthStatus, ProviderName } from '@arco/shared';
import { LoginCommand } from './LoginCommand';

// Poll cadence while we're blocked on auth. Once a login has been triggered
// we poll aggressively so the overlay disappears the moment credentials land.
const POLL_IDLE_MS = 10_000;
const POLL_ACTIVE_MS = 1500;

export function AuthOverlay() {
  const setAuthStatus = useAppStore((s) => s.setAuthStatus);
  const authStatus = useAppStore((s) => s.authStatus);
  const isProviderEnabled = useAppStore((s) => s.isProviderEnabled);
  const setShowSettings = useAppStore((s) => s.setShowSettings);
  const [loginPending, setLoginPending] = useState<ProviderName | null>(null);
  const [manualHint, setManualHint] = useState<string | null>(null);
  const [loginCommand, setLoginCommand] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const check = async () => {
    try {
      const res = await fetch('/api/auth-status');
      const data = (await res.json()) as AuthStatusByProvider;
      setAuthStatus(data);
    } catch {
      // Leave previous status; error will surface via status.claude.error
    }
  };

  useEffect(() => { check(); }, []);

  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    const ms = loginPending ? POLL_ACTIVE_MS : POLL_IDLE_MS;
    pollRef.current = setInterval(check, ms);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [loginPending]);

  const startLogin = async (provider: ProviderName) => {
    setLoginPending(provider);
    setManualHint(null);
    setLoginCommand(null);
    try {
      const res = await fetch(`/api/auth-login?provider=${provider}`, { method: 'POST' });
      const data = (await res.json()) as AuthLoginResult;
      if (data.command) {
        // Keep loginPending so the fast poll lifts the overlay when it lands.
        setLoginCommand(data.command);
        setManualHint(data.manual ?? null);
      } else if (!data.started && data.manual) {
        setManualHint(data.manual);
        setLoginPending(null);
      }
    } catch {
      /* detached spawn — we still tell the user to complete OAuth in the browser */
    }
  };

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
        gap: '14px',
        zIndex: 9500,
        padding: '20px',
      }}
    >
      <div className="display-font glow-text-bright" style={{ fontSize: '28px', letterSpacing: '8px', color: 'var(--color-accent-primary)' }}>
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
        NO AUTHENTICATED PROVIDER
      </div>
      <div style={{ fontSize: '12px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', textAlign: 'center', maxWidth: '480px', lineHeight: '1.6' }}>
        Arco needs at least one authenticated primary-capable provider.
        Sign in to Claude, Gemini, Codex, or configure Z.ai below — the overlay closes as soon as one provider is live.
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', width: '100%', maxWidth: '480px', marginTop: '4px' }}>
        {isProviderEnabled('claude') && (
          <ProviderAuthRow
            provider="claude"
            status={authStatus?.claude}
            loginPending={loginPending === 'claude'}
            onLogin={() => startLogin('claude')}
          />
        )}
        {isProviderEnabled('gemini') && (
          <ProviderAuthRow
            provider="gemini"
            status={authStatus?.gemini}
            loginPending={loginPending === 'gemini'}
            onLogin={() => startLogin('gemini')}
          />
        )}
        {isProviderEnabled('codex') && (
          <ProviderAuthRow
            provider="codex"
            status={authStatus?.codex}
            loginPending={loginPending === 'codex'}
            onLogin={() => startLogin('codex')}
          />
        )}
        {isProviderEnabled('zai') && (
          <ProviderAuthRow
            provider="zai"
            status={authStatus?.zai}
            loginPending={loginPending === 'zai'}
            onLogin={() => startLogin('zai')}
          />
        )}
        {!isProviderEnabled('claude') && !isProviderEnabled('gemini') && !isProviderEnabled('codex') && !isProviderEnabled('zai') && (
          <div style={{ fontSize: '11px', color: 'var(--color-warning)', fontFamily: 'var(--font-body)', textAlign: 'center', padding: '14px', border: '1px dashed var(--color-warning)', borderRadius: '4px' }}>
            All primary-capable providers are disabled in settings. Re-enable at least one to chat.
            <div style={{ marginTop: '8px' }}>
              <button
                onClick={() => setShowSettings(true)}
                className="display-font glow-border"
                style={{
                  padding: '6px 14px',
                  background: 'var(--color-accent-primary-a10)',
                  border: '1px solid var(--color-accent-primary)',
                  borderRadius: '3px',
                  color: 'var(--color-accent-primary)',
                  cursor: 'pointer',
                  fontSize: '10px',
                  letterSpacing: '2px',
                }}
              >
                OPEN SETTINGS
              </button>
            </div>
          </div>
        )}
      </div>

      {manualHint && (
        <div style={{ fontSize: '11px', color: 'var(--color-accent-secondary)', fontFamily: 'var(--font-body)', maxWidth: '480px', textAlign: 'center' }}>
          {manualHint}
        </div>
      )}
      {loginCommand && (
        <div style={{ width: '100%', maxWidth: '480px' }}>
          <LoginCommand command={loginCommand} />
        </div>
      )}

      <button
        onClick={check}
        className="display-font"
        style={{
          padding: '8px 18px',
          background: 'transparent',
          border: '1px solid var(--color-border-hairline)',
          borderRadius: '4px',
          color: 'var(--color-fg-muted)',
          cursor: 'pointer',
          fontSize: '11px',
          letterSpacing: '2px',
          marginTop: '4px',
        }}
      >
        RE-CHECK
      </button>
    </div>
  );
}

interface ProviderAuthRowProps {
  provider: ProviderName;
  status?: AuthStatus;
  loginPending: boolean;
  onLogin: () => void;
}

function ProviderAuthRow({ provider, status, loginPending, onLogin }: ProviderAuthRowProps) {
  const label = provider === 'claude' ? 'CLAUDE (ANTHROPIC)'
    : provider === 'gemini' ? 'GEMINI (GOOGLE)'
    : provider === 'codex' ? 'CODEX (OPENAI)'
    : provider === 'zai' ? 'Z.AI (GLM CODING)'
    : provider.toUpperCase();
  const loggedIn = status?.loggedIn ?? false;
  const usesOpenAiApiKey = provider === 'codex' && status?.apiProvider === 'openai-api-key';
  const ollamaEndpoint = provider === 'ollama' && status?.apiProvider?.startsWith('ollama:')
    ? status.apiProvider.slice('ollama:'.length)
    : '';
  const subline = (() => {
    if (usesOpenAiApiKey) return 'OPENAI_API_KEY fallback active';
    if (provider === 'codex' && status?.apiProvider === 'chatgpt-oauth') {
      return status?.email ? `${status.email} · ChatGPT OAuth` : 'ChatGPT OAuth';
    }
    if (provider === 'zai') {
      return loggedIn ? 'ZAI_API_KEY active' : (status?.error ? `error: ${status.error.slice(0, 80)}` : 'ZAI_API_KEY not set');
    }
    if (provider === 'ollama') {
      if (loggedIn) return `daemon up${ollamaEndpoint ? ` at ${ollamaEndpoint}` : ''}`;
      return status?.error
        ? `daemon not reachable${ollamaEndpoint ? ` at ${ollamaEndpoint}` : ''}: ${status.error.slice(0, 60)}`
        : `daemon not reachable${ollamaEndpoint ? ` at ${ollamaEndpoint}` : ''}`;
    }
    if (loggedIn) return status?.email || 'authenticated';
    return status?.error ? `error: ${status.error.slice(0, 60)}` : 'not authenticated';
  })();

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '10px 14px',
        border: '1px solid var(--color-border-hairline)',
        borderRadius: '4px',
        background: usesOpenAiApiKey ? 'var(--color-warning-a10, rgba(255, 180, 60, 0.08))' : loggedIn ? 'var(--color-accent-primary-a05)' : 'var(--color-bg-sunken)',
      }}
    >
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
        <span className="display-font" style={{ fontSize: '12px', letterSpacing: '2px', color: loggedIn ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)' }}>
          {label}
        </span>
        <span style={{ fontSize: '10px', color: usesOpenAiApiKey ? 'var(--color-warning)' : loggedIn ? 'var(--color-accent-primary-dim)' : 'var(--color-warning-dim)', fontFamily: 'var(--font-body)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {subline}
        </span>
        {usesOpenAiApiKey && (
          <span style={{ fontSize: '10px', color: 'var(--color-warning-dim)', fontFamily: 'var(--font-body)' }}>
            Codex will inherit API-key billing from the Arco server environment.
          </span>
        )}
      </div>
      {loggedIn ? (
        <span className="display-font" style={{ fontSize: '10px', letterSpacing: '1px', color: usesOpenAiApiKey ? 'var(--color-warning)' : 'var(--color-accent-primary)', padding: '4px 10px', border: `1px solid ${usesOpenAiApiKey ? 'var(--color-warning)' : 'var(--color-accent-primary)'}`, borderRadius: '3px' }}>
          {usesOpenAiApiKey ? 'API KEY' : 'LIVE'}
        </span>
      ) : (
        <button
          onClick={onLogin}
          disabled={loginPending}
          className="display-font glow-border"
          style={{
            padding: '6px 14px',
            background: loginPending ? 'transparent' : 'var(--color-accent-primary-a10)',
            border: '1px solid var(--color-accent-primary)',
            borderRadius: '3px',
            color: 'var(--color-accent-primary)',
            cursor: loginPending ? 'default' : 'pointer',
            fontSize: '10px',
            letterSpacing: '2px',
            opacity: loginPending ? 0.7 : 1,
          }}
        >
          {loginPending ? 'WAITING…' : 'LOG IN'}
        </button>
      )}
    </div>
  );
}
