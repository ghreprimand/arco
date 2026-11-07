// Opaque encrypted cluster-snapshot storage for the tailnet management hub.
// The hub never receives the encryption key and never parses snapshot content.

import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { withFileLock } from '../../server/src/atomicFile.js';
import { arcoHome } from '../../server/src/arcoHome.js';

export const MAX_VAULT_BLOB_BYTES = 1024 * 1024 * 1024;

export interface CloudClusterSnapshot {
  id: string;
  name: string;
  createdAt: string;
  uploadedAt: string;
  memberCount: number;
  sourceDevice: string;
  sourcePlatform: string;
  bytes: number;
  sha256: string;
}

function root(): string {
  return process.env.ARCO_CLUSTER_VAULT_DIR?.trim()
    || path.join(arcoHome(), 'hub', 'cluster-vault');
}

function validId(id: string): boolean {
  return /^[a-zA-Z0-9-]{1,64}$/.test(id);
}

function metaPath(id: string): string {
  return path.join(root(), `${id}.json`);
}

function blobPath(id: string, digest?: string): string {
  return path.join(root(), digest ? `${id}.${digest}.bin` : `${id}.bin`);
}
const withVaultLock = <T>(fn: () => Promise<T>) => withFileLock(path.resolve(root()), fn);

export async function listCloudSnapshots(): Promise<CloudClusterSnapshot[]> {
  let names: string[];
  try {
    names = await fs.readdir(root());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: CloudClusterSnapshot[] = [];
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    try {
      const value = JSON.parse(await fs.readFile(path.join(root(), name), 'utf8')) as CloudClusterSnapshot;
      if (value && validId(value.id) && typeof value.name === 'string') out.push(value);
    } catch { /* skip incomplete/corrupt rows */ }
  }
  return out.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
}

export async function saveCloudSnapshot(
  input: Omit<CloudClusterSnapshot, 'id' | 'uploadedAt'>,
  encrypted: Buffer,
  replaceId?: string,
): Promise<CloudClusterSnapshot> {
  return withVaultLock(async () => {
  if (!input.name?.trim() || input.name.length > 64) throw new Error('invalid snapshot name');
  if (!Number.isInteger(input.memberCount) || input.memberCount < 2 || input.memberCount > 256) throw new Error('invalid member count');
  if (encrypted.length < 32 || encrypted.length > MAX_VAULT_BLOB_BYTES) throw new Error('invalid snapshot size');
  const digest = createHash('sha256').update(encrypted).digest('hex');
  if (input.sha256 !== digest || input.bytes !== encrypted.length) throw new Error('snapshot checksum mismatch');
  const existing = await listCloudSnapshots();
  const duplicate = existing.find((row) => row.name.trim().toLowerCase() === input.name.trim().toLowerCase());
  if (duplicate && replaceId !== duplicate.id) throw new Error(`snapshot named "${duplicate.name}" already exists`);
  if (replaceId && (!duplicate || duplicate.id !== replaceId || !validId(replaceId))) {
    throw new Error('cloud replacement target no longer matches that name');
  }
  const id = duplicate?.id ?? randomUUID();
  const row: CloudClusterSnapshot = {
    ...input,
    id,
    name: input.name.trim(),
    sourceDevice: String(input.sourceDevice || 'unknown').slice(0, 120),
    sourcePlatform: String(input.sourcePlatform || 'unknown').slice(0, 40),
    uploadedAt: new Date().toISOString(),
  };
  await fs.mkdir(root(), { recursive: true });
  const tempSuffix = `${randomUUID()}.tmp`;
  const publishedBlob = blobPath(id, digest);
  const tempBlob = `${publishedBlob}.${tempSuffix}`;
  let createdBlob = false;
  const tempMeta = `${metaPath(id)}.${tempSuffix}`;
  try {
    const blobHandle = await fs.open(tempBlob, 'wx', 0o600);
    try { await blobHandle.writeFile(encrypted); await blobHandle.sync(); } finally { await blobHandle.close(); }
    try { await fs.link(tempBlob, publishedBlob); createdBlob = true; }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (!(await fs.readFile(publishedBlob)).equals(encrypted)) throw new Error('The existing snapshot blob could not be verified.');
    }
    await fs.rm(tempBlob, { force: true });
    const metaHandle = await fs.open(tempMeta, 'wx', 0o600);
    try { await metaHandle.writeFile(JSON.stringify(row, null, 2) + '\n'); await metaHandle.sync(); } finally { await metaHandle.close(); }
    // The existing metadata remains the sole pointer until this rename.
    await fs.rename(tempMeta, metaPath(id));
  } catch (err) {
    // Rename errors can be ambiguous. Delete an owned published blob only
    // when the current pointer proves it is not active; uncertainty keeps it.
    let discardPublished = false;
    if (createdBlob) {
      try {
        const pointer = JSON.parse(await fs.readFile(metaPath(id), 'utf8')) as Partial<CloudClusterSnapshot> | null;
        discardPublished = pointer?.id === id && typeof pointer.sha256 === 'string'
          && /^[a-f0-9]{64}$/.test(pointer.sha256) && pointer.sha256 !== digest;
      } catch (readError) { discardPublished = (readError as NodeJS.ErrnoException).code === 'ENOENT'; }
    }
    await Promise.all([
      fs.rm(tempBlob, { force: true }).catch(() => {}),
      ...(discardPublished ? [fs.rm(publishedBlob, { force: true }).catch(() => {})] : []),
      fs.rm(tempMeta, { force: true }).catch(() => {}),
    ]);
    throw err;
  }
  // Cleanup follows publication; failures leave an unreferenced blob, never
  // a broken active snapshot. Reads and replacements hold the same lock.
  if (duplicate && duplicate.sha256 !== digest) await fs.rm(blobPath(id, duplicate.sha256), { force: true }).catch(() => {});
  await fs.rm(blobPath(id), { force: true }).catch(() => {});
  return row;
  });
}

export async function readCloudSnapshot(id: string): Promise<Buffer | null> {
  if (!validId(id)) return null;
  return withVaultLock(async () => {
    let row: CloudClusterSnapshot;
    try { row = JSON.parse(await fs.readFile(metaPath(id), 'utf8')) as CloudClusterSnapshot; }
    catch (err) {
      if (err instanceof SyntaxError || (err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    if (row.id !== id || !/^[a-f0-9]{64}$/.test(row.sha256)) return null;
    let blob: Buffer;
    try { blob = await fs.readFile(blobPath(id, row.sha256)); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      try { blob = await fs.readFile(blobPath(id)); }
      catch (legacyErr) { if ((legacyErr as NodeJS.ErrnoException).code === 'ENOENT') return null; throw legacyErr; }
    }
    return blob.length === row.bytes && createHash('sha256').update(blob).digest('hex') === row.sha256 ? blob : null;
  });
}

export async function deleteCloudSnapshot(id: string): Promise<boolean> {
  if (!validId(id)) return false;
  return withVaultLock(async () => {
    try { await fs.access(metaPath(id)); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false; throw err; }
    await fs.rm(metaPath(id), { force: true });
    const escaped = id.replace(/[-]/g, '\\-');
    const pattern = new RegExp(`^${escaped}(?:\\.[a-f0-9]{64})?\\.bin$`);
    for (const name of await fs.readdir(root())) {
      if (pattern.test(name)) await fs.rm(path.join(root(), name), { force: true });
    }
    return true;
  });
}
