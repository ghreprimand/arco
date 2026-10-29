import { existsSync, readFileSync, statSync } from 'node:fs';
import { win32 } from 'node:path';

export interface ResolvedCommand {
  command: string;
  args: string[];
}

export interface ResolveOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  nodePath?: string;
  isFile?: (path: string) => boolean;
  readText?: (path: string) => string;
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
  const found = findWindowsCommand(command, env, isFile);
  if (!found) return { command, args: [...args] };
  const ext = win32.extname(found).toLowerCase();
  if (ext === '.cmd' || ext === '.bat') {
    let text = '';
    try { text = (opts.readText ?? defaultReadText)(found); } catch { /* unreadable shim */ }
    const script = npmShimTarget(found, text);
    if (script && isFile(script)) return { command: opts.nodePath ?? process.execPath, args: [script, ...args] };
    return { command, args: [...args] };
  }
  return { command: found, args: [...args] };
}

// `spawn(...commandArgs('codex', args), options)`: the resolved command and
// arguments as a tuple for the spawn/execFile call sites.
export function commandArgs(command: string, args: readonly string[] = []): [string, string[]] {
  const r = resolveCommand(command, args);
  return [r.command, r.args];
}
