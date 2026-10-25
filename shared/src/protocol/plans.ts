// ── Plans ──
// A Plan is a long-form markdown brief stored at
// <cwd>/.arco/plans/<planId>.md. Multiple plans can live in a single cwd;
// a workflow attaches 0 or 1 via meta.planId. The active plan's title +
// last-updated timestamp get injected as a one-line system note at the start
// of every primary turn so the agent stays aware. CRUD on plan bodies/list
// goes over REST (GET /api/plans, GET /api/plans/body, POST/PATCH); only
// attachment changes ride the workflow-scoped WS so they persist to
// events.jsonl and survive replay.

export interface PlanAttachMessage {
  type: 'plan_attach';
  workflowId: string;
  planId: string;
}

export interface PlanDetachMessage {
  type: 'plan_detach';
  workflowId: string;
}

// Operator-initiated plan-mode arming. Sent immediately before a
// `user_message` (send-time-fire) so the upcoming turn starts with
// `worker.planMode = true` and a system-prompt nudge instructing the model
// to call EnterPlanMode for the operator's task. Single-turn arming —
// consumed by the next turn dispatch and cleared. Only Claude Native
// honours the request; other providers / transports silently no-op.
export interface EnterPlanModeRequestMessage {
  type: 'enter_plan_mode_request';
  workflowId: string;
}

// Plan is now active for this workflow. Fired on attach, on workflow
// (re)hydrate when meta.planId is set, and after a plan body edit so all
// attached tabs see the fresh title/updatedAt. Body itself is fetched via
// `GET /api/plans/body?path=<cwd>&planId=<id>` — keeps events.jsonl small.
export interface PlanAttachedMessage {
  type: 'plan_attached';
  workflowId: string;
  planId: string;
  title: string;
  updatedAt: number;
}

// Plan was detached from this workflow (or its underlying file vanished).
export interface PlanDetachedMessage {
  type: 'plan_detached';
  workflowId: string;
}

// Phase 7b — Claude Native EnterPlanMode broadcast. The worker writes the
// plan body to a real plan file under .arco/plans/ and attaches it (plan_attached
// fires too); plan_set carries the inline body so observers can render it
// without a separate read. `source: 'native-tool'` distinguishes this from a
// future operator-initiated plan-set surface.
export interface PlanSetMessage {
  type: 'plan_set';
  workflowId: string;
  plan: string;
  source: 'native-tool';
  planId?: string;
}

// Phase 7b — Claude Native ExitPlanMode broadcast. Operator-visible signal that
// the agent is no longer plan-mode-gated; write tools re-enabled. The plan
// stays attached to the workflow.
export interface PlanExitedMessage {
  type: 'plan_exited';
  workflowId: string;
  summary?: string;
}

// Cluster-member plan-creation choice point. When a worker that is a member
// of a cluster produces a plan via an auto-attach path (Claude Native
// `EnterPlanMode` tool, or the PlanComposerDialog AUTOSAVE button), the
// server skips the silent worker-attach and emits this event instead. The
// client lands it in `JobState.planCandidate` (mode: 'review') so
// `PlanCandidateBanner` renders the three-button choice
// (SAVE & ATTACH TO WORKER / ATTACH TO CLUSTER / DISCARD).
//
// Non-cluster workflows never see this message — the existing `plan_set`
// auto-attach pipeline is unchanged for them.
//
// `plan_set` STILL fires alongside this message (for events.jsonl audit);
// only the `handlePlanAttach` side-effect is gated when the workflow is in
// a cluster.
export interface PlanCandidateReadyMessage {
  type: 'plan_candidate_ready';
  workflowId: string;
  body: string;
  // Provenance: which auto-attach path was intercepted. Server-side discriminator,
  // useful in events.jsonl when reconstructing why a banner appeared.
  source: 'native-plan-tool' | 'autosave-cluster-fallback';
  // Optional pre-extracted title; the client extracts its own if absent. Lets
  // the server pass through the same title heuristic the worker-attach path
  // used so the banner preview matches what would have been saved.
  planTitle?: string;
}

// One attach→detach span on a plan. `detachedAt: null` means currently
// attached; the operator (or a workflow remove) flips it to a timestamp on
// detach. `workflowName` snapshots `WorkflowConfig.name` at attach time so
// the UI can show a label even after the workflow tab is gone.
export interface PlanAttachmentSpan {
  workflowId: string;
  workflowName: string;
  attachedAt: number;
  detachedAt: number | null;
}

// Plan summary as returned by `GET /api/plans?path=<cwd>`. The body is
// fetched separately so the list endpoint stays O(N) cheap. `attachments`
// is the full attach/detach history for this plan (active + past). Optional
// for back-compat with index.json files written before the field existed.
// `completedAt` archives the plan into the Plan tab's collapsed Completed
// section — null/undefined means active. Marking complete auto-detaches
// from any workflow; reopening just clears the timestamp (no auto-attach).
export interface PlanSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  attachments?: PlanAttachmentSpan[];
  completedAt?: number | null;
}

export interface PlanFull extends PlanSummary {
  body: string;
}

// Plan reference doc — long-form detail (specs, research, designs) that
// belongs to one plan but would bloat its checklist. Stored as
// `<cwd>/.arco/plans/<planId>.refs/<slug>.md` and directory-listed (no
// index entry), so an agent with plain file tools can add one by writing a
// file. Plan bodies link a ref as `[label](ref:slug)` or `[[ref:slug]]`.
// `title` is the doc's first H1, else the slug.
export interface PlanRefSummary {
  slug: string;
  title: string;
  bytes: number;
  updatedAt: number;
}

export interface PlanRefFull extends PlanRefSummary {
  body: string;
}

// One row of `GET /api/explorer/plans` — the cross-project plans library.
export interface PlanLibraryEntry extends PlanSummary {
  refCount: number;
  // True when a workflow attachment span is still open or a cluster binds it.
  attached: boolean;
  clusters: Array<{ clusterId: string; name: string }>;
}

export interface PlanLibraryProject {
  cwd: string;
  name: string;
  plans: PlanLibraryEntry[];
}
