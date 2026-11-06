// The shell that runs agent shell commands (the Claude Native and Ollama Bash
// tools, the sandbox's shell scripts) and Claude Native hooks, following
// Claude Code's documented rules.
//
// - Linux and macOS: /bin/sh, as before.
// - Windows: Git Bash, as Claude Code itself uses there, so hook commands
//   written for Claude Code behave the same. Found through
//   CLAUDE_CODE_GIT_BASH_PATH (Claude Code's own override), then the Git for
//   Windows install that `git` on PATH belongs to, then the standard install
//   folders. The bash.exe in the Windows system folder (WSL) and the
//   WindowsApps alias are never used: they run commands in a Linux
//   distribution, not on this computer's files and tools.
// - Windows without Git Bash: PowerShell (pwsh.exe first, then Windows
//   PowerShell 5.1), as Claude Code falls back to. The result carries a
//   notice saying so and how to get Git Bash; it is information, not an error.
// - Neither: a problem text naming the missing piece and the fix. Callers
//   decide what that means (the Bash tool returns it as an error; a hook does
//   not run and the action goes ahead with a notice).
//
// A hook can also ask for a shell itself ("shell": "bash" or "powershell",
// hookShell below), and PowerShell commands are passed encoded, so no quoting
// survives into the command line (shellInvocation).
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const GIT_BASH_OVERRIDE = 'CLAUDE_CODE_GIT_BASH_PATH';
const FIX = `install Git for Windows (https://git-scm.com/downloads/win), or set ${GIT_BASH_OVERRIDE} to the full path of its bash.exe, then restart Arco.`;

export type ShellKind = 'sh' | 'git-bash' | 'powershell';

export type CommandShell =
  // `notice`: set when Windows falls back to PowerShell; why, and how to get Git Bash.
  | { ok: true; file: string; kind: ShellKind; notice?: string }
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

type GitBash = { ok: true; file: string } | { ok: false; reason: string };

function findGitBash(env: NodeJS.ProcessEnv, isFile: (file: string) => boolean): GitBash {
  const p = path.win32;
  const override = unquote(envValue(env, GIT_BASH_OVERRIDE, true) ?? '');
  if (override) {
    if (isWindowsSystemBash(override, env)) {
      return { ok: false, reason: `${GIT_BASH_OVERRIDE} points to the bash.exe in the Windows system folder, which runs commands in WSL, not Git Bash` };
    }
    if (isFile(override)) return { ok: true, file: override };
    return { ok: false, reason: `${GIT_BASH_OVERRIDE} is set, but there is no file at ${override}` };
  }

  const roots: string[] = [];
  for (const dir of pathDirs(env, true)) {
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
      if (!isWindowsSystemBash(candidate, env) && isFile(candidate)) return { ok: true, file: candidate };
    }
  }
  return { ok: false, reason: 'Git Bash was not found' };
}

function pathDirs(env: NodeJS.ProcessEnv, win: boolean): string[] {
  return (envValue(env, 'PATH', win) ?? '').split(win ? ';' : ':').map(unquote).filter(Boolean);
}

// PowerShell, as Claude Code finds it: pwsh (PowerShell 7 and later) first,
// then Windows PowerShell 5.1. PATH first, then the standard install folders.
// Null when there is none.
export function findPowerShell(lookup: ShellLookup = {}): string | null {
  const platform = lookup.platform ?? process.platform;
  const env = lookup.env ?? process.env;
  const isFile = lookup.isFile ?? defaultIsFile;
  if (platform !== 'win32') {
    const dirs = [...pathDirs(env, false), '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/opt/microsoft/powershell/7', '/snap/bin'];
    for (const dir of dirs) {
      const candidate = path.posix.join(dir, 'pwsh');
      if (isFile(candidate)) return candidate;
    }
    return null;
  }
  const p = path.win32;
  const dirs = pathDirs(env, true);
  const pwshFolders = ['ProgramFiles', 'ProgramW6432']
    .map((name) => envValue(env, name, true)?.trim())
    .filter((base): base is string => !!base)
    .map((base) => p.join(base, 'PowerShell', '7'));
  for (const dir of [...dirs, ...pwshFolders]) {
    const candidate = p.join(dir, 'pwsh.exe');
    if (isFile(candidate)) return candidate;
  }
  const root = envValue(env, 'SystemRoot', true)?.trim() || 'C:\\Windows';
  for (const dir of [...dirs, p.join(root, 'System32', 'WindowsPowerShell', 'v1.0')]) {
    const candidate = p.join(dir, 'powershell.exe');
    if (isFile(candidate)) return candidate;
  }
  return null;
}

export function findCommandShell(lookup: ShellLookup = {}): CommandShell {
  const platform = lookup.platform ?? process.platform;
  if (platform !== 'win32') return { ok: true, file: '/bin/sh', kind: 'sh' };
  const env = lookup.env ?? process.env;
  const isFile = lookup.isFile ?? defaultIsFile;
  const bash = findGitBash(env, isFile);
  if (bash.ok) return { ok: true, file: bash.file, kind: 'git-bash' };
  const powershell = findPowerShell({ platform, env, isFile });
  if (powershell) {
    return { ok: true, file: powershell, kind: 'powershell', notice: `${bash.reason}, so shell commands and hooks run in PowerShell, as in Claude Code. To use Git Bash instead, ${FIX}` };
  }
  return { ok: false, problem: `${bash.reason}, and PowerShell was not found either, so shell commands and hooks cannot run. On Windows, Arco runs them with Git Bash, or PowerShell when Git Bash is missing. To fix it, ${FIX}` };
}

/** The shell a hook asked for with "shell": "bash" or "powershell". */
export function findRequestedShell(requested: 'bash' | 'powershell', lookup: ShellLookup = {}): CommandShell {
  const platform = lookup.platform ?? process.platform;
  if (requested === 'powershell') {
    const file = findPowerShell(lookup);
    return file
      ? { ok: true, file, kind: 'powershell' }
      : { ok: false, problem: 'The hook asks for PowerShell ("shell": "powershell"), but neither pwsh nor powershell.exe was found.' };
  }
  if (platform !== 'win32') return { ok: true, file: '/bin/sh', kind: 'sh' };
  const bash = findGitBash(lookup.env ?? process.env, lookup.isFile ?? defaultIsFile);
  return bash.ok
    ? { ok: true, file: bash.file, kind: 'git-bash' }
    : { ok: false, problem: `The hook asks for bash ("shell": "bash"), which needs Git Bash on Windows. ${bash.reason}. To fix it, ${FIX}` };
}

let cached: CommandShell | null = null;
let forced: CommandShell | null = null;
const requestedCache = new Map<string, CommandShell>();

// The shell for this process. A found shell is remembered; a missing one is
// looked up again on the next call.
export function commandShell(): CommandShell {
  if (forced) return forced;
  if (cached) return cached;
  const found = findCommandShell();
  if (found.ok) cached = found;
  return found;
}

// The shell for a hook: its own "shell" field when set, else commandShell().
export function hookShell(requested?: 'bash' | 'powershell'): CommandShell {
  if (!requested) return commandShell();
  const hit = requestedCache.get(requested);
  if (hit) return hit;
  const found = findRequestedShell(requested);
  if (found.ok) requestedCache.set(requested, found);
  return found;
}

/** Tests: force commandShell() (or null to look it up again). */
export function _setCommandShellForTest(value: CommandShell | null): void {
  forced = value;
  cached = null;
  requestedCache.clear();
}

/**
 * Tests: the PowerShell fallback this computer would use without Git Bash. On
 * Windows the real lookup, with every PATH folder holding git.exe or bash.exe
 * and the install folders hidden; elsewhere the pwsh found, with a stand-in
 * notice. Null when there is no PowerShell here.
 */
export function _powerShellFallbackForTest(): CommandShell | null {
  if (process.platform === 'win32') {
    const p = path.win32;
    const PATH = pathDirs(process.env, true).filter((d) => !defaultIsFile(p.join(d, 'git.exe')) && !defaultIsFile(p.join(d, 'bash.exe'))).join(';');
    const found = findCommandShell({ env: { PATH, SystemRoot: envValue(process.env, 'SystemRoot', true) } });
    return found.ok && found.kind === 'powershell' ? found : null;
  }
  const file = findPowerShell();
  return file ? { ok: true, file, kind: 'powershell', notice: 'Git Bash was not found, so shell commands and hooks run in PowerShell (test stand-in).' } : null;
}

export interface ShellInvocation {
  file: string;
  args: string[];
  /** Removes the temporary script of a long PowerShell command; call after the child exits. */
  cleanup: () => void;
}

// UTF-8 in and out (Windows PowerShell 5.1 defaults to the console code page),
// no progress bars on stderr.
const POWERSHELL_PRELUDE = "$ProgressPreference='SilentlyContinue'; $OutputEncoding=[System.Text.UTF8Encoding]::new($false); try { [Console]::OutputEncoding=$OutputEncoding } catch {}; try { [Console]::InputEncoding=$OutputEncoding } catch {}";
// A native program's failing exit code becomes the script's, as in sh.
const POWERSHELL_TRAILER = 'if (-not $?) { if ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 } }';
// Windows limits a command line to 32767 characters; longer scripts go
// through a temporary .ps1 file.
const MAX_ENCODED_COMMAND = 24_000;

export function powerShellScript(command: string): string {
  return `${POWERSHELL_PRELUDE}\n${command}\n${POWERSHELL_TRAILER}\n`;
}

/** How to run `command` in `shell`: `-c` for sh and bash; for PowerShell an encoded command (or a temporary script file when long). */
export function shellInvocation(shell: { file: string; kind: ShellKind }, command: string): ShellInvocation {
  const none = (): void => {};
  if (shell.kind !== 'powershell') return { file: shell.file, args: ['-c', command], cleanup: none };
  const script = powerShellScript(command);
  const base = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  if (encoded.length <= MAX_ENCODED_COMMAND) return { file: shell.file, args: [...base, '-EncodedCommand', encoded], cleanup: none };
  const dir = mkdtempSync(path.join(tmpdir(), 'arco-ps-'));
  const file = path.join(dir, 'command.ps1');
  // The byte order mark makes Windows PowerShell 5.1 read the file as UTF-8.
  writeFileSync(file, `\uFEFF${script}`, 'utf8');
  return {
    file: shell.file,
    args: [...base, '-File', file],
    cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ } },
  };
}

/** What the model is told about the shell its Bash tool runs in. */
export function shellToolLabel(shell: CommandShell = commandShell()): string {
  if (!shell.ok) return 'sh -c (no shell was found on this computer, so commands fail until one is installed)';
  if (shell.kind === 'powershell') return 'PowerShell, because Git Bash was not found on this Windows computer. Write PowerShell commands, not bash or sh syntax';
  if (shell.kind === 'git-bash') return 'Git Bash (bash -c) on Windows';
  return 'sh -c';
}
