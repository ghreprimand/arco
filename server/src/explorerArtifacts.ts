// ARCHIVE (docs/ARCHIVE_PLAN.md §4.1) — the ARTIFACTS join. Answers "what have
// agents produced for me to review?" by aggregating workflow artifacts across
// projects into a flat, attributed list — NEVER raw-browsing the opaque
// `.arco/workflows/<uuid>/` tree (the overwhelming majority of those dirs are
// empty; UUID folders are meaningless to a human).
//
// For each known cwd, glob `<cwd>/.arco/workflows/*/artifacts/**` with two
// prunes that kill the noise: skip empty dirs (a recursive file walk naturally
// yields nothing for them) and skip `raw-tools/` (gzipped filtered/evicted
// tool-output spills — recovery data, not review material; see PERSISTENCE.md).
// Each hit is joined with the workflow's meta.json → tab title + provider, with
// the 8-char UUID prefix as the fallback when meta is missing/unreadable.
//
// Fencing (§5): every path is realpath-resolved and confirmed ⊆ $HOME before it
// is returned. `realpathWithinHome` is exported for the Phase 4 changed scan.

import { readFile, readdir, realpath, stat } from 'fs/promises';
import { basename, join, resolve, sep } from 'path';
import { homedir } from 'os';
import { arcoHome } from './arcoHome.js';

export interface ArtifactEntry {
  path: string;        // absolute, realpath-resolved, ⊆ $HOME
  name: string;        // basename
  size: number;        // bytes
  mtime: number;       // epoch ms
  workflowId: string;
  tabTitle: string;    // meta.name, else the 8-char wfid prefix
  provider: string;    // meta.primaryProvider, else 'unknown'
  project: string;     // basename of the owning cwd
  cwd: string;         // the owning project cwd (reveal-in-tree + attribution)
}

const KNOWN_CWDS = join(arcoHome(), 'known-cwds.json');
// Defensive caps — artifact trees are shallow + small in practice, but a
// pathological or symlink-looped tree must not hang the request.
const MAX_DEPTH = 8;
const MAX_ENTRIES = 2000;

// Post-resolution $HOME jail. Resolves symlinks (realpath) so a symlinked path
// can't escape the home dir after the join, then confirms containment. Returns
// the resolved absolute path, or null when the target is missing or escapes.
export async function realpathWithinHome(p: string): Promise<string | null> {
  // Compare realpath with realpath: a home reached through a symlink would
  // otherwise put every project outside it.
  const home = await realpath(homedir()).catch(() => resolve(homedir()));
  try {
    const rp = await realpath(p);
    if (rp === home || rp.startsWith(home + sep)) return rp;
    return null;
  } catch {
    return null;
  }
}

export async function readKnownCwds(): Promise<string[]> {
  try {
    const raw = await readFile(KNOWN_CWDS, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string' && x.length > 0);
  } catch {
    return [];
  }
}

// meta.json join, cached per (cwd, wfid) so a workflow with N artifacts reads
// its meta once. Falls back to the UUID prefix + 'unknown' provider.
async function readWorkflowMeta(cwd: string, wfid: string): Promise<{ tabTitle: string; provider: string }> {
  const fallback = { tabTitle: wfid.slice(0, 8), provider: 'unknown' };
  try {
    const raw = await readFile(join(cwd, '.arco', 'workflows', wfid, 'meta.json'), 'utf8');
    const meta = JSON.parse(raw) as { name?: string; primaryProvider?: string };
    return {
      tabTitle: meta.name && meta.name.trim().length > 0 ? meta.name.trim() : fallback.tabTitle,
      provider: meta.primaryProvider || fallback.provider,
    };
  } catch {
    return fallback;
  }
}

// Recursively collect files under an artifacts dir, skipping `raw-tools/` at any
// depth and stopping at MAX_DEPTH. Pushes into `out` (bounded by MAX_ENTRIES).
async function walkArtifactFiles(dir: string, depth: number, out: string[]): Promise<void> {
  if (depth > MAX_DEPTH || out.length >= MAX_ENTRIES) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // missing / unreadable artifacts dir — treated as empty
  }
  for (const e of entries) {
    if (out.length >= MAX_ENTRIES) return;
    if (e.isDirectory()) {
      if (e.name === 'raw-tools') continue; // recovery spill, not review material
      await walkArtifactFiles(join(dir, e.name), depth + 1, out);
    } else if (e.isFile()) {
      out.push(join(dir, e.name));
    }
  }
}

// Collect artifacts for one project cwd. Reads its workflows dir, walks each
// workflow's artifacts/, joins meta.json.
async function collectForCwd(cwd: string): Promise<ArtifactEntry[]> {
  const project = basename(cwd);
  const workflowsDir = join(cwd, '.arco', 'workflows');
  let wfdirs;
  try {
    wfdirs = await readdir(workflowsDir, { withFileTypes: true });
  } catch {
    return []; // no workflows on disk for this cwd
  }
  const results: ArtifactEntry[] = [];
  for (const wf of wfdirs) {
    if (!wf.isDirectory()) continue;
    const wfid = wf.name;
    const files: string[] = [];
    await walkArtifactFiles(join(workflowsDir, wfid, 'artifacts'), 0, files);
    if (files.length === 0) continue; // empty artifact dir → skipped (the ~90%)
    const meta = await readWorkflowMeta(cwd, wfid);
    for (const f of files) {
      const rp = await realpathWithinHome(f);
      if (!rp) continue; // escaped $HOME or vanished — drop
      let st;
      try { st = await stat(rp); } catch { continue; }
      results.push({
        path: rp,
        name: basename(rp),
        size: st.size,
        mtime: st.mtimeMs,
        workflowId: wfid,
        tabTitle: meta.tabTitle,
        provider: meta.provider,
        project,
        cwd,
      });
    }
  }
  return results;
}

// Public entry. `project` (an absolute cwd) scopes to one project; omitted →
// global via known-cwds.json (dead paths skipped silently). Newest-first.
export async function collectArtifacts(opts: { project?: string } = {}): Promise<ArtifactEntry[]> {
  let cwds: string[];
  if (opts.project) {
    // Explicit project must itself be a real dir ⊆ $HOME.
    const rp = await realpathWithinHome(opts.project);
    cwds = rp ? [rp] : [];
  } else {
    const known = await readKnownCwds();
    const resolved = await Promise.all(known.map((c) => realpathWithinHome(c)));
    cwds = resolved.filter((c): c is string => c !== null);
  }
  const all: ArtifactEntry[] = [];
  for (const cwd of cwds) {
    const entries = await collectForCwd(cwd).catch(() => []);
    all.push(...entries);
  }
  all.sort((a, b) => b.mtime - a.mtime);
  return all;
}
