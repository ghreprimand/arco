// ARCHIVE (docs/ARCHIVE_PLAN.md §4.2) — the RECENTLY MODIFIED scan. The
// exhaustive, UNATTRIBUTED catch-all: an on-demand walk that surfaces files the
// agent-writes ledger never saw (Bash redirects, generated images, ffmpeg /
// demucs output — anything created outside a tracked tool event). Together with
// the ledger it covers the hole either has alone (§9).
//
// Portable Node fs walk (§5 — no `fd`, which isn't guaranteed on macOS), pruning
// the usual build/VCS dirs plus `.archon` internals EXCEPT
// `.archon/workflows/*/artifacts/`. Depth-capped (8) and count-capped (500,
// newest-first) so a pathological tree can't hang the request. $HOME-jailed via
// realpathWithinHome.

import { readdir, stat } from 'fs/promises';
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

// `.archon` carve-out: only `.archon/workflows/<wfid>/artifacts/**` survives.
// `segs` is the path relative to the project root. Dirs may be a proper prefix
// of that pattern (to descend); files must be strictly inside an artifacts dir.
export function underArchonAllowed(segs: string[], isDir: boolean): boolean {
  const i = segs.indexOf('.archon');
  if (i === -1) return true;
  const tail = segs.slice(i);
  if (tail.length >= 2 && tail[1] !== 'workflows') return false;
  if (tail.length >= 4 && tail[3] !== 'artifacts') return false;
  if (!isDir && tail.length < 5) return false; // a file directly under .archon/… is pruned
  return true;
}

// `fixedProject` is set for a single-project scan (every file belongs to that
// project). For a global scan over ~/Projects it stays undefined and each file's
// project is derived from its top-level dir under the base root.
async function walk(root: string, cutoff: number, out: ChangedEntry[], fixedProject?: string): Promise<void> {
  const rootName = basename(root);
  const stack: Array<{ dir: string; segs: string[]; depth: number }> = [{ dir: root, segs: [], depth: 0 }];
  while (stack.length > 0 && out.length < MAX_ENTRIES) {
    const { dir, segs, depth } = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable dir — skip
    }
    for (const e of entries) {
      const childSegs = [...segs, e.name];
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth + 1 > MAX_DEPTH) continue;
        if (PRUNE_DIRS.has(e.name)) continue;
        if (!underArchonAllowed(childSegs, true)) continue;
        stack.push({ dir: abs, segs: childSegs, depth: depth + 1 });
      } else if (e.isFile()) {
        if (!underArchonAllowed(childSegs, false)) continue;
        let st;
        try { st = await stat(abs); } catch { continue; }
        if (st.mtimeMs < cutoff) continue;
        const project = fixedProject ?? (childSegs.length >= 2 ? childSegs[0] : rootName);
        out.push({ path: abs, name: e.name, size: st.size, mtime: st.mtimeMs, project });
      }
    }
  }
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
export async function scanChanged(opts: { within?: string; project?: string } = {}): Promise<ChangedEntry[]> {
  const cutoff = Date.now() - parseWithin(opts.within);
  const roots = await resolveRoots(opts.project);
  const out: ChangedEntry[] = [];
  for (const root of roots) {
    if (out.length >= MAX_ENTRIES) break;
    // Explicit project → attribute every file to it; global base → derive per file.
    await walk(root, cutoff, out, opts.project ? basename(root) : undefined).catch(() => { /* best-effort */ });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, MAX_ENTRIES);
}
