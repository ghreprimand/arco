import { projectFiles, scanBudget } from './projectScan.js';
// Bounded changed-file discovery over the explorer's existing project grants.
// Each root receives a share of the request budget. Registered descendants are
// scanned separately and pruned from ancestor walks to avoid duplicate work.
import { lstat, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createReadAccessContext, isPathWithin, type ReadAccessContext } from './fileAccessPolicy.js';
import { knownRoots } from './http/writeConfinement.js';
import { readListingSettings } from './settings.js';
import { scanBeforeDeadline } from './scanDeadline.js';
import type { ScanBudget } from './projectScan.js';

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
const REQUEST_MS = 650;
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
// project). The default collection instead derives labels from its top-level
// folders. Registered descendants keep their own project labels.
async function walk(root: string, cutoff: number, out: ChangedEntry[], budget: ScanBudget, access: ReadAccessContext, otherRoots: string[], fixedProject?: string): Promise<boolean> {
  const rootName = basename(root);
  let partial = false;
  const rootIsCheckout = await scanBeforeDeadline(lstat(join(root, '.git')).then(() => true, () => false), budget);
  if (rootIsCheckout === undefined) return true;
  const grant = [{ root, canonical: root }];
  for await (const file of projectFiles(root, { budget, skip: PRUNE_DIRS, maxDepth: MAX_DEPTH,
    respectGitIgnore: true, allowTopLevelCheckouts: !fixedProject && !rootIsCheckout,
    allowDirectory: segments => underArcoAllowed(segments, true) && !otherRoots.includes(join(root, ...segments)),
    allowIgnored: (segments, directory) => segments.includes('.arco') && underArcoAllowed(segments, directory),
  })) {
    if (!underArcoAllowed(file.segments, false)) continue;
    try {
      const checked = await scanBeforeDeadline(access.inspect(file.path, grant, 'file').then(({ real }) => stat(real)), budget);
      if (!checked) return true;
      const st = checked;
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

// Preparation has an early cutoff within the request deadline, reserving time
// to scan healthy roots. Each candidate validates independently; late results
// cannot add a grant or mutate the returned page.
async function resolveRoots(access: ReadAccessContext, budget: ScanBudget, project?: string): Promise<Array<{ path: string; fixed: boolean }>> {
  const settingsBudget = { deadline: budget.deadline - REQUEST_MS * 3 / 4, partial: false };
  const settings = await scanBeforeDeadline(readListingSettings(access, settingsBudget).catch(() => null), budget);
  if (settings === undefined) return [];
  budget.partial ||= settingsBudget.partial;
  const preparation = { deadline: budget.deadline - REQUEST_MS / 2, partial: false };
  const bounded = new Proxy(access, { get(target, key) {
    const value = Reflect.get(target, key);
    if (typeof value !== 'function' || key === 'assertSafePath') return value;
    return (...args: unknown[]) => {
      if (performance.now() >= preparation.deadline) {
        preparation.partial = true;
        return Promise.reject(new Error('Project preparation deadline reached'));
      }
      return scanBeforeDeadline(value.apply(target, args), preparation).then(result => {
        if (result === undefined) throw new Error('Project preparation deadline reached');
        return result;
      });
    };
  } });
  const prepared = new Map<string, { root: string; canonical: string }>();
  const tasks: Promise<void>[] = [];
  let closed = false;
  const collect = (root: string) => {
    if (closed) return;
    tasks.push(bounded.rootDirectory(root).then(canonical => {
      if (!closed && performance.now() < preparation.deadline) prepared.set(resolve(root), { root, canonical });
    }).catch(() => {}));
  };
  try {
    const pending = knownRoots(bounded, settings, collect).then(() => Promise.all(tasks));
    await scanBeforeDeadline(pending, preparation);
  } catch { preparation.partial = true; }
  finally { closed = true; budget.partial ||= preparation.partial; }
  const allowed = [...prepared.values()];
  if (project) {
    try {
      const checked = await scanBeforeDeadline(access.inspect(project, allowed, 'directory'), budget);
      return checked ? [{ path: checked.real, fixed: true }] : [];
    } catch { return []; }
  }
  const base = resolve(settings?.defaultWorkingDirectory || join(homedir(), 'Projects'));
  const canonicalBase = prepared.get(base)?.canonical;
  return [...new Set(allowed.map(r => r.canonical))].map(root => ({ path: root, fixed: root !== canonicalBase }));
}

// Public entry. Returns the newest MAX_ENTRIES files modified within the window,
// newest-first. Bounded so a huge tree can't hang the request.
export async function scanChangedPage(opts: { within?: string; project?: string } = {}): Promise<{ entries: ChangedEntry[]; partial: boolean }> {
  const cutoff = Date.now() - parseWithin(opts.within);
  const request = scanBudget(20_000, REQUEST_MS);
  const access = await scanBeforeDeadline(createReadAccessContext(), request);
  if (!access) return { entries: [], partial: true };
  const roots = await resolveRoots(access, request, opts.project);
  const out: ChangedEntry[] = [];
  let partial = request.partial;
  const share = Math.max(0, request.deadline - performance.now()) / roots.length;
  for (const root of roots) {
    // Preparation has already consumed part of the same request allowance.
    // Fixed shares reserve the remaining time and entries for every project.
    const budget = scanBudget(Math.floor(20_000 / roots.length), share);
    budget.deadline = Math.min(budget.deadline, request.deadline);
    const descendants = roots.filter(other => other.path !== root.path && isPathWithin(root.path, other.path)).map(other => other.path);
    partial = (await walk(root.path, cutoff, out, budget, access, descendants, root.fixed ? basename(root.path) : undefined).catch(() => true)) || partial;
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return { entries: out.slice(0, MAX_ENTRIES), partial };
}
export async function scanChanged(opts: { within?: string; project?: string } = {}): Promise<ChangedEntry[]> {
  return (await scanChangedPage(opts)).entries;
}
