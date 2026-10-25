// CLUSTER_MODE_PLAN.md Phase 2 — one cluster member's chat + composer.
//
// Wraps the existing ChatPanel + TerminalInput so per-member rendering reuses
// every transcript invariant (handoff/spawn pill collapse, Claude JSONL
// merge, queued-message dedup).
//
// Slice 6a — the per-tab primitive bar (REVIEW / HANDOFF / SPAWN / PLAN
// MODE / DOCS / GIT / RECALIBRATE / UPDATE-PRIMARY) IS now rendered in
// MemberPane, threaded through from App.tsx → ClusterTab → here so primitives
// stay reachable after the TabBar restructure hides member tabs from the top
// row. Behavior is unchanged from standalone-workflow primitives —
// HANDOFF still does what HANDOFF does, SPAWN still creates a standalone
// workflow (incorrect for cluster intent but reachable). Cluster-aware
// primitive behavior (SPAWN-into-this-cluster, HANDOFF preserves
// membership, REVIEW understands peer rows) is captured in
// docs/CLUSTER_MODE_PLAN.md §7.5 (master refactor row 6b).

import { ChatPanel } from './ChatPanel';
import { TerminalInput } from './TerminalInput';
import { RuntimeStateBanner } from './RuntimeStateBanner';
import { NorthStarBar } from './NorthStarBar';
import { AccountBadge, accountBadgeForJob } from './TabBar';
import { useAppStore } from '../stores/appStore';
import type { JobState } from '../stores/appStore';
import type { ProviderName, ModelName, EffortLevel, WorkflowConfig, ReviewContextRef } from '@arco/shared';

interface Props {
  job: JobState;
  // Identity strip
  displayName: string;
  status: 'idle' | 'busy';
  // Slice 6a — focused-pane visual highlight. The bottom-row member tab
  // click sets clusterFocusedMember; we mirror the same id here so the
  // pane border/header brighten when the operator targets it.
  focused: boolean;
  // Wire these straight to the App.tsx-level helpers; the cluster tab plumbs
  // through the workflowId.
  onSend: (content: string, attachments?: string[], kind?: 'steer' | 'follow-up') => boolean | void;
  onCancel: () => void;
  onCancelQueued: (clientMessageId: string) => void;
  onUpload: (file: File) => Promise<{ fileId: string; filename: string; path: string } | null>;
  onLoadEarlier?: () => void;
  // Slice 6a — primitive callbacks threaded from App.tsx, all keyed on this
  // member's workflowId at the App level. Optional so the pane still works
  // if a future surface omits any of them.
  onReview?: (
    reviewer: { provider: ProviderName; model: ModelName; effort: EffortLevel },
    contextRef: ReviewContextRef,
    includeGitDiff: boolean,
  ) => void;
  onHandoff?: (
    mode: 'fresh-summarizer' | 'original-worker' | 'fresh-agent',
    newPrimary?: { provider: ProviderName; model: ModelName; effort: EffortLevel; providerAccountRef?: string },
    // WP2 — summarizer that writes the handoff (fresh-summarizer mode).
    summarizer?: { provider: ProviderName; model: ModelName; effort: EffortLevel },
  ) => void;
  onSpawn?: (newConfig: WorkflowConfig, newDirection: string, includePlan: boolean, joinClusterId?: string) => void;
  onCompact?: () => void;
  // Phase 2.5b — set when this pane is mounted inside a cluster tab. Drives
  // the SpawnDialog "Spawn into cluster" checkbox.
  clusterContext?: { clusterId: string; name: string };
  onRecalibrate?: () => void;
  onUpdatePrimary?: (update: { model?: ModelName; effort?: EffortLevel; goal?: string }) => void;
  onArmPlanMode?: () => void;
  onTranscriptSend?: (toWorkflowId: string, content: string) => void;
  onReviewViaMember?: (
    reviewerWorkflowId: string,
    contextRef: ReviewContextRef,
    includeGitDiff: boolean,
  ) => void;
}

export function MemberPane({
  job,
  displayName,
  status,
  focused,
  onSend,
  onCancel,
  onCancelQueued,
  onUpload,
  onLoadEarlier,
  onReview,
  onHandoff,
  onSpawn,
  onCompact,
  onRecalibrate,
  onUpdatePrimary,
  onArmPlanMode,
  clusterContext,
  onTranscriptSend,
  onReviewViaMember,
}: Props) {
  const settings = useAppStore((s) => s.settings);
  const accountBadge = accountBadgeForJob(job, settings);
  return (
    <div
      style={{
        flex: '1 1 0',
        minWidth: '320px',
        display: 'flex',
        flexDirection: 'column',
        // Slice 6a — focused pane gets a whole-pane accent outline so the
        // eye catches which member the bottom-row click targeted. Right-
        // border-only was too subtle in multi-pane layouts where one pane's
        // right edge sits flush against the next pane's left edge.
        border: focused
          ? '1px solid var(--color-accent-primary)'
          : '1px solid var(--color-border-hairline)',
        // Transparent so the ambient background shader (e.g. matrix rain)
        // shows through behind the transcript, matching the single-workflow
        // ChatPanel column. Message bubbles carry their own backgrounds, so
        // text stays legible; the rain only fills the gaps.
        background: 'transparent',
      }}
    >
      <div
        className="display-font"
        style={{
          padding: '8px 12px',
          borderBottom: '1px solid var(--color-border-hairline)',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          fontSize: '11px',
          letterSpacing: '1px',
          background: focused
            ? 'var(--color-accent-primary-a06)'
            : 'transparent',
        }}
      >
        {status === 'busy' && (
          <span
            style={{
              width: '6px',
              height: '6px',
              borderRadius: '50%',
              background: 'var(--color-accent-primary)',
              animation: 'pulse-glow 1.5s ease-in-out infinite',
            }}
          />
        )}
        <span
          style={{
            color: focused ? 'var(--color-accent-primary)' : 'var(--color-fg)',
            fontWeight: focused ? 600 : 400,
          }}
        >
          {displayName}
        </span>
        {accountBadge && <AccountBadge label={accountBadge} />}
        <span style={{ color: status === 'busy' ? 'var(--color-warning)' : 'var(--color-fg-muted)', fontSize: '10px' }}>
          {status.toUpperCase()}
        </span>
        <span style={{ marginLeft: 'auto', color: 'var(--color-fg-muted)', fontSize: '10px' }}>
          {job.config.name.toUpperCase()}
        </span>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <ChatPanel
          job={job}
          onCancelQueued={onCancelQueued}
          onLoadEarlier={onLoadEarlier}
          clusterContext={clusterContext}
        />
        <RuntimeStateBanner job={job} onCancel={onCancel} />
        <NorthStarBar job={job} onUpdatePrimary={onUpdatePrimary} />
        <TerminalInput
          job={job}
          onSend={(content, attachments, kind) => onSend(content, attachments, kind)}
          onCancel={onCancel}
          onCancelQueued={onCancelQueued}
          onUpload={onUpload}
          onReview={onReview}
          onHandoff={onHandoff}
          onSpawn={onSpawn}
          onCompact={onCompact}
          onRecalibrate={onRecalibrate}
          onUpdatePrimary={onUpdatePrimary}
          onArmPlanMode={onArmPlanMode}
          clusterContext={clusterContext}
          onTranscriptSend={onTranscriptSend}
          onReviewViaMember={onReviewViaMember}
        />
      </div>
    </div>
  );
}
