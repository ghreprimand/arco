import { create } from 'zustand';
import type {
  OrchestrationAssistKind,
  OrchestrationAssistModelRef,
  OrchestrationInputRef,
  OrchestrationProposal,
} from '@arco/shared';

export interface OrchestrationAssistRequestArgs {
  clusterId: string;
  workflowId: string;
  requestId: string;
  kind: OrchestrationAssistKind;
  prompt: string;
  inputRefs?: OrchestrationInputRef[];
  model: OrchestrationAssistModelRef;
}

type AssistSender = (args: OrchestrationAssistRequestArgs) => void;
let sender: AssistSender | null = null;
export function registerOrchestrationAssistSender(fn: AssistSender | null) { sender = fn; }

interface OrchestrationAssistState {
  byCluster: Record<string, OrchestrationProposal[]>;
  selectedProposalId: Record<string, string | null>;
  dispatch: (args: Omit<OrchestrationAssistRequestArgs, 'requestId'>) => string;
  upsertProposal: (proposal: OrchestrationProposal) => void;
  replaceClusterProposals: (clusterId: string, proposals: OrchestrationProposal[]) => void;
  markRejected: (clusterId: string, proposalId: string) => void;
  markApplied: (clusterId: string, proposalId: string, itemIds: string[]) => void;
  selectProposal: (clusterId: string, proposalId: string | null) => void;
}

function sortProposals(rows: OrchestrationProposal[]): OrchestrationProposal[] {
  return [...rows].sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
}

export const useOrchestrationAssistStore = create<OrchestrationAssistState>((set, get) => ({
  byCluster: {},
  selectedProposalId: {},
  dispatch: (args) => {
    const requestId = `assist-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    sender?.({ ...args, requestId });
    return requestId;
  },
  upsertProposal: (proposal) => set((s) => {
    const current = s.byCluster[proposal.clusterId] ?? [];
    const idx = current.findIndex((p) => p.id === proposal.id);
    const next = idx >= 0
      ? current.map((p, i) => (i === idx ? proposal : p))
      : [proposal, ...current];
    return {
      byCluster: { ...s.byCluster, [proposal.clusterId]: sortProposals(next) },
      selectedProposalId: {
        ...s.selectedProposalId,
        [proposal.clusterId]: s.selectedProposalId[proposal.clusterId] ?? proposal.id,
      },
    };
  }),
  replaceClusterProposals: (clusterId, proposals) => set((s) => ({
    byCluster: { ...s.byCluster, [clusterId]: sortProposals(proposals) },
    selectedProposalId: {
      ...s.selectedProposalId,
      [clusterId]: proposals.some((p) => p.id === s.selectedProposalId[clusterId])
        ? s.selectedProposalId[clusterId]
        : proposals[0]?.id ?? null,
    },
  })),
  markRejected: (clusterId, proposalId) => set((s) => ({
    byCluster: {
      ...s.byCluster,
      [clusterId]: (s.byCluster[clusterId] ?? []).map((p) =>
        p.id === proposalId ? { ...p, status: 'rejected', updatedAt: Date.now() } : p),
    },
  })),
  markApplied: (clusterId, proposalId, itemIds) => set((s) => ({
    byCluster: {
      ...s.byCluster,
      [clusterId]: (s.byCluster[clusterId] ?? []).map((p) => {
        if (p.id !== proposalId) return p;
        const acceptedItemIds = [...new Set([...(p.acceptedItemIds ?? []), ...itemIds])];
        return {
          ...p,
          status: acceptedItemIds.length >= p.items.length ? 'accepted' : 'partially_accepted',
          acceptedItemIds,
          updatedAt: Date.now(),
        };
      }),
    },
  })),
  selectProposal: (clusterId, proposalId) => set((s) => ({
    selectedProposalId: { ...s.selectedProposalId, [clusterId]: proposalId },
  })),
}));
