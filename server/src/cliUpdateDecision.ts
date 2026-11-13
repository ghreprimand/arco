import { execFile } from 'node:child_process';
import { promises as fs, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { CliUpdateOutcome } from '@arco/shared';
import { commandArgs, findWindowsCommand, npmShimTarget } from './windowsCommand.js';
import { resolveInstallableVersion, type ResolvedInstall } from './npmPlatformResolve.js';
import { compareVersions } from './updateCheck.js';

const exec = promisify(execFile);
const options = { timeout: 5_000, maxBuffer: 256 * 1024, killSignal: 'SIGKILL' as const };

export interface CodexInstallation {
  kind: 'standalone' | 'npm' | 'unknown';
  launcher?: string;
  supportsUpdate: boolean;
  npmRootMatches?: boolean;
  instruction?: string;
}

export interface CliUpdateDecision {
  kind: CodexInstallation['kind'];
  targetVersion?: string;
  command?: { cmd: string; args: string[] };
  repairArgs?: string[];
  outcome?: 'manual' | 'deferred';
  message?: string;
  notice?: string;
}

function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function canonical(file: string): Promise<string | undefined> {
  try { return await fs.realpath(file); } catch { return undefined; }
}

async function launcherOnPath(): Promise<string | undefined> {
  if (process.platform === 'win32') {
    return findWindowsCommand('codex', process.env, (file) => {
      try { return requireFile(file); } catch { return false; }
    }) ?? undefined;
  }
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const file = path.resolve(dir, 'codex');
    try { await fs.access(file, constants.X_OK); if ((await fs.stat(file)).isFile()) return file; } catch { /* try the next PATH entry */ }
  }
  return undefined;
}

// Windows command lookup is synchronous so it can use the same PATH/PATHEXT
// selection as the provider launcher, including npm's .cmd wrapper.
function requireFile(file: string): boolean { return statSync(file).isFile(); }

export async function inspectCodexInstallation(): Promise<CodexInstallation> {
  const launcher = await launcherOnPath();
  if (!launcher) return { kind: 'unknown', supportsUpdate: false };
  let entry = launcher;
  if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(launcher)) {
    try { entry = npmShimTarget(launcher, await fs.readFile(launcher, 'utf8')) ?? launcher; } catch { /* leave an unreadable wrapper unknown */ }
  }
  const real = await canonical(entry);
  if (!real) return { kind: 'unknown', launcher, supportsUpdate: false };
  let supportsUpdate = false;
  try {
    const { stdout } = await exec(...commandArgs(launcher, ['--help']), options);
    supportsUpdate = /^\s+update\s+/m.test(stdout);
  } catch { /* an older or broken CLI can still have a proven npm repair path */ }

  if (path.basename(real) === 'codex.js') {
    const packageRoot = path.dirname(path.dirname(real));
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));
      if (manifest.name === '@openai/codex') {
        const { stdout } = await exec(...commandArgs('npm', ['root', '-g']), options);
        const target = await canonical(path.join(stdout.trim(), '@openai', 'codex'));
        return { kind: 'npm', launcher, supportsUpdate, npmRootMatches: !!target && path.relative(target, packageRoot) === '' };
      }
    } catch { /* ownership could not be proved; never guess a global npm target */ }
    return { kind: 'unknown', launcher, supportsUpdate, instruction: 'Arco could not confirm the npm update target. No update was run. Use the package manager that installed this Codex.' };
  }

  const home = process.env.CODEX_HOME || path.join(homedir(), '.codex');
  const releases = await canonical(path.join(home, 'packages', 'standalone', 'releases'));
  if (releases && inside(releases, real)) {
    const defaultBin = process.platform === 'win32'
      ? process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin')
      : path.join(homedir(), '.local', 'bin');
    const installBin = process.env.CODEX_INSTALL_DIR || defaultBin;
    // The updater reruns the installer. Its destination must still be the
    // active command directory, including a retained custom install directory.
    if (!installBin || path.relative(path.resolve(path.dirname(launcher)), path.resolve(installBin)) !== '') {
      return { kind: 'unknown', launcher, supportsUpdate, instruction: 'This Codex was not installed through npm. No update was run because its installer destination could not be confirmed. Open codex in a terminal and use its update prompt with the original install directory.' };
    }
    return { kind: 'standalone', launcher, supportsUpdate };
  }
  return { kind: 'unknown', launcher, supportsUpdate };
}

export function decideCodexUpdate(installation: CodexInstallation, published?: string, resolved?: ResolvedInstall | null): CliUpdateDecision {
  const base = { kind: installation.kind };
  if (installation.kind === 'unknown' || !installation.launcher) {
    return { ...base, outcome: 'manual', message: installation.instruction ?? 'Arco could not identify how this Codex was installed. No update was run. Open codex in a terminal and use its update prompt or the package manager that installed it.' };
  }
  if (installation.kind === 'standalone') {
    return installation.supportsUpdate
      ? { ...base, targetVersion: published, command: { cmd: installation.launcher, args: ['update'] } }
      : { ...base, targetVersion: published, outcome: 'manual', message: 'This Codex was not installed through npm and does not support codex update. No update was run. Open codex in a terminal and use its update prompt.' };
  }
  if (!installation.npmRootMatches) {
    return { ...base, outcome: 'manual', message: 'The npm update would target a different Codex installation. No update was run. Use the package manager that installed this Codex.' };
  }
  if (!resolved) {
    return { ...base, outcome: 'deferred', message: 'Arco could not confirm an installable Codex npm build. The current installation was not changed.' };
  }
  if (resolved.blocked || (installation.supportsUpdate && resolved.degraded)) {
    return { ...base, outcome: 'deferred', message: `Codex v${resolved.latest} has no ${process.platform}-${process.arch} build available yet. The current installation was not changed.` };
  }
  const args = ['install', '-g', `@openai/codex@${resolved.version}`];
  return {
    ...base, targetVersion: resolved.version,
    command: installation.supportsUpdate ? { cmd: installation.launcher, args: ['update'] } : { cmd: 'npm', args },
    repairArgs: args,
    ...(resolved.degraded ? { notice: `Codex v${resolved.latest} has no ${process.platform}-${process.arch} build available yet. The newest installable npm version is v${resolved.version}.` } : {}),
  };
}

export async function probeCodexUpdate(published?: string): Promise<CliUpdateDecision> {
  const installation = await inspectCodexInstallation();
  const resolved = installation.kind === 'npm' && installation.npmRootMatches
    ? await resolveInstallableVersion('@openai/codex') : undefined;
  return decideCodexUpdate(installation, published, resolved);
}

export interface UpdateCommandResult { output: string; exitCode: number; }

export function describeCliUpdate(provider: string, previous: string, current: string, target: string | undefined, command: UpdateCommandResult, notice?: string): { outcome: CliUpdateOutcome; message: string; updated: boolean; error?: string } {
  const name = provider === 'codex' ? 'Codex' : 'Claude CLI';
  if (command.exitCode !== 0) {
    const error = `${name} update failed: ${command.output.trim().slice(0, 2000) || `exit code ${command.exitCode}`}`;
    return { outcome: 'failed', message: error, updated: false, error };
  }
  if (current === 'unknown' || current === 'broken') {
    const error = `${name} did not run after the update.`;
    return { outcome: 'failed', message: error, updated: false, error };
  }
  if (previous !== current && (compareVersions(current, previous) ?? 1) > 0) {
    return { outcome: 'updated', message: `Updated ${name} from v${previous} to v${current}.${notice ? ` ${notice}` : ''}`, updated: true };
  }
  if (notice) return { outcome: 'deferred', message: notice, updated: false };
  const comparison = target ? compareVersions(current, target) : null;
  if (comparison !== null && comparison >= 0) return { outcome: 'current', message: `${name} v${current} is up to date for this installation.`, updated: false };
  return { outcome: 'unchanged', updated: false, message: comparison !== null
    ? `${name} did not change; v${target} is still available.`
    : `The ${name} version did not change. Arco could not check whether it is up to date.` };
}
