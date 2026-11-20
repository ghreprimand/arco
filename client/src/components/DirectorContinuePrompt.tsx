// Continue the Director (docs/PROTOCOL_CLUSTER.md): one prompt above the
// Director's message box when an approved board task still needs a handoff,
// or when its handoff waits unread with an idle member that only NUDGE can
// wake. The server decides; this only shows the offer and sends the click.
import { useAppStore } from '../stores/appStore';
import { useDirectorContinueStore } from '../stores/directorContinueStore';

const buttonStyle = {
  padding: '3px 8px', border: '1px solid var(--color-border-hairline)', borderRadius: '3px',
  background: 'transparent', cursor: 'pointer', fontSize: '10px', whiteSpace: 'nowrap' as const, minHeight: '24px',
};

export function DirectorContinuePrompt({ workflowId }: { workflowId: string }) {
  const offer = useDirectorContinueStore((s) => s.offers[workflowId]);
  const notice = useDirectorContinueStore((s) => s.notices[workflowId]);
  const clearNotice = useDirectorContinueStore((s) => s.clearNotice);
  const wsSendRaw = useAppStore((s) => s.wsSendRaw);
  if (!offer && !notice) return null;
  const act = (action: 'continue' | 'dismiss') => {
    if (!offer || !wsSendRaw) return;
    wsSendRaw({ type: 'director_continue_action', workflowId, offerId: offer.id, action });
  };
  const title = offer ? `"${offer.taskTitle}"` : '';
  const text = !offer ? notice
    : offer.kind === 'continue'
      ? `${title} is approved and still needs an assignment.`
      : `${title} was handed to ${offer.memberName ?? 'a member'}, who is idle and has not read it. Use NUDGE to wake ${offer.memberName ?? 'that member'}.`;
  return (
    <div role="group" aria-label="Director handoff" data-help="cluster.director-continue" data-testid="director-continue"
      style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px', marginBottom: '6px', padding: '5px 8px', minWidth: 0,
        border: '1px solid var(--color-border-hairline)', borderLeft: '3px solid var(--color-warning)', background: 'var(--color-bg-inset)', fontSize: '12px', lineHeight: 1.4 }}>
      <span style={{ flex: '1 1 220px', minWidth: 0, overflowWrap: 'anywhere', color: 'var(--color-fg)' }}>{text}</span>
      {offer?.kind === 'continue' && (
        <button type="button" className="display-font" onClick={() => act('continue')}
          title="Start one Director turn to hand this task to its owner."
          // The theme's text colour, not its accent: some light themes give the
          // secondary accent almost no contrast against the inset background.
          style={{ ...buttonStyle, color: 'var(--color-fg)', borderColor: 'var(--color-accent-secondary)' }}>
          CONTINUE DIRECTOR
        </button>
      )}
      {offer ? (
        <button type="button" className="display-font" onClick={() => act('dismiss')}
          title="Close this offer. It does not come back for this approval."
          style={{ ...buttonStyle, color: 'var(--color-fg-muted)' }}>
          DISMISS
        </button>
      ) : (
        <button type="button" className="display-font" aria-label="Close notice" onClick={() => clearNotice(workflowId)}
          style={{ ...buttonStyle, color: 'var(--color-fg-muted)' }}>
          CLOSE
        </button>
      )}
    </div>
  );
}
