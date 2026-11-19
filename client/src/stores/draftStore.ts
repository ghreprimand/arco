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
export type DraftSkillPick = { scope: 'project' | 'global' | 'builtin'; slug: string; name?: string };
export function mergeDraftSkillPicks(...groups: unknown[]): DraftSkillPick[] {
  const result: DraftSkillPick[] = [];
  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    for (const pick of group) {
      if (!pick || !['project', 'global', 'builtin'].includes(pick.scope) || typeof pick.slug !== 'string' || !pick.slug) continue;
      if (result.some(p => p.scope === pick.scope && p.slug === pick.slug)) continue;
      result.push({ scope: pick.scope, slug: pick.slug, ...(typeof pick.name === 'string' ? { name: pick.name } : {}) });
    }
  }
  return result;
}
export function clearDraftSkillPicks(jobId: string): void {
  useDraftStore.setState(s => { const { [jobId]: _, ...queueEditSkills } = s.queueEditSkills; return { queueEditSkills }; });
}

export type TaskChildSend = { id: string; content: string; state: 'awaiting' | 'unconfirmed' | 'rejected' };
const TASK_CHILD_SENDS_KEY = 'arco.taskChildSends';
export function readSavedTaskChildSends(storage: Pick<Storage, 'getItem'> | null): Record<string, TaskChildSend> {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(TASK_CHILD_SENDS_KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).flatMap(([jobId, value]) => {
      if (!value || typeof value !== 'object') return [];
      const item = value as Partial<TaskChildSend>;
      if (typeof item.id !== 'string' || typeof item.content !== 'string') return [];
      return [[jobId, { id: item.id, content: item.content, state: item.state === 'rejected' ? 'rejected' : 'unconfirmed' }]];
    }));
  } catch { return {}; }
}
function taskSendStorage(): Storage | null {
  try { return typeof sessionStorage === 'undefined' ? null : sessionStorage; } catch { return null; }
}
const restoredTaskSends = readSavedTaskChildSends(taskSendStorage());
interface DraftState {
  taskChildSends: Record<string, TaskChildSend>;
  beginTaskChildSend: (jobId: string, id: string, content: string) => void;
  acceptTaskChildSend: (jobId: string, id: string) => void;
  rejectTaskChildSend: (jobId: string, id: string) => void;
  disconnectTaskChildSends: () => void;
  releaseTaskChildSend: (jobId: string) => void;
  drafts: Record<string, string>;
  queueEditSkills: Record<string, DraftSkillPick[]>;
  queueEditKinds: Record<string, 'steer' | 'follow-up' | 'interrupt'>;
  tidyUndo: Record<string, { original: string; replacement: string }>;
  applyTidy: (jobId: string, expected: string, replacement: string) => boolean;
  undoTidy: (jobId: string) => boolean;
  setDraft: (jobId: string, text: string) => void;
  clearDraft: (jobId: string) => void;
}

export const useDraftStore = create<DraftState>((set) => ({
  drafts: Object.fromEntries(Object.entries(restoredTaskSends).map(([id, pending]) => [id, pending.content])),
  taskChildSends: restoredTaskSends,
  beginTaskChildSend: (jobId, id, content) => set((s) => ({ taskChildSends: { ...s.taskChildSends, [jobId]: { id, content, state: 'awaiting' } } })),
  acceptTaskChildSend: (jobId, id) => set((s) => {
    const pending = s.taskChildSends[jobId];
    if (!pending || pending.id !== id) return {};
    const { [jobId]: _, ...taskChildSends } = s.taskChildSends;
    if (s.drafts[jobId] !== pending.content) return { taskChildSends };
    const { [jobId]: _draft, ...drafts } = s.drafts;
    return { taskChildSends, drafts };
  }),
  rejectTaskChildSend: (jobId, id) => set((s) => {
    const pending = s.taskChildSends[jobId];
    if (!pending || pending.id !== id) return {};
    return { taskChildSends: { ...s.taskChildSends, [jobId]: { ...pending, state: 'rejected' } } };
  }),
  disconnectTaskChildSends: () => set((s) => ({ taskChildSends: Object.fromEntries(Object.entries(s.taskChildSends).map(([id, pending]) => [id, pending.state === 'awaiting' ? { ...pending, state: 'unconfirmed' as const } : pending])) })),
  releaseTaskChildSend: (jobId) => set((s) => { const { [jobId]: _, ...taskChildSends } = s.taskChildSends; return { taskChildSends }; }),
  queueEditSkills: {},
  queueEditKinds: {},
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
      if ((s.drafts[jobId] === text || (text === '' && !(jobId in s.drafts))) && !(text === '' && jobId in s.queueEditKinds)) return {};
      const { [jobId]: _undo, ...tidyUndo } = s.tidyUndo;
      if (text === '') {
        const { [jobId]: _, ...rest } = s.drafts;
        const { [jobId]: _kind, ...queueEditKinds } = s.queueEditKinds;
        return { drafts: rest, tidyUndo, queueEditKinds };
      }
      return { drafts: { ...s.drafts, [jobId]: text }, tidyUndo };
    }),

  clearDraft: (jobId) =>
    set((s) => {
      if (!(jobId in s.drafts) && !(jobId in s.tidyUndo) && !(jobId in s.queueEditKinds) && !(jobId in s.queueEditSkills)) return {};
      const { [jobId]: _, ...rest } = s.drafts;
      const { [jobId]: _undo, ...tidyUndo } = s.tidyUndo;
      const { [jobId]: _kind, ...queueEditKinds } = s.queueEditKinds;
      const { [jobId]: _skills, ...queueEditSkills } = s.queueEditSkills;
      return { drafts: rest, tidyUndo, queueEditKinds, queueEditSkills };
    }),
}));

// Pending child messages survive a reload in this browser tab. They are never
// resent automatically; after reload their delivery is unconfirmed until replay.
useDraftStore.subscribe((state, previous) => {
  if (state.taskChildSends === previous.taskChildSends) return;
  try {
    const storage = taskSendStorage();
    if (!storage) return;
    if (Object.keys(state.taskChildSends).length) storage.setItem(TASK_CHILD_SENDS_KEY, JSON.stringify(state.taskChildSends));
    else storage.removeItem(TASK_CHILD_SENDS_KEY);
  } catch { /* retain the in-memory draft if browser storage is unavailable */ }
});

// Non-reactive read for event handlers (send, Escape-when-empty, slash-command
// prefixing). Reads at call time so it is always current without subscribing.
export function readDraft(jobId: string): string {
  return useDraftStore.getState().drafts[jobId] ?? '';
}

// Called from appStore.removeJob so closing a tab still drops its draft.
// Keep a pending child send recoverable if its workflow disappears.
export function dropDraftForJob(jobId: string): void {
  if (!useDraftStore.getState().taskChildSends[jobId]) useDraftStore.getState().clearDraft(jobId);
}
