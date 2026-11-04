// Cluster tab composer controls: who the message goes to, and NUDGE.
// BRIEF's worker / whole-cluster choice lives in BriefControl.

export interface ClusterComposerControls {
  clusterId: string;
  // "BUILDER" for one member, "3 MEMBERS" for several, "EVERYONE" for all.
  recipientLabel: string;
  // Empty-composer placeholder naming who the message goes to.
  placeholder?: string;
  onChooseRecipients: () => void;
  pendingTotal: number;
  pendingMembers: number;
  // Members nudged that have not started their turn yet.
  nudgedCount?: number;
  onNudge: () => void;
}

export function ClusterComposerButtons({ controls }: { controls: ClusterComposerControls }) {
  const { recipientLabel, onChooseRecipients, pendingTotal, pendingMembers, nudgedCount = 0, onNudge } = controls;
  const nudgeLabel = pendingTotal > 0
    ? `NUDGE: ${pendingTotal} pending ${pendingTotal === 1 ? 'message' : 'messages'} across ${pendingMembers} ${pendingMembers === 1 ? 'member' : 'members'}`
    : 'NUDGE: no pending messages';
  const nudgedNote = nudgedCount > 0 ? `${nudgedCount} ${nudgedCount === 1 ? 'member was' : 'members were'} nudged and ${nudgedCount === 1 ? 'has' : 'have'} not started yet. ` : '';
  return (
    <>
      <button
        type="button"
        className="display-font"
        data-help="cluster.recipients"
        data-testid="composer-recipients"
        aria-label={`Send to ${recipientLabel}. Choose recipients.`}
        title="Who this message goes to. Click to choose one or several members."
        onClick={onChooseRecipients}
        style={{ padding: '7px 18px', background: 'transparent', border: '1px solid var(--color-border-hairline)', borderRadius: '3px', color: 'var(--color-accent-secondary)', cursor: 'pointer', fontSize: '12px', letterSpacing: '1.5px', fontWeight: 600, whiteSpace: 'nowrap' }}
      >
        TO: {recipientLabel} {'\u25BE'}
      </button>
      <button
        type="button"
        className="display-font"
        data-help="cluster.broadcast.nudge"
        data-testid="cluster-nudge"
        aria-label={`${nudgedNote}${nudgeLabel}`}
        title="Remind selected members to check their mail. Active members pick it up when able; idle members start a turn."
        onClick={onNudge}
        style={{
          padding: '7px 18px', fontSize: '12px', letterSpacing: '1.5px', fontWeight: 600, whiteSpace: 'nowrap', cursor: 'pointer', borderRadius: '3px',
          color: pendingTotal > 0 ? 'var(--color-warning)' : 'var(--color-accent-secondary)',
          background: pendingTotal > 0 ? 'var(--color-accent-primary-a12, var(--color-accent-primary-a06))' : 'transparent',
          border: pendingTotal > 0 ? '1px solid var(--color-warning)' : '1px solid var(--color-accent-secondary-dim, var(--color-accent-secondary))',
        }}
      >
        {nudgedCount > 0 ? `NUDGED ${nudgedCount}` : `NUDGE${pendingTotal > 0 ? ` ${pendingTotal}` : ''}`}
      </button>
    </>
  );
}
