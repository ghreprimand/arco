import { scanBeforeDeadline } from './scanDeadline.js';
import { projectFiles, scanBudget, exhausted, type ScanBudget } from './projectScan.js';
import { confinedPath, createReadAccessContext } from './fileAccessPolicy.js';
import { resolveBoundCwd } from './http/writeConfinement.js';
import { browserWorktreeFile, browserWorktreeRegistry, confirmBrowserWorktree } from './http/browserWorktrees.js';
// ARCHIVE (docs/CLIENT.md) - project-DOCUMENT scan. The ARTIFACTS
// lens is a project-artifact tool, and the documents an operator most wants to
// find live in the PROJECT TREE (e.g. `Codex/Reports/2026-07-10_*.md`, top-level
// `*.md`, `docs/*.md`) — NOT under `.arco/workflows/*/artifacts/` (those are
// the workflow artifacts the explorerArtifacts.ts join already surfaces). This
// scan is the other half: readable documents in the real tree, so drilling into
// a project shows the docs written FOR it, not just agent workflow spill.
//
// Portable pruned walk (no `fd`), depth/count-capped. The global scan stays
// inside HOME; a scoped project can include Git-confirmed siblings. `.arco` is
// pruned wholesale here (the artifacts join owns it — merging both client-side
// gives the full picture without double-counting).

import { stat } from 'node:fs/promises';
import { basename, relative } from 'node:path';
import { readKnownCwds, realpathWithinHome } from './explorerArtifacts.js';

export interface DocEntry {
  path: string;
  name: string;
  size: number;
  mtime: number;
  project: string;
  cwd: string;   // the owning project root (drill scoping + reveal-in-tree)
  rel: string;   // path relative to its checkout (shows the subdir)
  branch?: string;
}

interface DocsPage {
  entries: DocEntry[];
  partial: boolean;
  projects?: Array<{ cwd: string; project: string }>;
}

const PRUNE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.venv', '__pycache__',
  '.next', 'target', '.cache', 'coverage', '.turbo', '.arco',
]);
// Readable document types. Deliberately NOT images/binaries — those browse via
// the TREE lens; this is the "find and read a doc" surface.
const DOC_EXT = new Set(['md', 'markdown', 'mdx', 'txt', 'rst', 'adoc', 'org', 'pdf', 'csv']);
const MAX_DEPTH = 8;

function isDoc(name: string): boolean {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  return DOC_EXT.has(ext);
}

async function scanDocuments(root: string, owner: string, budget: ScanBudget, out: DocEntry[],
  authorize: (file: string) => string | Promise<string>, branch?: string): Promise<void> {
  for await (const file of projectFiles(root, { budget, skip: PRUNE_DIRS, hidden: true, maxDepth: MAX_DEPTH })) {
    if (!isDoc(file.name)) continue;
    try {
      const authorized = await scanBeforeDeadline(Promise.resolve(authorize(file.path)), budget);
      if (!authorized) break;
      const st = await scanBeforeDeadline(stat(authorized), budget);
      if (!st) break;
      out.push({ path: file.path, name: file.name, size: st.size, mtime: st.mtimeMs, project: basename(owner), cwd: owner,
        rel: relative(root, file.path), ...(branch ? { branch } : {}) });
    } catch { /* unreadable or outside the project */ }
  }
}

function finishPage(out: DocEntry[], limit: number, budget: ScanBudget): DocsPage {
  out.sort((a, b) => b.mtime - a.mtime);
  return { entries: out.slice(0, limit), partial: budget.partial || out.length > limit };
}

// Walk one project tree for document files, newest-first, capped.
export async function collectProjectDocsPage(project: string, limit = 1000, global?: ScanBudget): Promise<DocsPage> {
  const budget = scanBudget();
  if (global) budget.deadline = Math.min(budget.deadline, global.deadline);
  const root = await scanBeforeDeadline(realpathWithinHome(project), budget);
  if (!root) return { entries: [], partial: budget.partial };
  if (global) budget.entries = Math.min(budget.entries, global.entries);
  const starting = budget.entries;
  const out: DocEntry[] = [];
  await scanDocuments(root, root, budget, out, file => confinedPath(file, [root], 'file'));
  if (global) global.entries -= starting - budget.entries;
  return finishPage(out, limit, budget);
}

export async function collectProjectDocs(project: string, limit = 1000): Promise<DocEntry[]> {
  return (await collectProjectDocsPage(project, limit)).entries;
}

async function collectScopedDocs(project: string): Promise<DocsPage> {
  const budget = scanBudget();
  const out: DocEntry[] = [];
  const root = await scanBeforeDeadline(realpathWithinHome(project), budget);
  if (root) await scanDocuments(root, root, budget, out, file => confinedPath(file, [root], 'file'));
  if (exhausted(budget)) return finishPage(out, 1000, budget);

  const bound = await scanBeforeDeadline(resolveBoundCwd(project, undefined), budget);
  if (!bound?.ok) return finishPage(out, 1000, budget);
  const access = await scanBeforeDeadline(createReadAccessContext(), budget);
  if (!access) return finishPage(out, 1000, budget);
  const owner = root ?? await scanBeforeDeadline(access.safeDirectory(bound.cwd), budget);
  if (!owner) return finishPage(out, 1000, budget);
  const signal = AbortSignal.timeout(Math.max(1, Math.ceil(budget.deadline - performance.now())));
  const registry = await scanBeforeDeadline(browserWorktreeRegistry(owner, signal), budget);
  if (!registry) {
    if (signal.aborted) budget.partial = true;
    return finishPage(out, 1000, budget);
  }
  for (const entry of registry.entries) {
    if (exhausted(budget)) break;
    const tree = await scanBeforeDeadline(confirmBrowserWorktree(registry, entry, access, signal), budget);
    if (!tree) continue;
    await scanDocuments(tree.canonical, owner, budget, out, file => browserWorktreeFile(file, tree, access), tree.branch);
  }
  if (signal.aborted) budget.partial = true;
  return finishPage(out, 1000, budget);
}

// Global doc scan across known projects, bounded per-project so a home load over
// dozens of projects stays responsive. `project` scopes to one (full limit).
export async function collectDocsPage(opts: { project?: string } = {}): Promise<DocsPage> {
  if (opts.project) return collectScopedDocs(opts.project);
  const global = scanBudget(50_000, 650);
  const known = await scanBeforeDeadline(readKnownCwds(), global);
  if (!known) return { entries: [], partial: true };
  const cwds = [...new Set(known)];
  const all: DocEntry[] = [];
  const projects = new Map<string, { cwd: string; project: string }>();
  const access = await scanBeforeDeadline(createReadAccessContext(), global);
  if (!access) return { entries: [], partial: true };
  let partial = false;
  for (const cwd of cwds) {
    if (exhausted(global)) { partial = true; break; }
    const root = await scanBeforeDeadline(access.safeDirectory(cwd).catch(() => null), global);
    if (!root) continue;
    projects.set(root, { cwd: root, project: basename(root) });
    const page = await collectProjectDocsPage(root, 150, global).catch(() => ({ entries: [], partial: true }));
    all.push(...page.entries);
    partial ||= page.partial;
  }
  all.sort((a, b) => b.mtime - a.mtime);
  return { entries: all.slice(0, 600), partial: partial || global.partial || all.length > 600, projects: [...projects.values()] };
}
export async function collectDocs(opts: { project?: string } = {}): Promise<DocEntry[]> {
  return (await collectDocsPage(opts)).entries;
}
