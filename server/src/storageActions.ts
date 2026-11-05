import { promises as fs } from 'node:fs';
import path from 'node:path';
import { STAYING_FILES, holdsKept, isKept, readKeep, withKeepLock } from './keepStore.js';
import { ensureProjectStateIgnore } from './projectStateIgnore.js';

// Operator storage actions (P7.4/P7.5, docs/STORAGE_PLAN.md). Every action is
// an explicit operator request, never touches plans, skips KEEP items, stops
// when the KEEP file cannot be read, and is recorded in
// <project>/.arco/storage-actions.jsonl.
export class StorageActionError extends Error {
  constructor(readonly code: 'keep_unreadable' | 'busy' | 'open' | 'not_found' | 'kept' | 'exists' | 'invalid' | 'unsafe', message: string) {
    super(message);
  }
}

const WFID = /^[a-zA-Z0-9-]{1,64}$/;
export function conversationDir(cwd: string, workflowId: string): string {
  if (!WFID.test(workflowId)) throw new StorageActionError('invalid', 'Invalid conversation id.');
  return path.join(cwd, '.arco', 'workflows', workflowId);
}

// Links are never followed by a storage action. The project's `.arco`,
// `.arco/workflows` and the conversation folder must be real folders (not
// links), and the folder must resolve to where its path says; otherwise the
// action is refused before anything is read, written or removed.
// `mayBeMissing`: a conversation folder that does not exist is fine (restore).
export async function checkedConversationDir(cwd: string, workflowId: string, opts: { mayBeMissing?: boolean } = {}): Promise<string> {
  const dir = conversationDir(cwd, workflowId);
  for (const p of [path.join(cwd, '.arco'), path.join(cwd, '.arco', 'workflows'), dir]) {
    let st;
    try { st = await fs.lstat(p); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      if (opts.mayBeMissing && p === dir) return dir;
      throw new StorageActionError('not_found', 'The conversation folder was not found.');
    }
    if (st.isSymbolicLink() || !st.isDirectory()) throw unsafe(path.relative(cwd, p));
  }
  const expected = path.join(await fs.realpath(cwd), '.arco', 'workflows', workflowId);
  if (await fs.realpath(dir) !== expected) throw unsafe(path.relative(cwd, dir));
  return dir;
}
export function unsafe(rel: string): StorageActionError {
  return new StorageActionError('unsafe', `${rel.split(path.sep).join('/')} is a link or not a folder, so nothing was changed.`);
}
// The project's archive folder: a real folder or missing, never a link.
export async function checkedArchiveFolder(cwd: string): Promise<void> {
  const p = path.join(cwd, '.arco', 'archive');
  try { const st = await fs.lstat(p); if (st.isSymbolicLink() || !st.isDirectory()) throw unsafe(path.join('.arco', 'archive')); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
}

// A folder or file inside a checked conversation folder: false when missing,
// refused when it is a link.
export async function checkedEntry(dir: string, rel: string): Promise<boolean> {
  try { if ((await fs.lstat(path.join(dir, ...rel.split('/')))).isSymbolicLink()) throw unsafe(rel); return true; }
  catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false; throw err; }
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
  // The start folder itself is never a link (a link inside is removed as one).
  try { if ((await fs.lstat(abs)).isSymbolicLink()) throw unsafe(rel || '.'); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; throw err; }
  let entries;
  try { entries = await fs.readdir(abs, { withFileTypes: true }); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; throw err; }
  for (const entry of entries) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    const child = path.join(abs, entry.name);
    if (!rel && STAYING_FILES.has(entry.name)) continue;
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
  if (opts.busy) throw new StorageActionError('busy', 'The conversation is working; empty its scratch folder when it is idle.');
  const dir = await checkedConversationDir(cwd, workflowId, { mayBeMissing: true });
  await checkedEntry(dir, 'scratch');
  return withKeepLock(dir, async () => {
  const keep = await readKeep(dir);
  if (!keep.ok) throw new StorageActionError('keep_unreadable', 'The KEEP list of this conversation cannot be read, so nothing was deleted.');
  const out: RemovalResult = { removedBytes: 0, removedFiles: 0, keptItems: 0 };
  if (isKept(keep.items, 'scratch')) { out.keptItems++; return out; }
  await removeExceptKept(dir, 'scratch', keep.items, out);
  await recordStorageAction(cwd, { action: 'empty_scratch', workflowId, removedBytes: out.removedBytes, removedFiles: out.removedFiles, keptItems: out.keptItems });
  return out;
  });
}

// DELETE a closed conversation (P7.5): the existing purge (folder, checkpoints,
// Recall row, mailbox), plus its archive if it has one. Kept items stay in
// the conversation folder. Refused for an open or working conversation, a
// wholly kept one, or an unreadable KEEP list.
export async function deleteConversation(
  cwd: string, workflowId: string,
  opts: { open: boolean; busy: boolean; purge: (cwd: string, id: string, o: { nuclear: boolean; removeDir?: (dir: string) => Promise<void> }) => Promise<{ ok: boolean; error?: string }>; archiveFile?: string },
): Promise<RemovalResult> {
  if (opts.open || opts.busy) throw new StorageActionError('open', 'Close the conversation before deleting it.');
  const dir = await checkedConversationDir(cwd, workflowId, { mayBeMissing: true });
  if (opts.archiveFile) {
    await checkedArchiveFolder(cwd);
    try { if (!(await fs.lstat(opts.archiveFile)).isFile()) throw unsafe(path.relative(cwd, opts.archiveFile)); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
  }
  return withKeepLock(dir, async () => {
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
    // Checked again right before the removal.
    await checkedArchiveFolder(cwd);
    if (!(await fs.lstat(opts.archiveFile)).isFile()) throw unsafe(path.relative(cwd, opts.archiveFile));
    await fs.rm(opts.archiveFile, { force: true });
  }
  await recordStorageAction(cwd, { action: 'delete', workflowId, removedBytes: out.removedBytes, removedFiles: out.removedFiles, keptItems: out.keptItems });
  return out;
  });
}

// COMPRESS OLD LOGS (operator click, per project): seal the live logs of
// closed conversations into compressed segments. Open or working
// conversations are skipped and listed; logs under 1 MiB are not worth it.
// Lossless: the same sealing as during writes, inside each conversation's
// flush chain. Nothing is deleted.
export const COMPRESS_MIN_BYTES = 1024 * 1024;
// deferred: segments written but the live file is still held open (Windows);
// the next COMPRESS OLD LOGS or seal finishes it.
export interface CompressResult { sealed: number; skippedOpen: string[]; failed: number; deferred: number; beforeBytes: number; afterBytes: number }
export async function compressOldLogs(
  cwd: string,
  opts: { isOpen: (id: string) => boolean; isBusy: (id: string) => boolean; seal: (cwd: string, id: string) => Promise<unknown> },
): Promise<CompressResult> {
  const root = path.join(cwd, '.arco', 'workflows');
  const out: CompressResult = { sealed: 0, skippedOpen: [], failed: 0, deferred: 0, beforeBytes: 0, afterBytes: 0 };
  let names: string[] = [];
  try { names = await fs.readdir(root); } catch { names = []; }
  for (const id of names.sort()) {
    if (!WFID.test(id)) continue;
    // Linked folders are never sealed into (checkedConversationDir refuses them).
    try { await checkedConversationDir(cwd, id); } catch { continue; }
    const live = path.join(root, id, 'events.jsonl');
    let size = 0;
    try { const st = await fs.lstat(live); if (!st.isFile()) continue; size = st.size; } catch { continue; }
    if (size < COMPRESS_MIN_BYTES) continue;
    if (opts.isOpen(id) || opts.isBusy(id)) { out.skippedOpen.push(id); continue; }
    const before = await logBytes(path.join(root, id));
    let result: unknown;
    try { result = await opts.seal(cwd, id); }
    catch (err) { out.failed++; console.error(`[arco] compress logs: ${id.slice(0, 8)} not sealed:`, err); continue; }
    if (result && typeof result === 'object' && (result as { liveReplaced?: boolean }).liveReplaced === false) { out.deferred++; continue; }
    const after = await logBytes(path.join(root, id));
    if (after < before) { out.sealed++; out.beforeBytes += before; out.afterBytes += after; }
  }
  await recordStorageAction(cwd, { action: 'compress_logs', sealed: out.sealed, skippedOpen: out.skippedOpen.length, failed: out.failed, deferred: out.deferred, beforeBytes: out.beforeBytes, afterBytes: out.afterBytes });
  return out;
}

async function logBytes(dir: string): Promise<number> {
  let total = 0;
  try {
    for (const name of await fs.readdir(dir)) {
      if (name !== 'events.jsonl' && !/^events\.\d{12}-\d{12}\.jsonl\.br$/.test(name)) continue;
      total += (await fs.lstat(path.join(dir, name))).size;
    }
  } catch { /* unreadable */ }
  return total;
}
