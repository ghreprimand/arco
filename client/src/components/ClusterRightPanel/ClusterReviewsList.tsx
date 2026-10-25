import { useEffect, useState } from 'react';
import { useAppStore } from '../../stores/appStore';
import type { ClusterStatePayload } from '@archon/shared';

// Phase 2.5 B1 — aggregated review feed across every cluster member.
// Per-workflow reviews live on each job's `reviews` array (populated by the
// existing `review_started` / `review_artifact_ready` WS handlers); this
// surface just merges + sorts them. Standalone workflow Review tab on each
// member's individual tab is untouched. Click a row to expand the full
// reviewer body (artifact) — same expand-on-click shape as the per-workflow
// Review tab.
export function ClusterReviewsList({ cluster, onCancelReview }: {
  cluster: ClusterStatePayload;
  onCancelReview?: (workflowId: string, reviewId: string) => void;
}) {
  const jobs = useAppStore((s) => s.jobs);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const rows: Array<{
    reviewId: string;
    workflowId: string;
    cwd: string;
    memberName: string;
    reviewer: string;
    startedAt: number;
    completedAt?: number;
    verdict?: 'PASS' | 'MINOR' | 'BLOCKING';
    artifactName: string;
    error?: string;
  }> = [];
  for (const m of cluster.members) {
    const job = jobs[m.workflowId];
    if (!job) continue;
    for (const r of job.reviews) {
      rows.push({
        reviewId: r.reviewId,
        workflowId: m.workflowId,
        cwd: job.config.workingDirectory ?? '',
        memberName: m.displayName,
        reviewer: `${r.reviewer.provider}:${r.reviewer.model}@${r.reviewer.effort}`,
        startedAt: r.startedAt,
        ...(r.completedAt !== undefined ? { completedAt: r.completedAt } : {}),
        ...(r.verdict ? { verdict: r.verdict } : {}),
        artifactName: r.artifactName,
        ...(r.error ? { error: r.error } : {}),
      });
    }
  }
  rows.sort((a, b) => b.startedAt - a.startedAt);
  if (rows.length === 0) {
    return (
      <div style={{ color: 'var(--color-fg-muted)', fontSize: '11px' }}>
        No reviews yet. Click REVIEW on any member to spawn one — results
        land here.
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      {rows.map((r) => (
        <ClusterReviewRow
          key={r.reviewId}
          row={r}
          open={expanded[r.reviewId] === true}
          onToggle={() => setExpanded((prev) => ({ ...prev, [r.reviewId]: !(prev[r.reviewId] === true) }))}
          onCancel={onCancelReview && !r.completedAt && !r.error
            ? () => onCancelReview(r.workflowId, r.reviewId)
            : undefined}
        />
      ))}
    </div>
  );
}

// Single review row — collapsed shows status + reviewer, expanded fetches
// the artifact body so the operator can see what the reviewer produced
// without leaving the cluster tab. Streaming reviews show whatever's been
// written so far (the artifact file gets appended as the reviewer streams),
// and surface a CANCEL button next to the status pill.
function ClusterReviewRow({ row, open, onToggle, onCancel }: {
  row: {
    reviewId: string;
    workflowId: string;
    cwd: string;
    memberName: string;
    reviewer: string;
    startedAt: number;
    completedAt?: number;
    verdict?: 'PASS' | 'MINOR' | 'BLOCKING';
    artifactName: string;
    error?: string;
  };
  open: boolean;
  onToggle: () => void;
  onCancel?: () => void;
}) {
  const [body, setBody] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const status = row.error ? 'FAILED' : row.completedAt ? (row.verdict ?? 'DONE') : 'STREAMING';
  const statusColor = status === 'FAILED'
    ? 'var(--color-warning)'
    : status === 'STREAMING'
      ? 'var(--color-accent-secondary)'
      : status === 'BLOCKING'
        ? 'var(--color-warning)'
        : 'var(--color-accent-primary)';

  // Refetch on every open + on completion transition. When the row stays
  // open across the completion event, we want the final body to replace the
  // streaming snapshot — keying the effect on `completedAt` triggers that.
  useEffect(() => {
    if (!open || !row.artifactName || !row.cwd) return;
    let cancelled = false;
    setLoadError(null);
    const q = new URLSearchParams({ path: row.cwd, workflowId: row.workflowId, name: row.artifactName });
    fetch(`/api/workflows/artifact?${q.toString()}`)
      .then((r) => r.ok ? r.json() as Promise<{ contents: string }> : Promise.reject(r.statusText))
      .then((d) => { if (!cancelled) setBody(d.contents); })
      .catch((err) => { if (!cancelled) setLoadError(String(err)); });
    return () => { cancelled = true; };
  }, [open, row.artifactName, row.cwd, row.workflowId, row.completedAt]);

  return (
    <div
      style={{
        border: '1px solid var(--color-border-hairline)',
        background: 'var(--color-bg)',
        fontSize: '11px',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        onClick={onToggle}
        style={{
          padding: '8px 10px',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          cursor: 'pointer',
        }}
      >
        <span style={{ color: 'var(--color-fg)' }}>{row.memberName}</span>
        <span
          className="display-font"
          style={{
            color: statusColor,
            fontSize: '10px',
            letterSpacing: '1px',
            padding: '1px 6px',
            border: '1px solid currentColor',
          }}
        >
          {status}
        </span>
        {onCancel && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onCancel(); }}
            className="display-font"
            style={{
              background: 'transparent',
              border: '1px solid var(--color-warning)',
              color: 'var(--color-warning)',
              padding: '1px 6px',
              cursor: 'pointer',
              fontSize: '9px',
              letterSpacing: '1px',
            }}
            title="Cancel this in-flight review"
          >
            CANCEL
          </button>
        )}
        <span style={{ marginLeft: 'auto', color: 'var(--color-fg-muted)', fontSize: '10px' }}>
          {new Date(row.startedAt).toLocaleTimeString()}
        </span>
        <span style={{ color: 'var(--color-fg-muted)', fontSize: '10px' }}>
          {open ? '▼' : '▶'}
        </span>
      </div>
      <div style={{ padding: '0 10px 6px', color: 'var(--color-fg-muted)', fontSize: '10px' }}>
        {row.reviewer}
      </div>
      {open && (
        <div style={{ borderTop: '1px solid var(--color-border-hairline)', padding: '10px', background: 'var(--color-bg-sunken)' }}>
          {row.error && (
            <div style={{ color: 'var(--color-warning)', fontSize: '11px', marginBottom: '8px' }}>
              Review failed: {row.error}
            </div>
          )}
          {loadError && (
            <div style={{ color: 'var(--color-warning)', fontSize: '10px', marginBottom: '8px' }}>
              Could not load artifact: {loadError}
            </div>
          )}
          {body === null && !loadError && (
            <div style={{ color: 'var(--color-fg-muted)', fontSize: '10px' }}>
              Loading {row.artifactName}…
            </div>
          )}
          {body !== null && (
            <pre style={{
              margin: 0,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              color: 'var(--color-fg)',
              fontSize: '11px',
              maxHeight: '480px',
              overflowY: 'auto',
            }}>{body || '(empty — reviewer has not produced output yet)'}</pre>
          )}
          <div style={{ marginTop: '8px', color: 'var(--color-fg-muted)', fontSize: '9px' }}>
            artifact: {row.artifactName}
          </div>
        </div>
      )}
    </div>
  );
}
