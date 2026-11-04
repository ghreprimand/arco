import { create } from 'zustand';
import type { StorageWarningMessage } from '@arco/shared';

interface WarningState {
  warnings: StorageWarningMessage[];
  add: (warning: StorageWarningMessage) => void;
  removeItem: (workflowId: string, path: string) => void;
}
export const useStorageWarningStore = create<WarningState>((set) => ({
  warnings: [],
  add: (warning) => set((s) => {
    const previous = s.warnings.find((w) => w.workflowId === warning.workflowId);
    const items = new Map((previous?.items ?? []).map((i) => [i.path, i]));
    for (const item of warning.items) items.set(item.path, item);
    return { warnings: [...s.warnings.filter((w) => w.workflowId !== warning.workflowId), { ...warning, items: [...items.values()] }].slice(-20) };
  }),
  removeItem: (workflowId, path) => set((s) => ({ warnings: s.warnings.map((w) => w.workflowId === workflowId ? { ...w, items: w.items.filter((i) => i.path !== path) } : w).filter((w) => w.items.length > 0) })),
}));
