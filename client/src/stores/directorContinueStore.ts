// Continue the Director (docs/PROTOCOL_CLUSTER.md): the server's current offer
// per Director workflow, and the one-line notice after a click that started
// nothing. Live only; a reconnecting client gets the offer again.
import { create } from 'zustand';
import type { DirectorContinueOffer } from '@arco/shared';

interface DirectorContinueState {
  offers: Record<string, DirectorContinueOffer | undefined>;
  notices: Record<string, string | undefined>;
  apply: (workflowId: string, offer: DirectorContinueOffer | null, notice?: string) => void;
  clearNotice: (workflowId: string) => void;
}

export const useDirectorContinueStore = create<DirectorContinueState>((set) => ({
  offers: {},
  notices: {},
  apply: (workflowId, offer, notice) => set((s) => ({
    offers: { ...s.offers, [workflowId]: offer ?? undefined },
    notices: notice ? { ...s.notices, [workflowId]: notice } : offer ? { ...s.notices, [workflowId]: undefined } : s.notices,
  })),
  clearNotice: (workflowId) => set((s) => ({ notices: { ...s.notices, [workflowId]: undefined } })),
}));
