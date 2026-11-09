// Shared browser-file boundary. A known project is authority for its ordinary
// files, never for provider credentials, server state, or operating-system
// pseudo-files. Check both the spelling and realpath: aliases cannot turn a
// protected directory into a project, and in-project links cannot escape it.
import { realpathSync, statSync, realpath } from 'node:fs';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import path from 'node:path';
import { arcoHome as runtimeHome } from './arcoHome.js';
import { UPSTREAM_STATE_DIRECTORY } from './envAliases.js';

export class FileAccessError extends Error {
  readonly code = 'EACCES';
  constructor() { super('file access is outside the permitted roots or targets protected state'); }
}

export function isPathWithin(root: string, target: string, pathApi = path): boolean {
  const rel = pathApi.relative(pathApi.resolve(root), pathApi.resolve(target));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(rel));
}

/** Local application temporary storage is content, not application settings. */
export function isProtectedRoot(root: string, target: string, temporaryRoot: string | undefined = undefined, pathApi = path): boolean {
  return isPathWithin(root, target, pathApi)
    && !(temporaryRoot && pathApi.sep === '\\' && isPathWithin(temporaryRoot, target, pathApi));
}

const PRIVATE_COMPONENTS = new Set([
  '.codex', '.claude', '.gemini', '.cursor', '.ssh', '.gnupg', '.aws', '.azure',
  '.kube', '.docker', '.config', '.git', '.npm', '.cache', '.pki', 'appdata', UPSTREAM_STATE_DIRECTORY,
]);
const SYSTEM_ROOTS = ['/proc', '/sys', '/dev', '/etc', '/run', '/var/run', '/var/lib', '/var/log', '/boot', '/private/etc', '/private/var/run', '/System'];

function protectedRoots(): { root: string; temporaryRoot?: string }[] {
  const roots: { root: string; temporaryRoot?: string }[] = [...SYSTEM_ROOTS, path.join(homedir(), '.local', 'share'), path.join(homedir(), '.local', 'state'), path.join(homedir(), 'Library')].map((root) => ({ root }));
  const appData = path.join(homedir(), process.platform === 'win32' ? 'AppData' : 'appdata');
  roots.push({ root: appData, temporaryRoot: path.join(appData, 'Local', 'Temp') });
  for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GEMINI_CLI_HOME', 'CURSOR_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'APPDATA', 'LOCALAPPDATA', 'WINDIR', 'SystemRoot', 'PROGRAMDATA']) {
    const value = process.env[key];
    if (value && path.isAbsolute(value)) roots.push({ root: value, temporaryRoot: key === 'LOCALAPPDATA' ? path.join(value, 'Temp') : undefined });
  }
  // Include aliases of default provider homes, not only their spelling.
  for (const name of PRIVATE_COMPONENTS) {
    if (name !== 'appdata') roots.push({ root: path.join(homedir(), name) });
  }
  return roots;
}

export function assertSpellingSafe(target: string, pathApi = path): void {
  if (target.includes('\0') || /^\\\\[?.]\\/.test(target)) throw new FileAccessError();
  if (pathApi.sep === '\\') {
    const resolved = pathApi.resolve(target);
    const root = pathApi.parse(resolved).root;
    const components = resolved.slice(root.length).split(/[\\/]/).filter(Boolean);
    // A drive colon belongs only to the parsed root. Other colons select
    // alternate data streams; trailing dots/spaces can alias another name.
    if (components.some(part => /[. ]$/.test(part) || part.includes(':'))) throw new FileAccessError();
    const unc = root.startsWith('\\\\') ? root.split('\\').filter(Boolean) : [];
    if (unc.some(part => /[. ]$/.test(part) || part.includes(':'))) throw new FileAccessError();
  }
  const parts = pathApi.resolve(target).split(pathApi.sep).map((p) => p.toLowerCase());
  if (parts.some((p, i) => PRIVATE_COMPONENTS.has(p)
    && !(p === 'appdata' && pathApi.sep === '\\' && parts[i + 1] === 'local' && parts[i + 2] === 'temp'))) throw new FileAccessError();
  const base = parts.at(-1) || '';
  if ((/^\.env(?:\.|$)/.test(base) && !/^\.env\.(example|sample|template)$/.test(base))
    || /^(auth\.json|\.claude\.json|\.gitconfig|\.(?:bash|zsh|python)_history|\.authinfo|credentials(?:\.[^/]*)?|\.credentials\.json|\.netrc|\.npmrc|\.pypirc|\.git-credentials|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?)$/.test(base)
    || /\.(pem|key|p12|pfx)$/.test(base)) throw new FileAccessError();
  // Keep project artifacts, handoffs and plans usable without making runtime
  // transcripts, settings, account homes, cluster vaults or logs browseable.
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] !== '.arco') continue;
    if (!runtimePathAllowed(parts.slice(i + 1))) throw new FileAccessError();
  }
}

function runtimePathAllowed(parts: string[]): boolean {
  return parts[0] === 'plans' || parts[0] === 'media-scratch'
    || (parts[0] === 'workflows' && /^[a-z0-9_-]+$/.test(parts[1] || '') && ['artifacts', 'handoffs'].includes(parts[2]))
    || (['chats', 'genesis'].includes(parts[0]) && /^[a-z0-9_-]+$/.test(parts[1] || ''));
}

export function assertSafePath(target: string): void {
  assertSpellingSafe(target);
  // The runtime home may itself be a symlink/volume alias. Its canonical
  // provider-accounts/settings/vault paths stay private even without an
  // `.arco` component in their real names. Scratch cannot alias those paths.
  const runtimeRoots = [path.join(homedir(), '.arco'), runtimeHome()];
  for (const runtime of [...runtimeRoots]) {
    try { runtimeRoots.push(realpathSync(runtime)); } catch { /* not created */ }
  }
  for (const root of runtimeRoots) {
    if (isPathWithin(root, target) && !runtimePathAllowed(path.relative(root, target).split(path.sep).map((p) => p.toLowerCase()))) throw new FileAccessError();
  }
  for (const { root, temporaryRoot } of protectedRoots()) {
    // Default AppData and LOCALAPPDATA exempt only local temporary storage.
    // Explicit provider, runtime and system roots still deny every child.
    if (isProtectedRoot(root, target, temporaryRoot)) throw new FileAccessError();
    try {
      const canonicalRoot = realpathSync(root);
      const canonicalTemp = temporaryRoot ? path.join(canonicalRoot, path.relative(root, temporaryRoot)) : undefined;
      if (isProtectedRoot(canonicalRoot, target, canonicalTemp)) throw new FileAccessError();
    } catch (err) {
      if (err instanceof FileAccessError) throw err;
    }
  }
}

/** Existing ordinary directory, allowed as a project/media grant or picker target. */
export function safeDirectory(dir: string): string {
  if (!path.isAbsolute(dir)) throw new FileAccessError();
  assertSafePath(dir);
  const real = realpathSync(dir);
  assertSafePath(real);
  // A Windows data drive or UNC share can itself be a project mount. The
  // system drive and POSIX filesystem root are never content grants.
  const broadRoot = real === path.parse(real).root
    && (process.platform !== 'win32' || real.toLowerCase() === path.parse(homedir()).root.toLowerCase());
  if (broadRoot || !statSync(real).isDirectory()) throw new FileAccessError();
  return real;
}

/** Resolve an existing regular file/directory inside one explicit root. */
export function confinedPath(target: string, roots: readonly string[], kind: 'file' | 'directory' | 'either' = 'file'): string {
  assertSafePath(target);
  const real = realpathSync(target);
  assertSafePath(real);
  const allowed = roots.some((root) => {
    try {
      const canonical = safeDirectory(root);
      // Require both lexical and canonical membership in the SAME root. A
      // link to a second registered project is still an escape from the first.
      return (isPathWithin(root, target) || isPathWithin(canonical, target)) && isPathWithin(canonical, real);
    } catch { return false; }
  });
  if (!allowed) throw new FileAccessError();
  const st = statSync(real);
  if (!(kind !== 'directory' && st.isFile()) && !(kind !== 'file' && st.isDirectory())) throw new FileAccessError();
  return real;
}

// Use the callback resolver's async walk, not fs.promises.realpath's native
// resolver: the synchronous policy retains Windows short-name spellings.
const realpathAsync = promisify(realpath);
export interface ReadAccessContext {
  assertSafePath(target: string): void;
  realpath(target: string): Promise<string>;
  rootRealpath(target: string): Promise<string>;
  safeDirectory(target: string): Promise<string>;
  rootDirectory(target: string): Promise<string>;
  prepareRoots(roots: readonly string[]): Promise<Array<{ root: string; canonical: string }>>;
  inspect(target: string, roots?: readonly { root: string; canonical: string }[], kind?: 'file' | 'directory' | 'either'): Promise<{ real: string; isDirectory: boolean }>;
  confinedPath(target: string, roots: readonly string[], kind?: 'file' | 'directory' | 'either'): Promise<string>;
}

/** A fresh request snapshot of authority; targets themselves are never cached. */
export async function createReadAccessContext(): Promise<ReadAccessContext> {
  const rootPaths = new Map<string, Promise<string>>();
  const rootRealpath = (target: string) => {
    let result = rootPaths.get(target);
    if (!result) { result = realpathAsync(target); rootPaths.set(target, result); }
    return result;
  };
  const runtimeRoots = [path.join(homedir(), '.arco'), runtimeHome()];
  const protectedPaths = protectedRoots();
  const canonical = await Promise.all([...runtimeRoots, ...protectedPaths.map(p => p.root)]
    .map(root => rootRealpath(root).catch(() => undefined)));
  runtimeRoots.push(...canonical.slice(0, runtimeRoots.length).filter((p): p is string => p !== undefined));
  const protectedCanonical = canonical.slice(2);
  const assert = (target: string) => {
    assertSpellingSafe(target);
    for (const root of runtimeRoots) {
      if (isPathWithin(root, target) && !runtimePathAllowed(path.relative(root, target).split(path.sep).map(p => p.toLowerCase()))) throw new FileAccessError();
    }
    protectedPaths.forEach(({ root, temporaryRoot }, index) => {
      if (isProtectedRoot(root, target, temporaryRoot)) throw new FileAccessError();
      const real = protectedCanonical[index];
      const temporary = real && temporaryRoot ? path.join(real, path.relative(root, temporaryRoot)) : undefined;
      if (real && isProtectedRoot(real, target, temporary)) throw new FileAccessError();
    });
  };
  const check = async (target: string, roots: readonly { root: string; canonical: string }[] | undefined, kind: 'file' | 'directory' | 'either', resolve: (target: string) => Promise<string> = realpathAsync) => {
    if (!roots && !path.isAbsolute(target)) throw new FileAccessError();
    assert(target);
    const real = await resolve(target);
    assert(real);
    if (roots && !roots.some(({ root, canonical }) =>
      (isPathWithin(root, target) || isPathWithin(canonical, target)) && isPathWithin(canonical, real))) throw new FileAccessError();
    const broadRoot = real === path.parse(real).root
      && (process.platform !== 'win32' || real.toLowerCase() === path.parse(homedir()).root.toLowerCase());
    if (!roots && broadRoot) throw new FileAccessError();
    const st = await stat(real);
    if ((!(kind !== 'directory' && st.isFile()) && !(kind !== 'file' && st.isDirectory()))) throw new FileAccessError();
    return { real, isDirectory: st.isDirectory() };
  };
  const inspect: ReadAccessContext['inspect'] = (target, roots, kind = 'either') => check(target, roots, kind);
  const safe = async (target: string) => (await inspect(target, undefined, 'directory')).real;
  const rootCache = new Map<string, Promise<string>>();
  const rootDirectory = (target: string) => {
    let result = rootCache.get(target);
    if (!result) { result = check(target, undefined, 'directory', rootRealpath).then(p => p.real); rootCache.set(target, result); }
    return result;
  };
  const prepareRoots: ReadAccessContext['prepareRoots'] = async roots => (await Promise.all(roots.map(async root => {
    try { return { root, canonical: await rootDirectory(root) }; } catch { return null; }
  }))).filter((p): p is { root: string; canonical: string } => p !== null);
  return { assertSafePath: assert, realpath: realpathAsync, rootRealpath, safeDirectory: safe, rootDirectory, prepareRoots, inspect,
    confinedPath: async (target, roots, kind = 'file') => (await inspect(target, await prepareRoots(roots), kind)).real };
}
