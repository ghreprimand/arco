// Opaque encrypted cluster-snapshot storage for the tailnet management hub.
// The hub never receives the encryption key and never parses snapshot content.

import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { archonHome } from '../../server/src/archonHome.js';

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
  return process.env.ARCHON_CLUSTER_VAULT_DIR?.trim()
    || path.join(archonHome(), 'hub', 'cluster-vault');
}

function validId(id: string): boolean {
  return /^[a-zA-Z0-9-]{1,64}$/.test(id);
}

function metaPath(id: string): string {
  return path.join(root(), `${id}.json`);
}

function blobPath(id: string): string {
  return path.join(root(), `${id}.bin`);
}

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
  const tempSuffix = `${process.pid}.${Date.now()}.tmp`;
  const tempBlob = `${blobPath(id)}.${tempSuffix}`;
  const tempMeta = `${metaPath(id)}.${tempSuffix}`;
  try {
    await fs.writeFile(tempBlob, encrypted, { mode: 0o600 });
    await fs.writeFile(tempMeta, JSON.stringify(row, null, 2) + '\n', { mode: 0o600 });
    await fs.rename(tempBlob, blobPath(id));
    await fs.rename(tempMeta, metaPath(id));
  } catch (err) {
    await Promise.all([
      fs.rm(tempBlob, { force: true }).catch(() => {}),
      fs.rm(tempMeta, { force: true }).catch(() => {}),
    ]);
    throw err;
  }
  return row;
}

export async function readCloudSnapshot(id: string): Promise<Buffer | null> {
  if (!validId(id)) return null;
  try {
    return await fs.readFile(blobPath(id));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function deleteCloudSnapshot(id: string): Promise<boolean> {
  if (!validId(id)) return false;
  try {
    await fs.access(metaPath(id));
  } catch {
    return false;
  }
  await Promise.all([
    fs.rm(metaPath(id), { force: true }),
    fs.rm(blobPath(id), { force: true }),
  ]);
  return true;
}
