// A read grant for a single Git-confirmed checkout. This does not register the
// checkout with the global project roots or use the managed-task write grant.
import { realpath } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { FileAccessError, isPathWithin, type ReadAccessContext } from '../fileAccessPolicy.js';
import { gitOutput } from './projectBinding.js';

const nativePath = promisify(realpath.native);
const samePath = (a: string, b: string) => path.relative(a, b) === '';

interface RegisteredWorktree {
  directory: string;
  branch: string;
}

interface WorktreeRegistry {
  checkout: string;
  common: string;
  entries: RegisteredWorktree[];
}

interface BrowserWorktree {
  directory: string;
  canonical: string;
  branch: string;
  device: number;
  inode: number;
}

function refuseArcoState(target: string): void {
  if (path.resolve(target).split(path.sep).some(part => part.toLowerCase() === '.arco')) throw new FileAccessError();
}

async function gitDirectory(cwd: string, arg: string, signal?: AbortSignal): Promise<string> {
  const stdout = await gitOutput(cwd, ['rev-parse', '--path-format=absolute', arg], signal);
  return nativePath(stdout.replace(process.platform === 'win32' ? /\r?\n$/ : /\n$/, ''));
}

export async function browserWorktreeRegistry(boundCwd: string, signal?: AbortSignal): Promise<WorktreeRegistry | null> {
  try {
    const output = await gitOutput(boundCwd, ['worktree', 'list', '--porcelain', '-z'], signal);
    const entries = output.split('\0\0').flatMap(record => {
      const [worktree, ...fields] = record.split('\0');
      if (!worktree.startsWith('worktree ') || fields.some(field => /^(bare|prunable)( |$)/.test(field))) return [];
      const directory = path.normalize(worktree.slice('worktree '.length));
      const branch = fields.find(field => field.startsWith('branch refs/heads/'))?.slice('branch refs/heads/'.length);
      const head = fields.find(field => /^HEAD [0-9a-f]{7,64}$/.test(field))?.slice(5, 12);
      return path.isAbsolute(directory) && (branch || head)
        ? [{ directory, branch: branch || ('Detached HEAD ' + head) }] : [];
    });
    if (entries.length < 2) return null;
    const [checkout, common] = await Promise.all([
      gitDirectory(boundCwd, '--show-toplevel', signal),
      gitDirectory(boundCwd, '--git-common-dir', signal),
    ]);
    return { checkout, common, entries: entries.filter(entry => !samePath(entry.directory, checkout)) };
  } catch { return null; }
}

export async function confirmBrowserWorktree(registry: WorktreeRegistry, entry: RegisteredWorktree, access: ReadAccessContext, signal?: AbortSignal): Promise<BrowserWorktree | null> {
  try {
    refuseArcoState(entry.directory);
    const root = await lstat(entry.directory);
    if (!root.isDirectory()) return null;
    const canonical = await access.safeDirectory(entry.directory);
    refuseArcoState(canonical);
    const real = await nativePath(canonical);
    const home = await nativePath(homedir()).catch(() => homedir());
    if (samePath(real, registry.checkout) || samePath(real, path.parse(real).root) || isPathWithin(real, home)) return null;
    const [top, common] = await Promise.all([
      gitDirectory(real, '--show-toplevel', signal),
      gitDirectory(real, '--git-common-dir', signal),
    ]);
    if (!samePath(real, top) || !samePath(common, registry.common)) return null;
    return { ...entry, canonical, device: root.dev, inode: root.ino };
  } catch { return null; }
}

export async function browserWorktreeFile(target: string, tree: BrowserWorktree, access: ReadAccessContext): Promise<string> {
  refuseArcoState(target);
  const { real } = await access.inspect(target, [{ root: tree.directory, canonical: tree.canonical }], 'file');
  refuseArcoState(real);
  const root = await lstat(tree.directory);
  if (!root.isDirectory() || root.dev !== tree.device || root.ino !== tree.inode) throw new FileAccessError();
  return real;
}

export async function resolveWorktreeFile(target: string, boundCwd: string, access: ReadAccessContext): Promise<string> {
  const registry = await browserWorktreeRegistry(boundCwd);
  if (!registry) throw new FileAccessError();
  let alias: string | undefined;
  let entry = registry.entries.filter(candidate => isPathWithin(candidate.directory, target))
    .sort((a, b) => b.directory.length - a.directory.length)[0];
  if (!entry) {
    // Parent aliases occur on macOS and Windows. Match the root's expanded
    // spelling but keep the request's spelling for read confinement below.
    for (let dir = path.dirname(target); dir !== path.dirname(dir); dir = path.dirname(dir)) {
      const stat = await lstat(dir).catch(() => null);
      if (!stat?.isDirectory()) continue;
      const real = await nativePath(dir);
      const registered = registry.entries.find(candidate => samePath(candidate.directory, real));
      if (registered) { entry = registered; alias = dir; break; }
    }
  }
  const verified = entry && await confirmBrowserWorktree(registry, entry, access);
  if (!verified) throw new FileAccessError();
  return browserWorktreeFile(target, alias ? { ...verified, directory: alias } : verified, access);
}
