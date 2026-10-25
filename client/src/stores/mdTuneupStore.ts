import { create } from 'zustand';
import type { ProviderName, ModelName, EffortLevel, MdTuneupTarget, MdTuneupCandidate } from '@archon/shared';

// Agent-instruction-file tune-up client store — see shared/src/protocol/mdTuneup.ts.
// Kept OUT of appStore (mirrors docEditStore / recallStore): a tune-up is a
// transient, operator-triggered concern, not persisted per-tab session state.
//
// Correlation is by workflowId (NOT a request key like docEditStore): a tab
// runs at most ONE tune-up at a time, so a per-workflow entry is unambiguous and
// far simpler than the doc-edit re-keying dance. The server's
// md_tuneup_started / _proposed / _applied events all carry workflowId.
//
// Fence: this store only TRACKS the proposal. The agent never writes the file;
// the server does the backup + write on accept, and only after the operator
// reviews the diff and clicks ACCEPT.

export type MdTuneupStatus = 'pending' | 'proposed' | 'applying' | 'applied' | 'error';

export interface MdTuneupEntry {
  workflowId: string;
  tuneupId?: string;
  status: MdTuneupStatus;
  filePath?: string;
  baseName?: string;
  original?: string;
  proposed?: string;
  notes?: string;
  originalBytes?: number;
  proposedBytes?: number;
  backupPath?: string;
  error?: string;
}

export interface MdTuneupEditor {
  provider: ProviderName;
  model: ModelName;
  effort: EffortLevel;
  providerAccountRef?: string;
}

// Module-level WS sender bridges — registered by useWebSocket once the socket is
// live, so the deeply-mounted composer button / modal don't thread callbacks.
type RequestSender = (args: { workflowId: string; editor: MdTuneupEditor; target: MdTuneupTarget }) => void;
type AcceptSender = (args: { workflowId: string; tuneupId: string; filePath: string; proposed: string }) => void;
type CandidatesSender = (workflowId: string) => void;
let requestSender: RequestSender | null = null;
let acceptSender: AcceptSender | null = null;
let candidatesSender: CandidatesSender | null = null;
export function registerMdTuneupRequestSender(fn: RequestSender | null) { requestSender = fn; }
export function registerMdTuneupAcceptSender(fn: AcceptSender | null) { acceptSender = fn; }
export function registerMdTuneupCandidatesSender(fn: CandidatesSender | null) { candidatesSender = fn; }

export interface MdTuneupCandidates {
  candidates: MdTuneupCandidate[];
  defaultPath?: string;
  // false until the server's md_tuneup_candidates lands (so the dialog shows a
  // "scanning…" state rather than a premature "no files found").
  loaded: boolean;
}

interface MdTuneupState {
  byWorkflow: Record<string, MdTuneupEntry>;
  candidatesByWorkflow: Record<string, MdTuneupCandidates>;
  requestCandidates: (workflowId: string) => void;
  onCandidates: (workflowId: string, candidates: MdTuneupCandidate[], defaultPath?: string) => void;
  dispatch: (workflowId: string, editor: MdTuneupEditor, target: MdTuneupTarget) => void;
  onStarted: (workflowId: string, patch: { tuneupId: string; filePath: string; baseName: string; originalBytes: number }) => void;
  onProposed: (workflowId: string, patch: {
    tuneupId: string; filePath: string; baseName: string;
    original: string; proposed: string; notes: string;
    originalBytes: number; proposedBytes: number; error?: string;
  }) => void;
  accept: (workflowId: string) => void;
  onApplied: (workflowId: string, patch: { tuneupId: string; filePath: string; ok: boolean; backupPath?: string; error?: string }) => void;
  clear: (workflowId: string) => void;
}

export const useMdTuneupStore = create<MdTuneupState>((set, get) => ({
  byWorkflow: {},
  candidatesByWorkflow: {},
  requestCandidates: (workflowId) => {
    // Reset to unloaded so the dialog shows "scanning…" until the answer lands.
    set((s) => ({ candidatesByWorkflow: { ...s.candidatesByWorkflow, [workflowId]: { candidates: [], loaded: false } } }));
    if (candidatesSender) candidatesSender(workflowId);
  },
  onCandidates: (workflowId, candidates, defaultPath) => set((s) => ({
    candidatesByWorkflow: { ...s.candidatesByWorkflow, [workflowId]: { candidates, defaultPath, loaded: true } },
  })),
  dispatch: (workflowId, editor, target) => {
    set((s) => ({ byWorkflow: { ...s.byWorkflow, [workflowId]: { workflowId, status: 'pending' } } }));
    if (requestSender) requestSender({ workflowId, editor, target });
  },
  onStarted: (workflowId, patch) => set((s) => {
    const prev = s.byWorkflow[workflowId];
    // Ignore a stale started for a workflow the operator already cleared.
    if (!prev) return s;
    return {
      byWorkflow: {
        ...s.byWorkflow,
        [workflowId]: {
          ...prev,
          status: prev.status === 'pending' ? 'pending' : prev.status,
          tuneupId: patch.tuneupId,
          filePath: patch.filePath,
          baseName: patch.baseName,
          originalBytes: patch.originalBytes,
        },
      },
    };
  }),
  onProposed: (workflowId, patch) => set((s) => ({
    byWorkflow: {
      ...s.byWorkflow,
      [workflowId]: {
        workflowId,
        tuneupId: patch.tuneupId,
        status: patch.error ? 'error' : 'proposed',
        filePath: patch.filePath,
        baseName: patch.baseName,
        original: patch.original,
        proposed: patch.proposed,
        notes: patch.notes,
        originalBytes: patch.originalBytes,
        proposedBytes: patch.proposedBytes,
        error: patch.error,
      },
    },
  })),
  accept: (workflowId) => {
    const entry = get().byWorkflow[workflowId];
    if (!entry || entry.status !== 'proposed' || !entry.tuneupId || !entry.filePath || !entry.proposed) return;
    set((s) => ({ byWorkflow: { ...s.byWorkflow, [workflowId]: { ...entry, status: 'applying' } } }));
    if (acceptSender) acceptSender({ workflowId, tuneupId: entry.tuneupId, filePath: entry.filePath, proposed: entry.proposed });
  },
  onApplied: (workflowId, patch) => set((s) => {
    const prev = s.byWorkflow[workflowId];
    if (!prev) return s;
    return {
      byWorkflow: {
        ...s.byWorkflow,
        [workflowId]: {
          ...prev,
          status: patch.ok ? 'applied' : 'error',
          backupPath: patch.backupPath,
          error: patch.error,
        },
      },
    };
  }),
  clear: (workflowId) => set((s) => {
    if (!s.byWorkflow[workflowId]) return s;
    const next = { ...s.byWorkflow };
    delete next[workflowId];
    return { byWorkflow: next };
  }),
}));
