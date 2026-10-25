import { create } from 'zustand';
import type { LiveChangesSnapshotMessage, WorkingChangesResponse } from '@arco/shared';

type Sender = (msg: { type: 'live_changes_subscribe' | 'live_changes_unsubscribe'; workflowId: string; cwd?: string }) => void;

let sender: Sender | null = null;

export function registerLiveChangesSender(fn: Sender | null) {
  sender = fn;
}

export function requestLiveChangesSubscribe(workflowId: string, cwd?: string) {
  sender?.({ type: 'live_changes_subscribe', workflowId, ...(cwd ? { cwd } : {}) });
}

export function requestLiveChangesUnsubscribe(workflowId: string, cwd?: string) {
  sender?.({ type: 'live_changes_unsubscribe', workflowId, ...(cwd ? { cwd } : {}) });
}

export function liveChangesKey(workflowId: string, cwd: string): string {
  return `${workflowId}\0${cwd}`;
}

interface LiveSnapshot {
  cwd: string;
  ts: number;
  data: WorkingChangesResponse;
  fingerprints?: Record<string, string>;
}

interface LiveChangesState {
  snapshots: Record<string, LiveSnapshot>;
  onSnapshot: (msg: LiveChangesSnapshotMessage) => void;
  clear: (workflowId: string, cwd: string) => void;
}

export const useLiveChangesStore = create<LiveChangesState>((set) => ({
  snapshots: {},
  onSnapshot: (msg) => set((s) => ({
    snapshots: {
      ...s.snapshots,
      [liveChangesKey(msg.workflowId, msg.cwd)]: {
        cwd: msg.cwd,
        ts: msg.ts,
        data: msg.data,
        fingerprints: msg.fingerprints,
      },
    },
  })),
  clear: (workflowId, cwd) => set((s) => {
    const key = liveChangesKey(workflowId, cwd);
    if (!s.snapshots[key]) return s;
    const next = { ...s.snapshots };
    delete next[key];
    return { snapshots: next };
  }),
}));
