// Phase 7a — Claude-Code-style settings.json hooks for Native transport.
//
// Discovery: walk up from cfg.cwd collecting `.claude/settings.json` at
// each level (project hooks); also read ~/.claude/settings.json (user-
// level). Project hooks take precedence over user hooks. Cached on the
// worker; refreshed on ensureStarted (operators can pick up edits by
// closing/reopening the tab).
//
// Events honored in 7a: PreToolUse, PostToolUse, UserPromptSubmit, Stop,
// SubagentStop (call site wired but never fires until 7b's Task lands),
// Notification, PreCompact (documented no-op pass-through). Non-zero
// exit blocks PreToolUse / UserPromptSubmit; other events' exit codes
// are informational. 30s default timeout; per-hook override via
// `timeout` field. SIGTERM then SIGKILL after 2s grace (on Windows the
// process tree ends at once through taskkill).
//
// How a command hook runs, as in Claude Code:
// - Exec form (`args` set): `command` is started directly with `args` as its
//   arguments, no shell, on every OS. ${CLAUDE_PROJECT_DIR} in `command` and
//   in each argument is replaced by the project folder as plain text.
// - Shell form (no `args`): the shell is the hook's `shell` field ("bash" or
//   "powershell") when set, else commandShell(): /bin/sh on Linux and macOS,
//   Git Bash on Windows, PowerShell on Windows without Git Bash. In a
//   PowerShell command the ${CLAUDE_PROJECT_DIR}, ${CLAUDE_PLUGIN_ROOT} and
//   ${CLAUDE_PLUGIN_DATA} placeholders become ${env:NAME}.
// A hook that cannot start (no shell, or a spawn error) does not run and does
// not block: its result carries `notRun` with the reason, and the worker shows
// a notice. A hook run in PowerShell only because Git Bash is missing carries
// `shellNotice`, shown once as information.
//
// CLAUDE_PROJECT_DIR is set to cfg.cwd; the per-event JSON payload is
// passed on stdin. Subprocess inherits the worker's env minus
// ARCO_*-prefixed debug vars (which would leak Arco-internal flags
// into hook scripts).

import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import type { ShellRegistry } from './tools.js';
import { hookShell, shellInvocation } from '../../commandShell.js';
import { shellChildSpawnOptions, signalChildTree } from '../../workers/processKill.js';

export type HookEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'UserPromptSubmit'
  | 'Stop'
  | 'SubagentStop'
  | 'Notification'
  | 'PreCompact';

export interface HookSpec {
  matcher?: string; // glob-like; for PreToolUse/PostToolUse this matches tool name
  hooks: HookCommand[];
}

export interface HookCommand {
  type: 'command';
  command: string;
  timeout?: number; // seconds, per Claude Code's documented field
  args?: string[]; // exec form: `command` is the program, no shell
  shell?: 'bash' | 'powershell'; // shell form only; ignored with `args`
}

interface HookSettings {
  hooks?: Partial<Record<HookEvent, HookSpec[]>>;
}

export interface HookConfig {
  byEvent: Partial<Record<HookEvent, HookSpec[]>>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const SIGKILL_GRACE_MS = 2_000;

async function readSettingsFile(path: string): Promise<HookSettings | null> {
  try {
    const buf = await fs.readFile(path, 'utf8');
    const parsed = JSON.parse(buf) as HookSettings;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

// Walk-up + ~/.claude. Project (cwd-side) hooks take precedence over
// user (~/.claude). When the same event has hooks at multiple levels,
// project hooks fire first; both fire (matcher-permitting). Closest-to-
// cwd wins ordering only; we don't dedupe by command string.
//
// `includeProject: false` (DD7 — untrusted repo) reads ONLY the user-level
// file: a project `.claude/settings.json` hook is arbitrary code run as the
// operator, the same cloned-repo vector DD7 closes for CLAUDE.md / skills.
// The walk-up's $HOME level IS the user file, so it is skipped there and read
// once below (it used to be collected twice for any cwd under $HOME, firing
// every user hook twice).
export async function discoverHooks(
  cwd: string,
  opts?: { includeProject?: boolean; homeDir?: string },
): Promise<HookConfig & { suppressedProjectFiles: string[] }> {
  const includeProject = opts?.includeProject !== false;
  const home = resolve(opts?.homeDir ?? homedir());
  const userPath = join(home, '.claude', 'settings.json');
  const collected: HookSettings[] = [];
  const suppressedProjectFiles: string[] = [];
  if (cwd) {
    let dir = resolve(cwd);
    for (let i = 0; i < 64; i++) {
      const path = join(dir, '.claude', 'settings.json');
      if (path !== userPath) {
        const data = await readSettingsFile(path);
        if (data?.hooks && !includeProject) suppressedProjectFiles.push(path);
        else if (data) collected.push(data);
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  const userData = await readSettingsFile(userPath);
  if (userData) collected.push(userData);

  const merged: HookConfig = { byEvent: {} };
  for (const settings of collected) {
    if (!settings.hooks) continue;
    for (const [event, specs] of Object.entries(settings.hooks) as Array<[HookEvent, HookSpec[]]>) {
      if (!Array.isArray(specs)) continue;
      const dest = merged.byEvent[event] ?? [];
      dest.push(...specs);
      merged.byEvent[event] = dest;
    }
  }
  return { ...merged, suppressedProjectFiles };
}

function matcherMatches(matcher: string | undefined, target: string): boolean {
  if (!matcher || matcher === '*') return true;
  // Claude Code's matcher is regex-flavored for tool names.
  try {
    return new RegExp(`^(?:${matcher})$`).test(target);
  } catch {
    return matcher === target;
  }
}

function scrubEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('ARCO_')) continue;
    out[k] = v;
  }
  return out;
}

interface RunOpts {
  cwd: string;
  abortSignal: AbortSignal;
  shells: ShellRegistry;
  // Stamped onto the hook subprocess's env so blocking hooks can write
  // structured replies if a future revision needs them. Not load-bearing
  // in 7a.
  workflowId?: string;
}

export interface HookFireResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  // docs/PROVIDERS.md - hook command that produced this result.
  // Used by the worker to label `hook_rewrote_input` events so transcript
  // review can attribute a rewrite back to its origin (e.g. rtk vs. a
  // bespoke project hook).
  command?: string;
  // Set when the hook did not run (no shell, or it could not start). Such a
  // result never blocks; the text says why, for the operator's notice.
  notRun?: string;
  // Set when the hook ran in PowerShell only because Git Bash is missing on
  // Windows: information for the operator, not an error.
  shellNotice?: string;
}

// docs/PROVIDERS.md - Claude Code's documented hook stdout shape.
// Tolerant: non-JSON stdout returns {}, malformed JSON also returns {}.
// Never throws. The fields we care about today:
//   - hookSpecificOutput.updatedInput: PreToolUse rewrite of the tool input
//   - hookSpecificOutput.additionalContext: PostToolUse extra system block
//   - hookSpecificOutput.permissionDecision: 'allow'|'deny'|'ask'
//   - decision: 'block' (legacy/older shape — model retries on PostToolUse)
//   - reason: human-readable for surfacing to the operator
// We accept any string as the parser's input; only well-formed JSON whose
// top level is an object yields fields. Anything else → empty object.
export interface ParsedHookOutput {
  hookSpecificOutput?: {
    permissionDecision?: 'allow' | 'deny' | 'ask';
    updatedInput?: Record<string, unknown>;
    additionalContext?: string;
  };
  decision?: 'block';
  reason?: string;
}

export function parseHookOutput(stdout: string): ParsedHookOutput {
  const trimmed = stdout.trim();
  if (!trimmed) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const obj = parsed as Record<string, unknown>;
  const out: ParsedHookOutput = {};
  const hso = obj.hookSpecificOutput;
  if (hso && typeof hso === 'object' && !Array.isArray(hso)) {
    const h = hso as Record<string, unknown>;
    const inner: NonNullable<ParsedHookOutput['hookSpecificOutput']> = {};
    if (h.permissionDecision === 'allow' || h.permissionDecision === 'deny' || h.permissionDecision === 'ask') {
      inner.permissionDecision = h.permissionDecision;
    }
    if (h.updatedInput && typeof h.updatedInput === 'object' && !Array.isArray(h.updatedInput)) {
      inner.updatedInput = h.updatedInput as Record<string, unknown>;
    }
    if (typeof h.additionalContext === 'string') {
      inner.additionalContext = h.additionalContext;
    }
    if (Object.keys(inner).length > 0) out.hookSpecificOutput = inner;
  }
  if (obj.decision === 'block') out.decision = 'block';
  if (typeof obj.reason === 'string') out.reason = obj.reason;
  return out;
}

const POWERSHELL_PLACEHOLDER = /\$\{(CLAUDE_PROJECT_DIR|CLAUDE_PLUGIN_ROOT|CLAUDE_PLUGIN_DATA)\}/g;

/** Claude Code's rewrite of path placeholders in a PowerShell shell-form command. */
export function powerShellPlaceholders(command: string): string {
  return command.replace(POWERSHELL_PLACEHOLDER, '${env:$1}');
}

type HookLaunch =
  | { ok: true; file: string; args: string[]; cleanup: () => void; exec: boolean; shellNotice?: string }
  | { ok: false; problem: string };

/** What to start for a hook: exec form when `args` is set, else its shell. */
export function hookLaunch(hook: HookCommand, projectDir: string): HookLaunch {
  if (hook.args !== undefined) {
    if (!Array.isArray(hook.args) || !hook.args.every((a) => typeof a === 'string')) {
      return { ok: false, problem: 'The hook\'s "args" must be a list of strings.' };
    }
    const fill = (v: string): string => v.split('${CLAUDE_PROJECT_DIR}').join(projectDir);
    return { ok: true, file: fill(hook.command), args: hook.args.map(fill), cleanup: () => {}, exec: true };
  }
  const requested = hook.shell === 'bash' || hook.shell === 'powershell' ? hook.shell : undefined;
  const shell = hookShell(requested);
  if (!shell.ok) return { ok: false, problem: shell.problem };
  const command = shell.kind === 'powershell' ? powerShellPlaceholders(hook.command) : hook.command;
  return { ok: true, ...shellInvocation(shell, command), exec: false, ...(shell.notice ? { shellNotice: shell.notice } : {}) };
}

function startFailure(err: Error, launch: { file: string; exec: boolean }): string {
  const code = (err as NodeJS.ErrnoException).code;
  if (launch.exec && code === 'ENOENT' && !/[\\/]/.test(launch.file) && /\s/.test(launch.file)) {
    return `The hook could not start: ${err.message}. With "args" set, "command" is only the program; move its arguments into "args".`;
  }
  if (launch.exec && process.platform === 'win32' && (code === 'EINVAL' || /\.(cmd|bat)$/i.test(launch.file))) {
    return `The hook could not start: ${err.message}. In exec form on Windows, "command" must be a real program such as node.exe; run a .cmd or .bat file in shell form instead.`;
  }
  return `The hook could not start: ${err.message}`;
}

async function runHookOnce(
  hook: HookCommand,
  payload: unknown,
  timeoutMs: number,
  opts: RunOpts,
): Promise<HookFireResult> {
  const launch = hookLaunch(hook, opts.cwd);
  if (!launch.ok) return { exitCode: 0, stdout: '', stderr: '', timedOut: false, notRun: launch.problem };
  const shellNotice = launch.shellNotice;
  return new Promise<HookFireResult>((resolveResult) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(launch.file, launch.args, {
        cwd: opts.cwd,
        env: { ...scrubEnv(), CLAUDE_PROJECT_DIR: opts.cwd },
        stdio: ['pipe', 'pipe', 'pipe'],
        ...shellChildSpawnOptions(),
      });
    } catch (err) {
      launch.cleanup();
      resolveResult({ exitCode: 0, stdout: '', stderr: '', timedOut: false, notRun: startFailure(err as Error, launch) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killTimer: NodeJS.Timeout | null = null;
    const killTree = (sig: NodeJS.Signals): void => signalChildTree(child, sig);
    const timer = setTimeout(() => {
      timedOut = true;
      killTree('SIGTERM');
      killTimer = setTimeout(() => killTree('SIGKILL'), SIGKILL_GRACE_MS);
    }, timeoutMs);
    const onAbort = (): void => killTree('SIGKILL');
    if (opts.abortSignal.aborted) onAbort();
    else opts.abortSignal.addEventListener('abort', onAbort, { once: true });

    // Register against the per-turn shell map so cancel + KillShell
    // tear in-flight hooks down. Idempotent on natural exit.
    const shellId = opts.shells.mintId();
    opts.shells.byId.set(shellId, { kill: () => killTree('SIGKILL'), backgrounded: false });

    child.stdout?.on('data', (b: Buffer) => { stdout += b.toString('utf8'); });
    child.stderr?.on('data', (b: Buffer) => { stderr += b.toString('utf8'); });
    child.on('error', (err) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      opts.abortSignal.removeEventListener('abort', onAbort);
      opts.shells.byId.delete(shellId);
      launch.cleanup();
      // The hook could not start, so it did not run and does not block.
      resolveResult({ exitCode: 0, stdout, stderr, timedOut: false, notRun: startFailure(err, launch) });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      opts.abortSignal.removeEventListener('abort', onAbort);
      opts.shells.byId.delete(shellId);
      launch.cleanup();
      const exitCode = code === null ? (signal === 'SIGKILL' || signal === 'SIGTERM' ? 137 : 1) : code;
      resolveResult({ exitCode, stdout, stderr, timedOut, ...(shellNotice ? { shellNotice } : {}) });
    });

    // A hook may exit without reading its input (`exit 2` to block). Writing
    // to the closed pipe then fails asynchronously with EPIPE as an 'error'
    // event on stdin, which the try/catch cannot see and which would crash
    // the server if unhandled. The hook's own exit code and output arrive
    // through 'close' as usual, so the write error is only swallowed here.
    child.stdin?.on('error', () => { /* EPIPE or ECONNRESET from an early exit */ });
    try {
      child.stdin?.write(JSON.stringify(payload));
      child.stdin?.end();
    } catch {
      /* the pipe close path will surface the failure */
    }
  });
}

export async function fireHooks(
  config: HookConfig,
  event: HookEvent,
  matcherTarget: string,
  payload: unknown,
  opts: RunOpts,
): Promise<HookFireResult[]> {
  const specs = config.byEvent[event];
  if (!specs || specs.length === 0) return [];
  const results: HookFireResult[] = [];
  for (const spec of specs) {
    if (!matcherMatches(spec.matcher, matcherTarget)) continue;
    for (const hook of spec.hooks) {
      if (hook.type !== 'command' || !hook.command) continue;
      const timeoutMs = (hook.timeout ?? DEFAULT_TIMEOUT_MS / 1000) * 1000;
      const result = await runHookOnce(hook, payload, timeoutMs, opts);
      results.push({ ...result, command: hook.command });
    }
  }
  return results;
}

// PreToolUse / UserPromptSubmit: any non-zero exit blocks. Returns the
// first blocking result so the caller can surface stderr.
export function firstBlocking(results: HookFireResult[]): HookFireResult | null {
  for (const r of results) {
    if (r.notRun) continue;
    if (r.exitCode !== 0 || r.timedOut) return r;
  }
  return null;
}
