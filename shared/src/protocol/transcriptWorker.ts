import type { EffortLevel, ProviderName } from './providers.js';

export interface TranscriptWorkerPreview {
  token: string;
  seed: string;
  bytes: number;
  availableTurns: number;
  selectedTurns: number;
  partialIncluded: boolean;
  cutoffSeq: number;
}

export interface TranscriptWorkerPreviewMessage {
  type: 'transcript_worker_preview';
  requestId: string;
  workflowId: string;
  turns: number;
  includePartial: boolean;
  preface: string;
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
