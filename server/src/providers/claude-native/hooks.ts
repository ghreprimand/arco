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
// `timeout` field. SIGTERM then SIGKILL after 2s grace.
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
  hooks: Array<{
    type: 'command';
    command: string;
    timeout?: number; // seconds, per Claude Code's documented field
  }>;
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

async function runHookOnce(
  command: string,
  payload: unknown,
  timeoutMs: number,
  opts: RunOpts,
): Promise<HookFireResult> {
  return new Promise<HookFireResult>((resolveResult) => {
    const child = spawn('/bin/sh', ['-c', command], {
      cwd: opts.cwd,
      env: { ...scrubEnv(), CLAUDE_PROJECT_DIR: opts.cwd },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killTimer: NodeJS.Timeout | null = null;
    const killTree = (sig: NodeJS.Signals): void => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch { /* gone */ }
    };
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
      resolveResult({ exitCode: 127, stdout, stderr: stderr + `\n[hook spawn error] ${err.message}`, timedOut: false });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      opts.abortSignal.removeEventListener('abort', onAbort);
      opts.shells.byId.delete(shellId);
      const exitCode = code === null ? (signal === 'SIGKILL' || signal === 'SIGTERM' ? 137 : 1) : code;
      resolveResult({ exitCode, stdout, stderr, timedOut });
    });

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
      const result = await runHookOnce(hook.command, payload, timeoutMs, opts);
      results.push({ ...result, command: hook.command });
    }
  }
  return results;
}

// PreToolUse / UserPromptSubmit: any non-zero exit blocks. Returns the
// first blocking result so the caller can surface stderr.
export function firstBlocking(results: HookFireResult[]): HookFireResult | null {
  for (const r of results) {
    if (r.exitCode !== 0 || r.timedOut) return r;
  }
  return null;
}
