import { useEffect, useState } from 'react';
import type { SessionInfo } from '@arco/shared';
import { useAppStore } from '../stores/appStore';
import { action, muted } from './Home/homeStyles';

// Discovery is read-only; opening is always an explicit operator action.
export function TerminalSessions({ cwd, onOpen }: { cwd: string; onOpen: (session: SessionInfo) => void }) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const jobs = useAppStore(s => s.jobs);
  const auth = useAppStore(s => s.authStatus);
  const connected = useAppStore(s => s.connected);
  useEffect(() => {
    const controller = new AbortController();
    setSessions([]);
    if (cwd) void fetch(`/api/terminal-sessions?path=${encodeURIComponent(cwd)}`, { signal: controller.signal, cache: 'no-store' })
      .then(response => response.ok ? response.json() : { sessions: [] })
      .then(body => { if (!controller.signal.aborted) setSessions(Array.isArray(body.sessions) ? body.sessions : []); })
      .catch(() => {});
    return () => controller.abort();
  }, [cwd]);
  const opened = new Set(Object.values(jobs).flatMap(job => [job.config.resumeSessionId, job.claudeSessionId]).filter(Boolean));
  const available = sessions.filter(s => (s.provider === 'claude' || s.provider === 'codex') && !opened.has(s.sessionId));
  const claudeReady = auth?.claude?.cli ? auth.claude.cli.loggedIn : auth?.claude?.native ? false : auth?.claude?.loggedIn;
  if (!available.length) return null;
  return <details data-help="terminal-sessions">
    <summary>Continue a session from the terminal</summary>
    <p style={muted}>Close the terminal session before continuing here. Claude sessions use the CLI transport for this tab; Native cannot resume a CLI session. Codex uses the terminal account.</p>
    <ul style={{ padding: 0, listStyle: 'none', maxHeight: 220, overflowY: 'auto' }}>
      {available.map(session => {
        const cliReady = session.provider === 'claude' ? claudeReady : auth?.codex?.loggedIn;
        const age = Math.max(0, Date.now() - session.startedAt);
        const relative = age < 60000 ? 'just now' : age < 3600000 ? `${Math.floor(age / 60000)}m ago` : age < 86400000 ? `${Math.floor(age / 3600000)}h ago` : `${Math.floor(age / 86400000)}d ago`;
        return <li key={`${session.provider}:${session.sessionId}`} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0' }}>
          <span aria-hidden="true" style={{ ...muted, border: '1px solid var(--color-border-hairline)', borderRadius: 3, padding: '1px 4px' }}>{session.provider === 'claude' ? 'C' : 'X'}</span>
          <span style={{ ...muted, flex: 1, overflowWrap: 'anywhere' }}>{session.provider === 'claude' ? 'Claude' : 'Codex'} / {session.name || 'Untitled session'} / {relative}</span>
          <button type="button" style={action} disabled={!connected || !cliReady} title={!cliReady ? `Connect the ${session.provider === 'claude' ? 'Claude CLI' : 'Codex'} to continue` : undefined} onClick={() => onOpen(session)} aria-label={`Open terminal session ${session.name || session.sessionId.slice(0, 8)}`}>OPEN</button>
        </li>;
      })}
    </ul>
    {available.some(s => s.provider === 'claude') && !claudeReady && <p style={muted}>Connect Claude CLI in Settings to open Claude terminal sessions.</p>}
  </details>;
}
