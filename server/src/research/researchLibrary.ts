// docs/RESEARCH.md - the Research library: Arco's index of research
// projects, listed on Home. The index only makes projects findable; status,
// question and counts are read from each folder's research.json every time,
// so the folder stays the source of truth. Nothing here creates, moves or
// deletes a research folder.

import { promises as fs } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  RESEARCH_MAX_RESEARCHERS,
  type ClusterMemberProvider,
  type ResearchLibraryRow,
  type ResearchReopenPreview,
} from '@arco/shared';
import { atomicWriteFile, withFileLock } from '../atomicFile.js';
import { loadAllClustersFromDisk } from '../clusterStore.js';
import { readSettings } from '../settings.js';
import { readMeta } from '../workflowMeta.js';
import { closedResearchRecordPath } from './researchClose.js';
import { researchMembersRoot } from './researchCreate.js';
import { researchLetter, upgradeResearchState, type ResearchState } from './researchState.js';

export interface LibraryEntry {
  projectId: string;
  folder: string;
  name: string;
  createdAt: string;
  addedAt: string;
  // FORGET: kept so the folder scan does not add the project back.
  forgotten?: boolean;
}

interface LibraryFile { schemaVersion: 1; projects: LibraryEntry[] }

// What research.json says about a project, as far as the library needs it.
export interface ResearchManifest {
  projectId?: string;
  name?: string;
  brief?: string;
  status?: string;
  createdAt?: string;
  closedAt?: string;
  blind?: boolean;
  revealedAt?: string;
  researchers?: Array<{ letter?: string; removedAt?: string }>;
  rounds?: unknown[];
}

const SCAN_LIMIT = 500;

export function libraryPath(): string { return join(researchMembersRoot(), 'library.json'); }

const closedRecordPath = (projectId: string): string => closedResearchRecordPath(projectId);

async function readLibraryFile(): Promise<LibraryFile> {
  try {
    const parsed = JSON.parse(await fs.readFile(libraryPath(), 'utf8')) as LibraryFile;
    if (parsed?.schemaVersion === 1 && Array.isArray(parsed.projects)) return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return { schemaVersion: 1, projects: [] };
}

async function writeLibraryFile(file: LibraryFile): Promise<void> {
  await fs.mkdir(researchMembersRoot(), { recursive: true, mode: 0o700 });
  await atomicWriteFile(libraryPath(), JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
}

// Serialized read-modify-write of the index; returning false writes nothing.
async function updateLibrary<T>(mutate: (file: LibraryFile) => T | false): Promise<T | false> {
  return withFileLock(libraryPath(), async () => {
    const file = await readLibraryFile();
    const result = mutate(file);
    if (result !== false) await writeLibraryFile(file);
    return result;
  });
}

export async function readLibrary(): Promise<LibraryEntry[]> {
  return (await readLibraryFile()).projects;
}

// A project Arco just created, or one picked up from the research folder.
export async function addToLibrary(entry: Omit<LibraryEntry, 'addedAt'>, now = new Date()): Promise<void> {
  await updateLibrary((file) => {
    const known = file.projects.find((p) => p.projectId === entry.projectId);
    if (known) {
      if (known.folder === entry.folder) return false;
      known.folder = entry.folder;
      return true;
    }
    file.projects.push({ ...entry, addedAt: now.toISOString() });
    return true;
  });
}

export async function readManifest(folder: string): Promise<ResearchManifest | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(join(folder, 'research.json'), 'utf8')) as ResearchManifest;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch { return null; }
}

// Whether a research.json belongs to this entry. Manifests written before
// the library carry no projectId and match on name and creation time.
export function manifestMatches(entry: Pick<LibraryEntry, 'projectId' | 'name' | 'createdAt'>, manifest: ResearchManifest | null): boolean {
  if (!manifest) return false;
  if (typeof manifest.projectId === 'string') return manifest.projectId === entry.projectId;
  return manifest.name === entry.name && manifest.createdAt === entry.createdAt;
}

export async function readClosedRecord(projectId: string): Promise<ResearchState | null> {
  try {
    const state = upgradeResearchState(JSON.parse(await fs.readFile(closedRecordPath(projectId), 'utf8')) as ResearchState);
    return state?.schemaVersion === 1 && state.projectId === projectId ? state : null;
  } catch { return null; }
}

// The kept record whose folder is `folder`, for a project found by the scan.
async function closedRecordIdFor(folder: string): Promise<string | undefined> {
  const names = await fs.readdir(join(researchMembersRoot(), 'closed')).catch(() => [] as string[]);
  for (const name of names) {
    const id = /^([0-9a-f-]{36})\.json$/.exec(name)?.[1];
    if (!id) continue;
    const record = await readClosedRecord(id);
    if (record && resolve(record.folder) === resolve(folder)) return id;
  }
  return undefined;
}

// Adds research projects in the configured research folder that the index
// does not know yet (projects made before the library). Arco never writes
// into a folder only to tag it: a new id lives in the index alone.
export async function scanResearchFolder(root: string | undefined, now = new Date()): Promise<number> {
  if (!root || !isAbsolute(root)) return 0;
  const dirs = (await fs.readdir(root, { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory()).slice(0, SCAN_LIMIT);
  const known = await readLibrary();
  const found: Array<Omit<LibraryEntry, 'addedAt'>> = [];
  for (const dir of dirs) {
    const folder = join(root, dir.name);
    const manifest = await readManifest(folder);
    if (!manifest || typeof manifest.name !== 'string' || typeof manifest.createdAt !== 'string') continue;
    if (known.some((e) => resolve(e.folder) === resolve(folder) || manifestMatches(e, manifest))) continue;
    const projectId = typeof manifest.projectId === 'string' ? manifest.projectId : await closedRecordIdFor(folder) ?? randomUUID();
    if (known.some((e) => e.projectId === projectId)) continue;
    found.push({ projectId, folder, name: manifest.name, createdAt: manifest.createdAt });
  }
  if (!found.length) return 0;
  await updateLibrary((file) => {
    for (const entry of found) {
      if (!file.projects.some((p) => p.projectId === entry.projectId)) file.projects.push({ ...entry, addedAt: now.toISOString() });
    }
    return true;
  });
  return found.length;
}

// Project id to live cluster id for every research project with a cluster.
export async function liveResearchClusters(): Promise<Map<string, string>> {
  const live = new Map<string, string>();
  for (const cluster of await loadAllClustersFromDisk()) {
    if (cluster.research?.projectId) live.set(cluster.research.projectId, cluster.clusterId);
  }
  return live;
}

export function firstLine(text: string | undefined): string {
  return (text ?? '').split('\n').map((line) => line.trim()).find(Boolean)?.slice(0, 200) ?? '';
}

// The rows Home shows, newest first. `liveClusters` maps a project id to
// the cluster that has it open.
export async function libraryRows(liveClusters: Map<string, string>): Promise<ResearchLibraryRow[]> {
  const settings = await readSettings().catch(() => null);
  await scanResearchFolder(settings?.researchFolder).catch((error) => console.error('[arco] research library scan failed:', error));
  const rows: ResearchLibraryRow[] = [];
  for (const entry of await readLibrary()) {
    if (entry.forgotten) continue;
    const manifest = await readManifest(entry.folder);
    const matches = manifestMatches(entry, manifest);
    const clusterId = liveClusters.get(entry.projectId);
    const status = clusterId ? 'open' : !matches ? 'missing' : 'closed';
    rows.push({
      projectId: entry.projectId,
      name: matches && typeof manifest!.name === 'string' ? manifest!.name : entry.name,
      folder: entry.folder,
      status,
      question: matches ? firstLine(manifest!.brief) : '',
      createdAt: entry.createdAt,
      ...(matches && typeof manifest!.closedAt === 'string' && status === 'closed' ? { closedAt: manifest!.closedAt } : {}),
      researchers: matches && Array.isArray(manifest!.researchers) ? manifest!.researchers.filter((r) => !r?.removedAt).length : 0,
      rounds: matches && Array.isArray(manifest!.rounds) ? manifest!.rounds.length : 0,
      ...(clusterId ? { clusterId } : {}),
    });
  }
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export type LocateResult = { ok: true } | { ok: false; code: 'unknown_project' | 'invalid_folder' | 'not_this_project' };

// LOCATE: the operator points at the folder a project was moved to. Only a
// folder whose research.json belongs to the entry is accepted; the kept
// record follows it so a reopen still finds the authors.
export async function locateProject(projectId: string, folder: string): Promise<LocateResult> {
  if (typeof folder !== 'string' || !isAbsolute(folder)) return { ok: false, code: 'invalid_folder' };
  const entry = (await readLibrary()).find((e) => e.projectId === projectId && !e.forgotten);
  if (!entry) return { ok: false, code: 'unknown_project' };
  if (!manifestMatches(entry, await readManifest(folder))) return { ok: false, code: 'not_this_project' };
  const target = resolve(folder);
  await updateLibrary((file) => {
    const e = file.projects.find((p) => p.projectId === projectId);
    if (!e) return false;
    e.folder = target;
    return true;
  });
  await withFileLock(closedRecordPath(projectId), async () => {
    const record = await readClosedRecord(projectId);
    if (!record || record.folder === target) return;
    await atomicWriteFile(closedRecordPath(projectId), JSON.stringify({ ...record, folder: target }, null, 2) + '\n', { mode: 0o600 });
  });
  return { ok: true };
}

// FORGET: removes the project from the library only. The folder and the
// kept record are left alone.
export async function forgetProject(projectId: string): Promise<boolean> {
  return await updateLibrary((file) => {
    const e = file.projects.find((p) => p.projectId === projectId && !p.forgotten);
    if (!e) return false;
    e.forgotten = true;
    return true;
  }) !== false;
}

export interface ReopenSource { entry: LibraryEntry; record: ResearchState }

export type ReopenSourceResult = ReopenSource | { reason: string };

// What a reopen needs: the entry, a folder that still belongs to it, and
// Arco's kept record (the author mapping and the round texts).
export async function reopenSource(projectId: string, liveClusters: Map<string, string>): Promise<ReopenSourceResult> {
  const entry = (await readLibrary()).find((e) => e.projectId === projectId && !e.forgotten);
  if (!entry) return { reason: 'This project is not in the Research library.' };
  if (liveClusters.has(projectId)) return { reason: 'This project is already open.' };
  if (!manifestMatches(entry, await readManifest(entry.folder))) return { reason: 'The project folder is missing. Use LOCATE first.' };
  const record = await readClosedRecord(projectId);
  if (!record) return { reason: 'Arco\'s record of this project is missing, so it cannot be reopened. The files in its folder are unchanged.' };
  return { entry, record: { ...record, folder: entry.folder } };
}

const PROVIDER_NAMES: Partial<Record<ClusterMemberProvider, string>> = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor', ollama: 'Ollama', llamacpp: 'llama.cpp' };

// The REOPEN dialog: can the saved Research Director be resumed, and the
// earlier panel to prefill the new researchers with.
export async function reopenPreview(
  projectId: string,
  liveClusters: Map<string, string>,
  providerRefusal: (provider: ClusterMemberProvider) => Promise<string | null | undefined>,
): Promise<ResearchReopenPreview | null> {
  const entry = (await readLibrary()).find((e) => e.projectId === projectId && !e.forgotten);
  if (!entry) return null;
  const source = await reopenSource(projectId, liveClusters);
  if ('reason' in source) {
    return { projectId, name: entry.name, folder: entry.folder, reopenable: false, reason: source.reason,
      director: { resumable: false }, researchers: [], nextLetter: 'A', slots: 0 };
  }
  const { record } = source;
  const meta = await readMeta(entry.folder, record.directorWorkflowId).catch(() => null);
  let reason: string | undefined;
  if (!meta) reason = 'Its conversation is no longer in the project folder.';
  else if (await providerRefusal(meta.primaryProvider as ClusterMemberProvider)) {
    reason = `${PROVIDER_NAMES[meta.primaryProvider as ClusterMemberProvider] ?? meta.primaryProvider} is turned off in Settings.`;
  }
  const authors = !record.blind || !!record.revealedAt;
  const panel = record.researchers.map((r) => ({ provider: r.provider, model: r.model, ...(r.effort ? { effort: r.effort } : {}), ...(r.claudeTransport ? { claudeTransport: r.claudeTransport } : {}) }))
    // Only the latest panel: researchers still in the project when it closed.
    .filter((_, i) => !record.researchers[i].removedAt);
  if (!authors) panel.sort((a, b) => `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`));
  const slots = Math.max(0, RESEARCH_MAX_RESEARCHERS - record.researchers.length);
  return {
    projectId, name: record.name, folder: entry.folder,
    reopenable: slots > 0, ...(slots > 0 ? {} : { reason: 'Every researcher letter up to Z has been used in this project.' }),
    director: {
      resumable: !reason, ...(reason ? { reason } : {}),
      ...(meta ? { provider: meta.primaryProvider as ClusterMemberProvider, model: String(meta.primaryModel ?? ''), ...(meta.primaryEffort ? { effort: String(meta.primaryEffort) } : {}) } : {}),
    },
    researchers: panel,
    nextLetter: researchLetter(record.researchers.length),
    slots,
  };
}
