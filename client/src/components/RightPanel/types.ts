import type { ModelName, EffortLevel, WorkflowConfig, ProviderName, ReviewContextRef, LedgerTaskStatus, TaskLink, GenesisSeed, GenesisGithubParams, GenesisAssistField, GenesisAssistIntent, PreviewCaptureKind, PreviewViewport, BakeoffAttemptSpec } from '@arco/shared';
import type { JobState } from '../../stores/appStore';
import type { McpSenders } from './McpRegistrySection';

export type RightTab = 'files' | 'activity' | 'genesis' | 'review' | 'research' | 'handoffs' | 'plan' | 'bakeoff' | 'knowledge' | 'tasks' | 'ledger' | 'history' | 'usage' | 'preview' | 'config' | 'github';

export interface TaskLedgerPatch {
  title?: string;
  status?: LedgerTaskStatus;
  notes?: string;
  links?: TaskLink[];
  worktreeRequired?: boolean;
}

export interface Props {
  job: JobState;
  onUpdatePrimary?: (update: { model?: ModelName; effort?: EffortLevel; autoHandoff?: { enabled: boolean; warnAt: number; autoAt: number; mode?: 'original-worker' | 'fresh-summarizer'; summarizer?: { provider: ProviderName; model?: ModelName; effort?: EffortLevel } }; autoFold?: { enabled: boolean; foldAt: number; tailBudget?: number }; autoCompaction?: import('@arco/shared').AutoCompactionPolicy | null; codexTransport?: 'exec' | 'appserver'; codexContextPolicy?: 'max' | 'standard'; claudeTransport?: 'cli' | 'native'; ultracode?: boolean; webSearchMaxUses?: number; claudeNativeCompact?: boolean; claudeNativeForceInterleavedThinkingBeta?: boolean; claudeNativeThinkingDisplay?: 'omitted' | 'summarized' | 'updates'; nativeCompactAutoContinue?: boolean; efficiencyToolFilter?: 'off' | 'conservative' | 'aggressive'; efficiencyFactForce?: 'on' | 'off'; efficiencyConfigProtection?: 'on' | 'off'; efficiencySandbox?: 'off' | 'on'; outputStyle?: 'normal' | 'lite' | 'terse'; goal?: string; ollamaParams?: Record<string, unknown> }) => void;
  onCancelReview?: (reviewId: string) => void;
  // D5 — the composer's send path, threaded to the Review tab so a finding's
  // "Fix" button can dispatch a scoped follow-up turn (kind: 'follow-up').
  // Operator-click-only; no auto-send. Same signature as the composer's onSend.
  onSend?: (content: string, attachments?: string[], kind?: 'steer' | 'follow-up' | 'interrupt', primitive?: 'docs' | 'git') => void;
  // docs/ARCHITECTURE.md - Genesis tab: update the seed (debounced) and trigger
  // the operator-confirmed scaffold. Threaded from App.tsx → useWebSocket senders.
  onGenesisSeedUpdate?: (workflowId: string, seed: GenesisSeed) => void;
  onGenesisScaffold?: (workflowId: string, root?: string, github?: GenesisGithubParams) => void;
  // docs/ARCHITECTURE.md - arm/disarm in-workflow Creative mode on an existing workflow.
  onGenesisCreativeArm?: (workflowId: string, disarm?: boolean) => void;
  onGenesisAssistRequest?: (workflowId: string, requestId: string, field: GenesisAssistField, intent: GenesisAssistIntent, seed: GenesisSeed, instruction?: string) => void;
  onCancelHandoff?: (handoffId: string) => void;
  onClearHandoffLock?: (cwd: string, workflowId: string, handoffId?: string) => void;
  onAttachPlan?: (planId: string) => void;
  onDetachPlan?: () => void;
  // Phase 2.6 — PROMOTE TO CLUSTER button inside PlanTab. Only shown when
  // this workflow is a cluster member (PlanTab derives that from the store).
  onPromoteToCluster?: (body: string) => void;
  // Spawn-from-plan task: when an attached plan has unchecked checkbox
  // rows, the Plan tab renders a per-row spawn button that opens
  // SpawnDialog with the task text prefilled. Reuses the same flow as
  // the composer's SPAWN button (App.tsx → requestSpawnFromHere).
  onSpawn?: (newConfig: WorkflowConfig, newDirection: string, includePlan: boolean) => void;
  // Review dispatch — same handler used by the composer's REVIEW button
  // (TerminalInput). Threaded down to PlanTab so the per-phase pill, the
  // REVIEW PLAN button, and the custom-review picker can all submit.
  onReview?: (
    reviewer: { provider: ProviderName; model: ModelName; effort: EffortLevel },
    contextRef: ReviewContextRef,
    includeGitDiff: boolean,
  ) => void;
  onSetPreviewPort?: (port: number, framework?: string) => void;
  onClearPreviewPort?: () => void;
  onPreviewCapture?: (captures?: PreviewCaptureKind[], viewport?: PreviewViewport) => void;
  // docs/ARCHITECTURE.md - attach a preview-capture report to a Review (fires
  // a reviewer over the report artifact, reusing the tab's primary config).
  onReviewCapture?: (reportName: string) => void;
  // docs/ARCHITECTURE.md - RESEARCH tab. Cancel an in-flight run,
  // and the artifact viewer's "dig deeper" composer (appends a cited addendum
  // to the same report by re-running a bounded mini-round seeded with it).
  onCancelResearch?: (researchId: string) => void;
  onResearchFollowUp?: (seedArtifactName: string, followUp: string) => void;
  // docs/PROVIDERS.md - codebase-memory toggle. Routed App ->
  // WorkflowView → RightPanel → ConfigTab → CodebaseMemorySection.
  onAttachCodebaseMemory?: (workflowId: string, indexPath?: string) => void;
  onDetachCodebaseMemory?: (workflowId: string) => void;
  // docs/ARCHITECTURE.md - project task ledger mutations (LEDGER tab).
  // cwd-scoped; the server resolves the cwd from the workflowId.
  onTaskLedgerCreate?: (workflowId: string, title: string, notes?: string) => void;
  onTaskLedgerUpdate?: (
    workflowId: string,
    id: string,
    patch: TaskLedgerPatch,
  ) => void;
  onTaskLedgerDelete?: (workflowId: string, id: string) => void;
  onTaskLedgerList?: (workflowId: string) => void;
  onTaskWorktreeCreate?: (workflowId: string, id: string) => void;
  onTaskWorktreeRemove?: (workflowId: string, id: string) => void;
  onBakeoffList?: (workflowId: string) => void;
  onBakeoffStart?: (workflowId: string, prompt: string, attempts: BakeoffAttemptSpec[], name?: string) => void;
  onBakeoffPromote?: (workflowId: string, bakeoffId: string, attemptId: string) => void;
  onBakeoffCleanup?: (workflowId: string, bakeoffId: string, attemptIds: string[]) => void;
  // docs/ARCHITECTURE.md - MCP registry senders bundle, routed App ->
  // WorkflowView → RightPanel → ConfigTab → McpRegistrySection.
  mcp?: McpSenders;
}
