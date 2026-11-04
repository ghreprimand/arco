import { useState } from 'react';
import type { AuthLoginResult, AuthRecoveryContext, ProviderName } from '@arco/shared';
import { LoginCommand } from './LoginCommand';
import { NativeLoginControls } from './NativeLoginControls';
import { sameRecoveryBinding, useClaudeNativeLogin } from '../hooks/useClaudeNativeLogin';
import { selectedClaudeTransport } from '../utils/claudeAuth';
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
  if (raw !== 'claude' && raw !== 'codex' && raw !== 'ollama' && raw !== 'github' && raw !== 'cursor') {
    return null;
  }
  return { provider: raw as ProviderName, body: m[2] };
}

interface Props {
  provider: ProviderName;
  body: string;
  workflowId?: string;
  messageId?: string;
  authRecovery?: AuthRecoveryContext;
}

export function AuthReloginNotice({ provider, body, workflowId, messageId, authRecovery }: Props) {
  const [state, setState] = useState<'idle' | 'pending' | 'sent' | 'error'>('idle');
  const [hint, setHint] = useState<string | null>(null);
  const [command, setCommand] = useState<string | null>(null);
  // Capture the notice's origin, never whichever tab is active at click time.
  const [origin] = useState(() => {
    const store = useAppStore.getState(), job = workflowId ? store.jobs[workflowId] : undefined;
    const transport = authRecovery?.transport ?? selectedClaudeTransport(job?.config.claudeTransport, store.settings?.claude?.transport, !!job?.config.ultracode);
    return { transport, accountRef: job?.config.providerAccountRef, binding: authRecovery?.binding ?? (transport === 'native' ? store.authStatus?.claude?.native?.binding : store.authStatus?.claude?.cli?.binding) };
  });
  const job = useAppStore(s => workflowId ? s.jobs[workflowId] : undefined);
  const currentNative = useAppStore(s => s.authStatus?.claude?.native);
  const nativeLogin = useClaudeNativeLogin(`notice:${workflowId ?? 'unknown'}:${messageId ?? body}`, workflowId, origin.binding);
  const claudeNative = provider === 'claude' && origin.transport === 'native';
  const complete = claudeNative && nativeLogin.session?.flow?.status === 'complete'
    && nativeLogin.session.flow.workflowId === workflowId
    && (!origin.binding || sameRecoveryBinding(origin.binding, nativeLogin.session.flow.bindingBefore))
    && sameRecoveryBinding(currentNative?.binding, nativeLogin.session.flow.binding)
    && currentNative?.state !== 'needs-attention';

  const label = provider === 'claude'
    ? (claudeNative ? 'CLAUDE NATIVE' : 'CLAUDE')
    : provider === 'codex' ? 'CODEX'
    : provider.toUpperCase();

  const startLogin = async () => {
    setState('pending');
    setHint(null);
    setCommand(null);
    try {
      if (claudeNative) {
        await nativeLogin.start();
        setState('idle');
        return;
      }
      const account = provider === 'codex' && origin.accountRef ? `&account=${encodeURIComponent(origin.accountRef)}` : '';
      const res = await fetch(`/api/auth-login?provider=${provider}${account}`, { method: 'POST' });
      const data = (await res.json()) as AuthLoginResult;
      if (data.command) {
        setState('sent');
        setCommand(data.command);
        setHint('Finish the login in the terminal, then review the original workflow before sending explicitly.');
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
          {complete ? 'Native sign-in completed for this recovery. Review the original workflow before continuing; earlier actions may already have run.' : body}
        </span>
        <button
          onClick={complete ? () => { if (workflowId && useAppStore.getState().jobs[workflowId]) useAppStore.getState().setActiveJob(workflowId); } : startLogin}
          disabled={state === 'pending' || nativeLogin.session?.busy || (complete && !job)}
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
          {complete ? 'REVIEW ORIGINAL WORKFLOW' : state === 'pending' ? 'STARTING...' : state === 'sent' ? `RE-LOGIN ${label}` : `RE-LOGIN ${label}`}
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
      {!claudeNative && state === 'sent' && workflowId && job && <p>Original workflow execution: {job.busy ? 'running' : job.lastTurnCancelledAt ? 'interrupted' : 'idle'}. Sign-in completion is not verified here. <button onClick={() => useAppStore.getState().setActiveJob(workflowId)}>REVIEW ORIGINAL WORKFLOW</button></p>}
      {claudeNative && <NativeLoginControls key={nativeLogin.session?.flow?.id} login={nativeLogin} />}
      {complete && <p>Original workflow: {job?.config.name ?? workflowId ?? 'unavailable'}. Execution: {!job ? 'workflow unavailable' : job.busy ? 'running' : job.lastTurnCancelledAt ? 'interrupted' : 'idle'}. Draft retained. Review the transcript and send explicitly from the composer; nothing was replayed.</p>}
    </div>
  );
}
