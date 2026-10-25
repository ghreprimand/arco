import { execFile } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import { CLAUDE_MODELS } from '@archon/shared';
import type { Capabilities, EffortLevel, ModelName } from '@archon/shared';
import { getStrataBase } from './providers/strata.js';
import { getDeepSeekBase } from './providers/deepseek.js';
import { probeStrataVersion, installedXolotlRevision, strataEngineReleaseVersion } from './providers/runtimeVersions.js';
import { atomicWriteFile } from './atomicFile.js';
import { resolveInstallableVersion } from './npmPlatformResolve.js';
import { archonHome } from './archonHome.js';

const execFileAsync = promisify(execFile);

const FALLBACK_EFFORTS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODELS: ModelName[] = [...CLAUDE_MODELS] as ModelName[];

// Provider we know how to check/update from Archon. Not a union with
// ProviderName because Ollama isn't a CLI and doesn't ship with a version
// flag in the same sense.
export type CliProvider = 'claude' | 'gemini' | 'codex';

// 'unknown' = the CLI isn't installed (the PROVIDERS popover hides those rows).
// 'broken' = it IS installed but the version probe failed. Keeping them distinct
// is load-bearing: 2026-09-03 `npm install -g @openai/codex@latest` (the popover's
// own update command) silently skipped the 129 MB platform binary — it's an
// optional dep, so npm exited 0 — and every `codex --version` threw. Collapsing
// that into 'unknown' made the whole CODEX row disappear from the popover, which
// reads as "not installed" and gives the operator nothing to click or diagnose.
async function probeVersion(bin: string, flags: string[] = ['--version']): Promise<string> {
  try {
    const { stdout } = await execFileAsync(bin, flags);
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
    await execFileAsync(bin, ['--version']);
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
    const { stdout } = await execFileAsync('claude', ['--help'], { maxBuffer: 2 * 1024 * 1024 });
    const match = stdout.match(/--effort\s+<level>[^(]*\(([^)]+)\)/);
    if (match) {
      const parsed = match[1].split(',').map((s) => s.trim()).filter(Boolean);
      if (parsed.length > 0) efforts = parsed as EffortLevel[];
    }
  } catch {
    // Keep fallback
  }

  const [cliVersion, geminiVersion, codexVersion, cursorVersion, strataVersion, xolotlRevision, latestVersions] = await Promise.all([
    probeVersion('claude'),
    probeVersion('gemini'),
    probeVersion('codex'),
    probeVersion('cursor-agent'),
    probeStrataVersion(await getStrataBase()),
    installedXolotlRevision(await getDeepSeekBase()),
    probeLatestVersions(),
  ]);

  return { efforts, models: MODELS, cliVersion, geminiVersion, codexVersion, cursorVersion, strataVersion, xolotlRevision, latestVersions };
}

// ── Upstream latest-version probes ──
//
// Source of truth for "is the operator running the latest CLI?" The three
// npm-installed CLIs query the registry directly; Ollama queries GitHub
// Releases since it's not npm-installed. All four are best-effort: any
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
  // Installed runtimes can change outside Archon. Refresh on demand without
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

export async function probeLatestVersions(): Promise<Capabilities['latestVersions']> {
  const [claude, gemini, codex, ollama, strata, xolotl] = await Promise.all([
    npmLatest('@anthropic-ai/claude-code'),
    npmLatest('@google/gemini-cli'),
    npmLatest('@openai/codex'),
    ollamaLatestRelease(),
    strataLatestRelease(),
    fetchJson('https://api.github.com/repos/Indras-Mirror/Xolotl/commits/HEAD').then((data) => {
      const sha = (data as { sha?: unknown } | null)?.sha;
      return typeof sha === 'string' && /^[a-f0-9]{40}$/.test(sha) ? sha : undefined;
    }),
  ]);
  return { claude, gemini, codex, ollama, strata, xolotl };
}

export interface UpdateResult {
  provider: CliProvider;
  updated: boolean;
  previousVersion: string;
  currentVersion: string;
  capabilities: Capabilities;
  output: string;
  // Set when the update command exited but left no working binary behind.
  // The client renders this instead of a bogus version transition.
  error?: string;
  // Deterministic explanation for a non-obvious outcome — most often "latest
  // has no build for this platform yet, so we installed the newest one that
  // does". Present on success too; `error` is reserved for failure.
  notice?: string;
}

// Claude ships a true self-updater (`claude update`). Gemini and Codex are
// typically installed via npm and don't expose one, so we fall back to
// `npm install -g <pkg>@latest`. If the operator installed via another
// mechanism (pipx, homebrew, curl script), that command fails and the error
// surfaces in the UI — they can update manually.
const UPDATE_COMMAND: Record<CliProvider, { cmd: string; args: string[] }> = {
  claude: { cmd: 'claude', args: ['update'] },
  gemini: { cmd: 'npm', args: ['install', '-g', '@google/gemini-cli@latest'] },
  codex: { cmd: 'npm', args: ['install', '-g', '@openai/codex@latest'] },
};

// npm package behind each CLI, for the pre-flight platform-build check. Claude
// is absent on purpose: it self-updates via `claude update`, so there is no
// `npm install` for us to aim at a specific version.
const NPM_PACKAGE: Partial<Record<CliProvider, string>> = {
  gemini: '@google/gemini-cli',
  codex: '@openai/codex',
};

function versionForProvider(caps: Capabilities, provider: CliProvider): string {
  if (provider === 'claude') return caps.cliVersion;
  if (provider === 'gemini') return caps.geminiVersion ?? 'unknown';
  return caps.codexVersion ?? 'unknown';
}

/**
 * Run the update command for the given CLI provider. Claude uses its built-in
 * self-updater; Gemini/Codex fall back to `npm install -g …@latest`. Re-probes
 * capabilities after so callers get the refreshed version strings.
 */
export async function runCliUpdate(previous: Capabilities, provider: CliProvider = 'claude'): Promise<UpdateResult> {
  const previousVersion = versionForProvider(previous, provider);

  // Pre-flight: for npm-installed CLIs, work out which version can actually run
  // on this machine before installing anything. `@latest` is not automatically
  // installable — a package whose binary ships as a platform-specific
  // optionalDependency is broken-on-arrival during the window between the
  // wrapper being tagged `latest` and that platform's tarball being published,
  // and npm reports that as success. See npmPlatformResolve.ts.
  const pkg = NPM_PACKAGE[provider];
  let notice: string | null = null;
  let { cmd, args } = UPDATE_COMMAND[provider];

  if (pkg) {
    // A null resolution means the registry was unreachable; fall through to the
    // plain `@latest` command rather than blocking an update on a network blip.
    const resolved = await resolveInstallableVersion(pkg);
    if (resolved) {
      notice = resolved.notice;
      args = ['install', '-g', `${pkg}@${resolved.version}`];
      // Already on the version we would install, and it runs — skip the install
      // entirely so a no-op click can't churn a working CLI into a broken one.
      if (resolved.version === previousVersion && previousVersion !== 'broken' && previousVersion !== 'unknown') {
        return {
          provider,
          updated: false,
          previousVersion,
          currentVersion: previousVersion,
          capabilities: previous,
          output: `${pkg}@${previousVersion} is already installed`,
          ...(notice ? { notice } : {}),
        };
      }
    }
  }

  let output = await runUpdateCommand(cmd, args);
  let next = await probeCapabilities();
  let currentVersion = versionForProvider(next, provider);

  // Post-flight repair. The pre-flight check closes the common case, but npm can
  // still skip an optional dep that does exist (a mid-install network failure,
  // a poisoned cache), and that also exits 0. One retry with a clean cache is
  // cheap next to leaving the operator's CLI dead.
  if ((currentVersion === 'broken' || currentVersion === 'unknown') && pkg) {
    const repairArgs = [...args, '--force'];
    output += `\n\n[archon] ${provider} did not run after the update — retrying: npm ${repairArgs.join(' ')}`;
    output += `\n${await runUpdateCommand('npm', repairArgs)}`;
    next = await probeCapabilities();
    currentVersion = versionForProvider(next, provider);
  }

  // A post-update probe that can't report a version means the command left the
  // CLI unusable, however cleanly it exited. Deciding `updated` purely on the
  // version string differing is how a silently-failed `npm install -g` surfaced
  // in the popover as a cheerful "→ vunknown" (2026-09-03, codex): npm skipped
  // the platform binary, exited 0, and 'unknown' !== '0.153.1' read as success.
  if (currentVersion === 'broken' || currentVersion === 'unknown') {
    return {
      provider,
      updated: false,
      previousVersion,
      currentVersion,
      capabilities: next,
      output,
      error: (await probeFailureReason(provider)) ?? `${provider} did not run after the update`,
      ...(notice ? { notice } : {}),
    };
  }

  return {
    provider,
    updated: currentVersion !== previousVersion,
    previousVersion,
    currentVersion,
    capabilities: next,
    output,
    ...(notice ? { notice } : {}),
  };
}

// Run an update command, folding a non-zero exit into the captured output — the
// caller decides success from whether the CLI runs afterwards, never from the
// exit code (npm exits 0 on a skipped optional dep).
async function runUpdateCommand(cmd: string, args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      maxBuffer: 4 * 1024 * 1024,
      timeout: 180_000,
    });
    return (stdout + stderr).trim();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

// ── CLI help snapshots + change detection ──
//
// On boot we snapshot each CLI's help surface and diff against the last
// snapshot. If anything changed (new version or new flags) we surface a
// toast in the UI so the operator isn't left discovering new CLI features
// by accident. Snapshots live at `~/.archon/cli-snapshots/`.

const SNAPSHOT_DIR = join(archonHome(), 'cli-snapshots');

const HELP_PROBES: Record<CliProvider, string[][]> = {
  claude: [['--help'], ['config', '--help'], ['mcp', '--help']],
  gemini: [['--help']],
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
    const { stdout } = await execFileAsync(bin, args, { maxBuffer: 2 * 1024 * 1024 });
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
 * snapshot + a dated diff file under ~/.archon/cli-snapshots/ and returns
 * a CliChange entry. First-run providers (no prior snapshot) seed a
 * baseline silently and are NOT reported as changes.
 */
export async function detectCliChanges(caps: Capabilities): Promise<CliChange[]> {
  const providers: CliProvider[] = ['claude', 'gemini', 'codex'];
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
      console.warn(`[archon] failed to write CLI diff ${diffFileName}:`, err);
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
