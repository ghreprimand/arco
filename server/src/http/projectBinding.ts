import { execFile } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { confinedPath, isPathWithin, FileAccessError, safeDirectory } from '../fileAccessPolicy.js';
import { worktreesRoot } from '../project/taskWorktree.js';
import { resolveBoundCwd } from './writeConfinement.js';

const execFileAsync = promisify(execFile);
const samePath = (a: string, b: string) => path.relative(a, b) === '';

class SelectedWorktreeError extends Error {
  readonly code = 'EACCES';
  constructor() { super('The selected worktree is unavailable or is not registered with this tab\'s project. Select a worktree again.'); }
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 });
  return stdout;
}

export async function requireProjectBinding(cwd?: string | null, workflowId?: string | null): Promise<string> {
  const bound = await resolveBoundCwd(cwd, workflowId);
  if (!bound.ok) throw new FileAccessError();
  const root = safeDirectory(bound.cwd);
  if (!workflowId || !cwd) return root;
  try {
    const selectedDirectory = (candidate: string): string => {
      try { return safeDirectory(candidate); } catch {
        // Managed task trees live inside runtime state. Only an exact task
        // directory beneath this project's managed root may proceed to the
        // Git registration and common-directory checks below.
        for (const owner of [bound.cwd, root]) {
          const managed = worktreesRoot(owner);
          try {
            const realManaged = realpathSync(managed);
            for (const base of [managed, realManaged]) {
              const relative = path.relative(base, candidate);
              if (!relative || relative === '..' || path.isAbsolute(relative) || relative.includes(path.sep)) continue;
              const real = realpathSync(candidate);
              if (samePath(real, path.join(realManaged, relative)) && statSync(real).isDirectory()) return real;
            }
          } catch { /* missing or replaced task tree */ }
        }
        throw new SelectedWorktreeError();
      }
    };
    const selected = selectedDirectory(cwd);
    const requested = path.resolve(cwd);
    const requestedEntry = path.join(realpathSync(path.dirname(requested)), path.basename(requested));
    // Parent aliases (including temporary-folder aliases) are fine, but a
    // selected worktree replaced by a link must not redirect to a sibling.
    if (!samePath(requestedEntry, selected) && !samePath(requested, path.resolve(bound.cwd))) throw new SelectedWorktreeError();
    if (samePath(root, selected)) return root;
    // Only the bound repository's registry can authorize another worktree.
    // NUL-delimited porcelain preserves spaces and newlines in pathnames.
    const registry = await gitOutput(root, ['worktree', 'list', '--porcelain', '-z']);
    const registered = registry.split('\0').some(field => {
      if (!field.startsWith('worktree ')) return false;
      try { return samePath(selectedDirectory(field.slice(9)), selected); } catch { return false; }
    });
    if (!registered) throw new SelectedWorktreeError();
    // A stale registered path may have been replaced by an unrelated repository.
    const commonDirectory = async (directory: string) => realpathSync(path.resolve(directory,
      (await gitOutput(directory, ['rev-parse', '--git-common-dir'])).trimEnd()));
    if (!samePath(await commonDirectory(root), await commonDirectory(selected))) throw new SelectedWorktreeError();
    return selected;
  } catch {
    throw new SelectedWorktreeError();
  }
}

/** Search may narrow a project or admitted worktree to an ordinary folder. */
export async function requireProjectFolder(cwd?: string | null, workflowId?: string | null): Promise<string> {
  const bound = await resolveBoundCwd(cwd, workflowId);
  if (!bound.ok) throw new FileAccessError();
  const root = safeDirectory(bound.cwd);
  if (!cwd) return root;
  const belongs = (owner: string) => isPathWithin(owner, cwd) || isPathWithin(realpathSync(owner), cwd);
  try {
    // Resolve links inside the same root. A link out must not gain admission
    // merely because its destination is another registered worktree.
    if (belongs(bound.cwd)) return confinedPath(cwd, [bound.cwd], 'directory');
    const registry = await gitOutput(root, ['worktree', 'list', '--porcelain', '-z']);
    const candidates = registry.split('\0').filter(field => field.startsWith('worktree ')).map(field => field.slice(9));
    // Walk from the outermost requested ancestor. This preserves parent
    // aliases but chooses the owning tree before any link inside that tree.
    const ancestors: string[] = [];
    for (let current = path.resolve(cwd); ; current = path.dirname(current)) {
      ancestors.unshift(current);
      if (current === path.dirname(current)) break;
    }
    for (const ancestor of ancestors) {
      const real = realpathSync(ancestor);
      const candidate = candidates.find(candidate => {
        try { return samePath(realpathSync(candidate), real); } catch { return false; }
      });
      if (!candidate) continue;
      await requireProjectBinding(candidate, workflowId);
      return confinedPath(cwd, [ancestor], 'directory');
    }
  } catch { /* invalid folder or non-Git project */ }
  throw new FileAccessError();
}
