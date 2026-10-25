// Phase 7a — token store for Claude Native OAuth credentials.
//
// Storage shape: ~/.arco/auth.json with `claude.native` namespace so a
// future `claude.cli` token persistence (or Codex / Gemini OAuth wins)
// can share the file without collision. Mode 0600, parent dir 0700,
// atomic tmp+rename, proper-lockfile around read/refresh/write.
//
// Lock is held only across the read-refresh-write cycle — never across
// the actual SDK call — so refreshes are serialized but model traffic is
// not.

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import * as lockfile from 'proper-lockfile';
import { atomicWriteFile } from '../../atomicFile.js';
import { arcoHome } from '../../arcoHome.js';

export interface ClaudeNativeTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  tokenType: string;
  scope: string;
  obtainedAt: number;
}

interface AuthFileShape {
  claude?: {
    native?: ClaudeNativeTokens;
  };
}

const ARCO_DIR = arcoHome();
const AUTH_PATH = join(ARCO_DIR, 'auth.json');

async function ensureDir(): Promise<void> {
  await fs.mkdir(ARCO_DIR, { recursive: true, mode: 0o700 });
}

async function readRaw(): Promise<AuthFileShape> {
  try {
    const buf = await fs.readFile(AUTH_PATH, 'utf8');
    const parsed = JSON.parse(buf) as AuthFileShape;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

async function writeRaw(data: AuthFileShape): Promise<void> {
  await ensureDir();
  await atomicWriteFile(AUTH_PATH, JSON.stringify(data, null, 2), { mode: 0o600 });
}

// proper-lockfile requires the target file to exist before locking. Touch
// it (empty `{}`) when first reaching here on a fresh machine.
async function ensureFile(): Promise<void> {
  try {
    await fs.access(AUTH_PATH);
  } catch {
    await ensureDir();
    await fs.writeFile(AUTH_PATH, '{}\n', { encoding: 'utf8', mode: 0o600 });
  }
}

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  await ensureFile();
  const release = await lockfile.lock(AUTH_PATH, {
    retries: { retries: 10, minTimeout: 50, maxTimeout: 500 },
    stale: 30_000,
  });
  try {
    return await fn();
  } finally {
    await release();
  }
}

export async function loadTokens(): Promise<ClaudeNativeTokens | null> {
  const data = await readRaw();
  return data.claude?.native ?? null;
}

export async function saveTokens(next: ClaudeNativeTokens): Promise<void> {
  await withLock(async () => {
    const data = await readRaw();
    const merged: AuthFileShape = {
      ...data,
      claude: { ...(data.claude ?? {}), native: next },
    };
    await writeRaw(merged);
  });
}

export async function clearTokens(): Promise<void> {
  await withLock(async () => {
    const data = await readRaw();
    if (data.claude?.native) {
      delete data.claude.native;
      if (Object.keys(data.claude).length === 0) delete data.claude;
    }
    await writeRaw(data);
  });
}

// Run `fn` while holding the auth-file lock. Used by oauth.ts to refresh
// the token in a critical section.
export async function withAuthLock<T>(fn: () => Promise<T>): Promise<T> {
  return withLock(fn);
}

export async function readTokensUnlocked(): Promise<ClaudeNativeTokens | null> {
  const data = await readRaw();
  return data.claude?.native ?? null;
}

export async function writeTokensUnlocked(next: ClaudeNativeTokens): Promise<void> {
  const data = await readRaw();
  const merged: AuthFileShape = {
    ...data,
    claude: { ...(data.claude ?? {}), native: next },
  };
  await writeRaw(merged);
}
