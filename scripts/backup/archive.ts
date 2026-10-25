// ARCO_OPS_PLAN.md §F1 — pure archive (de)serializer for `arco backup`.
//
// Dependency-free, pure-node, REGULAR-FILES-ONLY container. NO tar, NO new npm
// dep. Rationale (plan §F1): the format must "manifest-based, not 'tar a dir'",
// and F3's restore must "manually extract regular files only" — rejecting
// symlinks / hardlinks / device nodes / fifos / sockets. A format that can ONLY
// represent regular files (a relPath + its bytes) eliminates that entire
// dangerous-entry class BY CONSTRUCTION: there is nowhere in the wire format to
// encode a symlink target or a special-file type, so a malicious or corrupt
// archive cannot smuggle one through. Fully portable (gzip + length-framed
// binary), deterministic, and round-trippable in memory by the smoke.
//
// On-the-wire layout (before gzip):
//
//   ┌────────────┬──────────────────────────┬──────────── entries ───────────┐
//   │ MAGIC (8B) │ manifestLen (u32 BE) JSON │ entry · entry · entry · …      │
//   └────────────┴──────────────────────────┴────────────────────────────────┘
//
//   MAGIC        = ASCII "ARCOBK01" (8 bytes). Wrong magic → reject.
//   manifestLen  = uint32 big-endian byte length of the manifest JSON.
//   manifest     = UTF-8 JSON (BackupManifest) — the human-readable contract.
//   each entry   = relPathLen (u32 BE) · relPath (UTF-8) · byteLen (u32 BE) · bytes
//
// The ENTIRE buffer (header + entries) is gzipped (node:zlib gzipSync) so the
// reader can detect a truncated / non-gzip blob immediately. The manifest lives
// INSIDE the gzip so it cannot drift from the bytes it describes.
//
// This module is side-effect-free and clock/random-free: writeArchive takes the
// already-built file list + the already-built manifest and returns a Buffer.
// All path-walking, classification, redaction, and timestamps happen in
// manifest.ts / the CLI — kept out of here so F2 (verify) and F3 (restore) can
// reuse this reader/writer without re-deriving anything.

import { gzipSync, gunzipSync } from 'node:zlib';
import type { BackupManifest } from './manifest.js';

const MAGIC = Buffer.from('ARCOBK01', 'ascii'); // 8 bytes
const U32 = 4;

// A single regular-file entry. `relPath` is POSIX-relative (forward slashes,
// no leading slash, no `..`) — enforced by the walker, re-checked on read.
export interface ArchiveFile {
  relPath: string;
  bytes: Buffer;
}

function u32be(n: number): Buffer {
  const b = Buffer.allocUnsafe(U32);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

// Serialize manifest + regular files → gzipped Buffer. PURE: no fs, no clock.
// The caller guarantees `files` are regular files only and that the manifest
// truthfully describes them (the smoke asserts this round-trips).
export function writeArchive(manifest: BackupManifest, files: ArchiveFile[]): Buffer {
  const manifestJson = Buffer.from(JSON.stringify(manifest), 'utf8');
  const parts: Buffer[] = [MAGIC, u32be(manifestJson.length), manifestJson];
  for (const f of files) {
    const rel = Buffer.from(f.relPath, 'utf8');
    parts.push(u32be(rel.length), rel, u32be(f.bytes.length), f.bytes);
  }
  return gzipSync(Buffer.concat(parts));
}

export interface ReadArchiveResult {
  manifest: BackupManifest;
  files: ArchiveFile[];
}

// Inverse of writeArchive. Validates magic + frame lengths against the buffer
// bounds so a truncated / corrupt archive throws rather than reading OOB. Used
// by the smoke now and by F2/F3 later.
export function readArchive(gz: Buffer): ReadArchiveResult {
  let buf: Buffer;
  try {
    buf = gunzipSync(gz);
  } catch (err) {
    throw new Error(`backup archive: not a valid gzip stream (${(err as Error).message})`);
  }
  let off = 0;
  const need = (n: number, what: string) => {
    if (off + n > buf.length) throw new Error(`backup archive: truncated reading ${what}`);
  };

  need(MAGIC.length, 'magic');
  if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('backup archive: bad magic (not an ARCOBK01 container)');
  }
  off += MAGIC.length;

  need(U32, 'manifest length');
  const manifestLen = buf.readUInt32BE(off);
  off += U32;
  need(manifestLen, 'manifest body');
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(buf.subarray(off, off + manifestLen).toString('utf8')) as BackupManifest;
  } catch (err) {
    throw new Error(`backup archive: manifest JSON parse failed (${(err as Error).message})`);
  }
  off += manifestLen;

  const files: ArchiveFile[] = [];
  while (off < buf.length) {
    need(U32, 'entry path length');
    const relLen = buf.readUInt32BE(off);
    off += U32;
    need(relLen, 'entry path');
    const relPath = buf.subarray(off, off + relLen).toString('utf8');
    off += relLen;
    need(U32, 'entry byte length');
    const byteLen = buf.readUInt32BE(off);
    off += U32;
    need(byteLen, 'entry bytes');
    const bytes = buf.subarray(off, off + byteLen);
    off += byteLen;
    // Defense in depth: never let a crafted relPath escape on extract (F3).
    if (relPath.startsWith('/') || relPath.split('/').includes('..')) {
      throw new Error(`backup archive: unsafe entry path "${relPath}"`);
    }
    files.push({ relPath, bytes: Buffer.from(bytes) });
  }
  return { manifest, files };
}
