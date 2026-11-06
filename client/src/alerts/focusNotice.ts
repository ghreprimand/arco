import { useAppStore } from '../stores/appStore';

// Open only a tab that still exists. Notices may outlive their tab.
export function focusNoticeWorkflow(workflowId: string): void {
  const state = useAppStore.getState();
  const cluster = Object.values(state.clusters).find((c) => c.members.some((m) => m.workflowId === workflowId));
  const job = state.jobs[workflowId];
  if (cluster && state.jobs[workflowId]) {
    state.setActiveCluster(cluster.clusterId);
    state.setClusterFocusedMember(cluster.clusterId, workflowId);
  } else if (job && !cluster && !job.config.voiceOperator && (!job.parentWorkflowId || job.promoted === true)) {
    state.setActiveJob(workflowId);
  } else {
    state.pushNotification('info', 'That tab is no longer open.');
  }
}
