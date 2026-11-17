import type { EffortLevel, ProviderName } from './providers.js';

export interface TranscriptWorkerPreview {
  token: string;
  seed: string;
  bytes: number;
  availableTurns: number;
  selectedTurns: number;
  partialIncluded: boolean;
  cutoffSeq: number;
  historyMode?: 'recent' | 'full';
  requestedTurns?: number;
  truncated?: boolean;
  historyFallback?: boolean;
}

export interface TranscriptWorkerPreviewMessage {
  type: 'transcript_worker_preview';
  requestId: string;
  workflowId: string;
  turns: number;
  includePartial: boolean;
  preface: string;
  // REPLACE shares the fixed transcript-preview flow, with its own budgets.
  replacement?: { clusterId: string; mode: 'recent' | 'full' };
}

export interface TranscriptWorkerCreateMessage {
  type: 'transcript_worker_create';
  requestId: string;
  token: string;
  destination: {
    workingDirectory: string;
    name: string;
    provider: ProviderName;
    model: string;
    effort: EffortLevel;
    providerAccountRef?: string;
    skipPermissions?: boolean;
  };
}

export interface TranscriptWorkerResultMessage {
  type: 'transcript_worker_result';
  requestId: string;
  preview?: TranscriptWorkerPreview;
  newWorkflowId?: string;
  error?: string;
}
