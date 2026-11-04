import { create } from 'zustand';

// Composer drafts live HERE, not in appStore. This is a performance boundary,
// not a code-organisation preference — please don't fold it back in.
//
// Measured on a low-power laptop (Event Timing API, same page / same
// instant / same keyboard):
//
//   composer textarea (draft in appStore)   median 37.2ms per keystroke
//   NORTH STAR input  (plain local state)   median  4.2ms per keystroke
//
// A 9x gap with identical rendering work. The cause is Zustand's fan-out: every
// `set()` on a store notifies EVERY subscriber of that store, each of which
// re-runs its selector. appStore has several hundred mounted subscriptions,
// some looping over clusters/members/jobs. Typing wrote appStore on every
// character, so each keystroke paid the whole fan-out — ~57ms of script inside
// the `oninput` listener (confirmed by Long Animation Frames: styleAndLayout
// was 0ms, i.e. none of it was CSS or layout). Events then queued behind each
// other, producing 2.5s+ blocking frames and multi-second input delay.
//
// Splitting the drafts map into its own store keeps the semantics EXACTLY the
// same — still a synchronous write, still the single source of truth, still
// shared across tabs and readable by the terminal bridge / ReviewTab / the
// seed-prompt handler — but a keystroke now notifies only the two small
// composer components that subscribe here, instead of all of appStore.
//
// Deliberately NOT a debounce: that would leave the store transiently stale and
// force flush handling on send / blur / unmount, which is exactly the kind of
// edge case that turns into a "message sent without my last word" bug.
interface DraftState {
  drafts: Record<string, string>;
  tidyUndo: Record<string, { original: string; replacement: string }>;
  applyTidy: (jobId: string, expected: string, replacement: string) => boolean;
  undoTidy: (jobId: string) => boolean;
  setDraft: (jobId: string, text: string) => void;
  clearDraft: (jobId: string) => void;
}

export const useDraftStore = create<DraftState>((set) => ({
  drafts: {},
  tidyUndo: {},
  applyTidy: (jobId, expected, replacement) => {
    let applied = false;
    set((s) => {
      if (!replacement.trim() || (s.drafts[jobId] ?? '') !== expected) return {};
      applied = true;
      return { drafts: { ...s.drafts, [jobId]: replacement }, tidyUndo: { ...s.tidyUndo, [jobId]: { original: expected, replacement } } };
    });
    return applied;
  },
  undoTidy: (jobId) => {
    let restored = false;
    set((s) => {
      const item = s.tidyUndo[jobId];
      if (!item || (s.drafts[jobId] ?? '') !== item.replacement) return {};
      const { [jobId]: _, ...remaining } = s.tidyUndo;
      restored = true;
      return { drafts: { ...s.drafts, [jobId]: item.original }, tidyUndo: remaining };
    });
    return restored;
  },

  setDraft: (jobId, text) =>
    set((s) => {
      // Tombstone empty strings to keep the drafts map small; a missing key
      // reads back as '' at the callsite. (Behaviour carried over verbatim
      // from appStore so tab-switch / clear semantics are unchanged.)
      if (s.drafts[jobId] === text || (text === '' && !(jobId in s.drafts))) return {};
      const { [jobId]: _undo, ...tidyUndo } = s.tidyUndo;
      if (text === '') {
        const { [jobId]: _, ...rest } = s.drafts;
        return { drafts: rest, tidyUndo };
      }
      return { drafts: { ...s.drafts, [jobId]: text }, tidyUndo };
    }),

  clearDraft: (jobId) =>
    set((s) => {
      if (!(jobId in s.drafts) && !(jobId in s.tidyUndo)) return {};
      const { [jobId]: _, ...rest } = s.drafts;
      const { [jobId]: _undo, ...tidyUndo } = s.tidyUndo;
      return { drafts: rest, tidyUndo };
    }),
}));

// Non-reactive read for event handlers (send, Escape-when-empty, slash-command
// prefixing). Reads at call time so it is always current without subscribing.
export function readDraft(jobId: string): string {
  return useDraftStore.getState().drafts[jobId] ?? '';
}

// Called from appStore.removeJob so closing a tab still drops its draft.
export function dropDraftForJob(jobId: string): void {
  useDraftStore.getState().clearDraft(jobId);
}
