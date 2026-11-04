import { useCompareStore, sendCompareVote, sendCompareSynthesize, sendCompareCancel } from '../../stores/compareStore';
import { CompareGrid } from './CompareGrid';
import { CompareVote } from './CompareVote';
import { useDraftStore } from '../../stores/draftStore';
import { useAppStore } from '../../stores/appStore';
import { recordPick } from '../../utils/secondOpinionTally';

// Compare overlay - docs/ARCHITECTURE.md
//
// Globally mounted (App.tsx), driven entirely off compareStore.active. Renders
// the side-by-side grid while the race runs/streams; once the race is done it
// exposes the per-pane vote affordance; once a winner is voted it reveals
// identities and shows the synthesize footer. Dismiss closes the overlay
// (cancel kills in-flight legs first). The dialog itself lives in TerminalInput
// (CompareDialog), so this overlay only owns the results surface.

export function CompareOverlay() {
  const active = useCompareStore((s) => s.active);
  const dismiss = useCompareStore((s) => s.dismiss);

  if (!active) return null;

  const replyDraft = active.purpose === 'reply-draft';
  const voted = active.winnerLegIndex >= 0;
  const canVote = active.raceDone && !voted;

  const onCancelAndClose = () => {
    if (!active.raceDone) sendCompareCancel(active.workflowId, active.compareId);
    dismiss();
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 55, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div
        style={{
          background: 'var(--color-bg-dialog)', border: '1px solid var(--color-accent-primary-dim)',
          borderRadius: '6px', padding: '16px 18px', width: 'min(1180px, calc(96vw / var(--ui-scale, 1)))', height: 'min(820px, calc(92vh / var(--ui-scale, 1)))',
          display: 'flex', flexDirection: 'column', fontFamily: 'var(--font-body)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
          <span className="display-font" style={{ fontSize: '12px', letterSpacing: '3px', color: 'var(--color-accent-primary)' }}>
            {replyDraft ? 'SECOND OPINION' : 'COMPARE'}
          </span>
          <span style={{ fontSize: '11px', color: 'var(--color-fg-muted)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={active.prompt}>
            {active.prompt}
          </span>
          {!active.raceDone && (
            <span className="display-font" style={{ fontSize: '10px', letterSpacing: '1px', color: 'var(--color-warning)' }}>{replyDraft ? 'DRAFTING…' : 'RACING…'}</span>
          )}
          {active.raceDone && !voted && (
            <span className="display-font" style={{ fontSize: '10px', letterSpacing: '1px', color: 'var(--color-accent-primary)' }}>{replyDraft ? 'PICK A DRAFT' : 'PICK A WINNER'}</span>
          )}
          <button
            onClick={onCancelAndClose}
            className="display-font"
            style={{ padding: '4px 10px', background: 'transparent', border: '1px solid var(--color-border-hairline)', borderRadius: '3px', color: 'var(--color-fg-muted)', cursor: 'pointer', fontSize: '10px', letterSpacing: '2px' }}
          >
            {active.raceDone ? 'CLOSE' : 'CANCEL'}
          </button>
        </div>

        <CompareGrid
          legs={active.legs}
          panes={active.panes}
          blind={active.blind}
          revealed={voted}
          winnerLegIndex={active.winnerLegIndex}
          canVote={canVote}
          replyDraft={replyDraft}
          onVote={(legIndex) => {
            // The operator's pick is also kept in a local per-model tally.
            if (active.legs[legIndex]) recordPick(active.legs[legIndex]);
            sendCompareVote(active.workflowId, active.compareId, legIndex);
          }}
          onUse={(paneIndex) => {
            const text = active.panes[paneIndex]?.text.trim();
            if (!text) return;
            const draft = useDraftStore.getState();
            // Replaces the composer text but keeps the old text available through the composer's UNDO.
            if (!draft.applyTidy(active.workflowId, draft.drafts[active.workflowId] ?? '', text)) draft.setDraft(active.workflowId, text);
            useAppStore.getState().setActiveJob(active.workflowId);
            dismiss();
          }}
        />

        {voted && (
          <CompareVote
            legs={active.legs}
            winnerLegIndex={active.winnerLegIndex}
            blind={active.blind}
            synthesizing={active.synthesizing}
            onSynthesize={(synthLeg) => sendCompareSynthesize(active.workflowId, active.compareId, synthLeg)}
          />
        )}
      </div>
    </div>
  );
}
