// DD7 — cluster-scoped project-trust chip. Lives in the header chip bar next to
// MAIL ALERTS / AUTO-PICKUP / EFFICIENCY.
//
// A cluster pins all its members to one cwd, so trust is a cluster-wide fact —
// but the gate's one-shot prompt renders in a member tab's composer, and the
// cluster parent tab has no CONFIG tab to fall back on. Whichever member's turn
// hit the gate first consumed the prompt for every peer; if the operator was
// watching the cluster panel (the common case) they never saw it, and the only
// signal left was the per-turn "[PROJECT TRUST] … suppressed" notice. This chip
// is that missing surface.
//
// Hidden when the cwd ships none of the gated surfaces — the gate is a no-op
// there, so a chip would be pure noise.

import { useProjectTrust } from '../../hooks/useProjectTrust';

export function ProjectTrustChip({ cwd }: { cwd: string }) {
  const { snapshot, busy, setTrust } = useProjectTrust(cwd);
  const info = snapshot?.cwd;
  if (!info || info.resources.length === 0) return null;

  const trusted = info.status === 'always';
  const blocked = info.status === 'never';
  const label = trusted ? 'TRUSTED' : blocked ? 'BLOCKED' : 'ASK';
  const color = trusted
    ? 'var(--color-accent-primary)'
    : blocked
      ? 'var(--color-fg-muted)'
      : 'var(--color-accent-secondary)';

  return (
    <>
      <span
        className="display-font"
        data-help="cluster.project-trust"
        style={{ color: 'var(--color-fg-muted)', letterSpacing: '1px', marginLeft: '10px' }}
      >
        TRUST
      </span>
      <button
        className="display-font"
        data-help="cluster.project-trust"
        disabled={busy}
        // Trusted → clear (back to ask, re-arming the prompt); anything else →
        // grant. The write is keyed on the cluster's cwd, so it lands for every
        // member at once and clears any stale banner in their composers.
        onClick={() => { void setTrust(cwd, trusted ? 'clear' : 'always'); }}
        style={{
          padding: '3px 8px',
          background: trusted ? 'var(--color-accent-primary-a06)' : 'transparent',
          border: '1px solid ' + (trusted ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'),
          color,
          cursor: busy ? 'default' : 'pointer',
          fontSize: '9px',
          letterSpacing: '1px',
        }}
        title={
          trusted
            ? `Trusted — ${info.resources.join(', ')} folded into every member's turn. Click to revoke (back to ask).`
            : `Untrusted — ${info.resources.join(', ')} suppressed from every member's turn. Click to trust ${info.path} for all members. Takes effect next turn.`
        }
      >
        {label}
      </button>
    </>
  );
}
