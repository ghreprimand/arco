import { createHash, randomUUID } from 'crypto';
import { constants, promises as fs } from 'fs';
import path from 'path';
import { assertGuardedHandleCurrent, createTuneupBackup, openGuardedInstructionFile, readGuardedContent, writeGuardedContent } from './runMdTuneup.js';

interface Receipt { workflowId: string; cwd: string; filePath: string; backupPath: string; backupHash: string; appliedHash: string }
const receipts = new Map<string, Receipt>();
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

export function rememberTuneupUndo(receipt: Omit<Receipt, 'appliedHash'> & { proposed: string }): string {
  if (receipts.size >= 256) receipts.delete(receipts.keys().next().value!);
  const id = randomUUID();
  const { proposed, ...rest } = receipt;
  receipts.set(id, { ...rest, appliedHash: hash(proposed) });
  return id;
}

async function readBackup(receipt: Receipt): Promise<string> {
  const root = await fs.realpath(receipt.cwd);
  const dir = await fs.realpath(path.join(receipt.cwd, '.arco', 'md-backups'));
  const rel = path.relative(root, dir);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('Backup directory escapes the project.');
  const entry = await fs.lstat(receipt.backupPath);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Backup is not a regular file.');
  const resolved = await fs.realpath(receipt.backupPath);
  if (path.dirname(resolved) !== dir) throw new Error('Backup is outside the backup directory.');
  const handle = await fs.open(receipt.backupPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (stat.dev !== entry.dev || stat.ino !== entry.ino || await fs.realpath(receipt.backupPath) !== resolved) throw new Error('Backup changed while opening.');
    const body = await readGuardedContent(handle);
    if (hash(body) !== receipt.backupHash) throw new Error('Backup changed after the tune-up.');
    return body;
  } finally { await handle.close(); }
}

export type TuneupUndoResult = { ok: true; safetyBackupPath: string } | { ok: false; conflictHash: string };

export async function undoTuneup(workflowId: string, cwd: string, undoId: string, confirmedHash?: string): Promise<TuneupUndoResult> {
  const receipt = receipts.get(undoId);
  if (!receipt || receipt.workflowId !== workflowId || receipt.cwd !== cwd) throw new Error('Undo is unavailable for this tune-up.');
  const original = await readBackup(receipt);
  const file = await openGuardedInstructionFile(cwd, receipt.filePath);
  try {
    const current = await readGuardedContent(file);
    const currentHash = hash(current);
    if (currentHash !== receipt.appliedHash && currentHash !== confirmedHash) return { ok: false, conflictHash: currentHash };
    const safetyBackupPath = await createTuneupBackup(cwd, path.basename(receipt.filePath), current, Date.now());
    const latest = await readGuardedContent(file);
    if (hash(latest) !== currentHash) return { ok: false, conflictHash: hash(latest) };
    await assertGuardedHandleCurrent(cwd, receipt.filePath, file);
    await writeGuardedContent(file, original);
    receipts.delete(undoId);
    return { ok: true, safetyBackupPath };
  } finally { await file.close(); }
}
