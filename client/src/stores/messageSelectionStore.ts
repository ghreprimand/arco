import { create } from 'zustand';

// Chat messages the operator ticked in a tab, for FORWARD (and later actions
// that work on a few messages). Transient: not persisted, cleared per tab.
interface State {
  selected: Record<string, string[]>;
  toggle: (workflowId: string, messageId: string) => void;
  clear: (workflowId: string) => void;
}

export const useMessageSelectionStore = create<State>((set) => ({
  selected: {},
  toggle: (workflowId, messageId) => set((s) => {
    const cur = s.selected[workflowId] ?? [];
    const next = cur.includes(messageId) ? cur.filter((id) => id !== messageId) : [...cur, messageId];
    const { [workflowId]: _old, ...rest } = s.selected;
    return { selected: next.length ? { ...rest, [workflowId]: next } : rest };
  }),
  clear: (workflowId) => set((s) => {
    if (!s.selected[workflowId]) return s;
    const { [workflowId]: _old, ...rest } = s.selected;
    return { selected: rest };
  }),
}));

export const EMPTY_SELECTION: string[] = [];
