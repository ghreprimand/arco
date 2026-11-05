import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { KeepItem } from '@arco/shared';
import { atomicWriteFile, withFileLock } from './atomicFile.js';

// Reader for the per-conversation KEEP file (docs/STORAGE_PLAN.md, "KEEP file
// format"): <project>/.arco/workflows/<id>/keep.json. Builder of the KEEP and
// MOVE TO PROJECT controls owns the writer; archive, delete, EMPTY SCRATCH and
// size warnings read it here.
export const KEEP_FILE = 'keep.json';

// One in-process lock per conversation KEEP list. The KEEP writer and every
// action that reads the list and then removes files (archive, delete, EMPTY
// SCRATCH) hold it from the read through the last removal, so a KEEP set
// meanwhile is never undone. Use exactly this key: withFileLock matches keys
// as strings.
export function keepLockKey(conversationDir: string): string {
  return path.join(path.resolve(conversationDir), KEEP_FILE);
}
export function withKeepLock<T>(conversationDir: string, fn: () => Promise<T>): Promise<T> {
  return withFileLock(keepLockKey(conversationDir), fn);
}

// Files of the conversation folder itself that every storage action leaves
// in place: the KEEP list and the record of size warnings already shown.
export const STAYING_FILES = new Set([KEEP_FILE, 'storage-warnings.json']);

export type KeepRead = { ok: true; items: KeepItem[] } | { ok: false };

// Normalized relative path: '/' separators, no '.', '..' or empty parts.
// Returns null for anything that could leave the conversation folder.
export function normalizeKeepPath(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length > 4096 || raw.includes('\0')) return null;
  if (raw === '.' || raw === '') return '.';
  const parts = raw.replace(/\\/g, '/').split('/').filter((p) => p !== '' && p !== '.');
  if (!parts.length) return '.';
  if (parts.some((p) => p === '..') || path.isAbsolute(raw) || /^[a-zA-Z]:/.test(raw)) return null;
  return parts.join('/');
}

// Missing file: nothing is kept. Unreadable or malformed file: { ok: false };
// archive and delete must stop and ask instead of acting.
export async function readKeep(conversationDir: string): Promise<KeepRead> {
  let raw: string;
  try { raw = await fs.readFile(path.join(conversationDir, KEEP_FILE), 'utf8'); }
  catch (err) { return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { ok: true, items: [] } : { ok: false }; }
  try {
    const value = JSON.parse(raw) as { version?: unknown; items?: unknown };
    if (value.version !== 1 || !Array.isArray(value.items)) return { ok: false };
    const items: KeepItem[] = [];
    for (const item of value.items as Array<Partial<KeepItem>>) {
      const p = normalizeKeepPath(item?.path as string);
      if (p === null || (item.reason !== 'operator' && item.reason !== 'size-warning')) return { ok: false };
      items.push({ path: p, reason: item.reason, at: Number(item.at) || 0 });
    }
    return { ok: true, items };
  } catch { return { ok: false }; }
}

// True when `rel` (relative to the conversation folder) is kept: the path
// itself, or a folder above it, or the whole conversation.
export function isKept(items: KeepItem[], rel: string): boolean {
  const p = normalizeKeepPath(rel);
  if (p === null) return false;
  return items.some((k) => k.path === '.' || k.path === p || p.startsWith(`${k.path}/`));
}

// True when something below `rel` is kept (so `rel` itself cannot be removed
// as a whole).
export function holdsKept(items: KeepItem[], rel: string): boolean {
  const p = normalizeKeepPath(rel);
  if (p === null) return true;
  return items.some((k) => k.path.startsWith(`${p}/`));
}

// Add a protection atomically; malformed existing metadata is never overwritten.
export async function addKeep(conversationDir: string, raw: string, reason: KeepItem['reason']): Promise<KeepItem[]> {
  const rel = normalizeKeepPath(raw);
  if (rel === null || (rel !== '.' && !/^(artifacts|scratch)(?:\/|$)/.test(rel))) throw new Error('Invalid KEEP path.');
  if (reason !== 'operator' && reason !== 'size-warning') throw new Error('Invalid KEEP reason.');
  const file = path.join(conversationDir, KEEP_FILE);
  return withKeepLock(conversationDir, async () => {
    let current = conversationDir;
    const root = await fs.lstat(current);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Conversation is unavailable.');
    for (const part of rel === '.' ? [] : rel.split('/')) {
      current = path.join(current, part);
      const st = await fs.lstat(current);
      if (st.isSymbolicLink() || (!st.isDirectory() && !st.isFile())) throw new Error('KEEP does not follow links.');
    }
    try { if ((await fs.lstat(file)).isSymbolicLink()) throw new Error('KEEP file cannot be a link.'); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
    const existing = await readKeep(conversationDir);
    if (!existing.ok) throw new Error('The KEEP list cannot be read; nothing was changed.');
    if (!isKept(existing.items, rel)) {
      if (existing.items.length >= 10000) throw new Error('The KEEP list is full.');
      existing.items.push({ path: rel, reason, at: Date.now() });
      await atomicWriteFile(file, JSON.stringify({ version: 1, items: existing.items }) + '\n', { mode: 0o600, skipMkdir: true });
    }
    return existing.items;
  });
}

// The KEEP entry that protects `rel`: the entry for the path itself, else the
// nearest kept folder above it, else the whole conversation. Null when the
// path is not kept.
export function keepCovering(items: KeepItem[], rel: string): string | null {
  const p = normalizeKeepPath(rel);
  if (p === null) return null;
  let best: string | null = null;
  for (const k of items) {
    const covers = k.path === '.' || k.path === p || p.startsWith(`${k.path}/`);
    if (!covers) continue;
    if (best === null || best === '.' || (k.path !== '.' && k.path.length > best.length)) best = k.path;
  }
  return best;
}

// UNKEEP: remove one protection (exactly that path) or every protection of
// the conversation. Same lock and link rules as addKeep; an unreadable list is
// never rewritten. Returns the remaining entries.
export async function removeKeep(conversationDir: string, raw: string | { all: true }): Promise<KeepItem[]> {
  const rel = typeof raw === 'string' ? normalizeKeepPath(raw) : null;
  if (typeof raw === 'string' && rel === null) throw new Error('Invalid KEEP path.');
  const file = path.join(conversationDir, KEEP_FILE);
  return withKeepLock(conversationDir, async () => {
    const root = await fs.lstat(conversationDir);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Conversation is unavailable.');
    try { if ((await fs.lstat(file)).isSymbolicLink()) throw new Error('KEEP file cannot be a link.'); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []; throw err; }
    const existing = await readKeep(conversationDir);
    if (!existing.ok) throw new Error('The KEEP list cannot be read; nothing was changed.');
    const remaining = rel === null ? [] : existing.items.filter((k) => k.path !== rel);
    if (remaining.length !== existing.items.length) {
      await atomicWriteFile(file, JSON.stringify({ version: 1, items: remaining }) + '\n', { mode: 0o600, skipMkdir: true });
    }
    return remaining;
  });
}
