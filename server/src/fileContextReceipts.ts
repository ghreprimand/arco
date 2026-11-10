import type { FileContextReference, ServerMessage } from '@arco/shared';
import { basename } from 'node:path';

export const FILE_CONTEXT_CACHE_DIR = 'file-context';
export const MAX_FILE_REFERENCES = 64;
export const MAX_CONTEXT_RECEIPT_BYTES = 16 * 1024;
export function clipFileText(text: string, bytes: number): string {
  return new TextDecoder('utf-8').decode(Buffer.from(text).subarray(0, Math.max(0, bytes)), { stream: true });
}
export function fileLabel(value: string): string { return value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 200); }
export function fileContextVisible(message: { inputClientMessageIds?: string[] }, ids: Set<string>): boolean {
  return !message.inputClientMessageIds?.length || message.inputClientMessageIds.some(id => ids.has(id));
}
export function receiptPlan(events: ServerMessage[]): Map<number, string> {
  const ids = new Set(events.filter((event): event is Extract<ServerMessage, { type: 'user_message_echo' }> => event.type === 'user_message_echo').flatMap(event => event.clientMessageId ? [event.clientMessageId] : []));
  const result = new Map<number, string>(), seen = new Set<string>();
  let remaining = MAX_CONTEXT_RECEIPT_BYTES;
  for (let index = events.length - 1; index >= 0 && remaining > 0; index--) {
    const event = events[index];
    let text = '';
    if (event.type === 'user_message_echo' && event.attachments?.length) {
      const paths = event.attachments.filter(path => typeof path === 'string').slice(-16);
      text = '[Attached files]\n' + paths.map(path => `${fileLabel(basename(path))}: ${JSON.stringify(path)}`).join('\n');
    } else if (event.type === 'file_context' && fileContextVisible(event, ids)) text = typeof event.receipt === 'string' ? event.receipt : '';
    else if (event.type === 'primary_tool_use' && event.mediaReceipt && event.status !== 'started' && event.status !== 'in_progress') text = event.mediaReceipt;
    if (!text || seen.has(text)) continue;
    seen.add(text);
    text = clipFileText(text, Math.min(4096, remaining)); remaining -= Buffer.byteLength(text);
    result.set(index, text);
  }
  return result;
}
export function validFileReference(value: unknown): value is FileContextReference {
  if (!value || typeof value !== 'object') return false;
  const ref = value as FileContextReference;
  if (typeof ref.name !== 'string' || ref.name.length > 400) return false;
  if (ref.kind === 'source') return typeof ref.path === 'string' && ref.path.length <= 32768;
  if (ref.kind === 'cached') return typeof ref.ownerWorkflowId === 'string' && typeof ref.cacheName === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(ref.ownerWorkflowId) && /^(?:[0-9a-f-]{36}|[0-9a-f]{64})\.(?:png|jpg|txt)$/.test(ref.cacheName);
  if (ref.kind === 'memory') return typeof ref.key === 'string' && /^[0-9a-f-]{36}$/.test(ref.key);
  return false;
}
export function fileReferenceKey(ref: FileContextReference): string {
  return ref.kind === 'source' ? `source:${ref.path}` : ref.kind === 'cached' ? `cache:${ref.ownerWorkflowId}:${ref.cacheName}` : `memory:${ref.key}`;
}
