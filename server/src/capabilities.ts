import { execFile } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import { CLAUDE_MODELS } from '@arco/shared';
import type { Capabilities, CliUpdateOutcome, EffortLevel, ModelName } from '@arco/shared';
import { getStrataBase } from './providers/strata.js';
import { getDeepSeekBase } from './providers/deepseek.js';
import { probeStrataVersion, installedXolotlRevision, strataEngineReleaseVersion } from './providers/runtimeVersions.js';
import { atomicWriteFile } from './atomicFile.js';
import { probeCodexUpdate, describeCliUpdate, type CliUpdateDecision, type UpdateCommandResult } from './cliUpdateDecision.js';
import { compareVersions } from './updateCheck.js';
import { arcoHome } from './arcoHome.js';
import { commandArgs } from './windowsCommand.js';

const execFileAsync = promisify(execFile);
const CLI_PROBE_OPTIONS = {
  timeout: 5_000,
  killSignal: 'SIGKILL' as const,
  maxBuffer: 2 * 1024 * 1024,
};

const FALLBACK_EFFORTS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODELS: ModelName[] = [...CLAUDE_MODELS] as ModelName[];

// Provider we know how to check/update from Arco. Not a union with
// ProviderName because Ollama isn't a CLI and doesn't ship with a version
// flag in the same sense.
export type CliProvider = 'claude' | 'codex';

// 'unknown' = the CLI isn't installed (the PROVIDERS popover hides those rows).
// 'broken' = it IS installed but the version probe failed. Keeping them distinct
// is load-bearing: 2026-09-03 `npm install -g @openai/codex@latest` (the popover's
// own update command) silently skipped the 129 MB platform binary — it's an
// optional dep, so npm exited 0 — and every `codex --version` threw. Collapsing
// that into 'unknown' made the whole CODEX row disappear from the popover, which
// reads as "not installed" and gives the operator nothing to click or diagnose.
export async function probeVersion(bin: string, flags: string[] = ['--version'], timeoutMs = 5_000): Promise<string> {
  try {
    const { stdout } = await execFileAsync(...commandArgs(bin, flags), { ...CLI_PROBE_OPTIONS, timeout: timeoutMs });
    const match = stdout.match(/(\d+\.\d+\.\d+(?:[-.][A-Za-z0-9.-]+)?)/);
    return match ? match[1] : 'unknown';
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'unknown' : 'broken';
  }
}

// Re-run a failing binary to recover *why* it failed, for the update path. The
// first `Error:` line is what we want (node stack traces bury it), capped so it
// fits the popover's one-line result slot.
async function probeFailureReason(bin: string): Promise<string | null> {
  try {
    await execFileAsync(...commandArgs(bin, ['--version']), CLI_PROBE_OPTIONS);
    return null;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
    if (e.code === 'ENOENT') return `${bin} is not on PATH`;
    const text = `${e.stderr ?? ''}\n${e.stdout ?? ''}`.trim() || e.message;
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    return (lines.find((l) => /^Error\b/i.test(l)) ?? lines[0] ?? e.message).slice(0, 200);
  }
}

export async function probeCapabilities(): Promise<Capabilities> {
  let efforts = FALLBACK_EFFORTS;

  try {
    const { stdout } = await execFileAsync(...commandArgs('claude', ['--help']), CLI_PROBE_OPTIONS);
    const match = stdout.match(/--effort\s+<level>[^(]*\(([^)]+)\)/);
    if (match) {
      const parsed = match[1].split(',').map((s) => s.trim()).filter(Boolean);
      if (parsed.length > 0) efforts = parsed as EffortLevel[];
    }
  } catch {
    // Keep fallback
  }

  const codexDecision = npmLatest('@openai/codex').then(probeCodexUpdate);
  const [cliVersion, codexVersion, cursorVersion, strataVersion, xolotlRevision, latestVersions, codexUpdate] = await Promise.all([
    probeVersion('claude'),
    probeVersion('codex'),
    probeVersion('cursor-agent'),
    probeStrataVersion(await getStrataBase()),
    installedXolotlRevision(await getDeepSeekBase()),
    probeLatestVersions(codexDecision),
    codexDecision,
  ]);

  return { efforts, models: MODELS, cliVersion, codexVersion, cursorVersion, strataVersion, xolotlRevision, latestVersions,
    codexUpdate: { kind: codexUpdate.kind, updateAvailable: !!codexUpdate.targetVersion && (compareVersions(codexVersion, codexUpdate.targetVersion) ?? 0) < 0, instruction: codexUpdate.message ?? codexUpdate.notice } };
}

// ── Upstream latest-version probes ──
//
// Source of truth for "is the operator running the latest CLI?" Claude reads
// npm; Codex uses its installation decision and npm publication metadata;
// Ollama queries GitHub Releases since it's not npm-installed. All are best-effort: any
// failure (offline, rate-limited, schema drift) leaves that key undefined
// and the UI falls back to displaying the installed version with no
// outdated indicator. Caller decides cadence — boot + the existing 4h
// re-probe. We deliberately don't add internal caching: the caller already
// gates calls behind a long interval.
const NPM_REGISTRY = 'https://registry.npmjs.org';
const REGISTRY_TIMEOUT_MS = 4_000;

async function fetchJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function npmLatest(pkg: string): Promise<string | undefined> {
  const data = await fetchJson(`${NPM_REGISTRY}/${pkg}/latest`);
  if (data && typeof (data as { version?: unknown }).version === 'string') {
    return (data as { version: string }).version;
  }
  return undefined;
}

async function ollamaLatestRelease(): Promise<string | undefined> {
  const data = await fetchJson('https://api.github.com/repos/ollama/ollama/releases/latest');
  const tag = (data as { tag_name?: unknown } | null)?.tag_name;
  if (typeof tag === 'string') return tag.replace(/^v/, '');
  return undefined;
}

export async function refreshRuntimeVersions(previous: Capabilities): Promise<Capabilities> {
  // Installed runtimes can change outside Arco. Refresh on demand without
  // probing every CLI/upstream registry or starting an inference service.
  const [strataVersion, xolotlRevision] = await Promise.all([
    probeStrataVersion(await getStrataBase()),
    installedXolotlRevision(await getDeepSeekBase()),
  ]);
  return { ...previous, strataVersion, xolotlRevision };
}

async function strataLatestRelease(): Promise<string | undefined> {
  const [feed, release] = await Promise.all([
    fetchJson('https://github.com/Niko1221/Strata/releases/latest/download/strata-feed.json'),
    fetchJson('https://api.github.com/repos/Niko1221/Strata/releases/latest'),
  ]);
  return strataEngineReleaseVersion(feed, release);
}

export async function probeLatestVersions(codexDecision = npmLatest('@openai/codex').then(probeCodexUpdate)): Promise<Capabilities['latestVersions']> {
  const [claude, codex, ollama, strata, xolotl] = await Promise.all([
    npmLatest('@anthropic-ai/claude-code'),
    codexDecision.then((decision) => decision.targetVersion),
    ollamaLatestRelease(),
    strataLatestRelease(),
    fetchJson('https://api.github.com/repos/Indras-Mirror/Xolotl/commits/HEAD').then((data) => {
      const sha = (data as { sha?: unknown } | null)?.sha;
      return typeof sha === 'string' && /^[a-f0-9]{40}$/.test(sha) ? sha : undefined;
    }),
  ]);
  return { claude, codex, ollama, strata, xolotl };
}

export interface UpdateResult {
  provider: CliProvider;
  updated: boolean;
  previousVersion: string;
  currentVersion: string;
  capabilities: Capabilities;
  output: string;
  outcome: CliUpdateOutcome;
  message: string;
  // Set when preflight refuses the install or the command leaves no working binary.
  // The client renders this instead of a bogus version transition.
  error?: string;
  // Deterministic explanation for a non-obvious outcome — most often "latest
  // has no build for this platform yet, so we installed the newest one that
  // does". Present on success too; `error` is reserved for failure.
  notice?: string;
}

function versionForProvider(caps: Capabilities, provider: CliProvider): string {
  return provider === 'claude' ? caps.cliVersion : caps.codexVersion ?? 'unknown';
}

/**
 * Run the updater for the installation Arco actually launches. Claude uses its
 * built-in updater; Codex shares one installation decision with its version flag.
 * Re-probe afterwards: a successful command alone does not prove a working CLI.
 */
export async function runCliUpdate(previous: Capabilities, provider: CliProvider = 'claude', runCommand: (cmd: string, args: string[]) => Promise<UpdateCommandResult> = (cmd, args) => runUpdateCommand(cmd, args, provider)): Promise<UpdateResult> {
  const previousVersion = provider === 'codex' ? await probeVersion('codex') : versionForProvider(previous, provider);
  // Pre-flight: for npm-installed CLIs, work out which version can actually run
  // on this machine before installing anything. `@latest` is not automatically
  // installable — a package whose binary ships as a platform-specific
  // optionalDependency is broken-on-arrival during the window between the
  // wrapper being tagged `latest` and that platform's tarball being published,
  // and npm reports that as success. See npmPlatformResolve.ts.
  const decision: CliUpdateDecision = provider === 'codex'
    ? await probeCodexUpdate(await npmLatest('@openai/codex'))
    : { kind: 'unknown' as const, command: { cmd: 'claude', args: ['update'] }, targetVersion: previous.latestVersions?.claude };
  const notice = decision.notice;
  const capabilities = provider === 'codex'
    ? { ...previous, codexVersion: previousVersion, latestVersions: { ...previous.latestVersions, codex: decision.targetVersion }, codexUpdate: { kind: decision.kind, updateAvailable: !!decision.targetVersion && (compareVersions(previousVersion, decision.targetVersion) ?? 0) < 0, instruction: decision.message ?? decision.notice } }
    : previous;
  if (!decision.command) {
    const message = decision.message ?? 'Update deferred; the current CLI was not changed.';
    return { provider, previousVersion, currentVersion: previousVersion, capabilities, updated: false,
      outcome: decision.outcome ?? 'deferred', message, output: message, notice: message };
  }
  // Already on the version we would install, and it runs — skip the install
  // entirely so a no-op click can't churn a working CLI into a broken one.
  if (provider === 'codex' && decision.targetVersion && (compareVersions(previousVersion, decision.targetVersion) ?? -1) >= 0) {
    return { provider, previousVersion, currentVersion: previousVersion, capabilities, output: '',
      ...describeCliUpdate(provider, previousVersion, previousVersion, decision.targetVersion, { exitCode: 0, output: '' }, notice),
      ...(notice ? { notice } : {}) };
  }
  const { cmd, args } = decision.command;
  let commandResult = await runCommand(cmd, args);
  let next = await probeCapabilities();
  let currentVersion = versionForProvider(next, provider);

  // Post-flight repair. The pre-flight check closes the common case, but npm can
  // still skip an optional dep that does exist (a mid-install network failure,
  // a poisoned cache), and that also exits 0. One retry with a clean cache is
  // cheap next to leaving the operator's CLI dead. Only a proven npm install
  // with a successful updater exit can reach this npm repair path.
  if (commandResult.exitCode === 0 && (currentVersion === 'broken' || currentVersion === 'unknown') && decision.repairArgs) {
    const repairArgs = [...decision.repairArgs, '--force'];
    const repaired = await runCommand('npm', repairArgs);
    commandResult = { exitCode: repaired.exitCode, output: `${commandResult.output}\n\n[arco] ${provider} did not run after the update — retrying: npm ${repairArgs.join(' ')}\n${repaired.output}` };
    next = await probeCapabilities();
    currentVersion = versionForProvider(next, provider);
  }

  // A post-update probe that can't report a version means the command left the
  // CLI unusable, however cleanly it exited. Deciding `updated` purely on the
  // version string differing is how a silently-failed npm install surfaced
  // as a cheerful "→ vunknown". Nonzero exits are also failures, even when
  // the previous executable still runs and reports the same version.
  const report = describeCliUpdate(provider, previousVersion, currentVersion, next.latestVersions?.[provider], commandResult, notice);
  if (report.outcome === 'failed' && commandResult.exitCode === 0) {
    const reason = await probeFailureReason(provider);
    if (reason) { report.error = reason; report.message = reason; }
  }
  return { provider, previousVersion, currentVersion, capabilities: next, output: commandResult.output,
    ...report, ...(notice ? { notice } : {}) };
}

// Keep the command status as well as its captured output. npm can exit zero
// after skipping an optional dep, but a nonzero updater exit is always failure.
async function runUpdateCommand(cmd: string, args: string[], provider: CliProvider): Promise<UpdateCommandResult> {
  const env = { ...process.env };
  if (provider === 'codex') {
    // Native Codex must detect its own install; an enclosing agent's package
    // manager provenance must not turn a standalone update into an npm install.
    for (const name of ['CODEX_MANAGED_BY_NPM', 'CODEX_MANAGED_BY_BUN', 'CODEX_MANAGED_BY_PNPM', 'CODEX_MANAGED_BY_VITE_PLUS', 'CODEX_MANAGED_PACKAGE_ROOT', 'npm_config_user_agent', 'npm_execpath']) delete env[name];
  }
  try {
    const { stdout, stderr } = await execFileAsync(...commandArgs(cmd, args), { env, maxBuffer: 4 * 1024 * 1024, timeout: 180_000 });
    return { output: (stdout + stderr).trim(), exitCode: 0 };
  } catch (err) {
    const error = err as { code?: number | string; stdout?: string; stderr?: string; message?: string };
    return { output: (error.stderr || error.stdout || error.message || String(err)).trim(), exitCode: typeof error.code === 'number' ? error.code : 1 };
  }
}

// ── CLI help snapshots + change detection ──
//
// On boot we snapshot each CLI's help surface and diff against the last
// snapshot. If anything changed (new version or new flags) we surface a
// toast in the UI so the operator isn't left discovering new CLI features
// by accident. Snapshots live at `~/.arco/cli-snapshots/`.

const SNAPSHOT_DIR = join(arcoHome(), 'cli-snapshots');

const HELP_PROBES: Record<CliProvider, string[][]> = {
  claude: [['--help'], ['config', '--help'], ['mcp', '--help']],

  codex: [['--help'], ['exec', '--help']],
};

export interface CliChange {
  provider: CliProvider;
  fromVersion: string;
  toVersion: string;
  newFlags: string[];
  removedFlags: string[];
  diffFileName: string;
}

interface SnapshotMeta {
  version: string;
  hash: string;
  seenAt: number;
}

async function runHelpProbe(bin: CliProvider, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(...commandArgs(bin, args), CLI_PROBE_OPTIONS);
    return stdout;
  } catch {
    return null; // flag not supported on this version — skip silently
  }
}

async function snapshotHelp(provider: CliProvider): Promise<{ text: string; hash: string }> {
  const chunks: string[] = [];
  for (const args of HELP_PROBES[provider]) {
    const out = await runHelpProbe(provider, args);
    if (out !== null) chunks.push(`## ${provider} ${args.join(' ')}\n${out}`);
  }
  const text = chunks.join('\n\n');
  const hash = createHash('sha256').update(text).digest('hex').slice(0, 12);
  return { text, hash };
}

function extractFlags(helpText: string): Set<string> {
  const flags = new Set<string>();
  for (const m of helpText.matchAll(/(?:^|\s)(--[a-z][\w-]+)/g)) {
    flags.add(m[1]);
  }
  return flags;
}

async function readPriorSnapshot(provider: CliProvider): Promise<{ text: string; meta: SnapshotMeta } | null> {
  try {
    const text = await fs.readFile(join(SNAPSHOT_DIR, `${provider}.txt`), 'utf8');
    const meta = JSON.parse(await fs.readFile(join(SNAPSHOT_DIR, `${provider}.meta.json`), 'utf8')) as SnapshotMeta;
    return { text, meta };
  } catch {
    return null;
  }
}

async function writeSnapshot(provider: CliProvider, text: string, meta: SnapshotMeta): Promise<void> {
  await fs.mkdir(SNAPSHOT_DIR, { recursive: true });
  // Both files atomically: a truncated `.txt` paired with a valid `.meta.json`
  // reads back as a real snapshot and renders a large bogus capability diff to
  // the operator, rather than failing cleanly into a re-probe.
  await atomicWriteFile(join(SNAPSHOT_DIR, `${provider}.txt`), text);
  await atomicWriteFile(join(SNAPSHOT_DIR, `${provider}.meta.json`), JSON.stringify(meta, null, 2) + '\n');
}

// Tiny unified-ish diff for human reading. Not strict patch format — just
// +/- lines so the operator can scan what changed.
function simpleDiff(oldText: string, newText: string): string {
  const oldLines = new Set(oldText.split('\n'));
  const newLines = new Set(newText.split('\n'));
  const out: string[] = [];
  for (const l of newText.split('\n')) if (!oldLines.has(l)) out.push(`+ ${l}`);
  for (const l of oldText.split('\n')) if (!newLines.has(l)) out.push(`- ${l}`);
  return out.join('\n');
}

/**
 * Compare current CLI help surfaces against the last persisted snapshots.
 * For each provider whose version OR help hash changed, writes a fresh
 * snapshot + a dated diff file under ~/.arco/cli-snapshots/ and returns
 * a CliChange entry. First-run providers (no prior snapshot) seed a
 * baseline silently and are NOT reported as changes.
 */
export async function detectCliChanges(caps: Capabilities): Promise<CliChange[]> {
  const providers: CliProvider[] = ['claude',  'codex'];
  const changes: CliChange[] = [];
  for (const p of providers) {
    const currentVersion = versionForProvider(caps, p);
    if (currentVersion === 'unknown') continue;
    const snap = await snapshotHelp(p);
    if (snap.text.length === 0) continue;
    const prior = await readPriorSnapshot(p);
    const now = Date.now();
    if (!prior) {
      await writeSnapshot(p, snap.text, { version: currentVersion, hash: snap.hash, seenAt: now });
      continue;
    }
    const versionChanged = prior.meta.version !== currentVersion;
    const hashChanged = prior.meta.hash !== snap.hash;
    if (!versionChanged && !hashChanged) continue;

    const oldFlags = extractFlags(prior.text);
    const newFlags = extractFlags(snap.text);
    const added = [...newFlags].filter((f) => !oldFlags.has(f)).sort();
    const removed = [...oldFlags].filter((f) => !newFlags.has(f)).sort();

    const diffFileName = `${p}-${prior.meta.version}-to-${currentVersion}.diff`;
    const diff = [
      `# ${p}: ${prior.meta.version} → ${currentVersion}`,
      `# seen: ${new Date(prior.meta.seenAt).toISOString()} → ${new Date(now).toISOString()}`,
      '',
      simpleDiff(prior.text, snap.text),
    ].join('\n');
    try {
      await fs.writeFile(join(SNAPSHOT_DIR, diffFileName), diff, 'utf8');
    } catch (err) {
      console.warn(`[arco] failed to write CLI diff ${diffFileName}:`, err);
    }

    await writeSnapshot(p, snap.text, { version: currentVersion, hash: snap.hash, seenAt: now });
    changes.push({
      provider: p,
      fromVersion: prior.meta.version,
      toVersion: currentVersion,
      newFlags: added,
      removedFlags: removed,
      diffFileName,
    });
  }
  return changes;
}

export function cliSnapshotDir(): string {
  return SNAPSHOT_DIR;
}
