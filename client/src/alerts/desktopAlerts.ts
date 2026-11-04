import type { AttentionEventMessage, AttentionKind, NotificationChannelsView } from '@arco/shared';
import { useAppStore } from '../stores/appStore';
import { useNotificationChannelsStore } from '../stores/notificationChannelsStore';
import { useNotificationStore } from '../stores/notificationStore';

const PHRASE: Record<AttentionKind, string> = {
  finished: 'finished',
  failed: 'hit an error',
  waiting: 'is waiting for you',
};

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

// One notification per event: the event id is the tag, so a second browser
// window on the same computer replaces rather than repeats it.
export function handleAttentionEvent(msg: AttentionEventMessage): void {
  const view = useNotificationChannelsStore.getState().view;
  const state = useAppStore.getState();
  const cluster = Object.values(state.clusters).find((c) => c.members.some((m) => m.workflowId === msg.workflowId));
  const viewing = !state.showHome && !state.showCreator && (cluster ? state.activeClusterId === cluster.clusterId : state.activeJobId === msg.workflowId);
  const category = msg.kind === 'finished' ? 'turn-finished' : 'attention';
  if (shouldAddAttentionNotice(!useNotificationStore.getState().muted.includes(category), viewing)) {
    useNotificationStore.getState().pushNotice({ id: msg.id, category, severity: msg.kind === 'failed' ? 'error' : 'info', title: `${msg.workflowName} ${PHRASE[msg.kind]}`, ts: Date.now(), workflowId: msg.workflowId });
  }
  if (typeof Notification === 'undefined' || msg.desktopEligible === false) return;
  const ok = shouldRaiseDesktop(view, msg.kind, {
    permission: Notification.permission,
    hasFocus: typeof document.hasFocus === 'function' ? document.hasFocus() : true,
    visible: document.visibilityState !== 'hidden',
  });
  if (!ok) return;
  try {
    const n = new Notification(`${msg.workflowName} ${PHRASE[msg.kind]}`, { body: 'Open Arco to see it.', tag: msg.id });
    n.onclick = () => {
      try { window.focus(); } catch { /* ignore */ }
      focusWorkflowTab(msg.workflowId);
      n.close();
    };
  } catch { /* notifications blocked by the browser */ }
}
