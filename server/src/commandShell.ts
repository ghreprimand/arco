// The shell that runs agent shell commands (the Claude Native and Ollama Bash
// tools, the sandbox's shell scripts) and Claude Native hooks.
//
// - Linux and macOS: /bin/sh, as before.
// - Windows: Git Bash, as Claude Code itself uses there, so hook commands
//   written for Claude Code behave the same. Found through
//   CLAUDE_CODE_GIT_BASH_PATH (Claude Code's own override), then the Git for
//   Windows install that `git` on PATH belongs to, then the standard install
//   folders. The bash.exe in the Windows system folder (WSL) and the
//   WindowsApps alias are never used: they run commands in a Linux
//   distribution, not on this computer's files and tools.
// - No Git Bash: a problem text naming the missing piece and the fix. Callers
//   decide what that means (the Bash tool returns it as an error; a hook does
//   not run and the action goes ahead with a notice).
import { statSync } from 'node:fs';
import path from 'node:path';

export const GIT_BASH_OVERRIDE = 'CLAUDE_CODE_GIT_BASH_PATH';
const FIX = `Install Git for Windows (https://git-scm.com/downloads/win), or set ${GIT_BASH_OVERRIDE} to the full path of its bash.exe, then restart Arco.`;

export type CommandShell =
  | { ok: true; file: string; kind: 'sh' | 'git-bash' }
  | { ok: false; problem: string };

export interface ShellLookup {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  isFile?: (file: string) => boolean;
}

function defaultIsFile(file: string): boolean {
  try { return statSync(file).isFile(); } catch { return false; }
}

// Windows environment names are case-insensitive (Path, PATH); a plain
// object passed by a test is not, so look the name up both ways.
function envValue(env: NodeJS.ProcessEnv, name: string, win: boolean): string | undefined {
  if (env[name] !== undefined || !win) return env[name];
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

// The Git for Windows folder for a git.exe found on PATH: <root>\cmd\git.exe,
// <root>\bin\git.exe or <root>\mingw64\bin\git.exe. Null for other layouts.
export function gitRootFromGitExe(gitExe: string): string | null {
  const p = path.win32;
  const dir = p.dirname(gitExe);
  const name = p.basename(dir).toLowerCase();
  if (name === 'cmd') return p.dirname(dir);
  if (name !== 'bin') return null;
  const parent = p.dirname(dir);
  if (/^(mingw64|mingw32|clangarm64|usr)$/.test(p.basename(parent).toLowerCase())) return p.dirname(parent);
  return parent;
}

// The WSL launcher (System32, SysWOW64, Sysnative) or the Store alias in
// WindowsApps: not Git Bash.
export function isWindowsSystemBash(file: string, env: NodeJS.ProcessEnv = {}): boolean {
  const p = path.win32;
  const lower = p.normalize(file).toLowerCase();
  if (/\\windows\\(system32|syswow64|sysnative)\\/.test(lower) || /\\windowsapps\\/.test(lower)) return true;
  const root = envValue(env, 'SystemRoot', true)?.trim();
  return !!root && lower.startsWith(`${p.normalize(root).toLowerCase().replace(/\\$/, '')}\\`);
}

function unquote(value: string): string {
  return value.trim().replace(/^"(.*)"$/, '$1');
}

export function findCommandShell(lookup: ShellLookup = {}): CommandShell {
  const platform = lookup.platform ?? process.platform;
  if (platform !== 'win32') return { ok: true, file: '/bin/sh', kind: 'sh' };
  const env = lookup.env ?? process.env;
  const isFile = lookup.isFile ?? defaultIsFile;
  const p = path.win32;

  const override = unquote(envValue(env, GIT_BASH_OVERRIDE, true) ?? '');
  if (override) {
    if (isWindowsSystemBash(override, env)) {
      return { ok: false, problem: `${GIT_BASH_OVERRIDE} points to the bash.exe in the Windows system folder, which runs commands in WSL, not Git Bash. ${FIX}` };
    }
    if (isFile(override)) return { ok: true, file: override, kind: 'git-bash' };
    return { ok: false, problem: `${GIT_BASH_OVERRIDE} is set, but there is no file at ${override}. ${FIX}` };
  }

  const roots: string[] = [];
  for (const dir of (envValue(env, 'PATH', true) ?? '').split(';').map(unquote).filter(Boolean)) {
    const gitExe = p.join(dir, 'git.exe');
    if (!isFile(gitExe)) continue;
    const root = gitRootFromGitExe(gitExe);
    if (root) roots.push(root);
  }
  for (const [name, sub] of [['ProgramFiles', 'Git'], ['ProgramW6432', 'Git'], ['ProgramFiles(x86)', 'Git'], ['LOCALAPPDATA', 'Programs\\Git'], ['USERPROFILE', 'scoop\\apps\\git\\current']] as const) {
    const base = envValue(env, name, true)?.trim();
    if (base) roots.push(p.join(base, sub));
  }
  for (const root of roots) {
    for (const candidate of [p.join(root, 'bin', 'bash.exe'), p.join(root, 'usr', 'bin', 'bash.exe')]) {
      if (!isWindowsSystemBash(candidate, env) && isFile(candidate)) return { ok: true, file: candidate, kind: 'git-bash' };
    }
  }
  return { ok: false, problem: `Git Bash was not found. On Windows, Arco runs shell commands and hooks with Git Bash. ${FIX}` };
}

let cached: CommandShell | null = null;
let forced: CommandShell | null = null;

// The shell for this process. A found shell is remembered; a missing one is
// looked up again on the next call.
export function commandShell(): CommandShell {
  if (forced) return forced;
  if (cached) return cached;
  const found = findCommandShell();
  if (found.ok) cached = found;
  return found;
}

/** Tests: force a result (or null to look it up again). */
export function _setCommandShellForTest(value: CommandShell | null): void {
  forced = value;
  cached = null;
}

/** Arguments that run `command` in the shell: `-c` for both sh and bash. */
export function commandShellArgs(command: string): string[] {
  return ['-c', command];
}
