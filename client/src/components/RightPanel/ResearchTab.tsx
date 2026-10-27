import { useState, useEffect } from 'react';
import { type JobState, type ResearchEntry } from '../../stores/appStore';
import { EmptyState } from './FilesTab';

// docs/ARCHITECTURE.md - RESEARCH tab. Mirrors ReviewTab: a list of
// research runs, each expandable to its cited report (fetched from the same
// `GET /api/workflows/artifact` endpoint). The expanded viewer carries a "dig
// deeper" composer that re-runs a bounded mini-round seeded with the report +
// its sources and appends a dated addendum to the same artifact.
export function ResearchTab({
  job,
  onCancelResearch,
  onResearchFollowUp,
}: {
  job: JobState;
  onCancelResearch?: (researchId: string) => void;
  onResearchFollowUp?: (seedArtifactName: string, followUp: string) => void;
}) {
  const runs = [...(job.research ?? [])].sort((a, b) => b.startedAt - a.startedAt);
  const [expanded, setExpanded] = useState<string | null>(null);
  if (runs.length === 0) {
    return (
      <EmptyState text="No research yet. Use the ⌕ RESEARCH button near the composer to run a bounded web-research turn." />
    );
  }
  return (
    <div style={{ overflowY: 'auto', flex: 1 }}>
      {runs.map((r) => (
        <ResearchRow
          key={r.researchId}
          run={r}
          cwd={job.config.workingDirectory}
          workflowId={job.id}
          open={expanded === r.researchId}
          onToggle={() => setExpanded(expanded === r.researchId ? null : r.researchId)}
          onCancel={onCancelResearch ? () => onCancelResearch(r.researchId) : undefined}
          onFollowUp={onResearchFollowUp}
        />
      ))}
    </div>
  );
}

function ResearchRow({
  run,
  cwd,
  workflowId,
  open,
  onToggle,
  onCancel,
  onFollowUp,
}: {
  run: ResearchEntry;
  cwd: string;
  workflowId: string;
  open: boolean;
  onToggle: () => void;
  onCancel?: () => void;
  onFollowUp?: (seedArtifactName: string, followUp: string) => void;
}) {
  // Re-fetch when the artifact name changes OR completedAt advances (a
  // dig-deeper follow-up appends to the same file, so the body must reload).
  const [body, setBody] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const done = Boolean(run.completedAt);
  const inFlight = !done && !run.error;

  useEffect(() => {
    if (!open || !run.artifactName || !cwd || inFlight) return;
    let cancelled = false;
    setBody(null);
    setLoadError(null);
    const q = new URLSearchParams({ path: cwd, workflowId, name: run.artifactName });
    fetch(`/api/workflows/artifact?${q.toString()}`)
      .then((r) => r.ok ? r.json() as Promise<{ contents: string }> : Promise.reject(r.statusText))
      .then((d) => { if (!cancelled) setBody(d.contents); })
      .catch((err) => { if (!cancelled) setLoadError(String(err)); });
    return () => { cancelled = true; };
  }, [open, run.artifactName, run.completedAt, cwd, workflowId, inFlight]);

  const statusColor = run.error
    ? 'var(--color-warning)'
    : inFlight
      ? 'var(--color-accent-secondary)'
      : 'var(--color-accent-primary)';

  return (
    <div style={{ borderBottom: '1px solid var(--color-accent-primary-a05)' }}>
      <button
        onClick={onToggle}
        className="display-font"
        style={{
          width: '100%', padding: '8px 14px',
          background: open ? 'var(--color-accent-primary-a08)' : 'transparent',
          border: 'none', color: 'var(--color-fg-muted)', cursor: 'pointer',
          fontSize: '10px', letterSpacing: '1px', textAlign: 'left',
          display: 'flex', alignItems: 'center', gap: '8px',
        }}
      >
        <span style={{ color: statusColor, minWidth: '56px' }}>
          {run.error ? 'ERROR' : inFlight ? (run.progressNote ? run.progressNote.toUpperCase() : 'RUN…') : `${run.sourceCount ?? 0} SRC`}
        </span>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {run.isFollowUp ? '↳ ' : ''}{run.topic || run.artifactName}
        </span>
        <span style={{ opacity: 0.6 }}>{new Date(run.startedAt).toLocaleTimeString()}</span>
        <span style={{ opacity: 0.6 }}>{open ? '▼' : '▶'}</span>
      </button>
      {open && (
        <div style={{ padding: '10px 14px 16px', background: 'var(--color-bg-sunken)' }}>
          {run.error && (
            <div style={{ color: 'var(--color-warning)', fontSize: '11px', marginBottom: '8px' }}>
              Research failed: {run.error}
            </div>
          )}
          {inFlight && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <div className="display-font" style={{ color: 'var(--color-fg-muted)', fontSize: '10px', letterSpacing: '1px' }}>
                {run.progressNote ?? 'Researcher running…'} — report lands on completion.
              </div>
              {onCancel && (
                <button
                  onClick={(e) => { e.stopPropagation(); onCancel(); }}
                  className="display-font"
                  style={{ padding: '4px 10px', background: 'transparent', border: '1px solid var(--color-warning)', color: 'var(--color-warning)', cursor: 'pointer', fontSize: '10px', letterSpacing: '1px' }}
                  title="Kill the research subprocess"
                >
                  CANCEL
                </button>
              )}
            </div>
          )}
          {loadError && (
            <div style={{ color: 'var(--color-warning)', fontSize: '11px' }}>
              Artifact load failed: {loadError}
            </div>
          )}
          {body !== null && (
            <>
              <pre
                style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '12px', fontFamily: 'var(--font-body)', color: 'var(--color-accent-primary)', margin: 0 }}
              >
                {body}
              </pre>
              {onFollowUp && !run.error && (
                <DigDeeperComposer
                  artifactName={run.artifactName}
                  onFollowUp={onFollowUp}
                />
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// "Dig deeper" composer - docs/ARCHITECTURE.md step 4. Submits a
// follow-up question that re-runs a bounded mini-round seeded with this report
// + its sources, appending a dated addendum to the SAME artifact.
function DigDeeperComposer({
  artifactName,
  onFollowUp,
}: {
  artifactName: string;
  onFollowUp: (seedArtifactName: string, followUp: string) => void;
}) {
  const [q, setQ] = useState('');
  const [sent, setSent] = useState(false);
  const submit = () => {
    const trimmed = q.trim();
    if (!trimmed) return;
    onFollowUp(artifactName, trimmed);
    setQ('');
    setSent(true);
    setTimeout(() => setSent(false), 1500);
  };
  return (
    <div style={{ marginTop: '12px', borderTop: '1px solid var(--color-accent-primary-a05)', paddingTop: '10px' }}>
      <div className="display-font" style={{ fontSize: '10px', letterSpacing: '2px', color: 'var(--color-accent-primary-dim)', marginBottom: '4px' }}>
        DIG DEEPER
      </div>
      <textarea
        data-help="rightpanel.research.dig-deeper"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Ask a follow-up against the gathered sources — e.g. expand point 3, find counter-evidence, what did source X say?"
        rows={2}
        style={{
          width: '100%', boxSizing: 'border-box', padding: '6px 8px',
          background: 'var(--color-bg-panel)', border: '1px solid var(--color-border-hairline)',
          borderRadius: '3px', color: 'var(--color-accent-primary)',
          fontFamily: 'var(--font-body)', fontSize: '11px', resize: 'vertical',
        }}
      />
      <button
        onClick={submit}
        disabled={!q.trim()}
        className="display-font"
        style={{
          marginTop: '8px', padding: '6px 12px',
          background: q.trim() ? 'var(--color-accent-primary-a10)' : 'transparent',
          border: `1px solid ${q.trim() ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'}`,
          color: q.trim() ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
          cursor: q.trim() ? 'pointer' : 'default', fontSize: '10px', letterSpacing: '1.5px',
        }}
        title="Run a bounded follow-up and append a cited addendum to this report"
      >
        {sent ? '✓ FOLLOW-UP DISPATCHED' : '⌕ DIG DEEPER'}
      </button>
    </div>
  );
}
