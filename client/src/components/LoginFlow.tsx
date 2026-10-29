import { useEffect, useState } from 'react';
import type { AuthLoginResult, AuthLoginSession } from '@arco/shared';
import { LoginCommand } from './LoginCommand';

// In-app login. The server runs the provider CLI and relays its link and code
// (see server/src/authLoginSession.ts); this polls the session and walks the
// operator through the two steps. Codex: open the link, type the code shown
// here. Claude: open the link, paste the code the page shows back here. The
// terminal command stays behind a toggle for anyone who prefers it.
const POLL_MS = 1500;

const LABEL: Record<string, string> = { claude: 'Claude', codex: 'Codex', github: 'GitHub',  cursor: 'Cursor', ollama: 'Ollama' };

interface Props {
  result: AuthLoginResult;
  onRestart: () => void;
}

export function LoginFlow({ result, onRestart }: Props) {
  const [session, setSession] = useState<AuthLoginSession | null>(result.session ?? null);
  const [paste, setPaste] = useState('');
  const [note, setNote] = useState('');
  const [showCommand, setShowCommand] = useState(false);
  const provider = session?.provider ?? result.session?.provider ?? 'claude';
  const name = LABEL[provider] ?? provider;

  useEffect(() => { setSession(result.session ?? null); setPaste(''); setNote(''); }, [result]);

  useEffect(() => {
    if (!session || session.status !== 'pending') return;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/auth-login/session?provider=${provider}`);
        const data = (await res.json()) as { session: AuthLoginSession | null };
        if (data.session) setSession(data.session);
      } catch { /* keep polling */ }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [session?.status, provider]);

  const submit = async () => {
    const code = paste.trim();
    if (!code) return;
    try {
      const res = await fetch('/api/auth-login/code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider, code }) });
      const data = (await res.json()) as { session?: AuthLoginSession; error?: string };
      if (!res.ok) { setNote(data.error || 'Could not submit the code'); return; }
      if (data.session) setSession(data.session);
      setNote('Code sent. Finishing sign-in...');
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    }
  };

  const cancel = async () => {
    try { await fetch('/api/auth-login/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider }) }); } catch { /* ignore */ }
  };

  const copy = async (text: string, what: string) => {
    try { await navigator.clipboard.writeText(text); setNote(`${what} copied.`); } catch { setNote('Clipboard unavailable  -  select the text and copy it.'); }
  };

  const btn = { padding: '5px 12px', background: 'transparent', border: '1px solid var(--color-accent-primary)', borderRadius: '3px', color: 'var(--color-accent-primary)', cursor: 'pointer', fontSize: '10px', letterSpacing: '1px', textDecoration: 'none', display: 'inline-block' } as const;
  const dim = { ...btn, border: '1px solid var(--color-border-hairline)', color: 'var(--color-fg-muted)' } as const;
  const stepStyle = { display: 'flex', gap: '10px', alignItems: 'flex-start', padding: '8px 10px', border: '1px solid var(--color-border-hairline)', borderRadius: '4px', background: 'var(--color-bg-sunken)' } as const;
  const num = { fontFamily: 'var(--font-display)', fontSize: '12px', color: 'var(--color-accent-primary)', minWidth: '16px' } as const;

  if (!session) return <LoginCommand command={result.command ?? ''} hostCommand={result.hostCommand} />;

  return (
    <div data-help="auth.login-flow" style={{ display: 'flex', flexDirection: 'column', gap: '8px', textAlign: 'left' }}>
      <div className="display-font" style={{ fontSize: '11px', letterSpacing: '2px', color: 'var(--color-accent-primary-dim)' }}>
        SIGN IN TO {name.toUpperCase()}
      </div>
      {session.status === 'pending' && (
        <>
          <div style={stepStyle}>
            <span style={num}>1</span>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <span style={{ fontSize: '12px', fontFamily: 'var(--font-body)' }}>Open the {name} sign-in page and sign in with the account whose subscription you want to use.</span>
              {session.url ? (
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
                  <a className="display-font" style={btn} href={session.url} target="_blank" rel="noreferrer noopener">OPEN SIGN-IN PAGE</a>
                  <button className="display-font" style={dim} onClick={() => void copy(session.url!, 'Link')}>COPY LINK</button>
                </div>
              ) : (
                <span style={{ fontSize: '11px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)' }}>Preparing the sign-in link...</span>
              )}
            </div>
          </div>
          <div style={stepStyle}>
            <span style={num}>2</span>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {session.needsCode ? (
                <>
                  <span style={{ fontSize: '12px', fontFamily: 'var(--font-body)' }}>The page shows a code when you finish. Paste it here.</span>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <input
                      type="text"
                      value={paste}
                      onChange={(e) => setPaste(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void submit(); } }}
                      placeholder="Paste the code from the page"
                      spellCheck={false}
                      aria-label="Sign-in code"
                      style={{ flex: 1, minWidth: 0, padding: '6px 10px', background: 'var(--color-bg-deep, rgba(0,0,0,0.3))', border: '1px solid var(--color-border-hairline)', borderRadius: '3px', color: 'var(--color-fg-primary, inherit)', fontSize: '12px', fontFamily: 'var(--font-code)' }}
                    />
                    <button className="display-font" style={btn} onClick={() => void submit()} disabled={!paste.trim()}>SUBMIT CODE</button>
                  </div>
                  {session.codeSubmitted && <span style={{ fontSize: '11px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)' }}>Checking the code...</span>}
                </>
              ) : (
                <>
                  <span style={{ fontSize: '12px', fontFamily: 'var(--font-body)' }}>Enter this one-time code on the page.</span>
                  {session.code ? (
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                      <code style={{ fontSize: '18px', letterSpacing: '3px', padding: '4px 10px', border: '1px solid var(--color-accent-primary)', borderRadius: '3px', color: 'var(--color-accent-primary)', fontFamily: 'var(--font-code)', userSelect: 'all' }}>{session.code}</code>
                      <button className="display-font" style={dim} onClick={() => void copy(session.code!, 'Code')}>COPY CODE</button>
                    </div>
                  ) : (
                    <span style={{ fontSize: '11px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)' }}>Waiting for the code...</span>
                  )}
                  <span style={{ fontSize: '11px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)' }}>Arco finishes on its own once the page accepts the code.</span>
                </>
              )}
            </div>
          </div>
        </>
      )}
      {session.status === 'completed' && (
        <div style={{ fontSize: '12px', color: 'var(--color-accent-primary)', fontFamily: 'var(--font-body)' }}>Signed in to {name}. Connecting...</div>
      )}
      {(session.status === 'failed' || session.status === 'cancelled') && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <span style={{ fontSize: '12px', color: 'var(--color-warning)', fontFamily: 'var(--font-body)' }}>
            {session.status === 'cancelled' ? 'Sign-in cancelled.' : `Sign-in did not finish: ${session.message ?? 'unknown error'}`}
          </span>
          <div><button className="display-font" style={btn} onClick={onRestart}>TRY AGAIN</button></div>
        </div>
      )}
      {note && <div style={{ fontSize: '11px', color: 'var(--color-accent-secondary-dim)', fontFamily: 'var(--font-body)' }}>{note}</div>}
      <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
        {session.status === 'pending' && <button className="display-font" style={dim} onClick={() => void cancel()}>CANCEL</button>}
        {result.command && (
          <button className="display-font" style={{ ...dim, border: 'none' }} onClick={() => setShowCommand((v) => !v)}>
            {showCommand ? 'HIDE TERMINAL COMMAND' : 'PREFER A TERMINAL?'}
          </button>
        )}
      </div>
      {showCommand && result.command && <LoginCommand command={result.command} hostCommand={result.hostCommand} />}
    </div>
  );
}
