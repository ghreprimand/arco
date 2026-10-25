// Client-side-at-rest encryption for cluster cloud snapshots. The VPS stores
// only this opaque envelope; the 256-bit key never leaves the workstation.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { atomicWriteFile } from './atomicFile.js';
import { archonHome } from './archonHome.js';

const MAGIC = Buffer.from('ARCHCV01', 'ascii');
const KEY_PATH = path.join(archonHome(), 'cluster-vault.key');

export async function readVaultKey(create = false): Promise<Buffer | null> {
  try {
    const raw = (await fs.readFile(KEY_PATH, 'utf8')).trim();
    const key = Buffer.from(raw, 'base64url');
    if (/^[a-zA-Z0-9_-]{43}$/.test(raw) && key.length === 32) return key;
    if (!create) return null;
    throw new Error(`cluster vault key is invalid: ${KEY_PATH}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      if (!create) return null;
      throw err;
    }
    if (!create) return null;
    const key = randomBytes(32);
    await fs.mkdir(path.dirname(KEY_PATH), { recursive: true });
    try {
      // Exclusive create prevents two simultaneous first cloud saves from
      // minting different keys and making one upload immediately unreadable.
      await fs.writeFile(KEY_PATH, key.toString('base64url') + '\n', { mode: 0o600, flag: 'wx' });
    } catch (writeErr) {
      if ((writeErr as NodeJS.ErrnoException).code !== 'EEXIST') throw writeErr;
      const raced = await readVaultKey(false);
      if (!raced) throw new Error(`cluster vault key is invalid: ${KEY_PATH}`);
      return raced;
    }
    await fs.chmod(KEY_PATH, 0o600).catch(() => {});
    return key;
  }
}

export async function exportVaultKey(): Promise<string> {
  const key = await readVaultKey(true);
  return key!.toString('base64url');
}

export async function importVaultKey(encoded: string): Promise<void> {
  const normalized = encoded.trim();
  const key = Buffer.from(normalized, 'base64url');
  if (!/^[a-zA-Z0-9_-]{43}$/.test(normalized) || key.length !== 32) {
    throw new Error('vault key must be a 43-character Arco base64url key');
  }
  await atomicWriteFile(KEY_PATH, key.toString('base64url') + '\n', { mode: 0o600 });
}

export function encryptVaultBlob(plain: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptVaultBlob(envelope: Buffer, key: Buffer): Buffer {
  if (envelope.length < MAGIC.length + 12 + 16 || !envelope.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('not an Arco encrypted cluster snapshot');
  }
  const iv = envelope.subarray(MAGIC.length, MAGIC.length + 12);
  const tag = envelope.subarray(MAGIC.length + 12, MAGIC.length + 28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(envelope.subarray(MAGIC.length + 28)), decipher.final()]);
  } catch {
    throw new Error('unable to decrypt snapshot — this machine has a different vault key');
  }
}
