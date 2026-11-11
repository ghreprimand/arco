import type { WorkflowState } from './workflows/types.js';

export const CLUSTER_TOOLS_PENDING_NOTICE = 'This tab is working. It gets its cluster tools when the current turn ends.';
export const CLUSTER_TOOLS_PENDING_AGENT = "[Arco cluster tools pending] This tab joined a cluster during the current turn. Its cluster tools become available on the next turn. Until then, continue only work supported by the tools already available. Do not work around the missing tools: do not read internal cluster state or make direct calls to Arco's routes. Arco will provide the cluster role and instructions with the cluster tools on the next turn.";

// Presence means configuration was captured, even for a standalone dispatch.
// Busy preparation before that capture can already acquire the new tools.
export function clusterToolsPending(wf: WorkflowState | undefined, clusterId: string | undefined): boolean {
  return !!(wf?.busy && clusterId && wf.primaryTurn?.clusterDispatch
    && wf.primaryTurn.clusterDispatch.clusterId !== clusterId);
}
