import { noticeSourceLabel } from '@arco/shared';
import * as clusterStore from './clusterStore.js';
import { workflows } from './server/state.js';

/** Snapshot the source when the event is raised, before a tab can be closed. */
export function noticeSourceFor(workflowId: string, fallbackName?: string): string {
  const name = workflows.get(workflowId)?.config.name || fallbackName || workflowId.slice(0, 8);
  const clusterId = clusterStore.getClusterIdForWorkflow(workflowId);
  const cluster = clusterId ? clusterStore.getClusterCached(clusterId) : null;
  return noticeSourceLabel(name, cluster);
}
