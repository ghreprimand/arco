import { useEffect, useRef, useState } from 'react';
import { useAppStore, type JobState } from '../stores/appStore';
import { hasGuardrails, insertGuardrails, type PlanFull } from '@arco/shared';
import { PublicProjectBox } from './PublicProjectBox';
import { rememberPublicChoice, usePublicProject } from '../utils/publicProject';
import { beginPlanRefine } from './terminalInput/planDraft';

interface Props {
  job: JobState;
  onAttachPlan?: (planId: string) => void;
  // Operator-only shortcut visible when the active workflow is a cluster
  // member: routes the body to the cluster's shared PLAN. The server creates
  // or updates the canonical per-cwd plan automatically.
  onAttachToCluster?: (body: string) => Promise<void> | void;
  // Sends a plan-review turn to this tab's agent; enables REFINE.
  onSend?: (content: string, attachments?: string[], kind?: 'steer' | 'follow-up' | 'interrupt', primitive?: 'docs' | 'git' | 'plan-review') => boolean | void;
}

// Sits between the chat panel and the composer. Shows up when
// `job.planCandidate` is set — that fires after a PLAN-button-armed turn
// completes and useWebSocket snapshots the assistant's reply. Behaviour:
//   - mode 'review'   → SAVE & ATTACH / DISCARD buttons
//   - mode 'autosave' → fires the save itself on mount, briefly shows a
//                       "saved" status then dismisses
export function PlanCandidateBanner({ job, onAttachPlan, onAttachToCluster, onSend }: Props) {
  const candidate = job.planCandidate;
  const setPlanCandidate = useAppStore((s) => s.setPlanCandidate);
  const cwd = job.config.workingDirectory;
  const { checked: publicProject } = usePublicProject(candidate ? cwd ?? '' : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedTitle, setSavedTitle] = useState<string | null>(null);
  const autosaveFiredRef = useRef(false);
  const [refining, setRefining] = useState(false);
  const [note, setNote] = useState('');
  const pushNotification = useAppStore((s) => s.pushNotification);
  const revising = job.pendingPlanCapture === 'review';

  // Pulled out of the JSX because the autosave path calls it via useEffect
  // before any click can. Returns the created PlanFull or throws.
  const persist = async (): Promise<PlanFull> => {
    if (!cwd || !candidate) throw new Error('no candidate / cwd');
    await rememberPublicChoice(cwd);
    const title = extractPlanTitle(candidate.body);
    const res = await fetch(`/api/plans?path=${encodeURIComponent(cwd)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body: candidate.body }),
    });
    if (!res.ok) throw new Error(await res.text() || `HTTP ${res.status}`);
    const d = (await res.json()) as { plan: PlanFull };
    return d.plan;
  };

  // Autosave path: fire-and-forget on first render of an autosave candidate.
  useEffect(() => {
    if (!candidate || candidate.mode !== 'autosave') return;
    if (autosaveFiredRef.current) return;
    autosaveFiredRef.current = true;
    (async () => {
      setSaving(true);
      try {
        const plan = await persist();
        onAttachPlan?.(plan.id);
        setSavedTitle(plan.title);
        setTimeout(() => setPlanCandidate(job.id, null), 2500);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSaving(false);
      }
    })();
    // candidate.body / id won't change for an autosave entry — fire once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidate?.mode]);

  if (!candidate) return null;

  if (savedTitle) {
    return (
      <div style={bannerStyle}>
        <span className="display-font" style={{ color: 'var(--color-accent-primary)', fontSize: '10px', letterSpacing: '1.5px' }}>
          ✓ PLAN SAVED
        </span>
        <span style={{ color: 'var(--color-fg-muted)', fontSize: '11px', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {savedTitle}
        </span>
      </div>
    );
  }

  if (candidate.mode === 'autosave') {
    return (
      <div style={bannerStyle}>
        <span className="display-font" style={{ color: 'var(--color-accent-secondary-dim)', fontSize: '10px', letterSpacing: '1.5px' }}>
          {error ? '✗ PLAN SAVE FAILED' : 'SAVING PLAN…'}
        </span>
        {error && <span style={{ color: 'var(--color-warning)', fontSize: '10px' }}>{error}</span>}
      </div>
    );
  }

  // Review mode: the operator saves, refines or discards the draft. In a
  // cluster tab the only save target is the cluster plan.
  const submitRefine = async () => {
    if (!onSend) return;
    let selected: boolean;
    try { selected = await rememberPublicChoice(cwd ?? ''); }
    catch { setError('Could not save the public-project choice. Try again.'); return; }
    if (beginPlanRefine(job.id, (content) => onSend(content, undefined, undefined, 'plan-review'), note, Boolean(onAttachToCluster), selected)) {
      setRefining(false);
      setNote('');
      setError(null);
    } else {
      pushNotification('error', 'Wait for the current turn to finish, and enter a note, before refining the plan draft.');
    }
  };
  const afterSave = (title: string) => {
    setSavedTitle(title);
    setTimeout(() => setPlanCandidate(job.id, null), 2500);
  };
  const busy = saving || revising;
  return (
    <div>
      <div style={bannerStyle}>
        <span className="display-font" style={{ color: 'var(--color-accent-secondary)', fontSize: '10px', letterSpacing: '1.5px' }}>
          {revising ? 'REVISING PLAN DRAFT...' : 'PLAN DRAFT READY'}
        </span>
        <span style={{ color: 'var(--color-fg-muted)', fontSize: '10px', flex: 1 }}>
          {candidate.body.length} chars · {extractPlanTitle(candidate.body)}
        </span>
        {error && <span style={{ color: 'var(--color-warning)', fontSize: '10px' }}>{error}</span>}
        {onAttachToCluster ? (
          <button
            data-help="cluster.plan-tab.attach-from-banner"
            disabled={busy}
            onClick={async () => {
              setSaving(true);
              setError(null);
              try {
                await rememberPublicChoice(cwd ?? '');
                await onAttachToCluster(candidate.body);
                afterSave(extractPlanTitle(candidate.body));
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              } finally {
                setSaving(false);
              }
            }}
            className="display-font"
            style={primaryBtn}
          >
            {saving ? 'SAVING…' : 'ATTACH TO CLUSTER'}
          </button>
        ) : (
          <button
            disabled={busy}
            onClick={async () => {
              setSaving(true);
              setError(null);
              try {
                const plan = await persist();
                onAttachPlan?.(plan.id);
                afterSave(plan.title);
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              } finally {
                setSaving(false);
              }
            }}
            className="display-font"
            style={primaryBtn}
          >
            {saving ? 'SAVING…' : 'SAVE & ATTACH'}
          </button>
        )}
        {onSend && (
          <button
            data-help="composer.plan-refine"
            disabled={busy}
            onClick={() => setRefining((v) => !v)}
            className="display-font"
            style={ghostBtn}
          >
            REFINE
          </button>
        )}
        <button
          disabled={busy}
          onClick={() => setPlanCandidate(job.id, null)}
          className="display-font"
          style={ghostBtn}
        >
          DISCARD
        </button>
      </div>
      <div style={{ ...bannerStyle, borderTop: 'none' }}>
        <PublicProjectBox cwd={cwd ?? ''} testId="plan-banner-public-project" />
        {publicProject && !hasGuardrails(candidate.body) && (
          <button type="button" data-testid="plan-banner-insert-guardrails" data-help="plan.insert-guardrails" disabled={busy} className="display-font" style={ghostBtn}
            onClick={() => setPlanCandidate(job.id, { ...candidate, body: insertGuardrails(candidate.body) })}>
            INSERT GUARDRAILS
          </button>
        )}
      </div>
      {refining && !revising && (
        <div style={{ ...bannerStyle, borderTop: 'none' }}>
          <input
            data-help="composer.plan-refine-note"
            autoFocus
            value={note}
            maxLength={2000}
            placeholder="What should change in this draft?"
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && note.trim()) submitRefine();
              if (e.key === 'Escape') setRefining(false);
            }}
            style={{ flex: 1, minWidth: 0, background: 'transparent', border: '1px solid var(--color-border-hairline)', color: 'var(--color-fg-primary)', padding: '4px 8px', fontSize: '11px', fontFamily: 'var(--font-body)' }}
          />
          <button disabled={!note.trim()} onClick={submitRefine} className="display-font" style={primaryBtn}>SEND</button>
          <button onClick={() => setRefining(false)} className="display-font" style={ghostBtn}>CANCEL</button>
        </div>
      )}
    </div>
  );
}

// Three-step fallback: H1 heading, else first non-empty line, else date stamp.
function extractPlanTitle(body: string): string {
  const h1 = body.match(/^\s*#\s+(.+?)\s*$/m);
  if (h1) return h1[1].trim().slice(0, 80);
  const lines = body.split('\n');
  for (const l of lines) {
    const t = l.trim();
    if (t.length > 0) return t.slice(0, 80);
  }
  return `Plan from ${new Date().toLocaleDateString()}`;
}

const bannerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '10px',
  padding: '6px 12px',
  borderTop: '1px solid var(--color-accent-primary-a08)',
  borderBottom: '1px solid var(--color-accent-primary-a08)',
  background: 'var(--color-bg-sunken)',
  fontFamily: 'var(--font-body)',
  flexShrink: 0,
};

const primaryBtn: React.CSSProperties = {
  padding: '4px 12px',
  background: 'transparent',
  border: '1px solid var(--color-accent-primary)',
  color: 'var(--color-accent-primary)',
  cursor: 'pointer',
  fontSize: '10px',
  letterSpacing: '1.5px',
};

const ghostBtn: React.CSSProperties = {
  padding: '4px 10px',
  background: 'transparent',
  border: '1px solid var(--color-border-hairline)',
  color: 'var(--color-fg-muted)',
  cursor: 'pointer',
  fontSize: '10px',
  letterSpacing: '1.5px',
};
