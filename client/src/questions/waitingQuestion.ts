import type { JobState } from '../stores/appStore';
import type { ClusterStatePayload } from '@arco/shared';
import { useAppStore } from '../stores/appStore';

export function hasWaitingQuestion(job: JobState | undefined): boolean {
  return !!job && ((job.claudeNativePendingQuestionIds?.length ?? 0) > 0 || job.messages.some((m) => m.operatorQuestion?.status === 'pending'));
}

export function setClaudeQuestionIds(workflowId: string, ids: string[]): void {
  useAppStore.setState((state) => {
    const job = state.jobs[workflowId];
    return job ? { jobs: { ...state.jobs, [workflowId]: { ...job, claudeNativePendingQuestionIds: ids } } } : state;
  });
}

export function clusterName(cluster: ClusterStatePayload): string {
  if (cluster.name?.trim()) return cluster.name;
  const path = cluster.cwd.replace(/[/\\]+$/, '');
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
  return name ? `${name} · ${cluster.clusterId.slice(0, 8)}` : cluster.clusterId.slice(0, 8);
}

export function questionToastText(workflowId: string): string {
  const state = useAppStore.getState();
  const cluster = Object.values(state.clusters).find((c) => c.members.some((m) => m.workflowId === workflowId));
  const member = cluster?.members.find((m) => m.workflowId === workflowId);
  const name = member?.displayName || state.jobs[workflowId]?.config.name || workflowId.slice(0, 8);
  return cluster ? `${name} in ${clusterName(cluster)} has a question` : `${name} has a question`;
}

export function notifyQuestion(workflowId: string, requestId?: string): void {
  if (!requestId) { useAppStore.getState().pushNotification('info', questionToastText(workflowId), workflowId); return; }
  useAppStore.setState((s) => ({ notifications: [...s.notifications.slice(-9), { id: `question-${requestId}`, level: 'info', message: questionToastText(workflowId), workflowId, createdAt: Date.now() }] }));
}
