// ARCHIVE — client-side mirrors of the server explorer read-models. Kept local
// to the explorer shell (the standalone window boots no app stores / shared
// protocol imports beyond what it needs).

export interface ArtifactEntry {
  path: string;
  name: string;
  size: number;
  mtime: number;
  workflowId: string;
  tabTitle: string;
  provider: string;
  project: string;
  cwd: string;
}

// AGENT WRITES ledger record (mirror of the server LedgerRecord).
export interface RecentRecord {
  ts: number;
  path: string;
  op: 'created' | 'modified';
  workflowId: string;
  tabTitle: string;
  provider: string;
  tool: string;
  project?: string;
}

// Project-tree DOCUMENT entry (mirror of the server DocEntry). The docs written
// FOR a project, alongside the .arco workflow artifacts.
export interface DocEntry {
  path: string;
  name: string;
  size: number;
  mtime: number;
  project: string;
  cwd: string;
  rel: string;
}

// One unified item the ARTIFACTS lens renders — a project document OR a workflow
// artifact, merged newest-first.
export interface ProjectItem {
  path: string;
  name: string;
  mtime: number;
  project: string;
  cwd: string;
  kind: 'doc' | 'artifact';
  rel?: string;        // doc: path relative to project root (shows the subdir)
  tabTitle?: string;   // artifact: the tab that produced it
  provider?: string;   // artifact
}

// RECENTLY MODIFIED scan entry (mirror of the server ChangedEntry).
export interface ChangedEntry {
  path: string;
  name: string;
  size: number;
  mtime: number;
  project: string;
}

// A project rolled up from its items — the landing home groups by this.
export interface ProjectSummary {
  cwd: string;
  project: string;
  count: number;
  docCount: number;
  artifactCount: number;
  lastMtime: number;
}

// Coarse file kind for the RECENTS filter chips (DOCS / IMAGES / ALL).
export type FileKind = 'doc' | 'image' | 'other';
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']);
const DOC_EXT = new Set(['md', 'markdown', 'mdx']);
export function fileKind(name: string): FileKind {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  if (DOC_EXT.has(ext)) return 'doc';
  if (IMAGE_EXT.has(ext)) return 'image';
  return 'other';
}

export function rollupProjects(items: ProjectItem[]): ProjectSummary[] {
  const byCwd = new Map<string, ProjectSummary>();
  for (const it of items) {
    const cur = byCwd.get(it.cwd);
    if (cur) {
      cur.count += 1;
      if (it.kind === 'doc') cur.docCount += 1; else cur.artifactCount += 1;
      cur.lastMtime = Math.max(cur.lastMtime, it.mtime);
    } else {
      byCwd.set(it.cwd, {
        cwd: it.cwd,
        project: it.project,
        count: 1,
        docCount: it.kind === 'doc' ? 1 : 0,
        artifactCount: it.kind === 'artifact' ? 1 : 0,
        lastMtime: it.mtime,
      });
    }
  }
  return [...byCwd.values()].sort((a, b) => b.lastMtime - a.lastMtime);
}

// Merge the two server read-models into one newest-first item list. Docs prune
// `.arco`, artifacts live only under it, so paths never collide — but dedup
// defensively anyway.
export function mergeItems(artifacts: ArtifactEntry[], docs: DocEntry[]): ProjectItem[] {
  const seen = new Set<string>();
  const out: ProjectItem[] = [];
  const push = (it: ProjectItem) => { if (!seen.has(it.path)) { seen.add(it.path); out.push(it); } };
  for (const d of docs) push({ path: d.path, name: d.name, mtime: d.mtime, project: d.project, cwd: d.cwd, kind: 'doc', rel: d.rel });
  for (const a of artifacts) push({ path: a.path, name: a.name, mtime: a.mtime, project: a.project, cwd: a.cwd, kind: 'artifact', tabTitle: a.tabTitle, provider: a.provider });
  out.sort((x, y) => y.mtime - x.mtime);
  return out;
}
