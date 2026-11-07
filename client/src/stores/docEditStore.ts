import { create } from 'zustand';
import type { ProviderName, ModelName, EffortLevel } from '@arco/shared';

// docs/ARCHITECTURE.md - AI-collaborative document editing client
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

// Module-level sender bridge. False means nothing was sent and the pending
// request must become a retryable error.
type DocEditSender = (args: DocEditRequestArgs) => boolean;
let sender: DocEditSender | null = null;
export function registerDocEditSender(fn: DocEditSender | null) { sender = fn; }

interface DocEditState {
  // Keyed by docEditId. A modal tracks the docEditId it dispatched and reads
  // its own entry; entries are pruned on modal close / accept / reject.
  byId: Record<string, DocEditEntry>;
  // The returned client key remains stable. The entry records the server id
  // separately when started/proposed arrives, so the editor keeps its lookup.
  dispatch: (args: DocEditRequestArgs) => string;
  onStarted: (docEditId: string, filePath: string) => void;
  onProposed: (docEditId: string, patch: { replacement: string; error?: string; selectionFrom: number; selectionTo: number; filePath: string }) => void;
  onDisconnected: () => void;
  clear: (docEditId: string) => void;
}

export const useDocEditStore = create<DocEditState>((set) => ({
  byId: {},
  dispatch: (args) => {
    // Client request key: correlates the server's doc_edit_started (which
    // carries the authoritative docEditId + echoed offsets/file) back to this
    // pending entry. We key the pending entry on the request key; onStarted
    // records the server id while keeping the client lookup stable. Since the affordance dispatches ONE
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
    if (!sender || !sender(args)) set(s => ({ byId: { ...s.byId, [requestKey]: { ...s.byId[requestKey], status: 'error', error: 'Not connected. Retry when the connection returns.' } } }));
    return requestKey;
  },
  // The server assigns the real docEditId. Keep the client lookup key for
  // this file onto the authoritative id (the affordance dispatches one request
  // at a time per modal, so a per-file match is unambiguous).
  onStarted: (docEditId, filePath) => set((s) => {
    if (s.byId[docEditId]) return s; // already re-keyed
    const pendingKey = Object.keys(s.byId).find((k) =>
      s.byId[k].status === 'pending' && s.byId[k].filePath === filePath);
    if (!pendingKey) return s;
    const entry = { ...s.byId[pendingKey], docEditId };
    const next = { ...s.byId, [pendingKey]: entry };
    return { byId: next };
  }),
  onProposed: (docEditId, patch) => set((s) => {
    // Match by authoritative id; fall back to the pending entry with matching
    // file+offsets (covers a started event we never saw, e.g. dropped frame).
    let key = Object.keys(s.byId).find(k => k === docEditId || s.byId[k].docEditId === docEditId);
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
    next[key] = {
      ...entry,
      docEditId,
      status: patch.error ? 'error' : 'proposed',
      replacement: patch.replacement,
      error: patch.error,
    };
    return { byId: next };
  }),
  onDisconnected: () => set(s => ({ byId: Object.fromEntries(Object.entries(s.byId).map(([key, entry]) => [key, entry.status === 'pending' ? { ...entry, status: 'error', error: 'Connection lost. Retry when the connection returns.' } : entry])) })),
  clear: (docEditId) => set((s) => {
    if (!s.byId[docEditId]) return s;
    const next = { ...s.byId };
    delete next[docEditId];
    return { byId: next };
  }),
}));
