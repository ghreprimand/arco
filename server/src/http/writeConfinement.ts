// Shared cwd-binding + symlink-safe confinement for the operator write routes
// (POST /api/files/write, /api/image/write) and the media routes' cwd tier.
//
// The old per-route resolveCwd let a caller-supplied `cwd` win over the
// workflow's bound cwd, and `resolveWithinCwd` is lexical only. So
// `{ cwd: "/", path: "/etc/…" }` confined against "/" — i.e. nothing — and a
// symlink inside the project pointing out of it was written through. Two fixes:
//
//   1. resolveBoundCwd: with a workflow id, ONLY the server's registered cwd
//      counts (the body's cwd is ignored). Without one, the caller's cwd must be
//      a root the server already knows (a live workflow / cluster cwd, the
//      known-cwds registry, or the explorer's default root) — never an
//      arbitrary directory.
//   2. confineRealPath: after the lexical gate, realpath the target (or its
//      deepest existing ancestor) and require it under realpath(cwd). A dangling
//      symlink at the target is refused — writeFile would follow it anywhere.

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { workflowCwds, workflows } from '../server/state.js';
import * as clusterStore from '../clusterStore.js';
import { readSettings } from '../settings.js';
import { safeDirectory, assertSafePath } from '../fileAccessPolicy.js';
import { resolveWithinCwd } from '../providers/ollamaTools.js';

const WFID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const KNOWN_CWDS_PATH = path.join(os.homedir(), '.archon', 'known-cwds.json');

async function readKnownCwdsRegistry(): Promise<string[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(KNOWN_CWDS_PATH, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
  } catch {
    return [];
  }
}

// Every root a no-workflow caller may legitimately name: live workflow cwds,
// cluster cwds (the cluster FILES tab passes cluster.cwd with no workflow id),
// the crash-recovery registry, and the explorer window's default root
// (settings.defaultWorkingDirectory || ~/Projects — what /api/list-dirs hands
// ExplorerApp as its FileExplorer cwd).
export async function knownRoots(): Promise<Set<string>> {
  const out = new Set<string>();
  for (const cwd of workflowCwds.values()) if (cwd) out.add(path.resolve(cwd));
  for (const wf of workflows.values()) {
    const cwd = wf.config.workingDirectory;
    if (cwd) out.add(path.resolve(cwd));
  }
  for (const id of clusterStore.listKnownClusterIds()) {
    const cwd = clusterStore.getClusterCached(id)?.cwd;
    if (cwd) out.add(path.resolve(cwd));
  }
  for (const cwd of await readKnownCwdsRegistry()) out.add(path.resolve(cwd));
  const settings = await readSettings().catch(() => null);
  out.add(path.resolve(settings?.defaultWorkingDirectory || path.join(os.homedir(), 'Projects')));
  return out;
}

export type BoundCwd =
  | { ok: true; cwd: string }
  | { ok: false; reason: 'none' | 'unknown-workflow' | 'unknown-cwd' };

/**
 * Resolve the cwd a write may target. A workflow id binds to the server's
 * registered cwd and the caller's `cwd` is ignored; otherwise the caller's
 * `cwd` must exactly match a known root. `reason: 'none'` = neither was given.
 */
export async function resolveBoundCwd(
  callerCwd: string | undefined | null,
  workflowId: string | undefined | null,
): Promise<BoundCwd> {
  if (workflowId) {
    if (!WFID_RE.test(workflowId)) return { ok: false, reason: 'unknown-workflow' };
    const bound = workflowCwds.get(workflowId) || workflows.get(workflowId)?.config.workingDirectory || '';
    try { if (bound) { safeDirectory(bound); return { ok: true, cwd: bound }; } } catch { /* protected or missing root */ }
    return { ok: false, reason: 'unknown-workflow' };
  }
  if (!callerCwd) return { ok: false, reason: 'none' };
  try { safeDirectory(callerCwd); } catch { return { ok: false, reason: 'unknown-cwd' }; }
  const roots = await knownRoots();
  const canonical = safeDirectory(callerCwd);
  for (const root of roots) {
    try { if (safeDirectory(root) === canonical) return { ok: true, cwd: callerCwd }; } catch { /* protected or stale root */ }
  }
  return { ok: false, reason: 'unknown-cwd' };
}

export function boundCwdError(reason: 'none' | 'unknown-workflow' | 'unknown-cwd'): string {
  switch (reason) {
    case 'none': return 'cwd or a workflow id with a bound cwd is required';
    case 'unknown-workflow': return 'workflow id has no bound cwd on this server';
    case 'unknown-cwd': return 'cwd is not a known workflow or project directory';
  }
}

function isWithin(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Lexical gate (resolveWithinCwd) + symlink-safe re-check. Returns the lexical
 * absolute path (callers compute cwd-relative paths from it); throws with an
 * operator-readable message on any escape. A TOCTOU swap after this check is
 * out of scope — this stops pre-existing links, which is the realistic vector.
 */
export async function confineRealPath(cwd: string, p: string): Promise<string> {
  const abs = resolveWithinCwd(cwd, p);
  const realRoot = safeDirectory(cwd);
  assertSafePath(abs);
  // Walk up to the deepest existing ancestor; realpath it; re-append the tail.
  let probe = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      await fs.lstat(probe);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const parent = path.dirname(probe);
      if (parent === probe) break;
      tail.unshift(path.basename(probe));
      probe = parent;
      continue;
    }
    let real: string;
    try {
      real = await fs.realpath(probe);
    } catch {
      // Exists per lstat but won't resolve → dangling symlink. A write would
      // follow it to wherever it points; refuse.
      throw new Error(`path "${p}" is a dangling symlink`);
    }
    const resolved = path.join(real, ...tail);
    assertSafePath(resolved);
    if (!isWithin(realRoot, resolved)) {
      throw new Error(`path "${p}" resolves outside the workflow cwd (symlink)`);
    }
    return abs;
  }
  throw new Error(`path "${p}" has no existing ancestor`);
}
