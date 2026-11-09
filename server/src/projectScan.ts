// Bounded project discovery. State-store readers use their own exhaustive paths.
import { opendir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
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
  allowTopLevelCheckouts?: boolean;
}): AsyncGenerator<{ path: string; name: string; segments: string[] }> {
  const queue = [{ dir: root, segments: [] as string[] }];
  for (let index = 0; index < queue.length && !exhausted(options.budget); index++) {
    const { dir, segments } = queue[index];
    await setImmediate();
    if (segments.length && !(options.allowTopLevelCheckouts && segments.length === 1)) {
      if (await lstat(join(dir, '.git')).then(() => true, () => false)) continue;
    }
    let directory;
    try { directory = await opendir(dir); } catch { continue; }
    try {
      for await (const entry of directory) {
        if (exhausted(options.budget)) return;
        options.budget.entries--;
        const path = join(dir, entry.name), child = [...segments, entry.name];
        if (entry.isDirectory()) {
          if (options.skip.has(entry.name) || (options.hidden && entry.name.startsWith('.'))) continue;
          if (child.length > (options.maxDepth ?? 8)) { options.budget.partial = true; continue; }
          queue.push({ dir: path, segments: child });
        } else if (entry.isFile()) yield { path, name: entry.name, segments: child };
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
