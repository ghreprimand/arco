// ── Reviews ──

import type { EffortLevel, ModelName, ProviderName } from './providers.js';

// Phase 5 Lite — operator-triggered review. The server spawns a short-lived
// reviewer worker (read-only tools) over an events.jsonl-derived context
// slice; output is persisted as an artifact and surfaced in the Review tab.

// Operator-selectable scope for what the reviewer actually sees. Tagged
// union so new scopes can be added without changing existing cases.
//  - last-turn        → just the most recent operator prompt + primary reply
//  - last-n           → the N most recent completed turns
//  - current-session  → every turn since the most recent handoff seed (or
//                       from the very beginning if no handoff happened)
//  - full             → every completed turn in events.jsonl
//  - git-diff         → reviewer sees `git diff HEAD` only, no transcript
export type ReviewContextRef =
  | { kind: 'last-turn' }
  | { kind: 'last-n'; n: number }
  | { kind: 'current-session' }
  | { kind: 'full' }
  | { kind: 'git-diff' }
  // Plan-scoped review kinds. Reviewer sees the plan markdown (or a slice
  // of it) instead of the workflow's transcript. `mode` chooses between
  // VERIFY (only [x] items shown; reviewer cross-checks claimed work) and
  // CRITIQUE (every item shown with check state preserved; reviewer
  // evaluates the plan itself, completed or not).
  | { kind: 'plan-whole'; planId: string; mode: PlanReviewMode }
  | { kind: 'plan-phase'; planId: string; heading: string; mode: PlanReviewMode }
  | { kind: 'plan-items'; planId: string; itemIds: string[]; mode: PlanReviewMode }
  // Cluster-plan-scoped review kinds. Identical surface to plan-* but the
  // body comes from `clusterStore.readCluster(clusterId).plan.body` (lives
  // in meta.json, no .md file backing) instead of `readPlan(cwd, planId)`.
  // The reviewer still runs on a member workflow — `workflowId` on the
  // ReviewRequestMessage names the worker that executes the review; the
  // ref's clusterId names the plan body being reviewed.
  | { kind: 'cluster-plan-whole'; clusterId: string; mode: PlanReviewMode }
  | { kind: 'cluster-plan-phase'; clusterId: string; heading: string; mode: PlanReviewMode }
  // Phase 8 — review the slice of events.jsonl from `anchorEventSeq` onward.
  // Reviewer sees USER:/AGENT: turns whose first event seq >= the anchor;
  // earlier turns are surfaced as context but the verdict applies to the
  // slice. Anchored from the HISTORY tab's "REVIEW FROM HERE" button.
  | { kind: 'since-event'; anchorEventSeq: number }
  // ARCO_OPS_PLAN.md §G2 — review a preview-capture report artifact. No
  // transcript: the reviewer sees the markdown report produced by a Preview
  // verification capture (screenshot reference + console/network + layout/a11y
  // notes) and evaluates the running UI from that evidence. `reportName` is the
  // artifact basename under the workflow's artifacts dir. Triggered by the
  // ATTACH TO REVIEW button on the Preview tab's capture result strip.
  | { kind: 'preview-capture'; reportName: string };

export type PlanReviewMode = 'verify' | 'critique';

export interface ReviewRequestMessage {
  type: 'review_request';
  workflowId: string;
  reviewer: {
    provider: ProviderName;
    model: ModelName;
    effort: EffortLevel;
    providerAccountRef?: string;
  };
  contextRef: ReviewContextRef;
  // Optional layer: when set for any non-`git-diff` scope, the reviewer
  // receives the transcript slice AND a `git diff HEAD` block. Useful
  // when the operator wants the reviewer to cross-check transcript claims
  // against real file changes.
  includeGitDiff?: boolean;
}

// Cancel a review that's still in-flight. No-op if the review has already
// settled. Kills the reviewer worker, which resolves the review as an error
// and fires the usual review_artifact_ready with an error field.
export interface CancelReviewMessage {
  type: 'cancel_review';
  workflowId: string;
  reviewId: string;
}

// Phase 5 review events. Both are workflow-scoped so they persist to
// events.jsonl and survive replay — clients rebuild the Review tab's list
// from the event stream.
export interface ReviewStartedMessage {
  type: 'review_started';
  workflowId: string;
  reviewId: string;
  reviewer: {
    provider: ProviderName;
    model: ModelName;
    effort: EffortLevel;
    providerAccountRef?: string;
  };
  contextRef: ReviewContextRef;
  startedAt: number;
}

export interface ReviewArtifactReadyMessage {
  type: 'review_artifact_ready';
  workflowId: string;
  reviewId: string;
  artifactName: string;
  verdict?: 'PASS' | 'MINOR' | 'BLOCKING';
  error?: string;
  completedAt: number;
}
