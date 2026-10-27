// Project registry. A project is a folder the operator can open a workflow in.
// Projects live anywhere the server can read; nothing requires one parent
// tree. Three sources feed one flat list, in precedence order:
//   registered -- settings.projects, added explicitly (settings or the creator)
//   scanned    -- children of the optional scan folder
//                (settings.defaultWorkingDirectory, else ~/Projects when present)
//   recent     -- the crash-recovery registry: every cwd a workflow ran in
//
// The same list is the containment authority for the explorer scans, mkdir and
// no-workflow writes. The earlier $HOME jail broke the Docker layout, where
// HOME is the data volume and projects are bind-mounted elsewhere.
import { mkdir, readFile, readdir, stat } from 'fs/promises';
import { realpathSync } from 'node:fs';
import { homedir } from 'os';
import path from 'path';
import { readKnownCwds } from './crashRecovery.js';
import { chatRootDir } from './chatMode.js';
import { patchSettings, readSettings, sanitizeProjects } from './settings.js';
import { assertSafePath, confinedPath, isPathWithin, safeDirectory } from './fileAccessPolicy.js';
import {
  applyOrganize, parseOrganizePatch, recordsFor, relocateStored, withRecords, type ProjectRecord,
} from './projectRecords.js';

export type ProjectSource = 'registered' | 'scanned' | 'recent';

export interface ProjectEntry {
  path: string;
  name: string;
  source: ProjectSource;
  exists: boolean;
  // Additive organization fields (projectRecords.ts). `name` is the display
  // name when one is set, else `derivedName`. `id` is absent only while the
  // record store is unreadable.
  id?: string;
  derivedName?: string;
  displayName?: string;
  pinned?: boolean;
  archived?: boolean;
  previousPaths?: string[];
}

export interface ProjectList {
  projects: ProjectEntry[];
  scanFolder: string | null;
  // False while ~/.arco/projects.json is unreadable: no ids, no organizing.
  organization?: boolean;
}

interface ProjectInputs {
  registered: string[];
  scanFolder: string | null;
  scanned: string[];
  recent: string[];
}

// Pure merge: first source wins per path; order within a source is kept.
export function mergeProjects(inputs: ProjectInputs, exists: (p: string) => boolean, nameOf: (p: string) => string = (p) => path.basename(p) || p): ProjectList {
  const seen = new Set<string>();
  const projects: ProjectEntry[] = [];
  const add = (list: string[], source: ProjectSource) => {
    for (const raw of list) {
      const resolved = path.resolve(raw);
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      projects.push({ path: resolved, name: nameOf(resolved), source, exists: exists(resolved) });
    }
  };
  add(inputs.registered, 'registered');
  add(inputs.scanned, 'scanned');
  add(inputs.recent, 'recent');
  return { projects, scanFolder: inputs.scanFolder };
}

async function isDirectory(p: string): Promise<boolean> {
  try { return (await stat(p)).isDirectory(); } catch { return false; }
}

async function resolveScanFolder(configured: string | undefined): Promise<string | null> {
  if (configured) {
    try { return safeDirectory(path.resolve(configured)); } catch { return null; }
  }
  const fallback = path.join(homedir(), 'Projects');
  return (await isDirectory(fallback)) ? fallback : null;
}

// Children of the scan folder. A scan folder that is itself a Git repository
// is one project, not a folder of projects: the Docker default mounts a single
// repository at /projects, and offering its internals as projects is wrong.
export async function scanFolderProjects(folder: string | null): Promise<string[]> {
  if (!folder) return [];
  try { safeDirectory(folder); } catch { return []; }
  if (await isDirectory(path.join(folder, '.git'))) return [folder];
  try {
    const entries = await readdir(folder, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => path.join(folder, e.name))
      .filter((p) => { try { safeDirectory(p); return true; } catch { return false; } })
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

// A project's display name. The folder name is usually right, but a Docker
// mount target such as /projects says nothing, so prefer the package name or
// the Git remote's repository name when the folder carries one.
export async function projectDisplayName(folder: string): Promise<string> {
  const fallback = path.basename(folder) || folder;
  try {
    const pkg = JSON.parse(await readFile(confinedPath(path.join(folder, 'package.json'), [folder]), 'utf8')) as { name?: unknown };
    if (typeof pkg.name === 'string' && pkg.name.trim()) return pkg.name.trim().replace(/^@[^/]+\//, '');
  } catch { /* no package.json */ }
  try {
    const realRoot = safeDirectory(folder);
    // Match safeDirectory's resolver: native realpath expands Windows short
    // names differently and can make an in-root config look like an escape.
    const configPath = realpathSync(path.join(folder, '.git', 'config'));
    if (!isPathWithin(path.join(realRoot, '.git'), configPath) || !(await stat(configPath)).isFile()) return fallback;
    const config = await readFile(configPath, 'utf8');
    const url = /^\s*url\s*=\s*(\S+)/m.exec(config)?.[1];
    const repo = url?.split(/[/:]/).pop()?.replace(/\.git$/, '');
    if (repo) return repo;
  } catch { /* not a repository */ }
  return fallback;
}

// Chats run in per-chat folders under the chat store and are remembered like
// any workflow cwd; they are conversations, not projects, so the recent list
// (Home, creator PROJECTS) never offers them.
export function isChatStorage(p: string, root = chatRootDir()): boolean {
  return isPathWithin(path.resolve(root), path.resolve(p));
}

// The merged folder list without organization records. Containment uses this
// (only existing folders count), so file access never reads or writes the
// record store.
async function listFolders(): Promise<ProjectList> {
  const settings = await readSettings().catch(() => null);
  const scanFolder = await resolveScanFolder(settings?.defaultWorkingDirectory);
  const safe = (p: string) => {
    try { assertSafePath(p); } catch { return false; }
    try { safeDirectory(p); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'ENOENT'; }
  };
  const registered = (settings?.projects ?? []).filter(safe);
  const [scanned, allRecent] = await Promise.all([scanFolderProjects(scanFolder), readKnownCwds()]);
  const recent = allRecent.filter((p) => safe(p) && !isChatStorage(p));
  const existence = new Map<string, boolean>();
  const names = new Map<string, string>();
  for (const p of [...registered, ...scanned, ...recent]) {
    const resolved = path.resolve(p);
    if (existence.has(resolved)) continue;
    const exists = await isDirectory(resolved);
    existence.set(resolved, exists);
    names.set(resolved, exists ? await projectDisplayName(resolved) : path.basename(resolved) || resolved);
  }
  return mergeProjects({ registered, scanFolder, scanned, recent }, (p) => existence.get(p) ?? false, (p) => names.get(p) ?? path.basename(p));
}

export async function listProjects(): Promise<ProjectList> {
  let merged: ProjectList;
  // A missing folder that a relocated project used to live in is represented
  // by that project, not listed again on its own. Listing never fails because
  // the record store cannot be read or written; organization is then off.
  const { records, visible, organization } = await recordsFor(async () => {
    merged = await listFolders();
    return merged.projects.map((p) => ({ path: p.path, exists: p.exists }));
  });
  const shown = new Set(visible);
  return { ...merged!, projects: withRecordFields(merged!.projects.filter((p) => shown.has(p.path)), records), organization };
}

// Pure: overlay record metadata on the merged list.
export function withRecordFields(projects: ProjectEntry[], records: ProjectRecord[] | null): ProjectEntry[] {
  const byPath = new Map((records ?? []).map((r) => [r.path, r]));
  return projects.map((p) => {
    const r = byPath.get(p.path);
    if (!r) return { ...p, derivedName: p.name };
    return {
      ...p,
      id: r.id,
      name: r.displayName || p.name,
      derivedName: p.name,
      ...(r.displayName ? { displayName: r.displayName } : {}),
      ...(r.pinned ? { pinned: true } : {}),
      ...(r.archived ? { archived: true } : {}),
      ...(r.previousPaths?.length ? { previousPaths: r.previousPaths } : {}),
    };
  });
}

export type ProjectMutation = { ok: true; list: ProjectList } | { ok: false; error: string; status?: number };

// Checks shared by registering, creating and relocating a project folder. The
// filesystem root and the server's home folder are refused as new project
// roots (they would make every file a project file); existing entries are
// left as they are.
async function checkNewRoot(raw: unknown): Promise<{ path: string } | { error: string }> {
  const [cleaned] = sanitizeProjects([raw]) ?? [];
  if (!cleaned) return { error: 'path must be absolute' };
  if (cleaned === path.parse(cleaned).root || cleaned === path.resolve(homedir())) {
    return { error: 'the filesystem root and the home folder cannot be projects; choose a folder inside them' };
  }
  try { safeDirectory(cleaned); } catch { return { error: 'path is not an accessible project directory' }; }
  if (!(await isDirectory(cleaned))) return { error: 'path is not a readable directory' };
  if (isChatStorage(cleaned)) return { error: 'chat storage folders cannot be projects' };
  return { path: cleaned };
}

const STORE_ERROR = 'project organization is unavailable: the project record file could not be read or saved';

export async function addProject(raw: unknown): Promise<ProjectMutation> {
  const checked = await checkNewRoot(raw);
  if ('error' in checked) return { ok: false, error: checked.error };
  const cleaned = checked.path;
  const current = (await readSettings().catch(() => null))?.projects ?? [];
  if (!current.includes(cleaned)) await patchSettings({ projects: [...current, cleaned] });
  return { ok: true, list: await listProjects() };
}

export async function removeProject(raw: unknown): Promise<ProjectMutation> {
  const [cleaned] = sanitizeProjects([raw]) ?? [];
  if (!cleaned) return { ok: false, error: 'path must be absolute' };
  const current = (await readSettings().catch(() => null))?.projects ?? [];
  const next = current.filter((p) => p !== cleaned);
  // An empty list clears the setting (see patchSettings).
  if (next.length !== current.length) await patchSettings({ projects: next });
  return { ok: true, list: await listProjects() };
}

// Rename, pin or archive a listed project. Never touches its folder.
export async function organizeProject(body: Record<string, unknown>): Promise<ProjectMutation> {
  const id = body.id;
  const patch = parseOrganizePatch(body);
  if (typeof id !== 'string' || !patch) return { ok: false, error: 'invalid project change' };
  const listed = (await listProjects()).projects.some((p) => p.id === id);
  if (!listed) return { ok: false, error: 'project not found', status: 404 };
  const out = await withRecords(async (records) => {
    const index = records.findIndex((r) => r.id === id);
    if (index < 0) return { result: false };
    const next = [...records];
    next[index] = applyOrganize(records[index], patch);
    return { records: next, result: true };
  });
  if (typeof out === 'object') return { ok: false, error: STORE_ERROR, status: 503 };
  if (!out) return { ok: false, error: 'project not found', status: 404 };
  return { ok: true, list: await listProjects() };
}

// Point a project whose folder is missing at the folder's new location. The
// new folder is registered (replacing the old registered path in place), and
// the record keeps its id, name, pin/archive state and the old path. The id is
// looked up in the record store, so a relocation interrupted between its
// writes can be repeated; see relocateStored for the ordering.
export async function relocateProject(body: Record<string, unknown>): Promise<ProjectMutation> {
  const id = body.id;
  if (typeof id !== 'string') return { ok: false, error: 'invalid project change' };
  const checked = await checkNewRoot(body.path);
  if ('error' in checked) return { ok: false, error: checked.error };
  const target = checked.path;
  const out = await relocateStored(id, target, async (from) => !(await isDirectory(from)), async (from) => {
    const current = (await readSettings().catch(() => null))?.projects ?? [];
    const replaced = current.includes(from) ? current.map((p) => (p === from ? target : p)) : [...current, target];
    await patchSettings({ projects: [...new Set(replaced)] });
  });
  if ('storeError' in out) return { ok: false, error: STORE_ERROR, status: 503 };
  if (!out.ok) return { ok: false, error: out.error, status: out.status };
  return { ok: true, list: await listProjects() };
}

// Create one empty project at an explicit path, or inside the scan folder
// for the name-only shortcut. The parent must exist; an existing folder is
// never reused or modified.
export async function createProject(body: Record<string, unknown>): Promise<ProjectMutation> {
  const name = typeof body.path === 'string' && path.isAbsolute(body.path) ? path.basename(body.path.trim()) : typeof body.name === 'string' ? body.name.trim() : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) || name.endsWith('.')) {
    return { ok: false, error: 'use a folder name of letters, digits, dot, dash or underscore (up to 64), starting with a letter or digit' };
  }
  let target: string;
  if (typeof body.path === 'string' && path.isAbsolute(body.path)) {
    target = path.resolve(body.path.trim());
    try {
      const parent = safeDirectory(path.dirname(target));
      target = path.join(parent, path.basename(target));
      assertSafePath(target);
    } catch { return { ok: false, error: 'choose a new folder inside an accessible parent directory' }; }
  } else {
    const { scanFolder } = await listFolders();
    if (!scanFolder || !(await isDirectory(scanFolder))) return { ok: false, error: 'set a projects (scan) folder in Settings or enter an absolute new folder path' };
    target = path.join(scanFolder, name);
    if (path.dirname(target) !== scanFolder) return { ok: false, error: 'invalid folder name' };
  }
  try {
    await mkdir(target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { ok: false, error: code === 'EEXIST' ? 'a file or folder with that name already exists; add it instead' : 'the folder could not be created' };
  }
  return addProject(target);
}

// Every folder a no-workflow caller may treat as a project root: the flat
// list plus the scan folder itself (so a new project can be created in it).
// Deliberately excludes $HOME; write confinement must not widen to the whole
// home directory just because projects may live outside it.
export async function projectRoots(): Promise<string[]> {
  const list = await listFolders();
  const roots = list.projects.filter((p) => p.exists).map((p) => p.path);
  if (list.scanFolder && (await isDirectory(list.scanFolder))) roots.push(list.scanFolder);
  return [...new Set(roots)];
}

// Pure containment: `target` equals a root or sits below one.
export function withinRoots(target: string, roots: Iterable<string>): boolean {
  return [...roots].some((root) => isPathWithin(root, target));
}

// Browser scans use the same policy as direct reads; HOME is not an implicit
// content grant. Re-evaluate roots so unregistering a project revokes access.
export async function realpathWithinProjects(p: string): Promise<string | null> {
  try { return confinedPath(p, await projectRoots(), 'either'); } catch { return null; }
}

// Existing project paths for the global explorer scans.
export async function projectPaths(): Promise<string[]> {
  return (await listFolders()).projects.filter((p) => p.exists).map((p) => p.path);
}
