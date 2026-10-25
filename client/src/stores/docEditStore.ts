import { create } from 'zustand';
import type { ProviderName, ModelName, EffortLevel } from '@arco/shared';

// WORKBENCH_EXPANSION_PLAN.md §A7 — AI-collaborative document editing client
// store. Kept OUT of appStore (mirrors recallStore / terminalStore): doc-edit
// is a transient, per-open-editor concern, not persisted per-tab session state.
//
// The affordance lives inside FileViewerModal (a deep, portal'd modal), so
// rather than thread `requestDocEdit` through every FileViewerModal call site,
// useWebSocket registers a module-level sender here at connect time and the
// affordance fires through it. The `doc_edit_started` / `doc_edit_proposed`
// server events are routed into `byId` by handleServerMessage.
//
// Fence: this store only TRACKS proposals. Accept (buffer splice) and Save
// (the existing A6 guarded write) both live in FileViewerModal/AiEditAffordance
// — this store never touches the buffer or disk.

export type DocEditStatus = 'pending' | 'proposed' | 'error';

export interface DocEditEntry {
  docEditId: string;
  status: DocEditStatus;
  filePath: string;
  selectionFrom: number;
  selectionTo: number;
  // The selection text as it was at request time — the "before" side of the
  // accept/reject diff preview (the proposal echoes offsets, not the original).
  selectionBefore: string;
  replacement: string;
  error?: string;
}

export interface DocEditRequestArgs {
  workflowId: string;
  editor: { provider: ProviderName; model: ModelName; effort: EffortLevel; providerAccountRef?: string };
  filePath: string;
  selectionText: string;
  selectionFrom: number;
  selectionTo: number;
  contextBefore: string;
  contextAfter: string;
  instruction: string;
  wholeDoc: boolean;
}

// Module-level WS sender bridge — registered by useWebSocket once the socket is
// live. Returns a docEditId the caller seeds the store with, or null if the
// socket is not open.
type DocEditSender = (args: DocEditRequestArgs) => void;
let sender: DocEditSender | null = null;
export function registerDocEditSender(fn: DocEditSender | null) { sender = fn; }

interface DocEditState {
  // Keyed by docEditId. A modal tracks the docEditId it dispatched and reads
  // its own entry; entries are pruned on modal close / accept / reject.
  byId: Record<string, DocEditEntry>;
  // Seed a pending entry and fire the WS request. The caller supplies the
  // docEditId is NOT known until the server assigns one, so we key the pending
  // entry by a client token until the server's doc_edit_started/proposed lands;
  // since the server generates the id, we instead correlate by the most-recent
  // pending entry per file. Simpler: we let the affordance hold the docEditId
  // returned from the server events filtered by filePath. To keep correlation
  // robust we stamp a client requestKey and match server events by filePath +
  // selection offsets (echoed back). See dispatch() below.
  dispatch: (args: DocEditRequestArgs) => string;
  onStarted: (docEditId: string, filePath: string) => void;
  onProposed: (docEditId: string, patch: { replacement: string; error?: string; selectionFrom: number; selectionTo: number; filePath: string }) => void;
  clear: (docEditId: string) => void;
}

export const useDocEditStore = create<DocEditState>((set) => ({
  byId: {},
  dispatch: (args) => {
    // Client request key: correlates the server's doc_edit_started (which
    // carries the authoritative docEditId + echoed offsets/file) back to this
    // pending entry. We key the pending entry on the request key; onStarted
    // re-keys it to the server docEditId. Since the affordance dispatches ONE
    // request at a time per modal, a per-request key is sufficient.
    const requestKey = `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    set((s) => ({
      byId: {
        ...s.byId,
        [requestKey]: {
          docEditId: requestKey,
          status: 'pending',
          filePath: args.filePath,
          selectionFrom: args.selectionFrom,
          selectionTo: args.selectionTo,
          selectionBefore: args.selectionText,
          replacement: '',
        },
      },
    }));
    if (sender) sender(args);
    return requestKey;
  },
  // The server assigns the real docEditId. Re-key the single pending entry for
  // this file onto the authoritative id (the affordance dispatches one request
  // at a time per modal, so a per-file match is unambiguous).
  onStarted: (docEditId, filePath) => set((s) => {
    if (s.byId[docEditId]) return s; // already re-keyed
    const pendingKey = Object.keys(s.byId).find((k) =>
      s.byId[k].status === 'pending' && s.byId[k].filePath === filePath);
    if (!pendingKey) return s;
    const entry = { ...s.byId[pendingKey], docEditId };
    const next = { ...s.byId };
    delete next[pendingKey];
    next[docEditId] = entry;
    return { byId: next };
  }),
  onProposed: (docEditId, patch) => set((s) => {
    // Match by authoritative id; fall back to the pending entry with matching
    // file+offsets (covers a started event we never saw, e.g. dropped frame).
    let key = s.byId[docEditId] ? docEditId : undefined;
    if (!key) {
      key = Object.keys(s.byId).find((k) =>
        s.byId[k].status === 'pending'
        && s.byId[k].filePath === patch.filePath
        && s.byId[k].selectionFrom === patch.selectionFrom
        && s.byId[k].selectionTo === patch.selectionTo);
    }
    if (!key) {
      // No tracked request — seed a fresh entry so the proposal still surfaces.
      return {
        byId: {
          ...s.byId,
          [docEditId]: {
            docEditId,
            status: patch.error ? 'error' : 'proposed',
            filePath: patch.filePath,
            selectionFrom: patch.selectionFrom,
            selectionTo: patch.selectionTo,
            selectionBefore: '',
            replacement: patch.replacement,
            error: patch.error,
          },
        },
      };
    }
    const entry = s.byId[key];
    const next = { ...s.byId };
    if (key !== docEditId) delete next[key];
    next[docEditId] = {
      ...entry,
      docEditId,
      status: patch.error ? 'error' : 'proposed',
      replacement: patch.replacement,
      error: patch.error,
    };
    return { byId: next };
  }),
  clear: (docEditId) => set((s) => {
    if (!s.byId[docEditId]) return s;
    const next = { ...s.byId };
    delete next[docEditId];
    return { byId: next };
  }),
}));
