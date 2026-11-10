import { admitImageResult, imageReceipts, type ImageReadResult } from './imageRead.js';
import { stripAllThinkingBlocks } from './appendOnlyPrefix.js';
import type { NativeMediaLimits } from './mediaLimits.js';

// Called between requests only. Preserve accepted objects unless retirement is
// necessary; changed histories deliberately start a fresh prefix/cache epoch.
export async function retainNewestMedia<T extends { role?: string; content?: unknown }>(history: T[], pending: unknown, result: ImageReadResult, limits: NativeMediaLimits, protectedRoundStart = history.length): Promise<{ history: T[]; pending: unknown; imagesReplaced: number; documentsReplaced: number }> {
  const unchanged = { history, pending, imagesReplaced: 0, documentsReplaced: 0 };
  if ((await admitImageResult(history, pending, result, 'tool', limits)).content) return unchanged;
  if (!(await admitImageResult([], [], result, 'tool', limits)).content) return unchanged;
  // Match inTurnCompactedHistory: the active assistant/tool-result round is
  // kept raw, including signed thinking, while only the older prefix changes.
  const protectedStart = Math.max(0, Math.min(history.length, protectedRoundStart));
  const rebuilt = [...structuredClone(history.slice(0, protectedStart)), ...history.slice(protectedStart)];
  const rebuiltPending = structuredClone(pending);
  let fromPending = false;
  const candidates: Array<{ parent: Record<string, unknown> | unknown[]; key: string | number; block: Record<string, unknown>; index: number; serverFetch: boolean; fromPending: boolean }> = [];
  const visit = (value: unknown, parent: Record<string, unknown> | unknown[], key: string | number, index: number, serverFetch = false): void => {
    if (Array.isArray(value)) { value.forEach((v, i) => visit(v, value, i, index, serverFetch)); return; }
    if (!value || typeof value !== 'object') return;
    const block = value as Record<string, unknown>;
    if (block.type === 'tool_use' || block.type === 'server_tool_use') return;
    serverFetch ||= block.type === 'web_fetch_tool_result';
    const source = block.source as { type?: string; media_type?: string } | undefined;
    if (block.type === 'image' || (block.type === 'document' && source?.type === 'base64' && source.media_type === 'application/pdf')) {
      candidates.push({ parent, key, block, index, serverFetch, fromPending }); return;
    }
    for (const [childKey, child] of Object.entries(block)) visit(child, block, childKey, index, serverFetch);
  };
  rebuilt.slice(0, protectedStart).forEach((message, index) => visit(message, rebuilt, index, index));
  fromPending = true;
  visit(rebuiltPending, { pending: rebuiltPending }, 'pending', -1);
  let historyChanged = false, pendingChanged = false;
  let imagesReplaced = 0, documentsReplaced = 0;
  for (const candidate of candidates) {
    const receipt = candidate.serverFetch && candidate.block.type === 'document'
      ? { type: 'document', ...(typeof candidate.block.title === 'string' ? { title: candidate.block.title } : {}), source: { type: 'text', media_type: 'text/plain', data: '[File media omitted from retained context; fetch the source again if needed.]' } }
      : imageReceipts(candidate.block);
    (candidate.parent as Record<string | number, unknown>)[candidate.key] = receipt;
    if (candidate.fromPending) pendingChanged = true; else historyChanged = true;
    if (candidate.block.type === 'image') imagesReplaced++; else documentsReplaced++;
    if ((await admitImageResult(rebuilt, rebuiltPending, result, 'tool', limits)).content) break;
  }
  if (!imagesReplaced && !documentsReplaced) return unchanged;
  // Older signed thinking belongs to the rebuilt prefix. The in-progress
  // round retains its original signatures and tool IDs, as in compaction.
  if (historyChanged) stripAllThinkingBlocks(rebuilt.slice(0, protectedStart), '[Prior reasoning omitted after media retention.]');
  return { history: historyChanged ? rebuilt : history, pending: pendingChanged ? rebuiltPending : pending, imagesReplaced, documentsReplaced };
}
