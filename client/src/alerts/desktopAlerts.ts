import { attentionTitle, type AttentionEventMessage, type AttentionKind, type NotificationChannelsView } from '@arco/shared';
import { useAppStore } from '../stores/appStore';
import { useNotificationChannelsStore } from '../stores/notificationChannelsStore';
import { useNotificationStore } from '../stores/notificationStore';

// Open the tab that holds a workflow: its cluster (focused on the member) or the workflow tab.
export function focusWorkflowTab(workflowId: string): void {
  const state = useAppStore.getState();
  const cluster = Object.values(state.clusters).find((c) => c.members.some((m) => m.workflowId === workflowId));
  if (cluster) { state.setActiveCluster(cluster.clusterId); state.setClusterFocusedMember(cluster.clusterId, workflowId); }
  else state.setActiveJob(workflowId);
}

export function shouldRaiseDesktop(
  view: NotificationChannelsView | null,
  kind: AttentionKind,
  env: { permission: string; hasFocus: boolean; visible: boolean },
): boolean {
  if (!view?.desktop[kind]) return false;
  if (env.permission !== 'granted') return false;
  // Only when Arco is not the window the operator is looking at.
  return !env.hasFocus || !env.visible;
}

export function shouldAddAttentionNotice(enabled: boolean, viewing: boolean): boolean {
  return enabled && !viewing;
}

type ViewState = Pick<ReturnType<typeof useAppStore.getState>, 'showHome' | 'showCreator' | 'activeJobId' | 'activeClusterId' | 'clusters' | 'clusterFocusedMember'>;

// The workflow on screen: the open workflow tab, or in an open cluster tab the
// member in view (the chosen one, else the first). Other members of the same
// cluster count as elsewhere, so their turns still reach the BELL.
export function isViewingWorkflow(state: ViewState, workflowId: string): boolean {
  if (state.showHome || state.showCreator) return false;
  const cluster = state.activeClusterId ? state.clusters[state.activeClusterId] : undefined;
  if (cluster) {
    const focused = state.clusterFocusedMember[cluster.clusterId];
    const inView = focused && cluster.members.some((m) => m.workflowId === focused) ? focused : cluster.members[0]?.workflowId;
    return inView === workflowId;
  }
  return !state.activeClusterId && state.activeJobId === workflowId;
}

// One notification per event: the event id is the tag, so a second browser
// window on the same computer replaces rather than repeats it.
export function handleAttentionEvent(msg: AttentionEventMessage): void {
  const view = useNotificationChannelsStore.getState().view;
  const viewing = isViewingWorkflow(useAppStore.getState(), msg.workflowId);
  const category = msg.kind === 'finished' ? 'turn-finished' : 'attention';
  if (shouldAddAttentionNotice(!useNotificationStore.getState().muted.includes(category), viewing)) {
    useNotificationStore.getState().pushNotice({ id: msg.id, category, severity: msg.kind === 'failed' ? 'error' : 'info', title: attentionTitle(msg.workflowName, msg.kind), ts: Date.now(), workflowId: msg.workflowId });
  }
  if (typeof Notification === 'undefined' || msg.desktopEligible === false) return;
  const ok = shouldRaiseDesktop(view, msg.kind, {
    permission: Notification.permission,
    hasFocus: typeof document.hasFocus === 'function' ? document.hasFocus() : true,
    visible: document.visibilityState !== 'hidden',
  });
  if (!ok) return;
  try {
    const n = new Notification(attentionTitle(msg.workflowName, msg.kind), { body: 'Open Arco to see it.', tag: msg.id });
    n.onclick = () => {
      try { window.focus(); } catch { /* ignore */ }
      focusWorkflowTab(msg.workflowId);
      n.close();
    };
  } catch { /* notifications blocked by the browser */ }
}
