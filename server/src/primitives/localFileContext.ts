import type { FileContextReference, ServerMessage } from '@arco/shared';
import { basename, resolve } from 'node:path';
import { projectDeliveredInputs } from '../inputDeliveryHistory.js';
import { currentHandoffEvents } from './exportContext.js';
import { fileContextVisible, fileLabel, fileReferenceKey, MAX_FILE_REFERENCES, validFileReference } from '../fileContextReceipts.js';

/** Structured replay data comes from server metadata, never text matching. */
export function projectLocalFileReferences(input: ServerMessage[], cwd: string): FileContextReference[] {
  const events = currentHandoffEvents(projectDeliveredInputs(input));
  const ids = new Set(events.filter((event): event is Extract<ServerMessage, { type: 'user_message_echo' }> => event.type === 'user_message_echo').flatMap(event => event.clientMessageId ? [event.clientMessageId] : []));
  const refs: FileContextReference[] = [];
  for (const event of events) {
    if (event.type === 'user_message_echo') {
      for (const path of (event.attachments ?? []).filter(value => typeof value === 'string')) refs.push({ kind: 'source', path: resolve(cwd, path), name: fileLabel(basename(path)) });
    } else if (event.type === 'file_context' && fileContextVisible(event, ids)) {
      if (event.origin === 'attachment') {
        for (const path of event.sourcePaths ?? []) {
          const original = refs.findLast(ref => ref.kind === 'source' && ref.path === resolve(cwd, path));
          if (original?.kind === 'source') original.restore = false;
        }
      }
      for (const ref of (Array.isArray(event.files) ? event.files : []).filter(validFileReference)) refs.push({ ...ref });
    }
  }
  const unique = new Map<string, FileContextReference>();
  for (const ref of refs) { const key = fileReferenceKey(ref); unique.delete(key); unique.set(key, ref); }
  const all = [...unique.values()];
  const protectedImages = all.filter(ref => ref.media === 'image').slice(-2);
  const tail = all.slice(-(MAX_FILE_REFERENCES - protectedImages.length));
  return [...new Map([...protectedImages, ...tail].map(ref => [fileReferenceKey(ref), ref])).values()];
}
