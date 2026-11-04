import { useCallback, useEffect, useState } from 'react';

interface Report { isGit: boolean; hasState: boolean; tracked: number; trackedSample: string[]; ignored: boolean; ignoreFile: 'default' | 'missing' | 'edited' }

const DISMISS_KEY = 'arco.projectStateNotice.';
const btn: React.CSSProperties = { padding: '2px 8px', fontSize: '10px', letterSpacing: '1px', cursor: 'pointer' };

// One quiet, dismissible notice per project when Arco's project state folder is
// tracked by Git or not ignored. Nothing changes until a button is pressed.
export function ProjectStateNotice({ cwd, skip = false }: { cwd: string; skip?: boolean }) {
  const [report, setReport] = useState<Report | null>(null);
  const [dismissed, setDismissed] = useState(() => { try { return localStorage.getItem(DISMISS_KEY + cwd) === '1'; } catch { return false; } });
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    void fetch(`/api/public-project/state?path=${encodeURIComponent(cwd)}`)
      .then((r) => (r.ok ? r.json() as Promise<Report> : null))
      .then((r) => setReport(r))
      .catch(() => setReport(null));
  }, [cwd]);
  useEffect(() => {
    try { setDismissed(localStorage.getItem(DISMISS_KEY + cwd) === '1'); } catch { setDismissed(false); }
    if (cwd && !skip) load(); else setReport(null);
  }, [cwd, skip, load]);

  const act = async (action: 'restore-ignore' | 'stop-tracking') => {
    setBusy(true);
    try {
      const res = await fetch(`/api/public-project/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: cwd }) });
      const body = await res.json() as { ok?: boolean; backup?: string; removed?: number; error?: string };
      if (!res.ok || body.ok === false) setMessage(body.error ?? 'The change did not apply.');
      else if (action === 'restore-ignore') setMessage(body.backup ? `The ignore file was restored. Your edited file was kept as ${body.backup}.` : 'The ignore file was restored.');
      else setMessage(`Stopped tracking ${body.removed ?? 0} file(s). The files are still on disk. Commit this change to finish; anything already pushed stays in the remote's history.`);
    } catch { setMessage('The change did not apply.'); }
    setBusy(false);
    load();
  };

  if (!cwd || skip || dismissed || !report || !report.isGit) return null;
  const tracked = report.tracked > 0;
  const unignored = report.hasState && !report.ignored;
  if (!tracked && !unignored && !message) return null;
  const dismiss = () => { try { localStorage.setItem(DISMISS_KEY + cwd, '1'); } catch { /* no-op */ } setDismissed(true); };
  return (
    <div data-testid="project-state-notice" data-help="project-state.notice" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px', padding: '5px 10px', fontSize: '11px', color: 'var(--color-fg-muted)', borderTop: '1px solid var(--color-border-hairline)' }}>
      <span>
        {tracked
          ? `Git is tracking ${report.tracked} file(s) in this project's .arco folder (Arco's private state).`
          : report.ignoreFile === 'missing' ? "This project's .arco folder is not ignored by Git: its ignore file is missing."
            : "This project's .arco folder is not ignored by Git: its ignore file was edited."}
        {tracked && report.trackedSample.length > 0 ? ` For example ${report.trackedSample.slice(0, 2).join(', ')}.` : ''}
        {tracked && ' If this repository is public, rotate any secret that may be in them.'}
      </span>
      {unignored && <button type="button" data-testid="project-state-restore" disabled={busy} onClick={() => void act('restore-ignore')} style={btn}>RESTORE IGNORE FILE</button>}
      {tracked && <button type="button" data-testid="project-state-stop" disabled={busy} onClick={() => void act('stop-tracking')} style={btn}>STOP TRACKING</button>}
      <button type="button" data-testid="project-state-dismiss" onClick={dismiss} style={btn}>DISMISS</button>
      {message && <span data-testid="project-state-message" style={{ flexBasis: '100%' }}>{message}</span>}
    </div>
  );
}
