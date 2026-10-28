// Project records: stable identity and organization for project folders.
//
// The project list itself still comes from settings.projects, the scan folder
// and the recent-cwd registry (projects.ts); that stays the authority for
// containment. This sidecar only adds metadata keyed by a random id:
//   ~/.arco/projects.json  { version: 1, records: ProjectRecord[] }
// A registered or recently used path gets a record; discovery alone does not. Relocating a project changes
// its path and keeps its id, display name, pin/archive state and the previous
// path (so saved work recorded under it stays associated). Workflow files and
// provider sessions are never rewritten; nothing here touches project folders.
//
// An unreadable or malformed store is never overwritten: listing continues
// without ids and every organization change is refused until it is repaired.
// A store that cannot be written (read-only volume, full disk) only degrades
// the listing: known records still show, no id is invented for a new folder,
// and organization changes are refused.
//
// Relocation is two-phase so an interruption never strands a record: the
// record first gains pendingPath, then settings register the new folder, then
// the record moves. A listing finishes a pending move whose target is listed
// and only drops an absent target after a fresh snapshot taken under the lock.
import { promises as fs } from 'fs';
import { arcoHome } from './arcoHome.js';
import path from 'path';
import { randomUUID } from 'crypto';
import { atomicWriteFile, withFileLock } from './atomicFile.js';

export interface ProjectRecord {
  id: string;
  path: string;
  displayName?: string;
  pinned?: boolean;
  archived?: boolean;
  // Most recent first. Only missing previous paths are folded into the record.
  previousPaths?: string[];
  // Set only between the two writes of a relocation.
  pendingPath?: string;
}

export const MAX_RECORDS = 1000;
export const MAX_PREVIOUS_PATHS = 10;
export const MAX_DISPLAY_NAME = 80;
const ID = /^[a-f0-9-]{36}$/;

export const projectRecordsPath = () => path.join(arcoHome(), 'projects.json');

const absolute = (p: unknown): p is string => typeof p === 'string' && path.isAbsolute(p) && !p.includes('\0') && p.length <= 4096;

export function cleanDisplayName(raw: unknown): string | undefined | null {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') return null;
  // Collapse whitespace and drop control characters; empty resets to derived.
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return name.length > MAX_DISPLAY_NAME ? null : name;
}

// Reject the whole store if any entry cannot be represented without loss.
// Salvaging siblings would overwrite the original bytes on the next write.
export function parseRecords(body: unknown): ProjectRecord[] | null {
  if (!body || typeof body !== 'object' || (body as { version?: unknown }).version !== 1) return null;
  const list = (body as { records?: unknown }).records;
  if (!Array.isArray(list) || list.length > MAX_RECORDS) return null;
  if (Object.keys(body).some((key) => key !== 'version' && key !== 'records')) return null;
  const out: ProjectRecord[] = [];
  const ids = new Set<string>(), paths = new Set<string>();
  const keys = new Set(['id', 'path', 'displayName', 'pinned', 'archived', 'previousPaths', 'pendingPath']);
  for (const raw of list) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const r = raw as Record<string, unknown>;
    if (Object.keys(r).some((key) => !keys.has(key))) return null;
    if (typeof r.id !== 'string' || !ID.test(r.id) || !absolute(r.path)) return null;
    const resolved = path.resolve(r.path);
    if (ids.has(r.id) || paths.has(resolved)) return null;
    const record: ProjectRecord = { id: r.id, path: resolved };
    const name = cleanDisplayName(r.displayName);
    if (name === null || name !== r.displayName) return null;
    if (name !== undefined) record.displayName = name;
    for (const key of ['pinned', 'archived'] as const) {
      if (r[key] !== undefined) {
        if (typeof r[key] !== 'boolean') return null;
        record[key] = r[key];
      }
    }
    if (r.previousPaths !== undefined) {
      if (!Array.isArray(r.previousPaths) || r.previousPaths.length > MAX_PREVIOUS_PATHS || !r.previousPaths.every(absolute)) return null;
      const prev = r.previousPaths.map((p) => path.resolve(p));
      if (new Set(prev).size !== prev.length || prev.includes(resolved)) return null;
      record.previousPaths = prev;
    }
    if (r.pendingPath !== undefined) {
      if (!absolute(r.pendingPath) || path.resolve(r.pendingPath) === resolved) return null;
      record.pendingPath = path.resolve(r.pendingPath);
    }
    ids.add(r.id); paths.add(resolved);
    out.push(record);
  }
  return out;
}

type Loaded = { ok: true; records: ProjectRecord[] } | { ok: false };

export async function readRecords(file = projectRecordsPath()): Promise<Loaded> {
  let text: string;
  try { text = await fs.readFile(file, 'utf8'); } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { ok: true, records: [] } : { ok: false };
  }
  try {
    const records = parseRecords(JSON.parse(text));
    return records ? { ok: true, records } : { ok: false };
  } catch { return { ok: false }; }
}

async function writeRecords(records: ProjectRecord[], file: string): Promise<void> {
  await atomicWriteFile(file, JSON.stringify({ version: 1, records }, null, 2) + '\n');
}

export interface ListedPath { path: string; exists: boolean; discovered?: boolean }

// Pure: finish pending relocations; only a fresh in-lock snapshot may drop
// an absent target. Hide missing folders a project has
// moved away from, and give every remaining listed path a record (minting ids
// only when `mint` is set, i.e. when the result can be stored).
export function reconcile(records: ProjectRecord[], listed: ListedPath[], mint = true, mintId: () => string = randomUUID, fresh = false): { records: ProjectRecord[]; visible: string[]; changed: boolean } {
  let next = [...records];
  let changed = false;
  const listedPaths = new Set(listed.map((p) => p.path));
  for (const pending of records.filter((r) => r.pendingPath)) {
    const target = pending.pendingPath!;
    const moved = listedPaths.has(target) ? relocateRecord(next, pending.id, target) : null;
    if (moved && !('error' in moved)) next = moved.records;
    else if (listedPaths.has(target) || fresh) next = next.map((r) => (r.id === pending.id ? withoutPending(r) : r));
    else continue; // An older snapshot cannot prove registration was abandoned.
    changed = true;
  }
  const movedFrom = new Set(next.flatMap((r) => r.previousPaths ?? []));
  const visible = listed.filter((p) => p.exists || !movedFrom.has(p.path)).map((p) => p.path);
  const byPath = new Set(next.map((r) => r.path));
  const discovered = new Set(listed.filter(p => p.discovered).map(p => p.path));
  for (const p of visible) {
    if (byPath.has(p) || !mint || discovered.has(p)) continue;
    if (next.length >= MAX_RECORDS) break;
    byPath.add(p); next.push({ id: mintId(), path: p }); changed = true;
  }
  return { records: next, visible, changed };
}

const withoutPending = (r: ProjectRecord): ProjectRecord => { const { pendingPath: _pending, ...rest } = r; return rest; };

// Serialize every read-modify-write of the store. A read or write failure is
// reported as storeError; nothing is written over an unreadable store.
export function withRecords<T>(fn: (records: ProjectRecord[]) => Promise<{ records?: ProjectRecord[]; result: T }>, file = projectRecordsPath()): Promise<T | { storeError: true }> {
  return withFileLock(file, async () => {
    const loaded = await readRecords(file);
    if (!loaded.ok) return { storeError: true as const };
    const { records, result } = await fn(loaded.records);
    if (records) {
      try { await writeRecords(records, file); } catch { return { storeError: true as const }; }
    }
    return result;
  });
}

// Records and visible paths for a listing. `organization` is false when the
// store cannot be read (no records) or cannot be written (known records only).
export async function recordsFor(source: ListedPath[] | (() => Promise<ListedPath[]>), file = projectRecordsPath()): Promise<{ records: ProjectRecord[]; visible: string[]; organization: boolean }> {
  return withFileLock(file, async () => {
    // Folder settings must be sampled after acquiring this lock: relocation
    // updates settings while holding it. A queued pre-move snapshot could
    // otherwise discard pendingPath after the final record write failed.
    const listed = typeof source === 'function' ? await source() : source;
    const loaded = await readRecords(file);
    if (!loaded.ok) return { records: [], visible: listed.map((p) => p.path), organization: false };
    const { records, visible, changed } = reconcile(loaded.records, listed, true, randomUUID, typeof source === 'function');
    try {
      if (changed) await writeRecords(records, file);
      return { records, visible, organization: true };
    } catch {
      const kept = reconcile(loaded.records, listed, false, randomUUID, typeof source === 'function');
      return { records: kept.records, visible: kept.visible, organization: false };
    }
  });
}

export type RelocateOutcome = { ok: true } | { ok: false; error: string; status: number } | { storeError: true };

// Two-phase relocation under the store lock. `isMissing` is checked inside the
// lock, so two relocations of one project cannot both succeed. `register`
// writes the settings; if it fails the pending marker is dropped by the next
// listing. If only the final record write fails, the next listing finishes it.
export function relocateStored(id: string, target: string, isMissing: (p: string) => Promise<boolean>, register: (from: string) => Promise<void>, file = projectRecordsPath()): Promise<RelocateOutcome> {
  return withFileLock(file, async (): Promise<RelocateOutcome> => {
    const loaded = await readRecords(file);
    if (!loaded.ok) return { storeError: true };
    const records = loaded.records.map((r) => (r.id === id ? withoutPending(r) : r));
    const moved = relocateRecord(records, id, target);
    if ('error' in moved) return { ok: false, error: moved.error, status: moved.error === 'project not found' ? 404 : 400 };
    if (!(await isMissing(moved.from))) return { ok: false, error: 'only a project whose folder is missing can be relocated', status: 400 };
    try { await writeRecords(records.map((r) => (r.id === id ? { ...r, pendingPath: target } : r)), file); } catch { return { storeError: true }; }
    try { await register(moved.from); } catch { return { ok: false, error: 'the project list could not be saved; nothing was moved', status: 503 }; }
    try { await writeRecords(moved.records, file); } catch { /* the next listing finishes the move */ }
    return { ok: true };
  });
}

export type OrganizePatch = { displayName?: string; pinned?: boolean; archived?: boolean };

// Validates an organization patch from the HTTP body.
export function parseOrganizePatch(body: Record<string, unknown>): OrganizePatch | null {
  const patch: OrganizePatch = {};
  const name = cleanDisplayName(body.displayName);
  if (name === null) return null;
  if (name !== undefined) patch.displayName = name;
  for (const key of ['pinned', 'archived'] as const) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== 'boolean') return null;
    patch[key] = body[key] as boolean;
  }
  return Object.keys(patch).length ? patch : null;
}

export function applyOrganize(record: ProjectRecord, patch: OrganizePatch): ProjectRecord {
  const next: ProjectRecord = { ...record };
  if (patch.displayName !== undefined) { if (patch.displayName) next.displayName = patch.displayName; else delete next.displayName; }
  if (patch.pinned !== undefined) { if (patch.pinned) next.pinned = true; else delete next.pinned; }
  if (patch.archived !== undefined) { if (patch.archived) next.archived = true; else delete next.archived; }
  return next;
}

// Pure relocation: the record keeps its id and metadata, gains the old path as
// a previous path, and takes over the target path. A target that already has a
// record is only replaced when that record carries nothing the operator set.
export function relocateRecord(records: ProjectRecord[], id: string, target: string): { records: ProjectRecord[]; from: string } | { error: string } {
  const record = records.find((r) => r.id === id);
  if (!record) return { error: 'project not found' };
  if (record.path === target) return { error: 'the project is already at that folder' };
  const occupant = records.find((r) => r.path === target);
  if (occupant && (occupant.displayName || occupant.pinned || occupant.archived || occupant.previousPaths?.length)) {
    return { error: 'that folder is already a project with its own name, pin, archive or history' };
  }
  const previousPaths = [record.path, ...(record.previousPaths ?? []).filter((p) => p !== target && p !== record.path)].slice(0, MAX_PREVIOUS_PATHS);
  const moved: ProjectRecord = { ...withoutPending(record), path: target, previousPaths };
  return { records: records.filter((r) => r !== occupant).map((r) => (r === record ? moved : r)), from: record.path };
}
