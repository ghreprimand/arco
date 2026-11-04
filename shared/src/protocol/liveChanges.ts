import type { WorkingChangesResponse } from './checkpoints.js';

export interface LiveChangesSubscribeMessage {
  type: 'live_changes_subscribe';
  workflowId: string;
  cwd?: string;
}

export interface LiveChangesUnsubscribeMessage {
  type: 'live_changes_unsubscribe';
  workflowId: string;
  cwd?: string;
}

export interface LiveChangesSnapshotMessage {
  type: 'live_changes_snapshot';
  workflowId: string;
  cwd: string;
  ts: number;
  data: WorkingChangesResponse;
  // Keyed as "<group>:<repo-relative-path>" where group is staged|unstaged|untracked.
  // Changes when the live file's size or mtime changes, so a file that stays
  // "modified" still refreshes while an agent keeps editing it.
  fingerprints?: Record<string, string>;
}
