import { create } from 'zustand';
import type { WorkbenchNotice, WorkbenchNoticeCategory } from '@arco/shared';

// docs/ARCHITECTURE.md - client notification store. Kept OUT of appStore
// (mirrors recallStore / terminalStore): notices are a global, cross-workflow
// projection, not per-tab session state. Holds the scrollable `notices` history
// for the header notice center, the server-authoritative muted-category set,
// and a last-seen marker for the unread badge. The transient heads-up reuses
// the existing app-level toast strip (`appStore.pushNotification`) — this store
// is the durable record + mute UI source of truth.
//
// Mute is enforced SERVER-side (a muted category never broadcasts), so the
// store only mirrors the set for the toggle UI — it never has to filter
// incoming notices itself.

const HISTORY_CAP = 50;

interface NotificationState {
  notices: WorkbenchNotice[];        // newest first, capped
  muted: WorkbenchNoticeCategory[];  // server-authoritative
  lastSeenTs: number;                // notices with ts > lastSeenTs are "unread"
  pushNotice: (n: WorkbenchNotice) => void;
  setMutedFromServer: (muted: WorkbenchNoticeCategory[]) => void;
  markAllSeen: () => void;
  clearHistory: () => void;
}

export const useNotificationStore = create<NotificationState>((set) => ({
  notices: [],
  muted: [],
  lastSeenTs: 0,
  pushNotice: (n) =>
    set((s) => ({
      // Dedup by id (a reconnect could replay; the server doesn't, but be safe).
      notices: s.notices.some((x) => x.id === n.id) ? s.notices : [n, ...s.notices].slice(0, HISTORY_CAP),
    })),
  setMutedFromServer: (muted) => set({ muted }),
  markAllSeen: () => set((s) => ({ lastSeenTs: s.notices[0]?.ts ?? s.lastSeenTs })),
  clearHistory: () => set({ notices: [] }),
}));

// Convenience selector for the unread badge (notices newer than last seen).
export function unreadCount(s: NotificationState): number {
  return s.notices.filter((n) => n.ts > s.lastSeenTs).length;
}
