import { useEffect, useRef, useState } from 'react';
import { useAppUpdateStore } from '../stores/appUpdateStore';

type State = { mode: 'service' | 'foreground' | 'docker'; platform?: string; packaged?: boolean; result: { outcome: string; message?: string; attemptId?: string } | null };
export function UpdateAction({ latest, url, autoConfirm = false }: { latest: string | null; url: string | null; autoConfirm?: boolean }) {
  const [state, setState] = useState<State | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [resultMessage, setResultMessage] = useState('');
  const [fallback, setFallback] = useState(false);
  // null means the start request is in flight; a string fences later polls to
  // that attempt. A new page can display any result the server still reports.
  const startedAttempt = useRef<string | null | undefined>(undefined);
  // Publish only real changes of this instance's own flag. Its initial false is
  // not a change (a second effect run under StrictMode must not publish either),
  // so a newly mounted instance never clears an update another one started.
  const published = useRef(false);
  useEffect(() => {
    if (pending === published.current) return;
    published.current = pending;
    useAppUpdateStore.getState().setUpdating(pending);
  }, [pending]);
  const asked = useRef(false);
  useEffect(() => {
    if (autoConfirm && !asked.current && state?.mode === 'service' && latest) { asked.current = true; setConfirm(true); }
  }, [autoConfirm, state, latest]);
  useEffect(() => {
    let live = true; let request = 0;
    const refresh = async () => {
      const sequence = ++request;
      try {
        const response = await fetch('/api/update-manager');
        if (!response.ok) return;
        const next = await response.json() as State;
        if (!live || sequence !== request || !['service', 'foreground', 'docker'].includes(next.mode)) return;
        setState(next);
        if (next.result?.outcome === 'running') { setResultMessage(''); setPending(true); }
        else if (next.result?.outcome === 'updated' || next.result?.outcome === 'failed' || next.result?.outcome === 'unchanged') {
          if (startedAttempt.current === null || (startedAttempt.current && next.result.attemptId !== startedAttempt.current)) return;
          startedAttempt.current = undefined;
          setPending(false); setMessage(''); setResultMessage(next.result.message || (next.result.outcome === 'updated' ? 'Update complete.' : next.result.outcome === 'unchanged' ? 'Already on the newest release.' : 'Update failed.'));
        } else setResultMessage('');
      } catch { /* reconnect retries on the next poll */ }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, pending ? 2000 : 30_000);
    return () => { live = false; clearInterval(timer); };
  }, [pending]);
  const start = async () => {
    startedAttempt.current = null;
    setConfirm(false); setPending(true); setFallback(false); setResultMessage(''); setMessage('Starting update. Arco will reconnect after restart.');
    try {
      const response = await fetch('/api/update-manager', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedLatest: latest }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not start update.');
      startedAttempt.current = typeof result.attemptId === 'string' ? result.attemptId : undefined;
    } catch (error) { startedAttempt.current = undefined; setPending(false); setFallback(true); setMessage(error instanceof Error ? error.message : 'Could not start update.'); }
  };
  if (!state) return null;
  const dockerTag = latest && /^v\d+\.\d+\.\d+$/.test(latest) ? latest : null;
  const command = state.mode === 'docker'
    ? dockerTag ? `git fetch --tags origin && git checkout --detach ${dockerTag} && docker compose up -d --build` : null
    : state.packaged ? 'arco update' : 'npm run arco:update';
  const powershellCommand = state.mode === 'docker' && dockerTag ? `git fetch --tags origin; if ($LASTEXITCODE -eq 0) { git checkout --detach ${dockerTag}; if ($LASTEXITCODE -eq 0) { docker compose up -d --build } }` : null;
  const copy = (value: string) => {
    if (!navigator.clipboard) { setMessage('Could not copy the command.'); return; }
    void navigator.clipboard.writeText(value).then(() => setMessage('Command copied.'), () => setMessage('Could not copy the command.'));
  };
  return <div data-help="settings.update-action" style={{ marginTop: 8 }}>
    {state.mode === 'service' && latest ? <button type="button" disabled={pending} onClick={() => setConfirm(true)}>UPDATE AND RESTART</button> : <>
      {state.mode === 'foreground' && state.platform === 'win32' && <div>Stop Arco before updating, then run {state.packaged ? 'arco start' : 'npm start'}.</div>}
      {state.mode === 'foreground' && state.platform === 'darwin' && <div>Restart the foreground process or the configured launchd job after updating.</div>}
      {command ? <><code>{command}</code>{' '}
      <button type="button" onClick={() => copy(command)}>COPY COMMAND</button>{powershellCommand && <button type="button" onClick={() => copy(powershellCommand)}>COPY POWERSHELL COMMAND</button>}</> : <span>Check for a release to get the Docker update command.</span>}
    </>}
    {fallback && <div><code>{state.packaged ? 'arco update' : 'npm run arco:update'}</code>{' '}<button type="button" onClick={() => copy(state.packaged ? 'arco update' : 'npm run arco:update')}>COPY COMMAND</button></div>}
    {message && <div role="status">{message}</div>}
    {resultMessage && <div role="status">{resultMessage}</div>}
    {confirm && <div role="dialog" aria-modal="true" aria-label="Confirm update" style={{ position: 'fixed', inset: 0, zIndex: 10000, background: 'rgba(0,0,0,.6)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: 'var(--color-bg-elevated)', color: 'var(--color-fg)', border: '1px solid var(--color-border)', padding: 20, maxWidth: 480 }}>
        <p>Update to {latest} and restart Arco? Running turns will stop.</p>
        {url && <p><a href={url} target="_blank" rel="noopener noreferrer">Release notes</a></p>}
        <button type="button" onClick={() => void start()}>UPDATE AND RESTART</button>{' '}
        <button type="button" onClick={() => setConfirm(false)}>CANCEL</button>
      </div>
    </div>}
  </div>;
}
