import type { EffortLevel, ModelName, ProviderName } from './providers.js';

// Operator-armed competitive parallelism. Every attempt receives the same
// prompt in its own managed git worktree; the operator compares diffs and
// explicitly promotes one branch. No model ranks or selects a winner.

export interface BakeoffAttemptSpec {
  provider: ProviderName;
  model: ModelName;
  effort: EffortLevel;
  providerAccountRef?: string;
}

export type BakeoffAttemptStatus =
  | 'creating'
  | 'running'
  | 'done'
  | 'failed'
  | 'interrupted'
  | 'cleaned';

export interface BakeoffAttempt {
  id: string;
  index: number;
  label: string;
  provider: ProviderName;
  model: ModelName;
  effort: EffortLevel;
  providerAccountRef?: string;
  workflowId?: string;
  worktreePath: string;
  branch: string;
  status: BakeoffAttemptStatus;
  startedAt?: number;
  completedAt?: number;
  error?: string;
}

export interface BakeoffState {
  id: string;
  sourceWorkflowId: string;
  sourceCwd: string;
  name: string;
  prompt: string;
  baseRef: string;
  baseBranch: string | null;
  createdAt: number;
  updatedAt: number;
  status: 'creating' | 'running' | 'ready' | 'promoted' | 'failed';
  attempts: BakeoffAttempt[];
  winnerAttemptId?: string;
  promotedAt?: number;
  mergeCommit?: string;
}

export interface BakeoffListMessage {
  type: 'bakeoff_list';
  workflowId: string;
}

export interface BakeoffStartMessage {
  type: 'bakeoff_start';
  workflowId: string;
  name?: string;
  prompt: string;
  attempts: BakeoffAttemptSpec[];
}

export interface BakeoffPromoteMessage {
  type: 'bakeoff_promote';
  workflowId: string;
  bakeoffId: string;
  attemptId: string;
}

export interface BakeoffCleanupMessage {
  type: 'bakeoff_cleanup';
  workflowId: string;
  bakeoffId: string;
  attemptIds: string[];
}

export interface BakeoffListResultMessage {
  type: 'bakeoff_list_result';
  workflowId: string;
  bakeoffs: BakeoffState[];
}

export interface BakeoffStateMessage {
  type: 'bakeoff_state';
  workflowId: string;
  bakeoff: BakeoffState;
}

export interface BakeoffErrorMessage {
  type: 'bakeoff_error';
  workflowId: string;
  bakeoffId?: string;
  error: string;
}

export interface BakeoffAttemptsRemovedMessage {
  type: 'bakeoff_attempts_removed';
  workflowId: string;
  bakeoffId: string;
  attemptIds: string[];
  workflowIds: string[];
}
