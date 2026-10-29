// ── Handoffs + Spawn-from-here ──

import type { EffortLevel, ModelName, ProviderName } from './providers.js';
import type { WorkflowConfig } from './workflows.js';

// Phase 6 Lite — operator-triggered session rotation. The server generates a
// handoff document, archives the current native session, and pre-warms a
// fresh session seeded with the handoff content as its first turn. v1 ships
// `'fresh-summarizer'` mode only — an ephemeral worker reads events.jsonl
// and writes the doc without touching the primary.
export type ExportContextMode = 'original-worker' | 'fresh-summarizer' | 'fresh-agent';

export interface HandoffRequestMessage {
  type: 'handoff_request';
  workflowId: string;
  mode: ExportContextMode;
  // Optional: override the summarizer worker's config. Defaults to the tab's
  // primary config (same provider/model/effort) when omitted.
  summarizer?: {
    provider: ProviderName;
    model: ModelName;
    effort: EffortLevel;
  };
  // Optional: change the primary for the post-handoff session. When set,
  // the workflow's primary config is updated before pre-warm, persisted to
  // meta.json, and the new session is minted with this provider/model/effort.
  // Use this to swap provider mid-tab (e.g., Claude → Codex) without a Spawn.
  newPrimary?: {
    provider: ProviderName;
    model: ModelName;
    effort: EffortLevel;
    providerAccountRef?: string;
  };
}

export interface HandoffCancelMessage {
  type: 'handoff_cancel';
  workflowId: string;
  handoffId: string;
}

export interface HandoffLockClearMessage {
  type: 'handoff_lock_clear';
  cwd: string;
  workflowId: string;
  handoffId?: string;
}

// Phase 7 Lite — fork the current tab into a new tab seeded with the parent's
// context plus an optional operator direction. Server generates the handoff
// doc against the parent's events.jsonl (shared exportContext primitive),
// creates a brand-new workflow (fresh wfid, own meta.json), and pre-warms
// its native session with the seed. Parent tab is untouched.
export interface SpawnFromHereRequestMessage {
  type: 'spawn_from_here_request';
  parentWorkflowId: string;
  newConfig: WorkflowConfig;
  mode: ExportContextMode;
  newDirection?: string;
  // Optional summarizer override. Server default: settings.handoffSummarizer
  // (model/effort filled from newConfig), else the spawn's new primary —
  // never the parent, whose degraded worker shouldn't summarize itself.
  summarizer?: {
    provider: ProviderName;
    model: ModelName;
    effort: EffortLevel;
  };
  // When true and the parent has a plan attached, the spawned workflow
  // also attaches the same plan (records a fresh open span, acquires the
  // watcher, persists planId to its meta.json). Default false — spawn is
  // plan-free unless the operator opts in via the SpawnDialog checkbox.
  includePlan?: boolean;
  // Phase 8 — truncate the parent's transcript to events with seq <= this
  // value before generating the handoff. Anchored from the HISTORY tab's
  // "SPAWN FROM HERE" button. Absent → no cutoff (full parent history).
  // Honored by the fresh-summarizer mode and Native original-worker;
  // CLI original-worker silently ignores (the resumed CLI session carries
  // every prior turn — there's no clean way to truncate its view).
  cutoffEventSeq?: number;
  // Phase 2.5b — when set, add the spawned workflow to this cluster after
  // creation. Native-only fence applies (server rejects if the new worker's
  // effective transport isn't 'native'). Operator opts in via the
  // SpawnDialog "Spawn into cluster" checkbox; default-checked when the
  // source tab is itself a cluster member.
  joinClusterId?: string;
}

// Phase 6 events. Persisted to events.jsonl so a reconnect/replay can
// reconstruct the HANDOFFS tab without hitting disk again.
export interface HandoffStartedMessage {
  type: 'handoff_started';
  workflowId: string;
  handoffId: string;
  mode: ExportContextMode;
  startedAt: number;
}

export interface HandoffArtifactReadyMessage {
  type: 'handoff_artifact_ready';
  workflowId: string;
  handoffId: string;
  artifactName: string;  // handoff-<ts>.md under .arco/workflows/<wfid>/handoffs/
  error?: string;
  // Set when the operator cancelled the in-flight handoff. Rendered as a
  // distinct CANCELLED state rather than an error.
  cancelled?: boolean;
  completedAt: number;
}

// Fires after the new session is pre-warmed and the old session is archived
// in meta.history[]. Client uses this to flip the tab's `primarySessionId`
// and surface the "previous session archived" system line.
export interface HandoffCompleteMessage {
  type: 'handoff_complete';
  workflowId: string;
  handoffId: string;
  archived: {
    sessionId: string;
    turnCount: number;
  };
  newSessionId?: string; // empty when Gemini (no native session id in Lite)
  completedAt: number;
}

export interface HandoffLockSnapshotMessage {
  type: 'handoff_lock_snapshot';
  cwd: string;
  locks: Array<{
    workflowId: string;
    workflowName?: string;
    handoffId?: string;
    status: 'preparing' | 'running';
    startedAt: number;
  }>;
}

export interface SessionHistoryEntry {
  sessionId: string;
  provider: ProviderName;
  startedAt: number;
  endedAt: number;
  turnCount: number;
  archivedReason: 'handoff' | 'fresh-cascade-reset' | 'computer-fresh-context';
  handoffArtifactName?: string;
}

// Phase 7 events — server-owned fork flow. `spawn_from_here_complete`
// carries the new workflow id so the client can auto-activate the tab.
export interface SpawnFromHereCompleteMessage {
  type: 'spawn_from_here_complete';
  parentWorkflowId: string;
  newWorkflowId: string;
  handoffArtifactName?: string;
  error?: string;
  completedAt: number;
}
