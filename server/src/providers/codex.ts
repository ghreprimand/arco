import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { statSync, readFileSync } from 'fs';
import { extname, join } from 'path';
import { homedir } from 'os';
import { CodexStreamParser } from './codex-stream.js';
import { killProcessTree } from '../workers/processKill.js';
import { MAX_WORKER_OUTPUT_BYTES, OUTPUT_TRUNCATION_NOTICE } from '../workers/limits.js';
import { getCachedCodexModelCapabilities } from './codex-appserver/catalog.js';
import { markThrottled, markAvailable } from '../quota.js';
import { modelImagePath } from './attachments.js';
import { goalBlock } from './goalBlock.js';
import { codexContextWindowOverride } from './codexContextWindow.js';
import { buildCodexMcpOverrides } from '../mcp/mcpConfigWriter.js';
import type { WorkerConfig, WorkerStatus } from '@arco/shared';
import type { Provider, ProviderProcess } from './types.js';
import { commandArgs } from '../windowsCommand.js';

// Slot 4 — Codex throttle detection. Per §6.3, 429s are "silent" — the CLI
// doesn't surface a Retry-After we can parse reliably. When we detect a
// throttle-shaped error, default to a 30-minute cooldown (matches OpenAI's
// observed window for ChatGPT-tier quota resets). Returns null when nothing
// looks throttled.
const CODEX_COOLDOWN_MS = 30 * 60 * 1000;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

function splitAttachments(paths: string[] | undefined): { images: string[]; nonImages: string[]; error?: string } {
  const images: string[] = [];
  const nonImages: string[] = [];
  for (const p of paths ?? []) {
    if (!IMAGE_EXT.has(extname(p).toLowerCase())) {
      nonImages.push(p);
      continue;
    }
    try {
      const s = statSync(p);
      if (!s.isFile()) return { images, nonImages, error: `image attachment "${p}" is not a file` };
      images.push(p);
    } catch (err) {
      return {
        images,
        nonImages,
        error: `image attachment "${p}" unreadable: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  return { images, nonImages };
}

export function parseCodexThrottle(text: string): { resetsAt?: number } | null {
  if (!text) return null;
  const has429 = /\b429\b/.test(text);
  const looksThrottled =
    /rate limit/i.test(text) ||
    /too many requests/i.test(text) ||
    /quota/i.test(text) ||
    /usage limit/i.test(text);
  if (!has429 && !looksThrottled) return null;
  return { resetsAt: Date.now() + CODEX_COOLDOWN_MS };
}

// OpenAI Codex CLI worker. `codex exec --json` runs non-interactively, streams
// JSONL events, and supports UUID-based session resume via `codex exec resume
// <uuid>`. Mirrors the Claude provider shape more closely than Gemini does
// (UUID sessions, sandbox knob, --add-dir support, no index juggling).
//
// Sandbox mapping (worker tools):
//   skipPermissions === true   → -s danger-full-access  (full system access)
//   skipPermissions === false  → -s workspace-write     (writes scoped to cwd + add-dir)
// The orchestrator path uses -s read-only — see OrchestratorAgent.

class CodexWorkerProcess extends EventEmitter implements ProviderProcess {
  readonly id: string;
  readonly config: WorkerConfig;
  private process: ChildProcess | null = null;
  private parser: CodexStreamParser | null = null;
  private _status: WorkerStatus = 'spawning';
  private _output = '';
  private outputCapped = false;
  private _stderrBuf = '';

  constructor(id: string, config: WorkerConfig) {
    super();
    this.id = id;
    this.config = config;
  }

  get status(): WorkerStatus {
    return this._status;
  }

  get output(): string {
    return this._output;
  }

  get pid(): number | undefined {
    return this.process?.pid;
  }

  spawn(prompt: string): void {
    const attachments = splitAttachments(this.config.attachments);
    if (attachments.error) {
      this._status = 'failed';
      setImmediate(() => this.emit('error', attachments.error!));
      return;
    }
    // `-i` gets the downscaled sibling when one exists (spawn is sync, so an
    // unfinished derivation just sends the original this turn).
    const args = this.buildArgs(attachments.images.map(modelImagePath));
    // Phase B — codex has no --system-prompt / --append-system-prompt flag.
    // Its prompt IS the stdin payload. Per Probe 5, codex exec caches ~89% of
    // its prefix automatically across invocations, so prepending the byte-
    // stable transcript buys the same cache leverage claude gets via
    // --append-system-prompt. A trailing sentinel separates the cached prefix
    // from the per-spawn task so the prefix hash matches across turns.
    const basePrompt = prompt.trim().length > 0 || attachments.images.length === 0
      ? prompt
      : 'Please inspect the attached image(s).';
    const promptWithAttachmentRefs = attachments.nonImages.length > 0
      ? `${basePrompt}\n\n${attachments.nonImages.map((p) => `[attached file: ${p}]`).join('\n')}`
      : basePrompt;
    // GOAL_NORTHSTAR_PLAN.md G2 — fold the operator's north-star into the
    // byte-stable prefix, above appendSystemPrompt, so it rides Codex's
    // prefix cache like the rest of the framing. Covers operator turns AND
    // primitive seeds (both carry config.goal). Absent / blank ⇒ no change.
    const northStarBlock = goalBlock(this.config.goal);
    const prefixSp = northStarBlock
      ? (this.config.appendSystemPrompt ? `${northStarBlock}\n\n${this.config.appendSystemPrompt}` : northStarBlock)
      : this.config.appendSystemPrompt;
    const fullPrompt = prefixSp
      ? `${prefixSp}\n\n---\n\n${promptWithAttachmentRefs}`
      : promptWithAttachmentRefs;

    this.process = spawn(...commandArgs('codex', args), {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(this.config.codexHome ? { CODEX_HOME: this.config.codexHome } : {}) },
      cwd: this.config.cwd || undefined,
      // detached:true → child becomes process group leader; killProcessTree
      // takes down descendants on cancel or RSS auto-kill.
      detached: true,
    });

    this.parser = new CodexStreamParser();
    this.wireEvents();

    if (this.process.stdin) {
      this.process.stdin.write(fullPrompt);
      this.process.stdin.end();
    }

    if (this.process.stdout) {
      this.parser.parse(this.process.stdout);
    }

    if (this.process.stderr) {
      // Always pipe stderr to the server's own stderr — silent worker
      // failures (rate limits, OAuth refresh) are otherwise invisible to the
      // operator. Cheap; stderr is low volume in exec mode. Also accumulate
      // for throttle detection (Slot 4).
      this.process.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        this._stderrBuf += text;
        if (this._stderrBuf.length > 64 * 1024) this._stderrBuf = this._stderrBuf.slice(-32 * 1024);
        if (!this.config.incognito) process.stderr.write(`[worker:${this.id}:stderr] ${text}`);
      });
    }

    this.process.on('exit', (code: number | null) => {
      if (this._status === 'running' || this._status === 'spawning') {
        if (code !== 0 && code !== null) {
          this._status = 'failed';
          this._checkThrottle();
          const detail = lastStderrError(this._stderrBuf);
          this.emit('error', `Codex exited with code ${code}${detail ? `: ${detail}` : ''}`);
        } else {
          // Clean exit but the parser never emitted 'done' or 'result'
          // (abrupt stdout close, or stream 'end' raced past the exit).
          // Mirror the parser's done-fallback so the worker settles
          // instead of hanging the workflow forever. Matches Claude's
          // claude.ts:522 pattern.
          this._status = 'completed';
          this.emit('result', {
            text: this._output,
            costUsd: 0,
            durationMs: 0,
          });
        }
      }
    });

    this.process.on('error', (err: Error) => {
      this._status = 'failed';
      this._checkThrottle(err.message);
      this.emit('error', `Failed to spawn codex: ${err.message}`);
    });
  }

  kill(): void {
    const wasRunning = this._status === 'running' || this._status === 'spawning';
    if (this.process && !this.process.killed && this.process.pid) {
      killProcessTree(this.process.pid);
    }
    this.parser?.destroy();
    if (wasRunning) {
      this._status = 'failed';
      this.emit('error', 'Worker killed');
    }
  }

  private buildArgs(imagePaths: string[] = []): string[] {
    // `codex exec` is the non-interactive subcommand — analogous to claude -p.
    // `codex exec resume <uuid>` continues an existing thread started by a
    // prior `codex exec`. Arco's primary-worker path feeds one prompt per
    // spawn; the resume form pins the thread across turns.
    //
    // IMPORTANT: the resume subcommand has a narrower arg surface than `exec`.
    // It does NOT accept `--color`, `-s <mode>`, `-C <cwd>`, or `--add-dir` —
    // passing any of those makes codex exit non-zero at argv validation
    // before the prompt is ever read, and the turn fails in ~20ms with no
    // output. Sandbox on resume goes through `-c sandbox_mode=…` (codex 0.157
    // dropped `--full-auto` from `exec resume`, which failed every non-yolo
    // resume turn in ~20ms with exit 2) or `--dangerously-bypass-approvals-
    // and-sandbox`; cwd gets handled by `spawn({ cwd })` above.
    const isResume = !!this.config.resumeSessionId;
    const args = isResume
      ? ['exec', 'resume', this.config.resumeSessionId!, '--json', '--skip-git-repo-check']
      : ['exec', '--json', '--color', 'never', '--skip-git-repo-check'];
    // Both flags exist on `exec resume` too. First-turn-only let a saved
    // chat's turn 2+ load the operator's config.toml — their MCP servers
    // (project tools inside Chat) and sandbox defaults.
    if (this.config.interactionMode === 'chat') {
      args.push('--ignore-user-config', '--ignore-rules');
    }
    if (this.config.interactionMode === 'chat') {
      // Chat's first turn drops the operator's config.toml, so web search has
      // to be stated outright rather than inherited — same knob (and same
      // vocabulary) the app-server transport sends. Stated on BOTH sides so a
      // disarmed chat can't pick web search up from a codex-side default, and
      // pushed on resume turns too (`-c` is one of the few flags `exec resume`
      // shares with `exec`, and resume DOES read the user config).
      args.push('-c', `web_search="${this.config.chatWebAccess ? 'live' : 'disabled'}"`);
    }
    const contextWindow = codexContextWindowOverride(this.config);
    if (contextWindow) args.push('-c', `model_context_window=${contextWindow}`);
    if (!isResume && this.config.incognito) args.push('--ephemeral');

    // Explicit sandbox wins over the skipPermissions boolean. Reviewers pass
    // `sandbox: 'read-only'` so Codex actually refuses writes; primaries leave
    // it unset and fall back to workspace-write / danger-full-access.
    const sandbox = this.config.sandbox
      ?? (this.config.skipPermissions ? 'danger-full-access' : 'workspace-write');
    if (isResume) {
      // `exec resume` doesn't accept `-s <mode>`; the config override does the
      // same job and covers read-only (chat resumes) as well.
      if (sandbox === 'danger-full-access') args.push('--dangerously-bypass-approvals-and-sandbox');
      else args.push('-c', `sandbox_mode="${sandbox}"`);
    } else {
      args.push('-s', sandbox);
    }

    args.push('-m', this.config.model);

    for (const imagePath of imagePaths) {
      args.push('-i', imagePath);
    }

    // Codex's reasoning-depth knob is `-c model_reasoning_effort=...`. The
    // bare `reasoning_effort` key this used to send isn't a config key; Codex
    // accepted and ignored it, so exec tabs ran at the model default effort.
    // Levels map 1:1 and clamp to the model's catalog efforts
    // (mapEffortToReasoning). `-c` works on both `exec` and `exec resume`.
    const reasoning = mapEffortToReasoning(this.config.effort, this.config.model);
    if (reasoning) {
      args.push('-c', `model_reasoning_effort="${reasoning}"`);
    }

    // `--add-dir` and `-C` are exec-only. The spawn's `cwd` option already
    // pins the process's working directory, so dropping `-C` on resume is
    // behaviour-preserving. `--add-dir` has no resume equivalent; callers
    // using additionalDirectories on a resume turn silently lose them, which
    // matches what happens today with Gemini primary resumes.
    if (!isResume) {
      if (this.config.additionalDirectories?.length) {
        for (const dir of this.config.additionalDirectories) {
          args.push('--add-dir', dir);
        }
      }
      if (this.config.cwd) {
        args.push('-C', this.config.cwd);
      }
    }

    // No equivalent to Claude's `--tools` allow-list. Codex exposes its own
    // tool surface (file read/write, shell within sandbox); workers either
    // get the sandbox-gated set or the full set per the sandbox flag above.

    // CLUSTER_MODE_PLAN.md Phase 4 + EFFICIENCY_PLAN.md Phase F9 — Codex
    // cluster members register the arco-cluster MCP stdio child Claude
    // CLI uses, AND codebase-memory-attached workflows register the
    // operator-installed codebase-memory-mcp child the same way. Codex has
    // no `--mcp-config <path>` flag, so both registrations layer on via
    // `-c key=value` TOML overrides — the operator's `~/.codex/config.toml`
    // is not touched and unrelated mcp_servers entries flow through.
    //
    // Per-turn shape (matches Claude CLI per-spawn lifecycle): codex spawns
    // the MCP child for the duration of the `codex exec` invocation; both
    // die together when the turn ends. The plan body / role hint / mailbox
    // prologue ride through `appendSystemPrompt` (folded into the prompt
    // by index.ts handleUserMessage, then prepended to stdin by spawn()).
    // §E1 — operator-enabled registry servers ALSO layer on via the same
    // `-c mcp_servers.*` overrides. NOTE: Codex has no per-tool allow/deny
    // flag, so EVERY tool of an enabled server is exposed — the dangerous-tool
    // denylist is NOT enforceable on Codex (documented gap; surfaced in the
    // UI/diagnostics). Server-level enable/disable IS honored.
    const registryServers = this.config.mcpRegistryServers ?? [];
    // The workflow-scoped `arco` plan entry applies to every workflow with a
    // cwd, so this is no longer gated on cluster / codebase-memory / registry.
    if (this.config.interactionMode !== 'chat' && (this.config.cwd || this.config.clusterId || this.config.codebaseMemoryAttached || registryServers.length > 0)) {
      const port = parseInt(process.env.ARCO_PORT || '3001', 10);
      args.push(
        ...buildCodexMcpOverrides(this.config.workflowId ?? '', {
          planToolsCwd: this.config.workflowId ? this.config.cwd : undefined,
          clusterId: this.config.clusterId,
          taskBoardAttached: this.config.clusterTaskBoardAttached === true,
          accessMode: this.config.clusterAccessMode,
          port,
          codebaseMemoryIndexPath: this.config.codebaseMemoryAttached
            ? this.config.codebaseMemoryIndexPath
            : undefined,
          registryServers,
        }),
      );
    }

    return args;
  }

  private wireEvents(): void {
    if (!this.parser) return;

    this.parser.on('init', (data: { sessionId?: string }) => {
      this._status = 'running';
      markAvailable('codex');
      // Codex doesn't return a model string in init events; surface the
      // configured model so the worker card upgrades from alias to concrete.
      this.emit('init', { model: this.config.model, sessionId: data.sessionId });
    });

    this.parser.on('text', (text: string) => {
      if (this.outputCapped) return;
      const remaining = MAX_WORKER_OUTPUT_BYTES - this._output.length;
      if (text.length <= remaining) {
        this._output += text;
        this.emit('text', text);
        return;
      }
      const fit = remaining > 0 ? text.slice(0, remaining) : '';
      if (fit) {
        this._output += fit;
        this.emit('text', fit);
      }
      this._output += OUTPUT_TRUNCATION_NOTICE;
      this.emit('text', OUTPUT_TRUNCATION_NOTICE);
      this.outputCapped = true;
      this._status = 'completed';
      this.emit('result', { text: this._output, costUsd: 0, durationMs: 0 });
      this.kill();
    });

    this.parser.on('thinking', (text: string) => {
      this.emit('thinking', text);
    });

    this.parser.on('tool_use', (data: {
      name: string;
      input: string;
      status?: 'started' | 'in_progress' | 'completed' | 'failed';
      provider?: 'codex';
      itemType?: string;
      itemId?: string;
      output?: string;
      exitCode?: number;
    }) => {
      this.emit('tool_use', data);
    });

    this.parser.on('result', (data: { text: string; costUsd: number; durationMs: number; usage?: Record<string, number>; modelContextWindow?: number }) => {
      this._status = 'completed';
      // Prefer parser-accumulated text; fall back to event text if longer.
      if (data.text.length > this._output.length) {
        this._output = data.text;
      }
      // EFFICIENCY_PLAN.md Phase A — see claude.ts CLI for sentinel rationale.
      this.emit('result', { ...data, text: this._output, thinkingBytes: 0, toolResultBytes: -1, toolResultBytesRaw: -1 });
    });

    this.parser.on('error', (error: string) => {
      this._status = 'failed';
      this._checkThrottle(error);
      this.emit('error', error);
    });

    const settleDone = () => {
      if (this._status === 'running' || this._status === 'spawning') {
        this._status = 'completed';
        this.emit('result', {
          text: this._output,
          costUsd: 0,
          durationMs: 0,
        });
      }
    };
    this.parser.on('done', () => {
      // An exec that dies at startup (e.g. `thread/resume failed: … already
      // has an active writer`) closes stdout with zero events and exits
      // non-zero a beat later. Settling here reported an empty success and
      // buried the real error (handoff then blamed the model for not calling
      // Write). Give the exit handler a short window to report it first.
      if (!this._output && this.process && this.process.exitCode === null && this.process.signalCode === null) {
        setTimeout(settleDone, 2000).unref();
        return;
      }
      settleDone();
    });
  }

  private _checkThrottle(extra?: string): void {
    const combined = [this._stderrBuf, extra].filter(Boolean).join('\n');
    const parsed = parseCodexThrottle(combined);
    if (parsed) markThrottled('codex', combined.slice(-500), parsed.resetsAt);
  }
}

// Most useful single line from codex stderr for an exit-code error: the last
// line mentioning an error, ANSI + tracing timestamp stripped, length-capped.
export function lastStderrError(buf: string): string {
  const lines = buf
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split('\n')
    .map((l) => l.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+/, '').trim())
    .filter(Boolean);
  const hit = [...lines].reverse().find((l) => /\berror\b/i.test(l));
  return (hit ?? '').slice(0, 500);
}

// Translate Arco's effort to Codex's reasoning_effort. Catalog-aware: if
// the catalog (populated lazily by codex-appserver/catalog.ts) reports the
// requested effort isn't supported on this model, downgrade to the highest
// supported effort. Cold-start (no catalog) falls back to a safe pass-through.
function mapEffortToReasoning(effort: string | undefined, modelId?: string): string | null {
  const desired = baseMapEffortToReasoning(effort);
  if (!desired || !modelId) return desired;
  const caps = getCachedCodexModelCapabilities(modelId);
  if (!caps || caps.supportedReasoningEfforts.length === 0) return desired;
  if (caps.supportedReasoningEfforts.includes(desired as never)) return desired;
  return caps.supportedReasoningEfforts[caps.supportedReasoningEfforts.length - 1] as string;
}

// See codex-appserver/worker.ts baseMapEffort for the history: Codex's enum
// used to stop at 'xhigh', so Arco's 'max' collapsed onto it. GPT-6 Astra
// added real 'max' and 'ultra', so the mapping is now 1:1 and the per-model
// catalog clamp in mapEffortToReasoning() handles models that stop lower.
function baseMapEffortToReasoning(effort: string | undefined): string | null {
  if (!effort) return null;
  switch (effort) {
    case 'low': return 'low';
    case 'medium': return 'medium';
    case 'high': return 'high';
    case 'xhigh': return 'xhigh';
    case 'max': return 'max';
    case 'ultra': return 'ultra';
    default: return null;
  }
}

export const CodexProvider: Provider = {
  create(id, config) {
    return new CodexWorkerProcess(id, config);
  },
};

// Read the authenticated email from a CODEX_HOME's auth.json by decoding the
// id_token JWT payload. `codex login status` only emits "Logged in using
// ChatGPT" with no email, so without this fallback two profiles look identical
// in the UI even when they hold different accounts.
function readCodexAuthEmail(codexHome?: string): string | undefined {
  try {
    const dir = codexHome
      ? codexHome.replace(/^~/, homedir())
      : join(homedir(), '.codex');
    const raw = readFileSync(join(dir, 'auth.json'), 'utf8');
    const parsed = JSON.parse(raw) as { tokens?: { id_token?: string } };
    const idToken = parsed?.tokens?.id_token;
    if (!idToken) return undefined;
    const payload = idToken.split('.')[1];
    if (!payload) return undefined;
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { email?: string };
    return typeof decoded.email === 'string' ? decoded.email : undefined;
  } catch {
    return undefined;
  }
}

// Sample one-line probe of the daemon — used by auth.ts for status checks.
// Returns true if `codex login status` reports an authenticated session.
export async function probeCodexLoggedIn(codexHome?: string): Promise<{ loggedIn: boolean; account?: string; raw?: string }> {
  return new Promise((resolve) => {
    const proc = spawn(...commandArgs('codex', ['login', 'status']), {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(codexHome ? { CODEX_HOME: codexHome } : {}) },
    });
    let out = '';
    let err = '';
    proc.stdout.on('data', (b: Buffer) => { out += b.toString(); });
    proc.stderr.on('data', (b: Buffer) => { err += b.toString(); });
    const timeout = setTimeout(() => { try { proc.kill('SIGTERM'); } catch { /* ignore */ } }, 5000);
    proc.on('exit', () => {
      clearTimeout(timeout);
      const combined = `${out}\n${err}`;
      // "Not logged in" also contains "logged in"; a negative answer wins.
      const loggedIn = /logged in/i.test(combined) && !/\bnot logged in\b/i.test(combined);
      const cliAccount = /Logged in (?:to \S+ )?(?:as|using)\s+(\S+)/i.exec(combined)?.[1];
      // Fall back to JWT email when the CLI output contains no email address.
      const account = (cliAccount && cliAccount.includes('@')) ? cliAccount : (readCodexAuthEmail(codexHome) ?? cliAccount);
      resolve({ loggedIn, account, raw: combined.trim().slice(0, 200) });
    });
    proc.on('error', () => {
      clearTimeout(timeout);
      resolve({ loggedIn: false });
    });
  });
}
