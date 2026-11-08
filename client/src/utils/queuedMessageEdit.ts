import type { QueuedMessageEditResultMessage } from '@arco/shared';
import { useAppStore } from '../stores/appStore';
import { useDraftStore, readDraft } from '../stores/draftStore';

const requests = new Map<string, { workflowId: string; clientMessageId: string }>();
export function requestQueuedMessageEdit(workflowId: string, clientMessageId: string): boolean {
  const store = useAppStore.getState();
  if (store.connectionState !== 'online' || !store.wsSendRaw) {
    store.pushNotification('error', 'Not connected: pending message was not edited.');
    return false;
  }
  const existing = [...requests].find(([, r]) => r.workflowId === workflowId && r.clientMessageId === clientMessageId);
  const requestId = existing?.[0] ?? crypto.randomUUID();
  requests.set(requestId, { workflowId, clientMessageId });
  store.wsSendRaw({ type: 'cancel_queued_message', workflowId, clientMessageId, editRequestId: requestId });
  return true;
}
export function retryQueuedMessageEdits(workflowId: string): void {
  for (const request of [...requests.values()]) if (request.workflowId === workflowId) requestQueuedMessageEdit(workflowId, request.clientMessageId);
}
export function finishQueuedMessageEdit(result: QueuedMessageEditResultMessage): void {
  const pending = requests.get(result.requestId);
  if (!pending || pending.workflowId !== result.workflowId || pending.clientMessageId !== result.clientMessageId) return;
  requests.delete(result.requestId);
  const store = useAppStore.getState();
  if (result.error || !result.item) {
    store.pushNotification('info', result.error ?? 'Already sent, nothing to edit');
    return;
  }
  if (!store.jobs[result.workflowId]) return;
  const current = readDraft(result.workflowId);
  useDraftStore.getState().setDraft(result.workflowId, current ? `${current}\n\n${result.item.content}` : result.item.content);
  useDraftStore.setState(s => ({ queueEditKinds: { ...s.queueEditKinds, [result.workflowId]: result.item!.kind } }));
  for (const path of result.item.attachments ?? []) {
    if ((useAppStore.getState().attachments[result.workflowId] ?? []).some(a => a.path === path)) continue;
    store.addAttachment(result.workflowId, { path, filename: path.split(/[\\/]/).pop() ?? path, isImage: /\.(?:png|jpe?g|gif|webp)$/i.test(path) });
  }
  store.pushNotification('info', 'Pending message returned to the message box.');
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('arco:focus-composer', { detail: { workflowId: result.workflowId } }));
}
