import { lstatSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { arcoHome } from '../arcoHome.js';
import { UPLOADS_DIR, UUID_PATTERN } from '../server/constants.js';
import { ensureStorageRoot } from '../storageRoot.js';
import type { StoredAttachment } from './attachmentUpload.js';

export const PHONE_DRAFT_TTL_MS = 30 * 60_000;
const ROOT_NAME = '.phone-upload-drafts';

export interface PhoneDraft extends StoredAttachment {
  workflowId: string;
  owner: string;
  expiresAt: number;
}

function recordsDirectory(): string {
  return join(arcoHome(), ROOT_NAME);
}

function recordPath(fileId: string): string {
  if (!UUID_PATTERN.test(fileId)) throw new Error('Invalid phone upload ID');
  return join(recordsDirectory(), fileId + '.json');
}

function safeName(filename: unknown): filename is string {
  return typeof filename === 'string' && /^[\p{L}\p{N}_()-][\p{L}\p{N} ._()-]{0,119}$/u.test(filename);
}

export function phoneFilename(name: string): string {
  const cleaned = name.normalize('NFC').replace(/[^\p{L}\p{N} ._()-]/gu, '_').replace(/^[. ]+|[. ]+$/g, '');
  // A Windows file system also observes the extension after Unicode sanitizing.
  return safeName(cleaned) ? cleaned : '';
}

function readRecord(id: string): PhoneDraft | null {
  try {
    const directory = lstatSync(recordsDirectory());
    if (!directory.isDirectory() || directory.isSymbolicLink()) return null;
    const target = recordPath(id);
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return null;
    const entry = JSON.parse(readFileSync(target, 'utf8')) as Partial<PhoneDraft>;
    if (entry.fileId !== id || !safeName(entry.filename) || typeof entry.path !== 'string'
      || basename(entry.path) !== `${id}-${entry.filename}` || typeof entry.owner !== 'string'
      || typeof entry.workflowId !== 'string' || typeof entry.expiresAt !== 'number'
      || !Number.isSafeInteger(entry.expiresAt)) return null;
    return entry as PhoneDraft;
  } catch {
    return null;
  }
}

export async function rememberPhoneDraft(entry: PhoneDraft): Promise<void> {
  const directory = await ensureStorageRoot(recordsDirectory());
  writeFileSync(join(directory, entry.fileId + '.json'), JSON.stringify(entry), { flag: 'wx', mode: 0o600 });
}

export function phoneDraftForOwner(id: string, owner: string): PhoneDraft | null {
  const entry = readRecord(id);
  return entry && entry.owner === owner && entry.expiresAt > Date.now() ? entry : null;
}

export async function discardPhoneDraft(entry: PhoneDraft): Promise<void> {
  const directory = await ensureStorageRoot(UPLOADS_DIR, false);
  // Send may take ownership while the directory check is in flight.
  if (readRecord(entry.fileId)?.path !== entry.path) return;
  const path = join(directory, `${entry.fileId}-${entry.filename}`);
  // Delete only a filename generated for this phone receipt, never a path
  // supplied by the phone or stored in the receipt.
  for (const name of [path, path + '.model.png', path + '.model.jpg']) {
    try { unlinkSync(name); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  forgetRecord(entry.fileId);
}

function forgetRecord(fileId: string): void {
  try { unlinkSync(recordPath(fileId)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

// Called only at the send acceptance points. Removing the cleanup receipt
// before queuing or starting the turn keeps sent attachments in history.
export function adoptPhoneDrafts(workflowId: string, attachments: readonly string[] | undefined): boolean {
  const entries: PhoneDraft[] = [];
  for (const path of attachments ?? []) {
    const id = basename(path).slice(0, 36);
    if (!UUID_PATTERN.test(id)) continue;
    const entry = readRecord(id);
    if (!entry) continue;
    if (entry.workflowId !== workflowId || entry.path !== path || entry.expiresAt <= Date.now()) return false;
    entries.push(entry);
  }
  for (const entry of entries) forgetRecord(entry.fileId);
  return true;
}

let sweeping = false;
export async function sweepPhoneDrafts(): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    const directory = lstatSync(recordsDirectory());
    if (!directory.isDirectory() || directory.isSymbolicLink()) return;
    for (const file of readdirSync(recordsDirectory())) {
      if (!file.endsWith('.json')) continue;
      const entry = readRecord(file.slice(0, -5));
      if (entry && entry.expiresAt <= Date.now()) await discardPhoneDraft(entry).catch(() => {});
    }
  } catch {
    // No phone uploads yet, or managed storage is unavailable.
  } finally {
    sweeping = false;
  }
}

setInterval(() => { void sweepPhoneDrafts(); }, 30_000).unref();
