import type { JobState } from '../stores/appStore';

interface Props {
  job: JobState;
  onConfirm: (mode: 'review' | 'autosave') => void;
  onCancel: () => void;
  // When the host workflow is a cluster member the dialog shows an inline
  // note explaining that AUTOSAVE silently routes through the
  // PlanCandidateBanner (review-mode) so the operator can pick between
  // attaching to the worker vs the cluster's shared PLAN. The override is
  // applied in the caller (TerminalInput) — this flag only affects copy.
  isClusterMember?: boolean;
}

// Composer-button sibling for REVIEW / HANDOFF / SPAWN. Two paths to capture
// the conversation as a project plan, both injecting the same synthesize-
// from-context prompt — the choice is just whether the operator wants a
// confirmation step ("review") or no-click save ("autosave"). The actual
// capture happens in useWebSocket on the next primary_complete; this dialog
// only triggers the prompt and arms the flag.
export function PlanComposerDialog({ job, onConfirm, onCancel, isClusterMember }: Props) {
  const hasExistingPlan = Boolean(job.plan);
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        zIndex: 50,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--color-bg-panel)',
          border: '1px solid var(--color-accent-primary-dim)',
          borderRadius: '6px',
          padding: '18px 22px',
          width: 'min(460px, calc(92vw / var(--ui-scale, 1)))',
          fontFamily: 'var(--font-body)',
        }}
      >
        <div
          className="display-font"
          style={{
            fontSize: '12px',
            letterSpacing: '3px',
            color: 'var(--color-accent-primary)',
            marginBottom: '6px',
          }}
        >
          DRAFT PROJECT PLAN
        </div>
        <div
          style={{
            fontSize: '11px',
            color: 'var(--color-fg-muted)',
            lineHeight: 1.5,
            marginBottom: '14px',
          }}
        >
          Asks the agent to synthesize this conversation into a project plan,
          then captures the reply as a new plan and attaches it to this workflow.
          {hasExistingPlan && (
            <span style={{ color: 'var(--color-warning)', display: 'block', marginTop: '6px' }}>
              A plan is already attached — saving will replace it.
            </span>
          )}
          {isClusterMember && (
            <span
              data-help="composer.plan-cluster-member"
              style={{ color: 'var(--color-accent-secondary-dim)', display: 'block', marginTop: '6px' }}
            >
              This workflow is in a cluster — AUTOSAVE routes through the
              choice banner so you can pick between attaching to the worker
              or the cluster's shared PLAN.
            </span>
          )}
        </div>

        <button
          onClick={() => onConfirm('review')}
          data-help="plan.draft-review"
          className="display-font"
          style={primaryBtn}
          title="Inject the prompt; you'll see the agent's draft and click to save"
        >
          DRAFT → I'LL REVIEW
          <span style={hint}>see the draft, then click Save & Attach</span>
        </button>

        <button
          onClick={() => onConfirm('autosave')}
          data-help="plan.draft-autosave"
          className="display-font"
          style={secondaryBtn}
          title="Inject the prompt; auto-save the agent's reply with no review step"
        >
          DRAFT &amp; AUTO-SAVE
          <span style={hint}>save the reply immediately, no confirmation</span>
        </button>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '14px' }}>
          <button onClick={onCancel} className="display-font" style={cancelBtn}>
            CANCEL
          </button>
        </div>
      </div>
    </div>
  );
}

const primaryBtn: React.CSSProperties = {
  display: 'block',
  width: '100%',
  padding: '12px 14px',
  marginBottom: '8px',
  background: 'transparent',
  border: '1px solid var(--color-accent-primary)',
  color: 'var(--color-accent-primary)',
  cursor: 'pointer',
  fontSize: '11px',
  letterSpacing: '1.5px',
  textAlign: 'left',
  fontFamily: 'var(--font-display)',
};

const secondaryBtn: React.CSSProperties = {
  ...primaryBtn,
  border: '1px solid var(--color-border-hairline)',
  color: 'var(--color-accent-secondary-dim)',
};

const cancelBtn: React.CSSProperties = {
  padding: '6px 14px',
  background: 'transparent',
  border: '1px solid var(--color-border-hairline)',
  color: 'var(--color-fg-muted)',
  cursor: 'pointer',
  fontSize: '10px',
  letterSpacing: '1.5px',
  fontFamily: 'var(--font-display)',
};

const hint: React.CSSProperties = {
  display: 'block',
  fontSize: '9px',
  letterSpacing: '0.5px',
  color: 'var(--color-fg-muted)',
  marginTop: '4px',
  textTransform: 'none',
  fontFamily: 'var(--font-body)',
};
