import { useState } from 'react';
import { nativeFlowPending, type useClaudeNativeLogin } from '../hooks/useClaudeNativeLogin';

export function NativeLoginControls({ login }: { login: ReturnType<typeof useClaudeNativeLogin> }) {
  const [value, setValue] = useState('');
  const session = login.session, active = nativeFlowPending(session?.flow);
  const buttonStyle = { padding: '4px 10px', background: 'transparent', border: '1px solid var(--color-accent-primary)', color: 'var(--color-accent-primary)', borderRadius: '3px', fontSize: '10px', cursor: 'pointer' };
  return <div style={{ fontSize: '11px', overflowWrap: 'anywhere', color: 'var(--color-fg-muted)' }}>
    {active && <>
      <p>Approve sign-in in the provider browser. Consent, MFA and account checks remain in that browser.</p>
      {session?.authorizationUrl && <a href={session.authorizationUrl} target="_blank" rel="noopener noreferrer">OPEN SIGN-IN</a>}
      <p>{session?.hint} A local callback completes automatically only when the browser reaches this server. On another device, paste the redirected localhost URL from the failed callback page.</p>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <input aria-label="Native callback URL" value={value} onChange={e => setValue(e.target.value)} placeholder="Redirected localhost callback URL" style={{ flex: '1 1 200px', minWidth: 0, padding: '4px 6px', background: 'var(--color-bg-sunken)', border: '1px solid var(--color-border-hairline)', color: 'var(--color-accent-primary)', borderRadius: '3px' }} />
        <button className="display-font" style={buttonStyle} disabled={!value.trim() || session?.busy} onClick={() => { void login.submit(value); }}>SUBMIT</button>
        <button className="display-font" style={buttonStyle} disabled={session?.busy} onClick={() => { void login.cancel(); }}>CANCEL SIGN-IN</button>
      </div>
    </>}
    {session?.flow && !active && <p>Sign-in flow: {session.flow.status}. {session.flow.status === 'complete' ? 'Credentials replaced; execution remains unverified. No work was replayed.' : 'This flow cannot resolve another recovery notice.'}</p>}
    {session?.error && <p role="status">{session.error}</p>}
  </div>;
}
