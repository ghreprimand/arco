import { projectFiles, scanBudget } from './projectScan.js';
import { confinedPath } from './fileAccessPolicy.js';
// ARCHIVE (docs/CLIENT.md) - the RECENTLY MODIFIED scan. The
// bounded, UNATTRIBUTED catch-all: an on-demand walk that surfaces files the
// agent-writes ledger never saw (Bash redirects, generated images, ffmpeg /
// demucs output — anything created outside a tracked tool event). Together with
// the ledger it covers the hole either has alone (§9).
//
// Portable Node fs walk (§5 — no `fd`, which isn't guaranteed on macOS), pruning
// the usual build/VCS dirs plus `.arco` internals EXCEPT
// `.arco/workflows/*/artifacts/`. Depth-capped (8) and count-capped (500,
// newest-first) so a pathological tree can't hang the request. $HOME-jailed via
// realpathWithinHome.

import { readdir, stat, lstat } from 'fs/promises';
import { basename, join } from 'path';
import { homedir } from 'os';
import { realpathWithinHome } from './explorerArtifacts.js';
import { readSettings } from './settings.js';

export interface ChangedEntry {
  path: string;
  name: string;
  size: number;
  mtime: number;
  project: string;
}

const PRUNE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.venv', '__pycache__',
  '.next', 'target', '.cache', 'coverage', '.turbo',
]);
const MAX_DEPTH = 8;
const MAX_ENTRIES = 500;
const DEFAULT_WINDOW_MS = 48 * 60 * 60 * 1000;

// Parse a "48h" / "7d" / "30m" window into ms. Falls back to 48h on garbage.
export function parseWithin(within: string | null | undefined): number {
  if (!within) return DEFAULT_WINDOW_MS;
  const m = /^(\d+)\s*([hdm])$/i.exec(within.trim());
  if (!m) return DEFAULT_WINDOW_MS;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const mult = unit === 'd' ? 86_400_000 : unit === 'h' ? 3_600_000 : 60_000;
  return Math.max(60_000, n * mult);
}

// `.arco` carve-out: only `.arco/workflows/<wfid>/artifacts/**` survives.
// `segs` is the path relative to the project root. Dirs may be a proper prefix
// of that pattern (to descend); files must be strictly inside an artifacts dir.
export function underArcoAllowed(segs: string[], isDir: boolean): boolean {
  const i = segs.indexOf('.arco');
  if (i === -1) return true;
  const tail = segs.slice(i);
  if (tail.length >= 2 && tail[1] !== 'workflows') return false;
  if (tail.length >= 4 && tail[3] !== 'artifacts') return false;
  if (!isDir && tail.length < 5) return false; // a file directly under .arco/… is pruned
  return true;
}

// `fixedProject` is set for a single-project scan (every file belongs to that
// project). For a global scan over ~/Projects it stays undefined and each file's
// project is derived from its top-level dir under the base root.
async function walk(root: string, cutoff: number, out: ChangedEntry[], fixedProject?: string): Promise<boolean> {
  const rootName = basename(root);
  const budget = scanBudget(20_000, 650);
  let partial = false;
  const rootIsCheckout = await lstat(join(root, '.git')).then(() => true, () => false);
  for await (const file of projectFiles(root, { budget, skip: PRUNE_DIRS, maxDepth: MAX_DEPTH,
    respectGitIgnore: true, allowTopLevelCheckouts: !fixedProject && !rootIsCheckout,
    allowDirectory: segments => underArcoAllowed(segments, true),
    allowIgnored: (segments, directory) => segments.includes('.arco') && underArcoAllowed(segments, directory),
  })) {
    if (!underArcoAllowed(file.segments, false)) continue;
    try {
      confinedPath(file.path, [root], 'file');
      const st = await stat(file.path);
      if (st.mtimeMs < cutoff) continue;
      const project = fixedProject ?? (file.segments.length >= 2 ? file.segments[0] : rootName);
      const entry = { path: file.path, name: file.name, size: st.size, mtime: st.mtimeMs, project };
      const at = out.findIndex(v => v.mtime < entry.mtime || (v.mtime === entry.mtime && v.path > entry.path));
      out.splice(at < 0 ? out.length : at, 0, entry);
      if (out.length > MAX_ENTRIES) { out.pop(); partial = true; }
    } catch { /* vanished, unreadable or confined */ }
  }
  return partial || budget.partial;
}

// Resolve the scan root(s): one explicit project, or the operator's default
// working directory (settings.defaultWorkingDirectory, else ~/Projects).
async function resolveRoots(project?: string): Promise<string[]> {
  if (project) {
    const rp = await realpathWithinHome(project);
    return rp ? [rp] : [];
  }
  let base: string;
  try {
    const settings = await readSettings();
    base = settings?.defaultWorkingDirectory || join(homedir(), 'Projects');
  } catch {
    base = join(homedir(), 'Projects');
  }
  const rp = await realpathWithinHome(base);
  return rp ? [rp] : [];
}

// Public entry. Returns the newest MAX_ENTRIES files modified within the window,
// newest-first. Bounded so a huge tree can't hang the request.
export async function scanChangedPage(opts: { within?: string; project?: string } = {}): Promise<{ entries: ChangedEntry[]; partial: boolean }> {
  const cutoff = Date.now() - parseWithin(opts.within);
  const roots = await resolveRoots(opts.project);
  const out: ChangedEntry[] = [];
  let partial = false;
  for (const root of roots) {
    // Explicit project → attribute every file to it; global base → derive per file.
    partial = (await walk(root, cutoff, out, opts.project ? basename(root) : undefined).catch(() => true)) || partial;
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return { entries: out.slice(0, MAX_ENTRIES), partial };
}
export async function scanChanged(opts: { within?: string; project?: string } = {}): Promise<ChangedEntry[]> {
  return (await scanChangedPage(opts)).entries;
}
