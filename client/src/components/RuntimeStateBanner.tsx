import { useEffect, useState } from 'react';
import { useAppStore, type JobState } from '../stores/appStore';
import { deriveWorkflowState, recoveryActionFor, type WorkflowRuntimeState } from '../runtime/runtimeState';

interface Props {
  job: JobState;
  // §C2 — workflow-scoped cancel, already bound to this job's id by the parent
  // (WorkflowView / MemberPane both pass their `onCancel`). The banner reuses
  // that exact path rather than reaching into the store: cancel is a WS message,
  // not a store mutation, so there is no store action to call.
  onCancel?: () => void;
}

// ARCHON_OPS_PLAN.md §C1/§C2 — sits between the chat panel and the composer
// (alongside PlanCandidateBanner). Surfaces ONLY the two genuinely-new
// per-workflow runtime states: `stuck` (busy but no primary content for
// ≥STUCK_THRESHOLD_MS while online) and `replay-recovered` (just rehydrated
// from disk). `busy`/`idle` are already conveyed by the existing composer
// spinner + state chrome, so we deliberately add no redundant indicator for
// them — duplicating chrome only adds noise.
//
// §C2 adds the ONE correct targeted recovery action per state (derived via the
// pure recoveryActionFor): stuck → CANCEL TURN (you can't wake a hung provider;
// cancel-and-resend is the honest recovery), replay-recovered → DISMISS (ack
// the informational notice early instead of waiting out the window).
//
// The deriver is pure (`now` injected); the impurity (reading the clock) stays
// here. A light 1s tick re-renders so the stuck pill's elapsed-seconds counts
// up and the replay-recovered badge auto-dismisses when its window elapses.
export function RuntimeStateBanner({ job, onCancel }: Props) {
  const connectionState = useAppStore((s) => s.connectionState);
  const clearRecovered = useAppStore((s) => s.clearRecovered);
  const [now, setNow] = useState(() => Date.now());

  const state: WorkflowRuntimeState = deriveWorkflowState({
    connection: connectionState,
    busy: job.busy === true,
    lastPrimaryEventAt: job.lastPrimaryEventAt ?? null,
    recoveredAt: job.recoveredAt ?? null,
    now,
  });
  const action = recoveryActionFor({ connection: connectionState, workflow: state });

  // Only tick while a transient state is actually showing — no background
  // timer churn when the workflow is plainly idle/busy.
  const ticking = state === 'stuck' || state === 'replay-recovered';
  useEffect(() => {
    if (!ticking) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [ticking]);

  if (state === 'stuck') {
    const anchor = job.lastPrimaryEventAt ?? job.recoveredAt ?? now;
    const silentSec = Math.max(0, Math.round((now - anchor) / 1000));
    return (
      <div
        role="status"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '4px 10px',
          fontSize: '11px',
          letterSpacing: '0.5px',
          color: 'var(--color-warning)',
          borderTop: '1px solid var(--color-warning-dim)',
          // color-mix keeps the fill keyed to the theme token — appending an
          // alpha suffix to a var() reference (…-dim)22 is invalid CSS and the
          // browser silently drops it.
          background: 'color-mix(in srgb, var(--color-warning) 12%, transparent)',
        }}
      >
        <span>⚠ no output for {silentSec}s — worker may be stuck</span>
        {action?.id === 'cancel-turn' && onCancel && (
          <button
            type="button"
            onClick={onCancel}
            data-help="runtime.cancel-turn"
            title={action.hint}
            style={pillButtonStyle('var(--color-warning)')}
          >
            {action.label}
          </button>
        )}
      </div>
    );
  }

  if (state === 'replay-recovered') {
    return (
      <div
        role="status"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '4px 10px',
          fontSize: '11px',
          letterSpacing: '0.5px',
          color: 'var(--color-accent-secondary)',
          borderTop: '1px solid var(--color-accent-secondary-dim)',
        }}
      >
        <span>↻ recovered from replay — context rehydrated from disk</span>
        {action?.id === 'dismiss-recovered' && (
          <button
            type="button"
            onClick={() => clearRecovered(job.id)}
            data-help="runtime.dismiss-recovered"
            title={action.hint}
            style={pillButtonStyle('var(--color-accent-secondary)')}
          >
            {action.label}
          </button>
        )}
      </div>
    );
  }

  return null;
}

// Small themed button matching the pill it sits in — tone passed by the caller
// (warning for cancel, accent-secondary for dismiss).
function pillButtonStyle(tone: string): React.CSSProperties {
  return {
    marginLeft: 'auto',
    background: 'transparent',
    border: `1px solid ${tone}`,
    borderRadius: '3px',
    color: tone,
    cursor: 'pointer',
    fontFamily: 'var(--font-display)',
    fontSize: '10px',
    letterSpacing: '1px',
    padding: '1px 8px',
  };
}
