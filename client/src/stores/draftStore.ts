import { create } from 'zustand';

// Composer drafts live HERE, not in appStore. This is a performance boundary,
// not a code-organisation preference — please don't fold it back in.
//
// Measured on the EliteBook (2026-08-06, Event Timing API, same page / same
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
  setDraft: (jobId: string, text: string) => void;
  clearDraft: (jobId: string) => void;
}

export const useDraftStore = create<DraftState>((set) => ({
  drafts: {},

  setDraft: (jobId, text) =>
    set((s) => {
      // Tombstone empty strings to keep the drafts map small; a missing key
      // reads back as '' at the callsite. (Behaviour carried over verbatim
      // from appStore so tab-switch / clear semantics are unchanged.)
      if (text === '') {
        if (!(jobId in s.drafts)) return {};
        const { [jobId]: _, ...rest } = s.drafts;
        return { drafts: rest };
      }
      if (s.drafts[jobId] === text) return {};
      return { drafts: { ...s.drafts, [jobId]: text } };
    }),

  clearDraft: (jobId) =>
    set((s) => {
      if (!(jobId in s.drafts)) return {};
      const { [jobId]: _, ...rest } = s.drafts;
      return { drafts: rest };
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
