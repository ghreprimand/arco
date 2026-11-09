import { scanBeforeDeadline } from './scanDeadline.js';
import { projectFiles, scanBudget, exhausted, type ScanBudget } from './projectScan.js';
import { confinedPath } from './fileAccessPolicy.js';
// ARCHIVE (docs/CLIENT.md) - project-DOCUMENT scan. The ARTIFACTS
// lens is a project-artifact tool, and the documents an operator most wants to
// find live in the PROJECT TREE (e.g. `Codex/Reports/2026-07-10_*.md`, top-level
// `*.md`, `docs/*.md`) — NOT under `.arco/workflows/*/artifacts/` (those are
// the workflow artifacts the explorerArtifacts.ts join already surfaces). This
// scan is the other half: readable documents in the real tree, so drilling into
// a project shows the docs written FOR it, not just agent workflow spill.
//
// Portable pruned walk (no `fd`), $HOME-jailed, depth/count-capped. `.arco` is
// pruned wholesale here (the artifacts join owns it — merging both client-side
// gives the full picture without double-counting).

import { readdir, stat } from 'fs/promises';
import { basename, join, relative } from 'path';
import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { realpathWithinHome } from './explorerArtifacts.js';
import { arcoHome } from './arcoHome.js';

export interface DocEntry {
  path: string;
  name: string;
  size: number;
  mtime: number;
  project: string;
  cwd: string;   // the owning project root (drill scoping + reveal-in-tree)
  rel: string;   // path relative to the project root (shows the subdir)
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

// Walk one project tree for document files, newest-first, capped.
export async function collectProjectDocsPage(project: string, limit = 1000, global?: ScanBudget): Promise<{ entries: DocEntry[]; partial: boolean }> {
  const budget = scanBudget();
  if (global) budget.deadline = Math.min(budget.deadline, global.deadline);
  const root = await scanBeforeDeadline(realpathWithinHome(project), budget);
  if (!root) return { entries: [], partial: budget.partial };
  if (global) budget.entries = Math.min(budget.entries, global.entries);
  const starting = budget.entries;
  const out: DocEntry[] = [];
  for await (const file of projectFiles(root, { budget, skip: PRUNE_DIRS, hidden: true, maxDepth: MAX_DEPTH })) {
    if (!isDoc(file.name)) continue;
    try {
      confinedPath(file.path, [root], 'file');
      const st = await scanBeforeDeadline(stat(file.path), budget);
      if (!st) break;
      out.push({ path: file.path, name: file.name, size: st.size, mtime: st.mtimeMs, project: basename(root), cwd: root, rel: relative(root, file.path) });
    } catch { /* unreadable or outside the project */ }
  }
  if (global) global.entries -= starting - budget.entries;
  out.sort((a, b) => b.mtime - a.mtime);
  return { entries: out.slice(0, limit), partial: budget.partial || out.length > limit };
}
export async function collectProjectDocs(project: string, limit = 1000): Promise<DocEntry[]> {
  return (await collectProjectDocsPage(project, limit)).entries;
}

const KNOWN_CWDS = join(arcoHome(), 'known-cwds.json');

async function readKnownCwds(): Promise<string[]> {
  try {
    const raw = await readFile(KNOWN_CWDS, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string' && x.length > 0);
  } catch {
    return [];
  }
}

// Global doc scan across known projects, bounded per-project so a home load over
// dozens of projects stays responsive. `project` scopes to one (full limit).
export async function collectDocsPage(opts: { project?: string } = {}): Promise<{ entries: DocEntry[]; partial: boolean }> {
  if (opts.project) return collectProjectDocsPage(opts.project);
  const global = scanBudget(50_000, 650);
  const known = await scanBeforeDeadline(readKnownCwds(), global);
  if (!known) return { entries: [], partial: true };
  const cwds = [...new Set(known)];
  const all: DocEntry[] = [];
  let partial = false;
  for (const cwd of cwds) {
    if (exhausted(global)) { partial = true; break; }
    const page = await collectProjectDocsPage(cwd, 150, global).catch(() => ({ entries: [], partial: true }));
    all.push(...page.entries);
    partial ||= page.partial;
  }
  all.sort((a, b) => b.mtime - a.mtime);
  return { entries: all.slice(0, 600), partial: partial || all.length > 600 };
}
export async function collectDocs(opts: { project?: string } = {}): Promise<DocEntry[]> {
  return (await collectDocsPage(opts)).entries;
}
