import { useState, useEffect, useMemo } from 'react';
import type { WorkflowConfig } from '@arco/shared';
import { useAppStore, type JobState, type ReviewEntry } from '../../stores/appStore';
import { SpawnDialog } from '../SpawnDialog';
import { FileViewerModal } from '../FileViewerModal';
import { EmptyState } from './FilesTab';
import { parseReviewFindings, type Finding } from './reviewFindings';

export function ReviewTab({
  job,
  onCancelReview,
  onSpawn,
  onSend,
}: {
  job: JobState;
  onCancelReview?: (reviewId: string) => void;
  onSpawn?: (newConfig: WorkflowConfig, newDirection: string, includePlan: boolean) => void;
  // D5 — the composer's send path. A finding's Fix button uses it to dispatch
  // a scoped follow-up turn. Operator-click-only.
  onSend?: (content: string, attachments?: string[], kind?: 'steer' | 'follow-up' | 'interrupt', primitive?: 'docs' | 'git') => void;
}) {
  const reviews = [...job.reviews].sort((a, b) => b.startedAt - a.startedAt);
  const [expanded, setExpanded] = useState<string | null>(null);
  // When the operator clicks SPAWN TO FIX on a row, we stash the framed seed
  // direction here and open SpawnDialog. State is local — we don't need to
  // bubble back up through RightPanel because the spawn callback is already
  // plumbed in.
  const [spawnFixDirection, setSpawnFixDirection] = useState<string | null>(null);
  // D5 — clicking a finding opens ONE shared FileViewerModal (portal'd) at the
  // finding's line. Lifted here so every row shares a single modal instance.
  const cwd = job.config.workingDirectory;
  const [viewerTarget, setViewerTarget] = useState<{ path: string; startLine: number } | null>(null);
  // Findings carry repo-relative paths; the file-content endpoint resolves a
  // relative path against the SERVER cwd, so anchor it to the workflow cwd
  // (leave already-absolute paths untouched).
  const openFinding = (f: Finding) => {
    const abs = f.file.startsWith('/') ? f.file : `${cwd.replace(/\/$/, '')}/${f.file}`;
    setViewerTarget({ path: abs, startLine: f.line });
  };
  if (reviews.length === 0) {
    return (
      <EmptyState text="No reviews yet. Use the ✎ REVIEW button near the composer to run a reviewer over the last turn." />
    );
  }
  return (
    <div style={{ overflowY: 'auto', flex: 1 }}>
      {reviews.map((r) => (
        <ReviewRow
          key={r.reviewId}
          review={r}
          cwd={cwd}
          workflowId={job.id}
          open={expanded === r.reviewId}
          onToggle={() => setExpanded(expanded === r.reviewId ? null : r.reviewId)}
          onCancel={onCancelReview ? () => onCancelReview(r.reviewId) : undefined}
          onSpawnToFix={onSpawn ? (direction) => setSpawnFixDirection(direction) : undefined}
          onOpenFinding={openFinding}
          onSend={onSend}
        />
      ))}
      {viewerTarget && (
        <FileViewerModal
          path={viewerTarget.path}
          startLine={viewerTarget.startLine}
          onClose={() => setViewerTarget(null)}
          fallback={{ cwd, workflowId: job.id }}
        />
      )}
      {spawnFixDirection !== null && onSpawn && (
        <SpawnDialog
          parentConfig={job.config}
          parentPlanTitle={null}
          initialDirection={spawnFixDirection}
          onConfirm={(newConfig, newDirection, includePlan) => {
            setSpawnFixDirection(null);
            onSpawn(newConfig, newDirection, includePlan);
          }}
          onCancel={() => setSpawnFixDirection(null)}
        />
      )}
    </div>
  );
}

function ReviewRow({
  review,
  cwd,
  workflowId,
  open,
  onToggle,
  onCancel,
  onSpawnToFix,
  onOpenFinding,
  onSend,
}: {
  review: ReviewEntry;
  cwd: string;
  workflowId: string;
  open: boolean;
  onToggle: () => void;
  onCancel?: () => void;
  onSpawnToFix?: (direction: string) => void;
  onOpenFinding: (f: Finding) => void;
  onSend?: (content: string, attachments?: string[], kind?: 'steer' | 'follow-up' | 'interrupt', primitive?: 'docs' | 'git') => void;
}) {
  const [body, setBody] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const done = Boolean(review.completedAt);
  const inFlight = !done && !review.error;
  // D5 — structured findings parsed from the (lazily-fetched) body. Tolerant:
  // [] when the reviewer emitted no block / a malformed one — the prose <pre>
  // below still renders unconditionally.
  const findings = useMemo(() => (body ? parseReviewFindings(body) : []), [body]);

  useEffect(() => {
    if (!open || body !== null || !review.artifactName || !cwd) return;
    let cancelled = false;
    const q = new URLSearchParams({ path: cwd, workflowId, name: review.artifactName });
    fetch(`/api/workflows/artifact?${q.toString()}`)
      .then((r) => r.ok ? r.json() as Promise<{ contents: string }> : Promise.reject(r.statusText))
      .then((d) => { if (!cancelled) setBody(d.contents); })
      .catch((err) => { if (!cancelled) setLoadError(String(err)); });
    return () => { cancelled = true; };
  }, [open, review.artifactName, cwd, workflowId, body]);

  const verdictColor = review.verdict === 'BLOCKING'
    ? 'var(--color-warning)'
    : review.verdict === 'MINOR'
      ? 'var(--color-accent-secondary)'
      : review.verdict === 'PASS'
        ? 'var(--color-accent-primary)'
        : 'var(--color-fg-muted)';

  return (
    <div style={{ borderBottom: '1px solid var(--color-accent-primary-a05)' }}>
      <button
        onClick={onToggle}
        className="display-font"
        style={{
          width: '100%',
          padding: '8px 14px',
          background: open ? 'var(--color-accent-primary-a08)' : 'transparent',
          border: 'none',
          color: 'var(--color-fg-muted)',
          cursor: 'pointer',
          fontSize: '10px',
          letterSpacing: '1px',
          textAlign: 'left',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
        }}
      >
        <span style={{ color: verdictColor, minWidth: '56px' }}>
          {review.verdict ?? (inFlight ? 'RUN…' : review.error ? 'ERROR' : '—')}
        </span>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {review.reviewer.provider.toUpperCase()} / {String(review.reviewer.model)} @ {review.reviewer.effort}
        </span>
        <span style={{ opacity: 0.6 }}>{new Date(review.startedAt).toLocaleTimeString()}</span>
        <span style={{ opacity: 0.6 }}>{open ? '▼' : '▶'}</span>
      </button>
      {open && (
        <div style={{ padding: '10px 14px 16px', background: 'var(--color-bg-sunken)' }}>
          {review.error && (
            <div style={{ color: 'var(--color-warning)', fontSize: '11px', marginBottom: '8px' }}>
              Review failed: {review.error}
            </div>
          )}
          {inFlight && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <div className="display-font" style={{ color: 'var(--color-fg-muted)', fontSize: '10px', letterSpacing: '1px' }}>
                Reviewer running… streams on completion.
              </div>
              {onCancel && (
                <button
                  onClick={(e) => { e.stopPropagation(); onCancel(); }}
                  className="display-font"
                  style={{
                    padding: '4px 10px',
                    background: 'transparent',
                    border: '1px solid var(--color-warning)',
                    color: 'var(--color-warning)',
                    cursor: 'pointer',
                    fontSize: '10px',
                    letterSpacing: '1px',
                  }}
                  title="Kill the reviewer subprocess"
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
                style={{
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  fontSize: '12px',
                  fontFamily: 'var(--font-body)',
                  color: 'var(--color-accent-primary)',
                  margin: 0,
                }}
              >
                {body}
              </pre>
              {findings.length > 0 && (
                <FindingsList
                  findings={findings}
                  onOpen={onOpenFinding}
                  onFix={onSend ? (f) => onSend(buildFixFollowUp(f), undefined, 'follow-up') : undefined}
                />
              )}
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                <SendReviewToAgent
                  workflowId={workflowId}
                  review={review}
                  body={body}
                />
                {onSpawnToFix && (
                  <SpawnReviewFix
                    review={review}
                    body={body}
                    onSpawn={onSpawnToFix}
                  />
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// Pre-fills the composer with a formatted "please address this review" message
// so the operator can hit Enter to send, or edit before sending. Strips the
// YAML frontmatter from the body — the primary agent doesn't need the metadata.
function SendReviewToAgent({
  workflowId,
  review,
  body,
}: {
  workflowId: string;
  review: ReviewEntry;
  body: string;
}) {
  const setDraft = useAppStore((s) => s.setDraft);
  const [sent, setSent] = useState(false);

  const onClick = () => {
    // Strip leading YAML frontmatter block between `---` fences.
    const stripped = body.replace(/^---\n[\s\S]*?\n---\n+/, '').trim();
    const reviewerLabel = `${review.reviewer.provider}/${String(review.reviewer.model)}@${review.reviewer.effort}`;
    const verdictLine = review.verdict
      ? `Their verdict: **${review.verdict}**.`
      : 'Their assessment is below.';
    const message = [
      `Your previous turn was reviewed by ${reviewerLabel}. ${verdictLine}`,
      '',
      '```',
      stripped,
      '```',
      '',
      'Please address the concerns above.',
    ].join('\n');
    setDraft(workflowId, message);
    setSent(true);
    setTimeout(() => setSent(false), 1500);
  };

  return (
    <button
      onClick={onClick}
      className="display-font"
      style={{
        marginTop: '10px',
        padding: '6px 12px',
        background: 'transparent',
        border: '1px solid var(--color-accent-primary-dim)',
        color: 'var(--color-accent-primary)',
        cursor: 'pointer',
        fontSize: '10px',
        letterSpacing: '1.5px',
      }}
      title="Pre-fill the composer with this review so the primary agent can address the concerns"
    >
      {sent ? '✓ LOADED INTO COMPOSER' : '↳ SEND TO AGENT'}
    </button>
  );
}

// Frames a review verdict as spawn-seed direction. The fresh worker doesn't
// share the parent's context, so the seed has to make the review legible on
// its own — reviewer identity, verdict, and the body verbatim. Trailing
// instruction tells them to re-verify after fixing so the operator can run
// VERIFY WORK against the same plan again without re-explaining the loop.
function reviewFixSpawnDirection(reviewerLabel: string, verdict: string | undefined, body: string): string {
  const verdictLine = verdict ? `Their verdict was **${verdict}**.` : 'Their assessment is below.';
  return (
    `A previous worker's output was reviewed by ${reviewerLabel}. ${verdictLine} ` +
    `Your job is to address every concern raised in the review against the actual code in the tree, ` +
    `then summarize what you changed so the operator can re-verify.\n\n` +
    `Review:\n\n${body}`
  );
}

function SpawnReviewFix({
  review,
  body,
  onSpawn,
}: {
  review: ReviewEntry;
  body: string;
  onSpawn: (direction: string) => void;
}) {
  const onClick = () => {
    const stripped = body.replace(/^---\n[\s\S]*?\n---\n+/, '').trim();
    const reviewerLabel = `${review.reviewer.provider}/${String(review.reviewer.model)}@${review.reviewer.effort}`;
    onSpawn(reviewFixSpawnDirection(reviewerLabel, review.verdict, stripped));
  };
  return (
    <button
      onClick={onClick}
      className="display-font"
      style={{
        marginTop: '10px',
        padding: '6px 12px',
        background: 'transparent',
        border: '1px solid var(--color-accent-primary-dim)',
        color: 'var(--color-accent-primary)',
        cursor: 'pointer',
        fontSize: '10px',
        letterSpacing: '1.5px',
      }}
      title="Open SpawnDialog with this review as direction so a fresh worker (any provider) can address the concerns"
    >
      ⤴ SPAWN TO FIX
    </button>
  );
}

// D5 — per-severity color for the finding chip. Reuses the verdict palette so
// the Review tab reads consistently (error≈BLOCKING, warning≈MINOR, info≈PASS).
function severityColor(s: Finding['severity']): string {
  return s === 'error'
    ? 'var(--color-warning)'
    : s === 'warning'
      ? 'var(--color-accent-secondary)'
      : 'var(--color-accent-primary)';
}

// Scoped follow-up prompt for a single finding. Operator-click-only (the Fix
// button) → dispatched via the composer's existing kind:'follow-up' send path,
// never auto-sent. Anchors the agent to the file:line + the reviewer's note.
function buildFixFollowUp(f: Finding): string {
  return [
    `A reviewer flagged a ${f.severity} at \`${f.file}:${f.line}\`:`,
    '',
    `> ${f.note}`,
    '',
    'Please look at that location and address the concern (or explain why it is a non-issue).',
  ].join('\n');
}

// Renders the parsed findings as a clickable list: the row opens the file at
// the finding's line; the Fix button seeds a scoped follow-up turn.
function FindingsList({
  findings,
  onOpen,
  onFix,
}: {
  findings: Finding[];
  onOpen: (f: Finding) => void;
  onFix?: (f: Finding) => void;
}) {
  return (
    <div style={{ marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <div
        className="display-font"
        style={{ fontSize: '10px', letterSpacing: '1.5px', color: 'var(--color-fg-muted)', marginBottom: '2px' }}
      >
        FINDINGS ({findings.length})
      </div>
      {findings.map((f, i) => (
        <div
          key={i}
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: '8px',
            padding: '6px 8px',
            background: 'var(--color-bg)',
            border: '1px solid var(--color-accent-primary-a05)',
            borderRadius: '3px',
          }}
        >
          <button
            onClick={() => onOpen(f)}
            title={`Open ${f.file}:${f.line}`}
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              color: 'var(--color-accent-primary)',
              cursor: 'pointer',
              textAlign: 'left',
              fontSize: '11px',
              fontFamily: 'var(--font-body)',
              padding: 0,
            }}
          >
            <span
              className="display-font"
              style={{ color: severityColor(f.severity), fontSize: '9px', letterSpacing: '1px', marginRight: '6px' }}
            >
              {f.severity.toUpperCase()}
            </span>
            <span style={{ textDecoration: 'underline', textUnderlineOffset: '2px' }}>
              {f.file}:{f.line}
            </span>
            <div style={{ color: 'var(--color-fg-muted)', marginTop: '2px' }}>{f.note}</div>
          </button>
          {onFix && (
            <button
              onClick={(e) => { e.stopPropagation(); onFix(f); }}
              className="display-font"
              title="Send a scoped follow-up turn asking the agent to address this finding"
              style={{
                flexShrink: 0,
                padding: '3px 8px',
                background: 'transparent',
                border: '1px solid var(--color-accent-primary-dim)',
                color: 'var(--color-accent-primary)',
                cursor: 'pointer',
                fontSize: '9px',
                letterSpacing: '1px',
              }}
            >
              FIX
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
