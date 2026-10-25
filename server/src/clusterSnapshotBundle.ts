// Portable cluster snapshot container. Regular files only, integrity checked,
// gzip-compressed, and independent of tar/platform metadata.

import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import type { PortableSnapshotFile } from './clusterSnapshots.js';

const MAGIC = Buffer.from('ARCHCL01', 'ascii');
const MAX_FILES = 256;
export const MAX_CLUSTER_BUNDLE_BYTES = 1024 * 1024 * 1024;

interface BundleHeader {
  format: 'archon-cluster/1';
  createdAt: string;
  files: Array<{ path: string; bytes: number; sha256: string }>;
}

function u32(n: number): Buffer {
  const out = Buffer.allocUnsafe(4);
  out.writeUInt32BE(n, 0);
  return out;
}

function safePath(value: string): boolean {
  return value.length > 0
    && !value.startsWith('/')
    && !value.includes('\\')
    && !value.split('/').includes('..');
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function writeClusterBundle(files: PortableSnapshotFile[]): Buffer {
  if (files.length < 1 || files.length > MAX_FILES) throw new Error('invalid bundle file count');
  let total = 0;
  const seen = new Set<string>();
  for (const file of files) {
    if (!safePath(file.relPath) || seen.has(file.relPath)) throw new Error(`unsafe or duplicate bundle path: ${file.relPath}`);
    seen.add(file.relPath);
    total += file.bytes.length;
  }
  if (total > MAX_CLUSTER_BUNDLE_BYTES) throw new Error('cluster bundle exceeds 1 GiB cap');
  const header: BundleHeader = {
    format: 'archon-cluster/1',
    createdAt: new Date().toISOString(),
    files: files.map((f) => ({ path: f.relPath, bytes: f.bytes.length, sha256: sha256(f.bytes) })),
  };
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
  const parts: Buffer[] = [MAGIC, u32(headerBytes.length), headerBytes];
  for (const file of files) {
    const pathBytes = Buffer.from(file.relPath, 'utf8');
    parts.push(u32(pathBytes.length), pathBytes, u32(file.bytes.length), file.bytes);
  }
  return gzipSync(Buffer.concat(parts));
}

export function readClusterBundle(gzip: Buffer): PortableSnapshotFile[] {
  if (gzip.length > MAX_CLUSTER_BUNDLE_BYTES) throw new Error('cluster bundle exceeds 1 GiB cap');
  let raw: Buffer;
  try {
    raw = gunzipSync(gzip, { maxOutputLength: MAX_CLUSTER_BUNDLE_BYTES });
  } catch (err) {
    throw new Error(`invalid cluster bundle gzip: ${err instanceof Error ? err.message : String(err)}`);
  }
  let offset = 0;
  const take = (n: number, label: string): Buffer => {
    if (!Number.isInteger(n) || n < 0 || offset + n > raw.length) throw new Error(`truncated cluster bundle (${label})`);
    const out = raw.subarray(offset, offset + n);
    offset += n;
    return out;
  };
  if (!take(MAGIC.length, 'magic').equals(MAGIC)) throw new Error('not an Arco cluster bundle');
  const headerLen = take(4, 'header length').readUInt32BE(0);
  let header: BundleHeader;
  try {
    header = JSON.parse(take(headerLen, 'header').toString('utf8')) as BundleHeader;
  } catch {
    throw new Error('invalid cluster bundle header');
  }
  if (header.format !== 'archon-cluster/1' || !Array.isArray(header.files) || header.files.length > MAX_FILES) {
    throw new Error('unsupported cluster bundle format');
  }
  const files: PortableSnapshotFile[] = [];
  const seen = new Set<string>();
  for (const declared of header.files) {
    const pathLen = take(4, 'path length').readUInt32BE(0);
    const relPath = take(pathLen, 'path').toString('utf8');
    const byteLen = take(4, 'file length').readUInt32BE(0);
    const bytes = Buffer.from(take(byteLen, 'file'));
    if (!safePath(relPath) || seen.has(relPath) || relPath !== declared.path) throw new Error('unsafe or mismatched bundle path');
    if (byteLen !== declared.bytes || sha256(bytes) !== declared.sha256) throw new Error(`bundle integrity failure: ${relPath}`);
    seen.add(relPath);
    files.push({ relPath, bytes });
  }
  if (offset !== raw.length) throw new Error('cluster bundle has undeclared trailing data');
  return files;
}

