// ── Worker / session state types ──

import type { EffortLevel, ModelName, ProviderName, WorkerStatus } from './providers.js';
import type { TokenUsage } from './usage.js';

// Tool calls the CLI auto-denied because the worker ran in SAFE mode.
export interface PermissionDenial {
  tool: string;
  input: string; // JSON-stringified tool args
}

// One long-running child process the primary launched (via Bash with
// `run_in_background: true`, or any descendant that outlived its turn).
// `toolUseId` is the id of the `primary_tool_use` event that spawned it
// when the tracker could correlate; absent otherwise (e.g. reparented
// processes, or when no Bash-bg hint was nearby).
export interface PrimaryBackgroundJob {
  id: string;
  pid: number;
  command: string;      // from /proc/<pid>/cmdline, or the Bash input when available
  toolUseId?: string;
  startedAt: number;
  alive: boolean;
  cpuActive: boolean;
  rssBytes: number;
  ageMs: number;
}

export interface WorkerToolCall {
  tool: string;
  input: string;
  timestamp: number;
}

export interface WorkerState {
  id: string;
  model: ModelName;
  resolvedModel?: string;
  effort: EffortLevel;
  status: WorkerStatus;
  task: string;
  output: string;
  thinking: string;
  toolCalls: WorkerToolCall[];
  spawnedAt: number;
  lastActivityAt: number;
  costUsd?: number;
  durationMs?: number;
  tokens?: TokenUsage;
  provider?: ProviderName;
  permissionDenials?: PermissionDenial[];
  activity?: {
    alive: boolean;
    cpuActive: boolean;
    descendantCount: number;
    rssBytes: number;
    probedAt: number;
  };
}
