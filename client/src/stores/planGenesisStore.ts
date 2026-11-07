import { create } from 'zustand';

export type PlanGenesisOrigin =
  | { kind: 'creator'; cwd: string; creatorDraftKey: string }
  | { kind: 'cluster'; cwd: string; clusterId: string }
  | { kind: 'workflow'; cwd: string; workflowId: string };

export type PlanGenesisResult = { origin: PlanGenesisOrigin; planId: string | null };

interface PlanGenesisState {
  pending: Record<string, PlanGenesisOrigin>;
  active: Record<string, PlanGenesisOrigin>;
  results: Record<string, PlanGenesisResult>;
  begin: (token: string, origin: PlanGenesisOrigin) => void;
  bind: (token: string, workflowId: string) => PlanGenesisOrigin | null;
  cancelPending: (token: string) => void;
  cancelCreator: (creatorDraftKey: string) => void;
  finish: (workflowId: string, cwd: string, planId: string) => PlanGenesisOrigin | null;
  cancel: (workflowId: string) => PlanGenesisOrigin | null;
  clearResult: (workflowId: string) => void;
}

// The origin stays in the client; only the normal workflow configuration is sent.
export const usePlanGenesisStore = create<PlanGenesisState>((set, get) => ({
  pending: {}, active: {}, results: {},
  begin: (token, origin) => set(state => ({ pending: { ...state.pending, [token]: origin } })),
  bind: (token, workflowId) => {
    const origin = get().pending[token];
    if (!origin) return null;
    set(state => {
      const { [token]: _removed, ...pending } = state.pending;
      return { pending, active: { ...state.active, [workflowId]: origin } };
    });
    return origin;
  },
  cancelPending: token => set(state => {
    const { [token]: _removed, ...pending } = state.pending;
    return { pending };
  }),
  cancelCreator: creatorDraftKey => set(state => ({
    pending: Object.fromEntries(Object.entries(state.pending).filter(([, origin]) => origin.kind !== 'creator' || origin.creatorDraftKey !== creatorDraftKey)),
    active: Object.fromEntries(Object.entries(state.active).filter(([, origin]) => origin.kind !== 'creator' || origin.creatorDraftKey !== creatorDraftKey)),
    results: Object.fromEntries(Object.entries(state.results).filter(([, result]) => result.origin.kind !== 'creator' || result.origin.creatorDraftKey !== creatorDraftKey)),
  })),
  finish: (workflowId, cwd, planId) => {
    const origin = get().active[workflowId];
    if (!origin || origin.cwd !== cwd || !planId) return null;
    set(state => {
      const { [workflowId]: _removed, ...active } = state.active;
      return { active, results: { ...state.results, [workflowId]: { origin, planId } } };
    });
    return origin;
  },
  cancel: workflowId => {
    const origin = get().active[workflowId];
    if (!origin) return null;
    set(state => {
      const { [workflowId]: _removed, ...active } = state.active;
      return { active, results: { ...state.results, [workflowId]: { origin, planId: null } } };
    });
    return origin;
  },
  clearResult: workflowId => set(state => {
    const { [workflowId]: _removed, ...results } = state.results;
    return { results };
  }),
}));
