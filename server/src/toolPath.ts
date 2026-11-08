import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { isPathWithin } from './fileAccessPolicy.js';

// File tools are confined to their workflow folder. Resolve the deepest
// existing ancestor for new writes, and never turn a dangling link into a
// missing ordinary file. The browser private-file policy is separate from
// the agent's sensitive-write approval and shell permissions.
export function resolveToolPath(cwd: string, input: string): string {
  if (!cwd || typeof input !== 'string' || !input || input.includes('\0')) throw new Error('A working directory and file path are required');
  const root = path.resolve(cwd);
  const target = path.resolve(root, input);
  const canonicalRoot = realpathSync(root);
  if (!isPathWithin(root, target) && !isPathWithin(canonicalRoot, target)) throw new Error('path escapes workflow cwd');
  let probe = target;
  const tail: string[] = [];
  for (;;) {
    try { lstatSync(probe); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(probe);
      if (parent === probe) throw error;
      tail.unshift(path.basename(probe));
      probe = parent;
      continue;
    }
    const canonical = path.join(realpathSync(probe), ...tail);
    if (!isPathWithin(canonicalRoot, canonical)) throw new Error('path resolves outside workflow cwd');
    return canonical;
  }
}
