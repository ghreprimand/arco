// Cluster member picker — small modal listing cluster members. Used by
// the cluster PLAN tab's REVIEW/VERIFY PLAN and REVIEW/VERIFY PHASE
// surfaces, which need a target worker to anchor the review against
// (the cluster plan body itself isn't backed by a transcript or a single
// member's git history, so the operator picks "which member's plan +
// transcript should the reviewer cross-check").
//
// Each row shows displayName + status + role chip (same chip style as
// MemberCard's role pill). Click commits the picker; Esc / backdrop
// click cancels.

import { useEffect } from 'react';
import { presetForText } from '@arco/shared';
import type { ClusterStatePayload, ClusterMember } from '@arco/shared';

interface Props {
  cluster: ClusterStatePayload;
  // Operator-readable prompt shown above the member list. Distinguishes
  // REVIEW from VERIFY contexts at the picker step so the operator can
  // bail out if they clicked the wrong pill.
  title: string;
  subtitle?: string;
  onPick: (member: ClusterMember) => void;
  onCancel: () => void;
}

function roleChipLabel(role: string | undefined): string | null {
  if (!role || !role.trim()) return null;
  const preset = presetForText(role);
  return preset ? preset.label : 'CUSTOM';
}

export function ClusterMemberPicker({ cluster, title, subtitle, onPick, onCancel }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div
      onClick={onCancel}
      data-help="cluster.plan-tab.member-picker"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        zIndex: 60,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--color-bg-panel)',
          border: '1px solid var(--color-accent-primary-dim)',
          borderRadius: '6px',
          padding: '18px 22px',
          width: 'min(480px, 94vw)',
          maxHeight: '88vh',
          overflowY: 'auto',
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
          {title.toUpperCase()}
        </div>
        {subtitle && (
          <div
            style={{
              fontSize: '11px',
              color: 'var(--color-fg-muted)',
              marginBottom: '14px',
              lineHeight: 1.4,
            }}
          >
            {subtitle}
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {cluster.members.length === 0 && (
            <div style={{ fontSize: '11px', color: 'var(--color-fg-muted)', fontStyle: 'italic' }}>
              No members in this cluster.
            </div>
          )}
          {cluster.members.map((m) => {
            const chip = roleChipLabel(m.role);
            return (
              <button
                key={m.workflowId}
                onClick={() => onPick(m)}
                className="display-font"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  textAlign: 'left',
                  padding: '8px 10px',
                  background: 'transparent',
                  border: '1px solid var(--color-border-hairline)',
                  borderRadius: '3px',
                  color: 'var(--color-fg)',
                  cursor: 'pointer',
                  fontSize: '11px',
                  letterSpacing: '0.5px',
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background = 'var(--color-accent-primary-a06)';
                  (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--color-accent-primary)';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
                  (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--color-border-hairline)';
                }}
              >
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {m.displayName}
                </span>
                <span
                  style={{
                    color: m.status === 'busy' ? 'var(--color-warning)' : 'var(--color-accent-primary)',
                    fontSize: '9px',
                    letterSpacing: '1px',
                  }}
                >
                  {m.status.toUpperCase()}
                </span>
                {chip && (
                  <span
                    style={{
                      padding: '1px 6px',
                      border: '1px solid var(--color-accent-secondary-dim)',
                      color: 'var(--color-accent-secondary-dim)',
                      fontSize: '9px',
                      letterSpacing: '1px',
                    }}
                    title={m.role}
                  >
                    {chip}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '14px' }}>
          <button
            type="button"
            onClick={onCancel}
            className="display-font"
            style={{
              padding: '6px 12px',
              background: 'transparent',
              border: '1px solid var(--color-border-hairline)',
              borderRadius: '3px',
              color: 'var(--color-fg-muted)',
              cursor: 'pointer',
              fontSize: '10px',
              letterSpacing: '1px',
            }}
          >
            CANCEL
          </button>
        </div>
      </div>
    </div>
  );
}
