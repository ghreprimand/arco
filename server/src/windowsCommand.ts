import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { win32 } from 'node:path';

export interface ResolvedCommand {
  command: string;
  args: string[];
  // Present when the program was found on the new-terminal PATH: the process
  // environment with that PATH under one key, for the child to run with.
  env?: NodeJS.ProcessEnv;
}

export interface ResolveOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  nodePath?: string;
  isFile?: (path: string) => boolean;
  readText?: (path: string) => string;
  // Opt in to searching the machine and user PATH a new terminal reads, after
  // the running PATH. Only for the process's own environment: a caller that
  // passes `env` never gains the host PATH implicitly.
  fresh?: boolean;
  registryPath?: () => string;
}

const defaultIsFile = (p: string): boolean => {
  try { return existsSync(p) && statSync(p).isFile(); } catch { return false; }
};
const defaultReadText = (p: string): string => readFileSync(p, 'utf8');

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  // Windows environment names are case-insensitive (`Path` is common).
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key ? env[key] : undefined;
}

// Locate `command` the way cmd.exe would: an explicit path is checked as is
// (with PATHEXT suffixes when it has no extension); a bare name is searched in
// each PATH directory.
export function findWindowsCommand(command: string, env: NodeJS.ProcessEnv, isFile: (p: string) => boolean): string | null {
  const exts = (envValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.trim().toLowerCase()).filter(Boolean);
  const hasExt = win32.extname(command) !== '';
  const candidates = (base: string): string[] => (hasExt ? [base] : exts.map((e) => base + e));
  if (/[\\/]/.test(command) || win32.isAbsolute(command)) {
    return candidates(command).find(isFile) ?? null;
  }
  const dirs = (envValue(env, 'PATH') ?? '').split(';').map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
  for (const dir of dirs) {
    const hit = candidates(win32.join(dir, command)).find(isFile);
    if (hit) return hit;
  }
  return null;
}

// A service or launcher started before an install keeps the PATH it began
// with, while a new terminal reads the current one from the registry. This
// reads that current value (machine then user, as Windows joins them) and
// expands %NAME% references. Empty when it cannot be read.
// The system utility by absolute path, never found through PATH or the folder.
function regExe(): string {
  const root = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows';
  return win32.join(root, 'System32', 'reg.exe');
}
let registryCache: { at: number; value: string } | null = null;
export function readRegistryPath(): string {
  const env = process.env;
  if (process.platform !== 'win32') return '';
  if (registryCache && Date.now() - registryCache.at < 30_000) return registryCache.value;
  const read = (key: string): string => {
    try {
      const out = execFileSync(regExe(),  ['query', key, '/v', 'Path'], { encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      return /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/im.exec(out)?.[1]?.trim() ?? '';
    } catch { return ''; }
  };
  const joined = [read('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'), read('HKCU\\Environment')].filter(Boolean).join(';');
  const value = joined.replace(/%([^%]+)%/g, (whole, name: string) => envValue(env, name.toUpperCase()) ?? whole);
  registryCache = { at: Date.now(), value };
  return value;
}

// findWindowsCommand on the running PATH first, then on the PATH a new
// terminal would have. Returns the file and the PATH that located it, so a
// child process can be given the same PATH.
export function locateWindowsCommand(command: string, env: NodeJS.ProcessEnv, isFile: (p: string) => boolean, registryPath?: () => string): { file: string; path?: string } | null {
  const direct = findWindowsCommand(command, env, isFile);
  if (direct) return { file: direct };
  if (/[\\/]/.test(command) || win32.isAbsolute(command)) return null;
  const fresh = registryPath?.();
  if (!fresh) return null;
  const current = envValue(env, 'PATH') ?? '';
  const merged = [...new Set([...fresh.split(';'), ...current.split(';')].map((d) => d.trim()).filter(Boolean))].join(';');
  const file = findWindowsCommand(command, { ...env, PATH: merged, Path: merged }, isFile);
  return file ? { file, path: merged } : null;
}

function freshSource(opts: ResolveOptions): (() => string) | undefined {
  if (!opts.fresh) return undefined;
  if (opts.registryPath) return opts.registryPath;
  return opts.env ? undefined : readRegistryPath;
}

// The environment with exactly one PATH variable, whatever its spelling.
export function withSinglePath(env: NodeJS.ProcessEnv, path: string): NodeJS.ProcessEnv {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (k.toUpperCase() !== 'PATH') out[k] = v;
  out[key] = path;
  return out;
}

// The first word of a sign-in command line, found like a provider program is;
// the rest is kept. `missing` names the program when it cannot be located.
export function resolveLoginCommand(line: string, opts: ResolveOptions = {}): { line: string; path?: string } | { missing: string } {
  if ((opts.platform ?? process.platform) !== 'win32') return { line };
  const match = /^([A-Za-z0-9._-]+)(\s.*)?$/.exec(line.trim());
  if (!match) return { line };
  const env = opts.env ?? process.env;
  const hit = locateWindowsCommand(match[1], env, opts.isFile ?? defaultIsFile, freshSource(opts));
  if (!hit) return { missing: match[1] };
  return { line: `"${hit.file}"${match[2] ?? ''}`, ...(hit.path ? { path: hit.path } : {}) };
}

// npm's cmd-shim writes `"%dp0%\node_modules\<pkg>\<bin>.js" %*` (older
// versions `"%~dp0\..."`). Returns the absolute JavaScript entry, or null when
// the shim does not wrap a script (for example a shim for a native binary).
export function npmShimTarget(shimPath: string, text: string): string | null {
  const match = /"%(?:dp0%|~dp0)\\?([^"%]+\.(?:c|m)?js)"/i.exec(text);
  if (!match) return null;
  return win32.join(win32.dirname(shimPath), match[1]);
}

// Resolve npm's Windows command shims to a Node entry point where possible.
// This lets child-process callers pass argument arrays directly instead of
// routing provider CLI arguments through cmd.exe shell parsing.
export function resolveCommand(command: string, args: readonly string[] = [], opts: ResolveOptions = {}): ResolvedCommand {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'win32') return { command, args: [...args] };
  const env = opts.env ?? process.env;
  const isFile = opts.isFile ?? defaultIsFile;
  const located = locateWindowsCommand(command, env, isFile, freshSource(opts));
  if (!located) return { command, args: [...args] };
  const found = located.file;
  const freshEnv = located.path ? { env: withSinglePath(env, located.path) } : {};
  const ext = win32.extname(found).toLowerCase();
  if (ext === '.cmd' || ext === '.bat') {
    let text = '';
    try { text = (opts.readText ?? defaultReadText)(found); } catch { /* unreadable shim */ }
    const script = npmShimTarget(found, text);
    if (script && isFile(script)) return { command: opts.nodePath ?? process.execPath, args: [script, ...args], ...freshEnv };
    return { command, args: [...args] };
  }
  return { command: found, args: [...args], ...freshEnv };
}

// `spawn(...commandArgs('codex', args), options)`: the resolved command and
// arguments as a tuple for the spawn/execFile call sites.
export function commandArgs(command: string, args: readonly string[] = []): [string, string[]] {
  const r = resolveCommand(command, args);
  return [r.command, r.args];
}
