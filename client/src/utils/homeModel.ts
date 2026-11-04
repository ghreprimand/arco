// Pure grouping/search rules for the project Home view. No fetching, no store:
// the component passes in the server project list, the open tabs and the
// clusters, so these rules are testable on their own.
//
// Privacy rule: Incognito tabs are never listed, counted or matched here.

import type { ClusterStatePayload, SessionInfo } from '@arco/shared';
import type { JobState } from '../stores/appStore.types';

export interface HomeProject {
  path: string;
  name: string;
  source: 'registered' | 'scanned' | 'recent';
  exists: boolean;
  // Organization (server projectRecords.ts); absent while unavailable.
  id?: string;
  derivedName?: string;
  displayName?: string;
  pinned?: boolean;
  archived?: boolean;
  previousPaths?: string[];
  rootPath?: string;
}

export interface HomeGroup {
  key: string;
  path?: string;
  exists?: boolean;
  discovered?: HomeProject[];
  savedCount?: number;
  pinnedCount?: number;
  folderCount?: number;
  unavailableCount?: number;
  title: string;
  description: string;
  projects: HomeProject[];
}

export interface OpenWorkItem {
  kind: 'workflow' | 'chat' | 'cluster';
  id: string;
  name: string;
  cwd: string;
  lastActivity: number;
}

const GROUPS: Array<Omit<HomeGroup, 'projects'>> = [
  { key: 'pinned', title: 'Pinned', description: 'Projects you pinned, from any source.' },
  { key: 'registered', title: 'Your projects', description: 'Folders you added to the project list.' },
  { key: 'recent', title: 'Recently used', description: 'Folders a session ran in before.' },
  { key: 'scanned', title: 'Found in the projects folder', description: 'Folders inside the scan folder set in Settings.' },
  { key: 'archived', title: 'Archived', description: 'Kept out of the lists above. Their folders and saved sessions are unchanged.' },
];
const ID = /^[a-f0-9-]{36}$/;

const windowsPath = (p: string) => /^[a-z]:[\\/]/i.test(p) || /^\\\\[^\\]/.test(p);
const absolutePath = (p: string) => p.startsWith('/') || windowsPath(p);
const norm = (p: string) => {
  const value = p.trim().replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  return windowsPath(p) ? value.toLowerCase() : value;
};

export function pathWithin(child: string, root: string): boolean {
  const c = norm(child), r = norm(root);
  return c === r || c.startsWith(r === '/' ? '/' : `${r}/`);
}

// The server list is untrusted input: keep well-formed entries only.
export function parseProjects(body: unknown): HomeProject[] | null {
  const list = (body as { projects?: unknown } | null)?.projects;
  if (!Array.isArray(list)) return null;
  const out: HomeProject[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const p = raw as Record<string, unknown>;
    if (typeof p.path !== 'string' || !absolutePath(p.path) || seen.has(p.path)) continue;
    const source = p.source === 'registered' || p.source === 'scanned' || p.source === 'recent' ? p.source : null;
    if (!source) continue;
    seen.add(p.path);
    const project: HomeProject = { path: p.path, name: typeof p.name === 'string' && p.name.trim() ? p.name.trim() : p.path.replace(/\\/g, '/').split('/').pop() || p.path, source, exists: p.exists === true };
    if (typeof p.rootPath === 'string' && absolutePath(p.rootPath)) project.rootPath = p.rootPath;
    if (typeof p.id === 'string' && ID.test(p.id)) project.id = p.id;
    if (typeof p.derivedName === 'string' && p.derivedName.trim()) project.derivedName = p.derivedName.trim();
    if (typeof p.displayName === 'string' && p.displayName.trim()) project.displayName = p.displayName.trim();
    if (p.pinned === true) project.pinned = true;
    if (p.archived === true) project.archived = true;
    if (Array.isArray(p.previousPaths)) {
      const prev = p.previousPaths.filter((x): x is string => typeof x === 'string' && absolutePath(x)).slice(0, 10);
      if (prev.length) project.previousPaths = prev;
    }
    out.push(project);
  }
  return out;
}

// Whether the server can store organization (pin, rename, archive, relocate).
export function organizationAvailable(body: unknown): boolean {
  return (body as { organization?: unknown } | null)?.organization === true;
}

export function scanFolderOf(body: unknown): string | null {
  const folder = (body as { scanFolder?: unknown } | null)?.scanFolder;
  return typeof folder === 'string' && absolutePath(folder) ? folder : null;
}

export interface HomeRoot { name: string; path: string; exists: boolean; }
export function rootsOf(body: unknown): HomeRoot[] | undefined {
  const roots = (body as { roots?: unknown } | null)?.roots;
  if (!Array.isArray(roots)) return undefined;
  return roots.filter((root): root is HomeRoot => !!root && typeof root.name === 'string' && typeof root.path === 'string' && absolutePath(root.path))
    .map(root => ({ ...root, exists: root.exists === true }));
}

// Card titles: a name shared by several listed projects gets its parent
// folder appended, so two "app" checkouts can be told apart.
export function projectLabels(projects: HomeProject[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const p of projects) counts.set(p.name, (counts.get(p.name) ?? 0) + 1);
  return new Map(projects.map((p) => {
    if ((counts.get(p.name) ?? 0) < 2) return [p.path, p.name];
    const parts = norm(p.path).split('/').filter(Boolean);
    return [p.path, `${p.name}  /  ${parts.length > 1 ? parts[parts.length - 2] : '/'}`];
  }));
}

export function searchProjects(projects: HomeProject[], query: string): HomeProject[] {
  const q = query.trim().toLowerCase();
  if (!q) return projects;
  return projects.filter((p) => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q)
    || !!p.derivedName?.toLowerCase().includes(q));
}

// Pinned first, then by source; archived projects only when asked for.
export function groupProjects(projects: HomeProject[], showArchived = false, roots?: HomeRoot[]): HomeGroup[] {
  if (roots) {
    const live = projects.filter(p => !p.archived);
    const pinned = live.filter(p => p.pinned);
    const groups: HomeGroup[] = pinned.length ? [{ key: 'pinned', title: 'Pinned', description: 'Shortcuts from every root.', projects: pinned }] : [];
    for (const root of roots) {
      const inside = live.filter(p => p.rootPath === root.path);
      groups.push({ key: `root-${roots.indexOf(root)}`, title: root.name, path: root.path, exists: root.exists,
        description: 'Choose a folder to start a session.', folderCount: inside.filter(p => p.exists).length, unavailableCount: inside.filter(p => !p.exists).length, savedCount: inside.filter(p => p.source !== 'scanned').length, pinnedCount: inside.filter(p => p.pinned).length, projects: inside.filter(p => p.source !== 'scanned' && !p.pinned), discovered: inside.filter(p => p.source === 'scanned') });
    }
    const other = live.filter(p => !p.rootPath && !p.pinned);
    if (other.length) groups.push({ key: 'registered', title: 'Other projects', description: 'Individual folders outside configured roots.', projects: other });
    const archived = projects.filter(p => p.archived);
    if (showArchived && archived.length) groups.push({ key: 'archived', title: 'Archived', description: 'Folders and saved sessions are unchanged.', projects: archived });
    return groups;
  }
  const groupOf = (p: HomeProject): HomeGroup['key'] => (p.archived ? 'archived' : p.pinned ? 'pinned' : p.source);
  return GROUPS
    .filter((g) => g.key !== 'archived' || showArchived)
    .map((g) => ({ ...g, projects: projects.filter((p) => groupOf(p) === g.key) }))
    .filter((g) => g.projects.length > 0);
}

function lastActivity(job: JobState): number {
  const last = job.messages[job.messages.length - 1];
  return typeof last?.timestamp === 'number' ? last.timestamp : 0;
}

// Every open tab the operator can return to: standalone workflows and chats
// (not Incognito, not unpromoted task children, not cluster members, which
// open through their cluster) plus clusters. Newest activity first.
export function openWork(jobs: Record<string, JobState>, clusters: Record<string, ClusterStatePayload>): OpenWorkItem[] {
  const memberIds = new Set(Object.values(clusters).flatMap((c) => c.members.map((m) => m.workflowId)));
  const items: OpenWorkItem[] = [];
  for (const job of Object.values(jobs)) {
    if (job.config.voiceOperator || job.config.incognito || memberIds.has(job.id)) continue;
    if (job.parentWorkflowId && !job.promoted) continue;
    items.push({
      kind: job.config.kind === 'chat' ? 'chat' : 'workflow',
      id: job.id,
      name: job.config.name || 'Untitled session',
      cwd: job.config.workingDirectory ?? '',
      lastActivity: lastActivity(job),
    });
  }
  for (const cluster of Object.values(clusters)) {
    const memberJobs = cluster.members.map((m) => jobs[m.workflowId]).filter(Boolean) as JobState[];
    items.push({
      kind: 'cluster',
      id: cluster.clusterId,
      name: cluster.name || `Cluster  /  ${cluster.cwd.replace(/\\/g, '/').split('/').pop() || cluster.cwd}`,
      cwd: cluster.cwd,
      lastActivity: Math.max(0, ...memberJobs.map(lastActivity)),
    });
  }
  return items.sort((a, b) => b.lastActivity - a.lastActivity);
}

// Assign open work to the most specific listed project containing its folder.
// Work recorded under a previous location of a relocated project counts too.
export function workForProject(project: HomeProject, all: HomeProject[], work: OpenWorkItem[]): OpenWorkItem[] {
  return work.filter((item) => {
    if (!item.cwd) return false;
    if (project.previousPaths?.some((old) => pathWithin(item.cwd, old))) return true;
    if (!pathWithin(item.cwd, project.path)) return false;
    const deeper = all.some((other) => other.path !== project.path && pathWithin(other.path, project.path)
      && pathWithin(item.cwd, other.path) && norm(other.path).length > norm(project.path).length);
    return !deeper;
  });
}

// One project's saved-session reply. A refused or malformed reply is an error
// the operator can retry, never an empty list: "No saved sessions" must only
// mean the server answered and listed none.
export function parseSavedSessions(status: number, body: unknown): { sessions: SessionInfo[] } | { error: string } {
  if (status < 200 || status > 299) return { error: `Saved sessions could not be loaded (the server answered ${status}).` };
  const list = body && typeof body === 'object' ? (body as { sessions?: unknown }).sessions : undefined;
  if (!Array.isArray(list)) return { error: 'Saved sessions could not be loaded (unexpected reply from the server).' };
  return { sessions: list.filter((s): s is SessionInfo => !!s && typeof s === 'object' && typeof (s as { sessionId?: unknown }).sessionId === 'string') };
}

export interface SavedSessionRow {
  sessionId: string;
  title: string;
  provider: string;
  account?: string;
  startedAt: number;
  openWorkflowId?: string;
  workspaceName?: string;
}

// Saved sessions for one project (the creator's RESUME source). A session
// already open in a tab is marked so Home offers Open instead of Resume.
export function savedSessionRows(sessions: SessionInfo[], jobs: Record<string, JobState>): SavedSessionRow[] {
  return sessions
    .filter((s) => s && typeof s.sessionId === 'string')
    .map((s) => {
      const open = s.arcoWorkflowId && jobs[s.arcoWorkflowId] && !jobs[s.arcoWorkflowId].config.incognito ? s.arcoWorkflowId : undefined;
      return {
        sessionId: s.sessionId,
        // Same title rule as the creator's RESUME list: content title first.
        title: s.name || s.arcoName || s.sessionId.slice(0, 8),
        provider: s.provider,
        ...(s.providerAccountShortLabel || s.providerAccountLabel ? { account: s.providerAccountShortLabel || s.providerAccountLabel } : {}),
        startedAt: typeof s.startedAt === 'number' ? s.startedAt : 0,
        ...(open ? { openWorkflowId: open } : {}),
        ...((open ? jobs[open].config.name : s.arcoName) ? { workspaceName: open ? jobs[open].config.name : s.arcoName } : {}),
      };
    })
    .sort((a, b) => b.startedAt - a.startedAt);
}
