import { create } from 'zustand';
import { COMPUTER_PROVIDERS, type ComputerProvider, type EffortLevel } from '@arco/shared';

export interface ComputerSelection { provider: ComputerProvider; model: string; effort: EffortLevel; history: 'saved' | 'none' }
const KEY = 'arco.computer.selection.v1';
const defaults: ComputerSelection = { provider: 'codex', model: 'gpt-6-luna', effort: 'low', history: 'saved' };
function load(): { selection: ComputerSelection; automatic: boolean } {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (value && COMPUTER_PROVIDERS.includes(value.provider) && typeof value.model === 'string'
      && ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(value.effort)
      && ['saved', 'none'].includes(value.history) && !(value.provider === 'strata' && value.history === 'none')) return { selection: value, automatic: false };
  } catch { /* preferences are optional */ }
  return { selection: defaults, automatic: true };
}
// Only non-content preferences persist. Never store an Incognito workflow id.
export const useComputerStore = create<{
  open: boolean; setOpen: (open: boolean) => void;
  automatic: boolean; selection: ComputerSelection; activeId: string | null;
  contextEpoch: number;
  pending: ComputerSelection | null; error: string | null;
  select: (selection: ComputerSelection, id: string) => void;
}>((set) => ({
  open: false, setOpen: (open) => set({ open }), ...load(), activeId: null, contextEpoch: 0, pending: null, error: null,
  select: (selection, activeId) => {
    try { localStorage.setItem(KEY, JSON.stringify(selection)); } catch {}
    set((s) => ({ selection, activeId, automatic: false, pending: null, error: null, contextEpoch: s.contextEpoch + (s.selection.provider !== selection.provider || s.selection.model !== selection.model || s.selection.effort !== selection.effort || s.selection.history !== selection.history ? 1 : 0) }));
  },
}));
export function computerPrivate(): boolean {
  const state = useComputerStore.getState();
  return state.selection.history === 'none' || state.pending?.history === 'none';
}

export const computerCaptureKey = () => JSON.stringify([useComputerStore.getState().selection, useComputerStore.getState().contextEpoch]);
