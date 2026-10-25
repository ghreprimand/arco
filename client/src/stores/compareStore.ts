import { create } from 'zustand';
import type { CompareLegConfig } from '@archon/shared';

// WORKBENCH_EXPANSION_PLAN.md §B1 — Compare primitive client store.
//
// Kept OUT of appStore (mirrors docEditStore / cookbookStore): a compare race
// is a transient, global overlay — one at a time, not per-tab session state,
// not persisted. The compare_* server events route here; the globally-mounted
// CompareOverlay renders the grid + vote off this state.
//
// Module-level senders (mirrors cookbookStore) so the dialog/overlay can
// dispatch a request / vote / synthesize / cancel without prop-threading a WS
// callback. Registered by useWebSocket; null when the socket is closed.

export interface CompareRequestArgs {
  workflowId: string;
  prompt: string;
  legs: CompareLegConfig[];
  blind: boolean;
}
type RequestSender = (args: CompareRequestArgs) => void;
type VoteSender = (workflowId: string, compareId: string, winnerLegIndex: number) => void;
type SynthesizeSender = (workflowId: string, compareId: string, synthesizerLegIndex: number) => void;
type CancelSender = (workflowId: string, compareId: string) => void;

let requestSender: RequestSender | null = null;
let voteSender: VoteSender | null = null;
let synthesizeSender: SynthesizeSender | null = null;
let cancelSender: CancelSender | null = null;

export function registerCompareRequestSender(fn: RequestSender | null) { requestSender = fn; }
export function registerCompareVoteSender(fn: VoteSender | null) { voteSender = fn; }
export function registerCompareSynthesizeSender(fn: SynthesizeSender | null) { synthesizeSender = fn; }
export function registerCompareCancelSender(fn: CancelSender | null) { cancelSender = fn; }

export function sendCompareRequest(args: CompareRequestArgs): boolean {
  if (!requestSender) return false;
  requestSender(args);
  return true;
}
export function sendCompareVote(workflowId: string, compareId: string, winnerLegIndex: number): boolean {
  if (!voteSender) return false;
  voteSender(workflowId, compareId, winnerLegIndex);
  return true;
}
export function sendCompareSynthesize(workflowId: string, compareId: string, synthesizerLegIndex: number): boolean {
  if (!synthesizeSender) return false;
  synthesizeSender(workflowId, compareId, synthesizerLegIndex);
  return true;
}
export function sendCompareCancel(workflowId: string, compareId: string): boolean {
  if (!cancelSender) return false;
  cancelSender(workflowId, compareId);
  return true;
}

// One pane's running projection. Pane index == leg index for the originals; the
// optional synthesis leg lands at index == legs.length.
export interface ComparePane {
  text: string;
  done: boolean;
  error?: string;
  durationMs?: number;
}

export interface CompareState {
  // The dialog open flag (the COMPARE button flips it). Workflow id is carried
  // so the dialog knows whose primary to seed the RUN AS picker from.
  dialogOpen: boolean;
  dialogWorkflowId: string | null;
  openDialog: (workflowId: string) => void;
  closeDialog: () => void;

  // The active race (or null when none). Built from the compare_* events.
  active: {
    workflowId: string;
    compareId: string;
    prompt: string;
    legs: CompareLegConfig[];
    blind: boolean;
    panes: ComparePane[];
    raceDone: boolean;
    // Operator's winner pick (leg index) once a vote lands; reveals labels in
    // blind mode. -1 == not yet voted.
    winnerLegIndex: number;
    // True once a synthesize follow-up is running (its pane is panes[legs.length]).
    synthesizing: boolean;
  } | null;

  // ── event sinks (called from handleServerMessage) ──
  onStarted: (m: { workflowId: string; compareId: string; prompt: string; legs: CompareLegConfig[]; blind: boolean }) => void;
  onLegDelta: (compareId: string, legIndex: number, text: string) => void;
  onLegComplete: (compareId: string, legIndex: number, text: string, durationMs: number, error?: string) => void;
  onComplete: (compareId: string) => void;
  onVoteRecorded: (compareId: string, winnerLegIndex: number) => void;

  // Close the overlay (does not cancel — cancel is a separate explicit action).
  dismiss: () => void;
}

function ensurePane(panes: ComparePane[], idx: number): ComparePane[] {
  const next = panes.slice();
  while (next.length <= idx) next.push({ text: '', done: false });
  return next;
}

export const useCompareStore = create<CompareState>((set) => ({
  dialogOpen: false,
  dialogWorkflowId: null,
  openDialog: (workflowId) => set({ dialogOpen: true, dialogWorkflowId: workflowId }),
  closeDialog: () => set({ dialogOpen: false }),

  active: null,

  onStarted: (m) => set({
    active: {
      workflowId: m.workflowId,
      compareId: m.compareId,
      prompt: m.prompt,
      legs: m.legs,
      blind: m.blind,
      panes: m.legs.map(() => ({ text: '', done: false })),
      raceDone: false,
      winnerLegIndex: -1,
      synthesizing: false,
    },
  }),

  onLegDelta: (compareId, legIndex, text) => set((s) => {
    if (!s.active || s.active.compareId !== compareId) return {};
    const panes = ensurePane(s.active.panes, legIndex);
    panes[legIndex] = { ...panes[legIndex], text: panes[legIndex].text + text };
    // A delta for a beyond-legs index means a synthesis pane started streaming.
    const synthesizing = s.active.synthesizing || legIndex >= s.active.legs.length;
    return { active: { ...s.active, panes, synthesizing } };
  }),

  onLegComplete: (compareId, legIndex, text, durationMs, error) => set((s) => {
    if (!s.active || s.active.compareId !== compareId) return {};
    const panes = ensurePane(s.active.panes, legIndex);
    // Final text is authoritative — replace the streamed accumulation.
    panes[legIndex] = { text: text || panes[legIndex].text, done: true, durationMs, error };
    return { active: { ...s.active, panes } };
  }),

  onComplete: (compareId) => set((s) => {
    if (!s.active || s.active.compareId !== compareId) return {};
    return { active: { ...s.active, raceDone: true } };
  }),

  onVoteRecorded: (compareId, winnerLegIndex) => set((s) => {
    if (!s.active || s.active.compareId !== compareId) return {};
    return { active: { ...s.active, winnerLegIndex } };
  }),

  dismiss: () => set({ active: null }),
}));
