// 2026-06-29 — per-cluster progress-tracking selector. Lives in the
// ClusterRightPanel header chip bar next to EFFICIENCY. One operator-set knob
// with three modes (plan / board / both) picking which standing surface(s) the
// members are instructed to keep current as work advances. The server
// (clusterProgress.ts) owns the deterministic doctrine; this just picks the
// mode and ships it via cluster_progress_set. Takes effect on each member's
// NEXT turn.

import {
  CLUSTER_PROGRESS_MODES,
  CLUSTER_PROGRESS_LABELS,
  type ClusterProgressMode,
} from '@archon/shared';

export function ProgressControl({
  clusterId,
  mode,
  onSetProgress,
}: {
  clusterId: string;
  mode: ClusterProgressMode;
  onSetProgress: (clusterId: string, mode: ClusterProgressMode) => void;
}) {
  return (
    <>
      <span
        className="display-font"
        style={{ color: 'var(--color-fg-muted)', letterSpacing: '1px', marginLeft: '10px' }}
      >
        KEEP CURRENT
      </span>
      <div data-help="cluster.progress" style={{ display: 'flex', gap: '3px' }}>
        {CLUSTER_PROGRESS_MODES.map((m) => {
          const active = m === mode;
          return (
            <button
              key={m}
              onClick={() => onSetProgress(clusterId, m)}
              className="display-font"
              title={CLUSTER_PROGRESS_LABELS[m].blurb}
              style={{
                padding: '3px 8px',
                background: active ? 'var(--color-accent-primary-a06)' : 'transparent',
                border: '1px solid ' + (active ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'),
                color: active ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
                cursor: 'pointer',
                fontSize: '9px',
                letterSpacing: '1px',
              }}
            >
              {CLUSTER_PROGRESS_LABELS[m].label.toUpperCase()}
            </button>
          );
        })}
      </div>
    </>
  );
}
