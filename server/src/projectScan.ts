import { scanBeforeDeadline } from './scanDeadline.js';
// Bounded project discovery. State-store readers use their own exhaustive paths.
import { opendir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { ignoredProjectPaths } from './projectIgnore.js';
import { setImmediate } from 'node:timers/promises';

export interface ScanBudget { entries: number; deadline: number; partial: boolean }
export function scanBudget(entries = 20_000, milliseconds = 250): ScanBudget {
  return { entries, deadline: performance.now() + milliseconds, partial: false };
}
export function exhausted(budget: ScanBudget): boolean {
  const done = budget.entries <= 0 || performance.now() >= budget.deadline;
  if (done) budget.partial = true;
  return done;
}
export async function* projectFiles(root: string, options: {
  budget: ScanBudget; skip: ReadonlySet<string>; hidden?: boolean; maxDepth?: number;
  allowDirectory?: (segments: string[]) => boolean;
  allowIgnored?: (segments: string[], directory: boolean) => boolean;
  allowTopLevelCheckouts?: boolean; respectGitIgnore?: boolean; includeDirectories?: boolean; includeLinks?: boolean;
}): AsyncGenerator<{ path: string; name: string; segments: string[]; directory: boolean }> {
  // An explicitly selected ignored root is a deliberate request to search it.
  const rootIgnored = options.respectGitIgnore ? await scanBeforeDeadline(ignoredProjectPaths(root, [root], options.budget.deadline - performance.now()), options.budget) : new Set<string>();
  if (!rootIgnored) return;
  const applyIgnore = options.respectGitIgnore && !rootIgnored.has(root);
  const queue = [{ dir: root, segments: [] as string[] }];
  for (let index = 0; index < queue.length && !exhausted(options.budget); index++) {
    const { dir, segments } = queue[index];
    await setImmediate();
    if (exhausted(options.budget)) return;
    if (segments.length && !(options.allowTopLevelCheckouts && segments.length === 1)) {
      const nested = await scanBeforeDeadline(lstat(join(dir, '.git')).then(() => true, () => false), options.budget);
      if (nested === undefined) return;
      if (nested) continue;
    }
    if (segments.length && options.includeDirectories) yield { path: dir, name: segments[segments.length - 1], segments, directory: true };
    let directory;
    try { directory = await scanBeforeDeadline(opendir(dir), options.budget, handle => handle.close()); } catch { continue; }
    if (!directory) return;
    try {
      const candidates = [];
      let lateRead = false;
      try {
        while (!exhausted(options.budget)) {
          const pendingRead = directory.read();
          const entry = await scanBeforeDeadline(pendingRead, options.budget, () => directory.close());
          if (entry === undefined) {
            lateRead = true;
            void pendingRead.catch(() => directory.close()).catch(() => {});
            return;
          }
          if (entry === null) break;
          options.budget.entries--;
          candidates.push(entry);
        }
      } finally {
        if (!lateRead) await scanBeforeDeadline(directory.close().catch(() => {}), options.budget);
      }
      const ignored = applyIgnore
        ? await scanBeforeDeadline(ignoredProjectPaths(root, candidates.filter(entry => entry.isDirectory()).map(entry => join(dir, entry.name)), options.budget.deadline - performance.now()), options.budget) : new Set<string>();
      if (!ignored) return;
      for (const entry of candidates) {
        if (performance.now() >= options.budget.deadline) { options.budget.partial = true; return; }
        const path = join(dir, entry.name), child = [...segments, entry.name];
        if (ignored.has(path) && !options.allowIgnored?.(child, entry.isDirectory())) continue;
        if (entry.isDirectory()) {
          if (options.allowDirectory && !options.allowDirectory(child)) continue;
          if (options.skip.has(entry.name) || (options.hidden && entry.name.startsWith('.'))) continue;
          if (child.length > (options.maxDepth ?? 8)) { options.budget.partial = true; continue; }
          queue.push({ dir: path, segments: child });
        } else if (entry.isFile() || (options.includeLinks && entry.isSymbolicLink())) yield { path, name: entry.name, segments: child, directory: false };
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
