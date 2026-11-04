import type { EffortLevel, ModelName, ProviderName, WorkflowConfig } from '@arco/shared';

// The summarizer Recall uses for a conversation: the open tab's own primary
// when there is one, else the hit's provider with a default model and effort
// (the server degrades to the deterministic digest if that provider is not
// signed in). Shared by the Recall Summarize action and summarize-on-close so
// both use the same choice.
export function recallSummarizerFor(cfg: Pick<WorkflowConfig, 'primaryProvider' | 'primaryModel' | 'primaryEffort' | 'providerAccountRef'> | undefined, fallbackProvider: ProviderName): {
  provider: ProviderName; model: ModelName; effort: EffortLevel; providerAccountRef?: string;
} {
  return {
    provider: (cfg?.primaryProvider ?? fallbackProvider) as ProviderName,
    model: (cfg?.primaryModel ?? 'default') as ModelName,
    effort: (cfg?.primaryEffort ?? 'high') as EffortLevel,
    providerAccountRef: cfg?.providerAccountRef,
  };
}

export interface CloseSummaryPlan {
  wfid: string;
  title: string;
  summarizer: ReturnType<typeof recallSummarizerFor>;
}

// Whether closing this tab starts a Recall summary. Only when the operator armed
// "summarize on tab close", the tab is not Incognito and it has a saved session
// (an operator message, or a resumed session). Anything else does nothing.
export function closeSummaryPlan(
  job: { id: string; resumedVia?: string; messages: readonly { role?: string }[]; config: Pick<WorkflowConfig, 'incognito' | 'name' | 'primaryProvider' | 'primaryModel' | 'primaryEffort' | 'providerAccountRef'> } | undefined,
  armed: boolean,
): CloseSummaryPlan | null {
  if (!armed || !job || job.config.incognito) return null;
  if (!job.resumedVia && !job.messages.some((m) => m.role === 'user')) return null;
  return { wfid: job.id, title: job.config.name || job.id.slice(0, 8), summarizer: recallSummarizerFor(job.config, job.config.primaryProvider ?? 'claude') };
}
