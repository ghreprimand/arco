import { promises as fs } from 'node:fs';
import path from 'node:path';
import { holdsKept, isKept, readKeep } from './keepStore.js';
import { ensureProjectStateIgnore } from './projectStateIgnore.js';

// Operator storage actions (P7.4/P7.5, docs/STORAGE_PLAN.md). Every action is
// an explicit operator request, never touches plans, skips KEEP items, stops
// when the KEEP file cannot be read, and is recorded in
// <project>/.arco/storage-actions.jsonl.
export class StorageActionError extends Error {
  constructor(readonly code: 'keep_unreadable' | 'busy' | 'open' | 'not_found' | 'kept' | 'exists' | 'invalid', message: string) {
    super(message);
  }
}

const WFID = /^[a-zA-Z0-9-]{1,64}$/;
export function conversationDir(cwd: string, workflowId: string): string {
  if (!WFID.test(workflowId)) throw new StorageActionError('invalid', 'Invalid conversation id.');
  return path.join(cwd, '.arco', 'workflows', workflowId);
}

export async function recordStorageAction(cwd: string, entry: Record<string, unknown>): Promise<void> {
  const line = JSON.stringify({ at: Date.now(), ...entry }) + '\n';
  try {
    ensureProjectStateIgnore(cwd);
    await fs.mkdir(path.join(cwd, '.arco'), { recursive: true });
    await fs.appendFile(path.join(cwd, '.arco', 'storage-actions.jsonl'), line, { encoding: 'utf8', mode: 0o600 });
  }
  catch (err) { console.error('[arco] storage action not recorded:', err); }
}

export interface RemovalResult { removedBytes: number; removedFiles: number; keptItems: number }

// Remove everything under `root` (relative `rel` inside the conversation)
// except kept items. Links are removed as links, never followed.
async function removeExceptKept(dir: string, rel: string, kept: Parameters<typeof isKept>[0], out: RemovalResult): Promise<void> {
  const abs = rel ? path.join(dir, ...rel.split('/')) : dir;
  let entries;
  try { entries = await fs.readdir(abs, { withFileTypes: true }); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; throw err; }
  for (const entry of entries) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    const child = path.join(abs, entry.name);
    if (entry.name === 'keep.json' && !rel) continue;
    if (isKept(kept, childRel)) { out.keptItems++; continue; }
    if (entry.isDirectory() && holdsKept(kept, childRel)) { await removeExceptKept(dir, childRel, kept, out); continue; }
    const size = await treeSize(child);
    await fs.rm(child, { recursive: true, force: true });
    out.removedBytes += size.bytes; out.removedFiles += size.files;
  }
}

export async function treeSize(p: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0, files = 0;
  const stack = [p];
  while (stack.length) {
    const cur = stack.pop()!;
    let st;
    try { st = await fs.lstat(cur); } catch { continue; }
    if (st.isDirectory()) {
      try { for (const name of await fs.readdir(cur)) stack.push(path.join(cur, name)); } catch { /* unreadable */ }
    } else { bytes += st.size; files++; }
  }
  return { bytes, files };
}

// EMPTY SCRATCH: delete the conversation's scratch/ contents except kept
// items. Refused while the conversation is working and when the KEEP file
// cannot be read.
export async function emptyScratch(cwd: string, workflowId: string, opts: { busy: boolean }): Promise<RemovalResult> {
  const dir = conversationDir(cwd, workflowId);
  if (opts.busy) throw new StorageActionError('busy', 'The conversation is working; empty its scratch folder when it is idle.');
  const keep = await readKeep(dir);
  if (!keep.ok) throw new StorageActionError('keep_unreadable', 'The KEEP list of this conversation cannot be read, so nothing was deleted.');
  const out: RemovalResult = { removedBytes: 0, removedFiles: 0, keptItems: 0 };
  if (isKept(keep.items, 'scratch')) { out.keptItems++; return out; }
  await removeExceptKept(dir, 'scratch', keep.items, out);
  await recordStorageAction(cwd, { action: 'empty_scratch', workflowId, removedBytes: out.removedBytes, removedFiles: out.removedFiles, keptItems: out.keptItems });
  return out;
}

// DELETE a closed conversation (P7.5): the existing purge (folder, checkpoints,
// Recall row, mailbox), plus its archive if it has one. Kept items stay in
// the conversation folder. Refused for an open or working conversation, a
// wholly kept one, or an unreadable KEEP list.
export async function deleteConversation(
  cwd: string, workflowId: string,
  opts: { open: boolean; busy: boolean; purge: (cwd: string, id: string, o: { nuclear: boolean; removeDir?: (dir: string) => Promise<void> }) => Promise<{ ok: boolean; error?: string }>; archiveFile?: string },
): Promise<RemovalResult> {
  const dir = conversationDir(cwd, workflowId);
  if (opts.open || opts.busy) throw new StorageActionError('open', 'Close the conversation before deleting it.');
  const keep = await readKeep(dir);
  if (!keep.ok) throw new StorageActionError('keep_unreadable', 'The KEEP list of this conversation cannot be read, so nothing was deleted.');
  if (isKept(keep.items, '.')) throw new StorageActionError('kept', 'The whole conversation is kept.');
  let exists = true;
  try { await fs.lstat(dir); } catch { exists = false; }
  let archived = false;
  if (opts.archiveFile) { try { await fs.lstat(opts.archiveFile); archived = true; } catch { /* none */ } }
  if (!exists && !archived) throw new StorageActionError('not_found', 'The conversation was not found.');
  const out: RemovalResult = { removedBytes: 0, removedFiles: 0, keptItems: 0 };
  if (exists && !keep.items.length) { const size = await treeSize(dir); out.removedBytes += size.bytes; out.removedFiles += size.files; }
  const result = await opts.purge(cwd, workflowId, {
    nuclear: false,
    ...(keep.items.length ? { removeDir: async () => { await removeExceptKept(dir, '', keep.items, out); } } : {}),
  });
  if (!result.ok) throw new Error(result.error || 'The conversation could not be deleted.');
  if (archived && opts.archiveFile) {
    out.removedBytes += (await fs.stat(opts.archiveFile)).size; out.removedFiles++;
    await fs.rm(opts.archiveFile, { force: true });
  }
  await recordStorageAction(cwd, { action: 'delete', workflowId, removedBytes: out.removedBytes, removedFiles: out.removedFiles, keptItems: out.keptItems });
  return out;
}
