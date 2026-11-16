import type { TranscriptWorkerCreateMessage, TranscriptWorkerPreviewMessage, TranscriptWorkerResultMessage } from '@arco/shared';
import { useAppStore } from '../stores/appStore';

const pending = new Map<string, { resolve: (result: TranscriptWorkerResultMessage) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

export function requestTranscriptWorker(message: Omit<TranscriptWorkerPreviewMessage, 'requestId'> | Omit<TranscriptWorkerCreateMessage, 'requestId'>): Promise<TranscriptWorkerResultMessage> {
  const state = useAppStore.getState();
  if (!state.connected || !state.wsSendRaw) return Promise.reject(new Error('Reconnect before sending.'));
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('The request did not finish. Reconnect or refresh the preview before trying again.')); }, 30_000);
    pending.set(requestId, { resolve, reject, timer });
    try { state.wsSendRaw!({ ...message, requestId }); }
    catch { clearTimeout(timer); pending.delete(requestId); reject(new Error('Reconnect before sending.')); }
  });
}

export function finishTranscriptWorkerRequest(result: TranscriptWorkerResultMessage): void {
  const entry = pending.get(result.requestId);
  if (!entry) return;
  clearTimeout(entry.timer); pending.delete(result.requestId);
  if (result.error) entry.reject(new Error(result.error));
  else entry.resolve(result);
}
