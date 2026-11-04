// Admission for managed work and checkpoint restores in this server process.
// Shared writers can coexist; a restore excludes every overlapping writer.
// This is not a lock for external processes or unrelated filesystem endpoints.
import { realpathSync } from 'node:fs';
import path from 'node:path';
import type { WorkflowState } from './workflows/types.js';

export function workflowWritePaths(wf: WorkflowState): string[] {
  const cwd = wf.config?.workingDirectory;
  const extra = wf.primary?.additionalDirectories ?? wf.config?.advanced?.additionalDirectories ?? [];
  return cwd ? checkoutWritePaths(cwd, extra) : [];
}

export function checkoutWritePaths(cwd: string, additional: string[] = []): string[] {
  return [cwd, ...additional.map(p => path.isAbsolute(p) ? p : `${cwd}${path.sep}${p}`)];
}

type Lease = { paths: string[]; observedPaths?: string[]; owner?: object; snapshot?: boolean; workerId?: string };
type Observation = { paths: string[]; owner: object; overlap: boolean; workerIds: Set<string>; primaryWorkerId?: string };
const writers = new Set<Lease>();
const observations = new Set<Observation>();
const restores = new Map<symbol, Lease>();

export class CheckoutInUseError extends Error {
  constructor() {
    super('Checkout is in use by managed work or a checkpoint restore. Wait for it to finish or cancel it first.');
  }
}

// Resolve existing ancestors too: a new auxiliary working directory may not
// exist yet. Never fall back to lexical paths for inaccessible ancestors.
function canonicalPath(value: string): string {
  // Collapsing '..' before realpath can change its meaning across a symlink.
  let current = path.isAbsolute(value) ? value : `${process.cwd()}${path.sep}${value}`;
  const suffix: string[] = [];
  for (;;) {
    try {
      const result = path.join(realpathSync.native(current), ...suffix);
      return process.platform === 'win32' ? result.toLowerCase() : result;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

function overlaps(a: string, b: string): boolean {
  const contains = (parent: string, child: string) => {
    const relative = path.relative(parent, child);
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
  };
  return contains(a, b) || contains(b, a);
}

function conflicts(paths: string[], lease: Lease): boolean {
  return paths.some(a => lease.paths.some(b => overlaps(a, b)));
}

export function assertCheckoutAvailable(paths: string[]): void {
  if (!restores.size) return;
  const resolved = paths.map(canonicalPath);
  if ([...restores.values()].some(lease => conflicts(resolved, lease))) throw new CheckoutInUseError();
}

export function acquireCheckoutWriter(paths: string[], restoreOwner?: symbol, writerOwner?: object, snapshot = false, workerId?: string, observedPaths?: string[]): () => void {
  const resolved = paths.map(canonicalPath);
  const owner = restoreOwner === undefined ? undefined : restores.get(restoreOwner);
  // Only the admitted restore's safety capture can write under its lease.
  if (restoreOwner !== undefined && (!owner || resolved.some(p => !owner.paths.includes(p)))) throw new CheckoutInUseError();
  if ([...restores].some(([token, lease]) => token !== restoreOwner && conflicts(resolved, lease))) throw new CheckoutInUseError();
  let observed: string[] | undefined;
  if (observedPaths) {
    try { observed = observedPaths.map(canonicalPath); } catch { observed = resolved; }
  }
  const lease: Lease = { paths: resolved, observedPaths: observed, owner: writerOwner, snapshot, workerId };
  writers.add(lease);
  if (!snapshot) for (const observation of observations) {
    if (!conflicts(observation.paths, { paths: lease.observedPaths ?? lease.paths })) continue;
    if (writerOwner !== observation.owner) observation.overlap = true;
    else if (workerId) observation.workerIds.add(workerId);
  }
  return () => { writers.delete(lease); };
}

// Observe without blocking shared writers. A snapshot lease writes only the
// checkpoint store and does not count as another agent editing the folder.
export function observeCheckoutWriters(paths: string[], owner: object): { hasOverlap: () => boolean; setPrimaryWorker: (id: string) => void; stop: () => void } {
  try {
    const resolved = paths.map(canonicalPath);
    const observation: Observation = { paths: resolved, owner, overlap: false, workerIds: new Set() };
    for (const lease of writers) {
      if (lease.snapshot || !conflicts(resolved, { paths: lease.observedPaths ?? lease.paths })) continue;
      if (lease.owner !== owner) observation.overlap = true;
      else if (lease.workerId) observation.workerIds.add(lease.workerId);
    }
    observations.add(observation);
    return { hasOverlap: () => observation.overlap || [...observation.workerIds].some(id => id !== observation.primaryWorkerId), setPrimaryWorker: id => { observation.primaryWorkerId = id; }, stop: () => { observations.delete(observation); } };
  } catch {
    // An unknown scope cannot safely offer a single-turn undo.
    return { hasOverlap: () => true, setPrimaryWorker: () => {}, stop: () => {} };
  }
}

export function acquireCheckoutRestore(paths: string[], activeWorkPaths: string[][]): { owner: symbol; release: () => void } {
  const resolved = [...new Set(paths.map(canonicalPath))];
  // No await between checking active work and installing the reservation.
  // Unknown active scope fails closed rather than guessing it is isolated.
  if (activeWorkPaths.some(paths => !paths.length || conflicts(resolved, { paths: paths.map(canonicalPath) }))
    || [...writers].some(lease => conflicts(resolved, lease))
    || [...restores.values()].some(lease => conflicts(resolved, lease))) throw new CheckoutInUseError();
  const owner = Symbol('checkpoint restore');
  restores.set(owner, { paths: resolved });
  return { owner, release: () => { restores.delete(owner); } };
}
