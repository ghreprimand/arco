import { useEffect, useState } from 'react';
import type { View, GhWorkflowRun, GhWorkflowJob, GhCheckRun } from './types';
import {
  Loading, ErrorBox, EmptyBox, InlineStatus, useVisiblePolling,
  fmtDate, mergeBtnStyle, rowStyle, runStateChip, checkStateChip,
} from './shared';

function RunsList({ owner, name, onOpen }: { owner: string; name: string; onOpen: (id: number) => void }) {
  const [runs, setRuns] = useState<GhWorkflowRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setRuns(null);
    setError(null);
    fetch(`/api/github/repos/${owner}/${name}/runs`)
      .then((r) => r.ok ? r.json() : r.json().then((j) => Promise.reject(j.error || r.statusText)))
      .then((d) => setRuns(d.workflow_runs))
      .catch((e) => setError(String(e)));
  }, [owner, name]);

  return (
    <div>
      {runs === null && !error && <Loading />}
      {error && <ErrorBox message={error} />}
      {runs && runs.length === 0 && <EmptyBox label="No workflow runs." />}
      {runs?.map((r) => (
        <button key={r.id} onClick={() => onOpen(r.id)} style={rowStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
            <span style={runStateChip(r)}>{(r.conclusion || r.status).toUpperCase()}</span>
            <span style={{ color: 'var(--color-accent-primary)', fontSize: '13px' }}>#{r.run_number}</span>
            <span style={{ flex: 1, color: 'var(--color-accent-primary)', fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {r.name || r.display_title}
            </span>
            <span style={{ fontSize: '10px', color: 'var(--color-fg-muted)' }}>{r.event}</span>
            <span style={{ fontSize: '10px', color: 'var(--color-accent-secondary-dim)' }}>{r.head_branch}</span>
          </div>
          <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-display)' }}>
            {r.actor.login} · {fmtDate(r.created_at)}
          </div>
        </button>
      ))}
    </div>
  );
}

// ── Run detail ──────────────────────────────────────────────────────────

function RunView({ view, onBack }: { view: Extract<View, { kind: 'run' }>; onBack: () => void }) {
  const [run, setRun] = useState<GhWorkflowRun | null>(null);
  const [jobs, setJobs] = useState<GhWorkflowJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionStatus, setActionStatus] = useState<{ kind: 'ok' | 'error'; message: string } | null>(null);

  const base = `/api/github/repos/${view.owner}/${view.name}/runs/${view.id}`;

  const reload = () => {
    fetch(base).then((r) => r.json()).then(setRun).catch((e) => setError(String(e)));
    fetch(`${base}/jobs`).then((r) => r.json()).then((d) => setJobs(d.jobs ?? [])).catch(() => setJobs([]));
  };
  useEffect(reload, [base]);

  // Active runs tick fast; completed runs are frozen so stop polling.
  const runActive = !!run && run.status !== 'completed';
  useVisiblePolling(runActive, 8_000, () => {
    fetch(base).then((r) => r.ok ? r.json() : null).then((d) => { if (d) setRun(d); }).catch(() => {});
    fetch(`${base}/jobs`).then((r) => r.json()).then((d) => setJobs(d.jobs ?? [])).catch(() => {});
  });

  async function rerun() {
    if (busy) return;
    setBusy(true);
    setActionStatus(null);
    try {
      const res = await fetch(`${base}/rerun`, { method: 'POST' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
      setActionStatus({ kind: 'ok', message: `Rerun requested.` });
      reload();
    } catch (e) {
      setActionStatus({ kind: 'error', message: `Rerun failed: ${e instanceof Error ? e.message : String(e)}` });
    } finally { setBusy(false); }
  }

  if (error) return <ErrorBox message={error} onDismiss={onBack} />;
  if (!run) return <Loading />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--color-border-hairline)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px', flexWrap: 'wrap' }}>
          <span style={runStateChip(run)}>{(run.conclusion || run.status).toUpperCase()}</span>
          <span style={{ color: 'var(--color-accent-primary)', fontSize: '16px', fontFamily: 'var(--font-display)' }}>#{run.run_number} {run.name || run.display_title}</span>
          <div style={{ flex: 1 }} />
          <button onClick={rerun} disabled={busy} style={mergeBtnStyle}>{busy ? '...' : 'RERUN'}</button>
          <a href={run.html_url} target="_blank" rel="noreferrer" style={{ color: 'var(--color-accent-secondary)', fontSize: '10px', fontFamily: 'var(--font-display)', letterSpacing: '1px', textDecoration: 'none', padding: '6px 10px', border: '1px solid var(--color-accent-secondary)', borderRadius: '3px' }}>OPEN ON GH ↗</a>
        </div>
        <div style={{ fontSize: '11px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-display)' }}>
          {run.actor.login} · {run.event} on {run.head_branch} · {fmtDate(run.created_at)}
        </div>
      </div>
      <InlineStatus status={actionStatus} onDismiss={() => setActionStatus(null)} />
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px', minHeight: 0 }}>
        {jobs === null ? <Loading /> : jobs.length === 0 ? <EmptyBox label="No jobs." /> : (
          jobs.map((j) => (
            <div key={j.id} style={{ border: '1px solid var(--color-border-hairline)', borderRadius: '3px', marginBottom: '8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 12px', background: 'rgba(0, 8, 4, 0.5)', borderBottom: '1px solid var(--color-border-hairline)' }}>
                <span style={checkStateChip({ status: j.status, conclusion: j.conclusion } as GhCheckRun)}>{(j.conclusion || j.status).toUpperCase()}</span>
                <span style={{ flex: 1, color: 'var(--color-accent-primary)', fontSize: '12px' }}>{j.name}</span>
                <a href={j.html_url} target="_blank" rel="noreferrer" style={{ fontSize: '10px', color: 'var(--color-accent-secondary)', fontFamily: 'var(--font-display)', letterSpacing: '1px', textDecoration: 'none' }}>LOG ↗</a>
              </div>
              {j.steps && j.steps.length > 0 && (
                <div style={{ padding: '4px 12px 8px' }}>
                  {j.steps.map((s) => (
                    <div key={s.number} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '3px 0', fontSize: '11px' }}>
                      <span style={checkStateChip({ status: s.status, conclusion: s.conclusion } as GhCheckRun)}>{(s.conclusion || s.status).toUpperCase()}</span>
                      <span style={{ color: 'var(--color-accent-primary-dim)' }}>{s.name}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export { RunsList, RunView };
