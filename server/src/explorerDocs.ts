// ARCHIVE (docs/ARCHIVE_PLAN.md §4.1) — project-DOCUMENT scan. The ARTIFACTS
// lens is a project-artifact tool, and the documents an operator most wants to
// find live in the PROJECT TREE (e.g. `Codex/Reports/2026-07-10_*.md`, top-level
// `*.md`, `docs/*.md`) — NOT under `.archon/workflows/*/artifacts/` (those are
// the workflow artifacts the explorerArtifacts.ts join already surfaces). This
// scan is the other half: readable documents in the real tree, so drilling into
// a project shows the docs written FOR it, not just agent workflow spill.
//
// Portable pruned walk (no `fd`), $HOME-jailed, depth/count-capped. `.archon` is
// pruned wholesale here (the artifacts join owns it — merging both client-side
// gives the full picture without double-counting).

import { readdir, stat } from 'fs/promises';
import { basename, join, relative } from 'path';
import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { realpathWithinHome } from './explorerArtifacts.js';

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
  '.next', 'target', '.cache', 'coverage', '.turbo', '.archon',
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
export async function collectProjectDocs(project: string, limit = 1000): Promise<DocEntry[]> {
  const root = await realpathWithinHome(project);
  if (!root) return [];
  const projectName = basename(root);
  const out: DocEntry[] = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth + 1 > MAX_DEPTH) continue;
        if (PRUNE_DIRS.has(e.name)) continue;
        stack.push({ dir: abs, depth: depth + 1 });
      } else if (e.isFile() && isDoc(e.name)) {
        let st;
        try { st = await stat(abs); } catch { continue; }
        out.push({ path: abs, name: e.name, size: st.size, mtime: st.mtimeMs, project: projectName, cwd: root, rel: relative(root, abs) });
      }
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, limit);
}

const KNOWN_CWDS = join(homedir(), '.archon', 'known-cwds.json');

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
export async function collectDocs(opts: { project?: string } = {}): Promise<DocEntry[]> {
  if (opts.project) return collectProjectDocs(opts.project, 1000);
  const cwds = await readKnownCwds();
  const perProject = 150;
  const overall = 600;
  const all: DocEntry[] = [];
  for (const cwd of cwds) {
    const docs = await collectProjectDocs(cwd, perProject).catch(() => []);
    all.push(...docs);
  }
  all.sort((a, b) => b.mtime - a.mtime);
  return all.slice(0, overall);
}
