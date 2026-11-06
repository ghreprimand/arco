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
import { commandShell, hookShell, shellInvocation } from '../../commandShell.js';
import { shellChildSpawnOptions, signalChildTree } from '../../workers/processKill.js';

export type HookEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
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
  async?: boolean; // run in the background; output reaches the model next turn
  asyncRewake?: boolean; // background; exit 2 wakes the model with stderr
  onFailure?: 'continue' | 'block'; // whether a failed hook lets the action go ahead
}

interface HookSettings {
  hooks?: Partial<Record<HookEvent, HookSpec[]>>;
}

export interface HookConfig {
  byEvent: Partial<Record<HookEvent, HookSpec[]>>;
}

// Claude Code's defaults: 600 s for command hooks, 30 s on UserPromptSubmit.
const DEFAULT_TIMEOUT_S = 600;
const USER_PROMPT_TIMEOUT_S = 30;
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

// Claude Code's matcher rules: "*", "" or none match everything; only
// letters, digits, _, -, spaces, "," and "|" is an exact name or a list of
// names; anything else is an unanchored JavaScript regular expression.
export function matcherMatches(matcher: string | undefined, target: string): boolean {
  if (matcher === undefined || matcher === null || matcher === '' || matcher === '*') return true;
  if (typeof matcher !== 'string') return false;
  if (/^[A-Za-z0-9_\- ,|]+$/.test(matcher)) {
    return matcher.split(/[|,]/).map((m) => m.trim()).filter(Boolean).includes(target);
  }
  try {
    return new RegExp(matcher).test(target);
  } catch {
    return false;
  }
}

// Events whose matcher Claude Code ignores: they fire on every occurrence.
const NO_MATCHER_EVENTS = new Set<HookEvent>(['UserPromptSubmit', 'Stop']);

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
  // Background hooks (async / asyncRewake) are not tied to the turn: they end
  // with this signal (the worker's lifetime) and report through onBackground.
  backgroundSignal?: AbortSignal;
  onBackground?: (done: BackgroundHookDone) => void;
}

export interface BackgroundHookDone {
  event: HookEvent;
  target: string;
  hook: HookCommand;
  result: HookFireResult;
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
  // The handler that ran.
  hook?: HookCommand;
  // Windows without Git Bash, shell form: Claude Code counts only exit 0 or 2
  // as a PreToolUse hook's verdict there, so a failure blocks unless the hook
  // sets onFailure.
  strictFailure?: boolean;
  // async / asyncRewake: started in the background, not awaited.
  background?: boolean;
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
  const strictFailure = hook.args === undefined && gitBashMissing();
  const meta = { hook, ...(strictFailure ? { strictFailure } : {}) };
  const launch = hookLaunch(hook, opts.cwd);
  if (!launch.ok) return { exitCode: 0, stdout: '', stderr: '', timedOut: false, notRun: launch.problem, ...meta };
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
      resolveResult({ exitCode: 0, stdout: '', stderr: '', timedOut: false, notRun: startFailure(err as Error, launch), ...meta });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killTimer: NodeJS.Timeout | null = null;
    const killTree = (sig: NodeJS.Signals): void => signalChildTree(child, sig);
    // An async hook has no timeout (Claude Code does not enforce one).
    const timer = Number.isFinite(timeoutMs) ? setTimeout(() => {
      timedOut = true;
      killTree('SIGTERM');
      killTimer = setTimeout(() => killTree('SIGKILL'), SIGKILL_GRACE_MS);
    }, timeoutMs) : undefined;
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
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      opts.abortSignal.removeEventListener('abort', onAbort);
      opts.shells.byId.delete(shellId);
      launch.cleanup();
      // The hook could not start, so it did not run and does not block.
      resolveResult({ exitCode: 0, stdout, stderr, timedOut: false, notRun: startFailure(err, launch), ...meta });
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      opts.abortSignal.removeEventListener('abort', onAbort);
      opts.shells.byId.delete(shellId);
      launch.cleanup();
      const exitCode = code === null ? (signal === 'SIGKILL' || signal === 'SIGTERM' ? 137 : 1) : code;
      resolveResult({ exitCode, stdout, stderr, timedOut, ...meta, ...(shellNotice ? { shellNotice } : {}) });
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

// True on Windows when Git Bash is missing (commandShell() fell back to
// PowerShell, or found no shell at all).
function gitBashMissing(): boolean {
  const shell = commandShell();
  return !shell.ok || (shell.kind === 'powershell' && shell.notice !== undefined);
}

function handlerKey(hook: HookCommand): string {
  return JSON.stringify([hook.command, hook.args ?? null, hook.shell ?? null, !!hook.async, !!hook.asyncRewake]);
}

// Runs the command hooks for `event` whose matcher fits `matcherTarget`, as
// Claude Code does: matching handlers run in parallel, an identical handler
// defined in more than one settings file runs once, async and asyncRewake
// handlers start in the background and are not waited for.
export async function fireHooks(
  config: HookConfig,
  event: HookEvent,
  matcherTarget: string,
  payload: unknown,
  opts: RunOpts,
): Promise<HookFireResult[]> {
  const specs = config.byEvent[event];
  if (!Array.isArray(specs) || specs.length === 0) return [];
  const seen = new Set<string>();
  const handlers: HookCommand[] = [];
  for (const spec of specs) {
    if (!spec || !Array.isArray(spec.hooks)) continue;
    if (!NO_MATCHER_EVENTS.has(event) && !matcherMatches(spec.matcher, matcherTarget)) continue;
    for (const hook of spec.hooks) {
      if (!hook || hook.type !== 'command' || typeof hook.command !== 'string' || !hook.command) continue;
      const key = handlerKey(hook);
      if (seen.has(key)) continue;
      seen.add(key);
      handlers.push(hook);
    }
  }
  const input = payload && typeof payload === 'object' ? { ...(payload as Record<string, unknown>), hook_event_name: event } : payload;
  const defaultS = event === 'UserPromptSubmit' ? USER_PROMPT_TIMEOUT_S : DEFAULT_TIMEOUT_S;
  return Promise.all(handlers.map(async (hook): Promise<HookFireResult> => {
    const seconds = typeof hook.timeout === 'number' && hook.timeout > 0 ? hook.timeout : defaultS;
    if (hook.async === true || hook.asyncRewake === true) {
      const bg: RunOpts = { ...opts, abortSignal: opts.backgroundSignal ?? new AbortController().signal };
      void runHookOnce(hook, input, hook.asyncRewake === true ? seconds * 1000 : Infinity, bg)
        .then((result) => opts.onBackground?.({ event, target: matcherTarget, hook, result: { ...result, command: hook.command } }))
        .catch(() => { /* reported through the result */ });
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false, command: hook.command, hook, background: true };
    }
    const result = await runHookOnce(hook, input, seconds * 1000, opts);
    return { ...result, command: hook.command };
  }));
}

// ── Reading the results, as Claude Code's hooks reference describes ──────────
//
// Exit 0: the JSON object on stdout applies; plain text is success (and, on
// UserPromptSubmit, context for the model). Exit 2: a blocking error on events
// that can block; stderr is the reason unless the JSON makes a blocking
// decision with its own. Any other exit: a non-blocking error shown to the
// operator, unless stdout is a valid JSON object, whose fields then decide.
// A failure (cannot start, exit other than 0 or 2, timeout, invalid JSON)
// blocks only with onFailure "block", or for a shell-form PreToolUse hook on
// Windows without Git Bash when onFailure is unset.

export type HookJson = Record<string, unknown>;

export interface HookBlock {
  // How the hook blocked: exit 2, a JSON decision, or a failure turned into a block.
  via: 'exit2' | 'decision' | 'failure';
  reason: string;
  command: string;
}

export interface HookVerdict {
  blocks: HookBlock[];
  // PreToolUse permission decision after precedence (deny > ask > allow).
  permission?: 'deny' | 'ask' | 'allow';
  permissionReason?: string;
  updatedInput?: Record<string, unknown>;
  // additionalContext, and on UserPromptSubmit plain-text stdout.
  context: string[];
  // systemMessage: shown to the operator.
  systemMessages: string[];
  // Non-blocking errors and ignored fields: shown to the operator.
  notices: string[];
  // continue: false, with its stopReason.
  stop?: { reason: string };
  updatedToolOutput?: unknown;
  suppressOriginalPrompt?: boolean;
  // Hooks that ran (not background, not skipped), for attribution.
  rewrites: Array<{ command: string; input: Record<string, unknown> }>;
}

// Events where exit 2 and blocking decisions take effect.
// PostToolUse and PostToolUseFailure cannot undo the tool; their exit 2 and
// "block" reasons go to the model next to the result.
const BLOCKING_EVENTS = new Set<HookEvent>(['PreToolUse', 'UserPromptSubmit', 'Stop', 'SubagentStop', 'PostToolUse', 'PostToolUseFailure', 'PreCompact']);
// onFailure has no effect on these.
const NO_ON_FAILURE = new Set<HookEvent>(['Stop', 'SubagentStop']);

export function readHookStdout(stdout: string): { json?: HookJson; plain?: string; parseError?: string } {
  const t = stdout.trim();
  if (!t) return {};
  if (!(t.startsWith('{') && t.endsWith('}'))) return { plain: t };
  try {
    const v = JSON.parse(t) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) return { json: v as HookJson };
    return { parseError: 'the output is not a JSON object' };
  } catch (err) {
    return { parseError: err instanceof Error ? err.message : String(err) };
  }
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/)[0]?.slice(0, 500) ?? '';
}

function hookLabel(event: HookEvent, target: string): string {
  return NO_MATCHER_EVENTS.has(event) ? event : `${event}:${target}`;
}

export function evaluateHooks(event: HookEvent, target: string, results: HookFireResult[]): HookVerdict {
  const v: HookVerdict = { blocks: [], context: [], systemMessages: [], notices: [], rewrites: [] };
  const label = hookLabel(event, target);
  const canBlock = BLOCKING_EVENTS.has(event);
  let deny: string | undefined;
  let ask: string | undefined;
  let allow = false;
  for (const r of results) {
    if (r.background) continue;
    const command = r.command ?? '';
    const where = `${label} hook error: [${command}]`;
    // Failures, and what they turn into.
    let failure: string | null = null;
    if (r.notRun) failure = `failed: ${r.notRun}`;
    else if (r.timedOut) failure = 'timed out';
    const out = r.notRun || r.timedOut ? {} : readHookStdout(r.stdout);
    if (!failure && out.parseError && r.exitCode !== 2) failure = `failed: the output is not valid JSON (${out.parseError})`;
    if (!failure && r.exitCode !== 0 && r.exitCode !== 2) failure = 'failed';
    if (failure) {
      const hook = r.hook ?? ({} as HookCommand);
      const blockWhy = NO_ON_FAILURE.has(event) || !canBlock ? null
        : hook.onFailure === 'block' ? 'onFailure is "block"'
          : hook.onFailure === undefined && r.strictFailure && event === 'PreToolUse' ? 'Git Bash wasn\'t found, so only exit code 0 or 2 counts as this hook\'s verdict'
            : null;
      const word = r.timedOut ? 'timed out' : 'failed';
      if (blockWhy) {
        const detail = r.notRun ?? (r.stderr.trim() || (out.parseError ? `invalid JSON output: ${out.parseError}` : ''));
        v.blocks.push({ via: 'failure', command, reason: `${word}; blocking because ${blockWhy}.${detail ? `\n${detail.slice(0, 1000)}` : ''}` });
        continue;
      }
      // A valid JSON object with an exit other than 0 or 2 still decides.
      if (!(out.json && !r.notRun && !r.timedOut)) {
        if (r.notRun) { /* reported by the worker's not-run notice */ }
        else if (r.timedOut) v.notices.push(`${where}: timed out; its output was discarded.`);
        else if (out.parseError) v.notices.push(`${where}: the output is not valid JSON (${out.parseError}).`);
        else v.notices.push(`${where}: Failed with non-blocking status code ${r.exitCode}: ${firstLine(r.stderr) || '(no stderr)'}`);
        continue;
      }
    }
    const json = out.json;
    if (r.exitCode === 0 && out.plain && event === 'UserPromptSubmit') v.context.push(out.plain);
    let jsonBlockReason: string | undefined;
    if (json) {
      if (json.continue === false) v.stop = { reason: typeof json.stopReason === 'string' ? json.stopReason : '' };
      if (typeof json.systemMessage === 'string' && json.systemMessage) v.systemMessages.push(json.systemMessage);
      const hso = json.hookSpecificOutput && typeof json.hookSpecificOutput === 'object' && !Array.isArray(json.hookSpecificOutput)
        ? json.hookSpecificOutput as Record<string, unknown> : undefined;
      if (typeof hso?.additionalContext === 'string' && hso.additionalContext) v.context.push(hso.additionalContext);
      const topReason = typeof json.reason === 'string' ? json.reason : undefined;
      if (event === 'PreToolUse') {
        const pd = hso?.permissionDecision ?? (json.decision === 'approve' ? 'allow' : json.decision === 'block' ? 'deny' : undefined);
        const pr = typeof hso?.permissionDecisionReason === 'string' ? hso.permissionDecisionReason : topReason;
        if (pd === 'deny') { deny ??= pr ?? 'denied by a PreToolUse hook'; jsonBlockReason = deny; }
        else if (pd === 'ask') ask ??= pr ?? 'a PreToolUse hook asks for confirmation';
        else if (pd === 'allow') allow = true;
        else if (pd === 'defer') v.notices.push(`${where}: "defer" works only in non-interactive mode, so it was ignored.`);
        const ui = hso?.updatedInput;
        if (r.exitCode !== 2 && ui && typeof ui === 'object' && !Array.isArray(ui)) {
          v.updatedInput = ui as Record<string, unknown>;
          v.rewrites.push({ command, input: v.updatedInput });
        }
      } else if (json.decision === 'block') {
        jsonBlockReason = topReason ?? `${event} hook blocked`;
        if (canBlock && r.exitCode !== 2) v.blocks.push({ via: 'decision', command, reason: jsonBlockReason });
      }
      if (event === 'PostToolUse' && hso && 'updatedToolOutput' in hso) v.updatedToolOutput = hso.updatedToolOutput;
      if (event === 'UserPromptSubmit' && hso?.suppressOriginalPrompt === true) v.suppressOriginalPrompt = true;
    }
    if (r.exitCode === 2 && canBlock) {
      v.blocks.push({ via: 'exit2', command, reason: jsonBlockReason ?? (r.stderr.trim() || 'exit code 2') });
    }
  }
  if (deny !== undefined) { v.permission = 'deny'; v.permissionReason = deny; }
  else if (ask !== undefined) { v.permission = 'ask'; v.permissionReason = ask; }
  else if (allow) v.permission = 'allow';
  return v;
}

// Kept for callers that only need to know whether anything blocked.
export function firstBlocking(results: HookFireResult[], event: HookEvent = 'PreToolUse', target = ''): HookBlock | null {
  const v = evaluateHooks(event, target, results);
  if (v.blocks[0]) return v.blocks[0];
  return v.permission === 'deny' ? { via: 'decision', command: '', reason: v.permissionReason ?? '' } : null;
}
