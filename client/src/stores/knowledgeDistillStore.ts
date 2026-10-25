import { create } from 'zustand';
import type { ProviderName, ModelName, EffortLevel } from '@arco/shared';

// WORKBENCH_EXPANSION_PLAN.md §B3 — knowledge "distill from session" client
// store. Kept OUT of appStore (mirrors docEditStore): the distill DRAFT is a
// transient wizard concern, not per-tab session state.
//
// The KnowledgeWizard is mounted per-tab and dispatches ONE distill at a time,
// so the store tracks a single in-flight draft keyed by workflowId. useWebSocket
// registers the module-level sender; handleServerMessage routes
// knowledge_distill_started / _proposed back here.
//
// FENCE: this store only TRACKS the draft. Nothing here saves to the KB — the
// wizard's Save button POSTs to /api/knowledge (the operator's explicit, only
// persist path). The agent drafts; the operator approves.

export type DistillStatus = 'pending' | 'proposed' | 'error';

export interface DistillEntry {
  workflowId: string;
  distillId: string;
  status: DistillStatus;
  title: string;
  body: string;
  tags: string[];
  error?: string;
}

export interface DistillRequestArgs {
  workflowId: string;
  drafter: { provider: ProviderName; model: ModelName; effort: EffortLevel; providerAccountRef?: string };
  focus?: string;
}

type DistillSender = (args: DistillRequestArgs) => void;
let sender: DistillSender | null = null;
export function registerDistillSender(fn: DistillSender | null) { sender = fn; }

interface DistillState {
  // Keyed by workflowId — one in-flight draft per tab's wizard.
  byWorkflow: Record<string, DistillEntry>;
  dispatch: (args: DistillRequestArgs) => void;
  onStarted: (workflowId: string, distillId: string) => void;
  onProposed: (
    workflowId: string,
    patch: { distillId: string; title: string; body: string; tags: string[]; error?: string },
  ) => void;
  clear: (workflowId: string) => void;
}

export const useKnowledgeDistillStore = create<DistillState>((set) => ({
  byWorkflow: {},
  dispatch: (args) => {
    set((s) => ({
      byWorkflow: {
        ...s.byWorkflow,
        [args.workflowId]: {
          workflowId: args.workflowId,
          distillId: '',
          status: 'pending',
          title: '',
          body: '',
          tags: [],
        },
      },
    }));
    if (sender) sender(args);
  },
  onStarted: (workflowId, distillId) => set((s) => {
    const e = s.byWorkflow[workflowId];
    if (!e || e.status !== 'pending') return s;
    return { byWorkflow: { ...s.byWorkflow, [workflowId]: { ...e, distillId } } };
  }),
  onProposed: (workflowId, patch) => set((s) => ({
    byWorkflow: {
      ...s.byWorkflow,
      [workflowId]: {
        workflowId,
        distillId: patch.distillId,
        status: patch.error ? 'error' : 'proposed',
        title: patch.title,
        body: patch.body,
        tags: patch.tags,
        error: patch.error,
      },
    },
  })),
  clear: (workflowId) => set((s) => {
    if (!s.byWorkflow[workflowId]) return s;
    const next = { ...s.byWorkflow };
    delete next[workflowId];
    return { byWorkflow: next };
  }),
}));
