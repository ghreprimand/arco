import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { KeepItem } from '@arco/shared';

// Reader for the per-conversation KEEP file (docs/STORAGE_PLAN.md, "KEEP file
// format"): <project>/.arco/workflows/<id>/keep.json. Builder of the KEEP and
// MOVE TO PROJECT controls owns the writer; archive, delete, EMPTY SCRATCH and
// size warnings read it here.
export const KEEP_FILE = 'keep.json';

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
