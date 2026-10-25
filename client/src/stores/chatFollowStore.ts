import { create } from 'zustand';

// Transient operator intent. Retain one request so navigation can precede the
// target ChatPanel mount; unrelated/background worker updates never re-pin it.
export const useChatFollowStore = create<{ request: { workflowId: string; seq: number } | null }>(() => ({ request: null }));
export function requestChatFollow(workflowId: string): void {
  useChatFollowStore.setState((s) => ({ request: { workflowId, seq: (s.request?.seq ?? 0) + 1 } }));
}
