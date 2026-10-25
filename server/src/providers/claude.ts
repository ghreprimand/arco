import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import {
  writeFileSync,
  unlinkSync,
  mkdirSync,
  readFileSync,
  statSync,
} from 'fs';
import { tmpdir } from 'os';
import { join as joinPath, extname } from 'path';
import { StreamParser } from '../workers/StreamParser.js';
import { killProcessTree } from '../workers/processKill.js';
import { MAX_WORKER_OUTPUT_BYTES, OUTPUT_TRUNCATION_NOTICE } from '../workers/limits.js';
import { markThrottled, markAvailable } from '../quota.js';
import type { WorkerConfig, WorkerStatus } from '@archon/shared';
import { modelImagePath } from './attachments.js';
import { goalBlock } from './goalBlock.js';
import type { Provider, ProviderProcess } from './types.js';

// Phase C.2 — above this char count we stop trying to pass
// --append-system-prompt as a single CLI arg (Linux MAX_ARG_STRLEN is
// ~128KB per arg; past ~30K tokens the spawn() call dies with E2BIG). We
// write the value to a tmp file and use --append-system-prompt-file instead.
// The 64KB crossover sits comfortably below the kernel limit and well below
// any transcript-compaction threshold, so normal cases (pre-Phase-B era
// tests, short workflows) keep the simple argv path.
const APPEND_SP_ARG_MAX = 64 * 1024;
const APPEND_SP_TMPDIR = joinPath(tmpdir(), 'archon-prompts');

// Per-attachment image cap. Claude API accepts up to 5MB base64 per image.
// Going over this would get bounced at the API boundary with a 400, so we
// reject early with a clear error.
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

const IMAGE_MEDIA_TYPE: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

function effectiveAppendSystemPrompt(config: WorkerConfig): string | undefined {
  const northStarBlock = goalBlock(config.goal);
  return northStarBlock
    ? (config.appendSystemPrompt ? `${northStarBlock}\n\n${config.appendSystemPrompt}` : northStarBlock)
    : config.appendSystemPrompt;
}

function classifyAttachment(path: string): { kind: 'image'; mediaType: string } | { kind: 'other' } {
  const mt = IMAGE_MEDIA_TYPE[extname(path).toLowerCase()];
  return mt ? { kind: 'image', mediaType: mt } : { kind: 'other' };
}

// Slot 4 — Claude CLI throttle detection. Stderr patterns observed in the
// wild: "Claude AI usage limit reached. Try again at 7:00pm.", "rate limit",
// subscription-exhausted messages. Returns a resetsAt epoch when we can parse
// the reset hint; otherwise returns {} (throttled, no known reset). Returns
// null when the text doesn't look throttle-shaped.
export function parseClaudeThrottle(text: string): { resetsAt?: number } | null {
  if (!text) return null;
  const lc = text.toLowerCase();
  const looksThrottled =
    lc.includes('usage limit reached') ||
    lc.includes('usage limit') && lc.includes('reach') ||
    lc.includes('rate limit') ||
    /try again (?:at|in)\s/i.test(text) ||
    (lc.includes('subscription') && lc.includes('limit'));
  if (!looksThrottled) return null;
  const resetsAt = parseClaudeReset(text);
  return resetsAt !== undefined ? { resetsAt } : {};
}

// Parse "Try again at 7:00pm" / "Try again at 14:30" / "resets at 2026-04-18T12:00Z".
// Returns epoch ms or undefined. Best-effort — we'd rather have no reset time
// than a wrong one (wrong time would flip quota to available prematurely).
function parseClaudeReset(text: string): number | undefined {
  // ISO timestamp
  const iso = /(?:try again at|resets? at)\s+(\d{4}-\d{2}-\d{2}T[\d:.Z+-]+)/i.exec(text);
  if (iso) {
    const t = Date.parse(iso[1]);
    if (!Number.isNaN(t)) return t;
  }
  // 12-hour clock: "7:00pm", "10:30 AM"
  const clock12 = /try again at\s+(\d{1,2})(?::(\d{2}))?\s*([ap]m)/i.exec(text);
  if (clock12) {
    const hour12 = parseInt(clock12[1], 10);
    const mins = clock12[2] ? parseInt(clock12[2], 10) : 0;
    const pm = clock12[3].toLowerCase() === 'pm';
    const hour24 = (hour12 % 12) + (pm ? 12 : 0);
    return nextOccurrence(hour24, mins);
  }
  // 24-hour clock
  const clock24 = /try again at\s+(\d{1,2}):(\d{2})(?!\s*[ap]m)/i.exec(text);
  if (clock24) {
    return nextOccurrence(parseInt(clock24[1], 10), parseInt(clock24[2], 10));
  }
  // Relative: "try again in 1 hour" / "in 45 minutes"
  const rel = /try again in\s+(\d+)\s*(hour|hr|minute|min)/i.exec(text);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const unit = rel[2].toLowerCase();
    const ms = unit.startsWith('h') ? n * 3600_000 : n * 60_000;
    return Date.now() + ms;
  }
  return undefined;
}

// Given hour:minute in local time, return the next epoch ms when the clock
// lands there. If it's already passed today, use tomorrow.
function nextOccurrence(hour24: number, minute: number): number {
  const now = new Date();
  const target = new Date(now);
  target.setHours(hour24, minute, 0, 0);
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
  return target.getTime();
}

// API resilience — retry a turn that dies before the CLI emits a `result`
// event, when we saw a transient Anthropic error on the way down. The prompt
// is NOT guaranteed unsent on a pre-result exit: once the CLI reached init on
// a pinned session it has recorded the user turn (and any tool calls), so a
// verbatim re-send under --resume duplicated it and --session-id collided
// with the now-existing session. Those retries resume the session with a
// short continuation prompt instead (see _resumeOnRetry).
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_CONTINUE_PROMPT =
  '[Archon retry] The previous attempt at this turn was cut off by a transient API error. ' +
  'Continue the task from where it stopped. Do not repeat tool calls whose results are already in this conversation.';
const RETRY_BACKOFF_MS = [15_000, 30_000, 60_000]; // 15s → 30s → 60s

class ClaudeWorkerProcess extends EventEmitter implements ProviderProcess {
  readonly id: string;
  readonly config: WorkerConfig;
  private process: ChildProcess | null = null;
  private parser: StreamParser | null = null;
  private _status: WorkerStatus = 'spawning';
  private _output = '';
  private outputCapped = false;
  // Slot 4 — accumulate stderr so we can run throttle detection on exit/error.
  // Capped to avoid unbounded growth on chatty failures.
  private _stderrBuf = '';
  // Phase C.2 — tmp file holding a too-large --append-system-prompt value.
  // Written in buildArgs(), passed to the CLI as --append-system-prompt-file
  // <path>, and unlinked when the process exits (exit handler + kill()).
  // Cleanup is best-effort; if a leak happens the OS tmpdir-reaper eventually
  // prunes, and the filename includes the worker id for attribution.
  private _appendSpFile: string | null = null;
  // Retry-loop state. _prompt is stashed so we can re-send on a retry
  // without the caller re-invoking spawn(). _gotResult flips true when the
  // parser emits `result` (or `done` without an explicit result), which is
  // our signal that the turn actually completed on the API side. If the
  // process exits non-zero before that, AND we saw a transient API error,
  // we reschedule; otherwise the exit is fatal as before.
  private _prompt: string | null = null;
  private _attempts = 0;
  private _gotResult = false;
  private _lastTransientError: string | null = null;
  private _retryTimer: NodeJS.Timeout | null = null;
  // Current attempt reached `init` — on a pinned session that means the CLI
  // owns the session file and has (or is about to have) the user turn.
  private _sawInit = false;
  // Sticky once a retry must continue a session the failed attempt touched:
  // buildArgs switches to --resume and _launch sends RETRY_CONTINUE_PROMPT.
  private _resumeOnRetry = false;
  // Parser saw stdout close; settlement waits for the process exit code.
  private _stdoutClosed = false;
  // ULTRACODE_PLAN.md — under ultracode a turn runs a background workflow that
  // emits MULTIPLE `result` events (an early "workflow launched" ack, then the
  // real synthesis when the fleet finishes; the process waits and exits 0 only
  // after the last). We HOLD each result instead of emitting it: when a newer
  // one arrives the prior is confirmed intermediate → surfaced as a progress
  // system_notice; the final held result is flushed as the canonical turn
  // result on clean process exit. Null when not ultracode (normal path).
  private _heldResult: { text: string; costUsd: number; durationMs: number; usage?: Record<string, number> } | null = null;

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
    // Stash the prompt once; a retry whose failed attempt never reached the
    // session re-sends it verbatim (otherwise it continues — see
    // RETRY_CONTINUE_PROMPT), so the session holds one canonical user turn.
    this._prompt = prompt;
    this._launch();
  }

  private _launch(): void {
    // ULTRACODE_PLAN.md — prepend the `ultracode` keyword so the CLI's
    // workflow keyword-trigger fires (the documented opt-in; equivalent to
    // typing "ultracode: …" in the interactive client). _prompt stays raw so
    // retries re-prepend idempotently and events.jsonl keeps the operator's
    // armed intent visible. xhigh effort + Workflow tool are forced in buildArgs.
    const rawPrompt = this._resumeOnRetry
      ? RETRY_CONTINUE_PROMPT
      : this.config.ultracode
        ? `ultracode: ${this._prompt ?? ''}`
        : this._prompt ?? '';
    // Strict incognito keeps all conversation-derived bytes off argv and out
    // of --append-system-prompt-file. Claude receives the framing + prior
    // memory through its existing stdin pipe instead; --no-session-persistence
    // prevents the CLI from materializing that input as a session transcript.
    const privatePrefix = this.config.incognito
      ? [this.config.systemPrompt, effectiveAppendSystemPrompt(this.config)].filter(Boolean).join('\n\n')
      : '';
    const prompt = privatePrefix
      ? `${privatePrefix}\n\n--- Current operator message ---\n\n${rawPrompt}`
      : rawPrompt;
    // Build the stdin payload first. If the operator attached image files
    // we switch to Claude's stream-json input mode (same wire format the
    // terminal uses for pasted images) and embed each image as a base64
    // content block in a single user message. Non-image attachments get
    // their paths appended to the text so the operator's intent isn't
    // silently lost — Agent primaries have the full CLI toolset and can Read
    // them; Chat (--tools "" or web-only) at least sees the reference.
    const images: Array<{ mediaType: string; data: string; path: string }> = [];
    const nonImagePaths: string[] = [];
    let attachmentError: string | null = null;

    // A continuation retry resumes a session that already holds the images.
    for (const p of this._resumeOnRetry ? [] : this.config.attachments ?? []) {
      const cls = classifyAttachment(p);
      if (cls.kind !== 'image') {
        nonImagePaths.push(p);
        continue;
      }
      try {
        // Downscaled sibling when present; media type follows ITS extension
        // (an over-cap PNG comes back as a .jpg re-encode).
        const src = modelImagePath(p);
        const size = statSync(src).size;
        if (size > IMAGE_MAX_BYTES) {
          attachmentError = `attachment "${p}" exceeds ${Math.round(IMAGE_MAX_BYTES / 1024 / 1024)}MB image limit`;
          break;
        }
        const buf = readFileSync(src);
        const srcCls = classifyAttachment(src);
        images.push({ mediaType: srcCls.kind === 'image' ? srcCls.mediaType : cls.mediaType, data: buf.toString('base64'), path: p });
      } catch (err) {
        attachmentError = `attachment "${p}" unreadable: ${err instanceof Error ? err.message : String(err)}`;
        break;
      }
    }

    if (attachmentError) {
      // Emit via the same error path subprocess failures use so the operator
      // sees it in chat and the workflow busy flag drops.
      this._status = 'failed';
      setImmediate(() => this.emit('error', attachmentError!));
      return;
    }

    const useStreamJson = images.length > 0;
    const args = this.buildArgs({ streamJsonInput: useStreamJson });

    this.process = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
      cwd: this.config.cwd || undefined,
      // detached:true makes the child a process group leader — required so
      // killProcessTree can reach descendants (runaway shells / finds / etc.)
      // via process.kill(-pid, signal). Stdio still piped, so this doesn't
      // change how we read events.
      detached: true,
    });

    this.parser = new StreamParser();
    this.wireEvents();

    if (this.process.stdin) {
      if (useStreamJson) {
        // Append any non-image attachment paths to the text so the model
        // sees them. Agent primaries can Read them; Chat runs --tools ""
        // (or web-only), so there they're informational only.
        let text = prompt;
        if (nonImagePaths.length > 0) {
          if (this.config.interactionMode === 'chat') {
            console.warn(
              `[worker:${this.id}] ${nonImagePaths.length} non-image attachment(s) passed as paths only (Chat has no Read tool)`,
            );
          }
          text += '\n\n' + nonImagePaths.map((p) => `[attached file: ${p}]`).join('\n');
        }
        // Images before the text block — Anthropic's vision guidance (and
        // the Native transport) put the image first, the question after.
        const content: Array<Record<string, unknown>> = [];
        for (const img of images) {
          content.push({
            type: 'image',
            source: { type: 'base64', media_type: img.mediaType, data: img.data },
          });
        }
        if (text.length > 0) content.push({ type: 'text', text });
        const envelope = { type: 'user', message: { role: 'user', content } };
        this.process.stdin.write(JSON.stringify(envelope) + '\n');
      } else {
        // No images ⇒ plain-text stdin. The path refs must still ride along:
        // this branch used to write the bare prompt, so a turn with only a
        // .md / .pdf attached never told the model the file existed.
        this.process.stdin.write(nonImagePaths.length > 0
          ? `${prompt}\n\n${nonImagePaths.map((p) => `[attached file: ${p}]`).join('\n')}`
          : prompt);
      }
      this.process.stdin.end();
    }

    if (this.process.stdout) {
      this.parser.parse(this.process.stdout);
    }

    if (this.process.stderr) {
      // Always pipe stderr to the server's own stderr — silent worker failures
      // are otherwise invisible to the operator. Cheap; stderr is low volume
      // in -p mode. Also accumulate for throttle detection (Slot 4).
      this.process.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        this._stderrBuf += text;
        if (this._stderrBuf.length > 64 * 1024) this._stderrBuf = this._stderrBuf.slice(-32 * 1024);
        if (!this.config.incognito) process.stderr.write(`[worker:${this.id}:stderr] ${text}`);
      });
    }

    this.process.on('exit', (code: number | null) => {
      this._cleanupAppendSpFile();
      // ULTRACODE_PLAN.md — flush the final held result as the canonical turn
      // result. The background workflow's last `result` before exit is the real
      // synthesis (held, not emitted, in parser.on('result')). Flush on ANY exit
      // when a held result exists — a clean exit is the common case, but if the
      // workflow crashed after producing an intermediate we still surface what
      // we have rather than hanging the turn "busy". With no held result we fall
      // through to the normal retry/error logic below.
      if (this.config.ultracode && this._heldResult) {
        const final = this._heldResult;
        this._heldResult = null;
        this.emit('result', { ...final, thinkingBytes: 0, toolResultBytes: -1, toolResultBytesRaw: -1 });
        return;
      }
      if (this._status !== 'running' && this._status !== 'spawning') return;
      if (this._gotResult) return;
      if (code === 0 || code === null) {
        // Clean exit with no `result`: settle now if stdout already closed;
        // otherwise the parser's 'done' settles when it does.
        if (this._stdoutClosed) this._settleDone();
        return;
      }

      // Non-zero exit without a completed turn. If the stream carried a
      // transient Anthropic error on the way down (overloaded_error /
      // rate_limit_error / api_error / timeout_error) we get to retry;
      // anything else is a hard stop (auth failure, model-not-found,
      // context-window exhausted, bad args).
      if (this._lastTransientError && this._attempts < MAX_RETRY_ATTEMPTS) {
        const errType = this._lastTransientError;
        const backoff = RETRY_BACKOFF_MS[this._attempts];
        this._attempts++;
        // Clear before scheduling so a stale signal from the prior attempt
        // can't re-fire a retry if no fresh error arrives on the next one.
        this._lastTransientError = null;
        // The failed attempt reached init on a pinned session → the session
        // exists and holds this turn's prompt. Resume it with a continuation
        // prompt rather than re-sending (duplicate turn) or re-pinning
        // --session-id (collision). Incognito never pins a session.
        if (this._sawInit && !this.config.incognito && (this.config.resumeSessionId || this.config.sessionId)) {
          this._resumeOnRetry = true;
        }
        this.emit(
          'system_notice',
          `Turn failed (${errType}) — retrying (${this._attempts}/${MAX_RETRY_ATTEMPTS}) in ${Math.round(backoff / 1000)}s…`,
        );
        this._retryTimer = setTimeout(() => {
          this._retryTimer = null;
          if (this._status === 'failed') return; // cancelled during backoff
          // Reset per-attempt transient state. _prompt + _attempts persist.
          this._stderrBuf = '';
          this._gotResult = false;
          this._sawInit = false;
          this._stdoutClosed = false;
          this.process = null;
          this.parser = null;
          this._launch();
        }, backoff);
        return;
      }

      // Fatal — either no transient signal, or we've exhausted attempts.
      this._status = 'failed';
      this._checkThrottle();
      const suffix = this._attempts > 0 ? ` after ${this._attempts} retry attempt(s)` : '';
      this.emit('error', `Process exited with code ${code}${suffix}`);
    });

    this.process.on('error', (err: Error) => {
      this._cleanupAppendSpFile();
      this._status = 'failed';
      this._checkThrottle(err.message);
      this.emit('error', `Failed to spawn claude: ${err.message}`);
    });
  }

  kill(): void {
    const wasRunning = this._status === 'running' || this._status === 'spawning';
    // Clear any pending retry timer so a CANCEL during backoff doesn't let a
    // zombie respawn fire after the operator's moved on.
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
    if (this.process && !this.process.killed && this.process.pid) {
      killProcessTree(this.process.pid);
    }
    this.parser?.destroy();
    // Phase C.2 — drop the tmp file eagerly here too. The exit handler runs
    // after the process's child tree is reaped; on kill we want the file
    // gone immediately, not after whatever delay the kernel takes to unwind.
    this._cleanupAppendSpFile();
    // If kill arrives mid-run, emit a synthetic 'error' so WorkerManager's
    // result-promise resolves. Otherwise spawnBatch awaits forever and the
    // workflow stays "busy" — operator clicks CANCEL and nothing visibly
    // changes. The exit handler can't help here because we set _status =
    // 'failed' below, suppressing its error emit.
    if (wasRunning) {
      this._status = 'failed';
      this.emit('error', 'Worker killed');
    }
  }

  private _cleanupAppendSpFile(): void {
    if (!this._appendSpFile) return;
    try { unlinkSync(this._appendSpFile); } catch { /* already gone, or never created */ }
    this._appendSpFile = null;
  }

  private buildArgs(opts?: { streamJsonInput?: boolean }): string[] {
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--model', this.config.model,
      // ULTRACODE_PLAN.md — ultracode decomposes to xhigh effort + the workflow
      // disposition; force xhigh here so the spawn matches `/effort ultracode`
      // regardless of the tab's displayed effort.
      '--effort', this.config.ultracode ? 'xhigh' : this.config.effort,
    ];
    if (opts?.streamJsonInput) {
      // Needed to send image content blocks. Archon only flips this when at
      // least one image attachment is present; plain-text turns stay on the
      // default `text` input mode.
      args.push('--input-format', 'stream-json');
    }

    // Session handling: plan-mode workers use persistent sessions so the two
    // phases (plan → execute) share one CLI conversation. Non-plan workers
    // keep --no-session-persistence (cheaper; no transcript accumulation).
    const pinnedSession = this.config.resumeSessionId ?? this.config.sessionId;
    if (this._resumeOnRetry && pinnedSession) {
      args.push('--resume', pinnedSession);
    } else if (this.config.resumeSessionId) {
      args.push('--resume', this.config.resumeSessionId);
    } else if (this.config.sessionId) {
      args.push('--session-id', this.config.sessionId);
    } else {
      args.push('--no-session-persistence');
    }

    // AUTO mode maps to --dangerously-skip-permissions; SAFE mode defaults.
    if (this.config.skipPermissions) {
      args.push('--dangerously-skip-permissions');
    }

    if (this.config.systemPrompt && !this.config.incognito) {
      args.push('--system-prompt', this.config.systemPrompt);
    }

    // Phase B — byte-stable transcript goes here so the CLI's auto-placed
    // cache_control breakpoint sits at the END of this value. Everything mode-
    // specific (preamble, role tail, current turn) stays in stdin, OUTSIDE the
    // cached region, so all modes/spawns on the same model share one cache
    // track. Empirically (Probe 3/4) this path caches significantly better
    // than --system-prompt, which discards the CLI's default SP cacheable bytes.
    //
    // Phase C.2 — large values switch to the file-based variant. Linux's
    // MAX_ARG_STRLEN (~128KB/arg) kills execve with E2BIG above that size,
    // and any meaningful transcript-compaction threshold assumes transcripts
    // can legitimately grow well above that. The CLI's --append-system-prompt-file
    // flag is documented in the --bare help text as a peer of --append-system-prompt.
    // GOAL_NORTHSTAR_PLAN.md G2 — fold the operator's north-star into
    // --append-system-prompt, at the top so it frames the appended section
    // (mirrors Native's "immediately after the identity block"). Covers operator
    // turns AND primitive seeds (both carry config.goal). Absent / blank ⇒ the
    // effective value is just the base appendSystemPrompt (byte-identical to
    // pre-feature behavior).
    const effectiveAppendSP = effectiveAppendSystemPrompt(this.config);
    if (effectiveAppendSP && !this.config.incognito) {
      if (effectiveAppendSP.length > APPEND_SP_ARG_MAX) {
        try {
          mkdirSync(APPEND_SP_TMPDIR, { recursive: true });
          // Include worker id in the filename so zombie files from crashed
          // workers are attributable. `.txt` suffix keeps tmp-file reapers
          // (that whitelist known extensions) from surprising us.
          const fp = joinPath(APPEND_SP_TMPDIR, `append-sp-${this.id}-${process.pid}.txt`);
          writeFileSync(fp, effectiveAppendSP, 'utf8');
          this._appendSpFile = fp;
          args.push('--append-system-prompt-file', fp);
        } catch (err) {
          // Fallback to the argv path. Will fail with E2BIG if the transcript
          // is truly too big, but at least the caller sees the spawn error
          // rather than a silently-dropped system prompt.
          console.error(
            `[worker:${this.id}] append-system-prompt-file write failed, falling back to argv:`,
            err instanceof Error ? err.message : err,
          );
          args.push('--append-system-prompt', effectiveAppendSP);
        }
      } else {
        args.push('--append-system-prompt', effectiveAppendSP);
      }
    }

    if (this.config.interactionMode === 'chat') {
      // Chat exposes no project tools. The one exception is the operator's
      // web-access toggle: an allowlist of exactly WebSearch + WebFetch, which
      // read the internet and touch neither the filesystem nor the shell.
      args.push('--tools', this.config.chatWebAccess ? 'WebSearch,WebFetch' : '');
      args.push('--strict-mcp-config');
    } else if (this.config.tools && this.config.tools.length > 0) {
      // ULTRACODE_PLAN.md — the WorkflowTool is a built-in available by default
      // (no --tools flag = all tools). We only need to intervene when a
      // restricted allowlist is set: ensure `Workflow` survives it, else the
      // ultracode keyword fires but the model has no tool to author with.
      const tools = this.config.ultracode && !this.config.tools.includes('Workflow')
        ? [...this.config.tools, 'Workflow']
        : this.config.tools;
      args.push('--tools', tools.join(','));
    }

    if (this.config.fallbackModel) {
      args.push('--fallback-model', this.config.fallbackModel);
    }

    if (this.config.additionalDirectories?.length) {
      args.push('--add-dir', ...this.config.additionalDirectories);
    }

    // CLUSTER_MODE_PLAN.md Phase 3 — CLI cluster members carry a per-spawn
    // `mcp-config.json` path. The CLI spawns its own MCP stdio child from
    // that config; the child translates `mcp__archon-cluster__peer_*` tool
    // calls into REST against `/api/clusters/:id/peer/...`. Per-turn
    // mailbox prologue + cluster plan + member role flow through
    // `--append-system-prompt` (handled above) — they are not the MCP
    // server's responsibility.
    if (this.config.interactionMode !== 'chat' && this.config.clusterMcpConfigPath) {
      args.push('--mcp-config', this.config.clusterMcpConfigPath);
    }

    // ARCHON_OPS_PLAN.md §E1 — dangerous-and-unticked MCP tools of the
    // workflow's operator-enabled registry servers. VERIFIED: --disallowedTools
    // composes with --dangerously-skip-permissions (the named tool is removed
    // from the model's available set entirely; non-listed tools of the same
    // server still work). So the dangerous-tool denylist is REAL on CLI Claude
    // even in AUTO mode, not a no-op.
    if (this.config.mcpDisallowedTools && this.config.mcpDisallowedTools.length > 0) {
      args.push('--disallowedTools', this.config.mcpDisallowedTools.join(','));
    }

    return args;
  }

  private wireEvents(): void {
    if (!this.parser) return;

    this.parser.on('init', (data) => {
      this._status = 'running';
      this._sawInit = true;
      // Slot 4 — successful init means the CLI connected to the API; clears
      // any stale throttle state. Subsequent errors can re-throttle.
      markAvailable('claude');
      this.emit('init', data);
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

    this.parser.on('tool_use', (data: { name: string; input: string }) => {
      this.emit('tool_use', data);
    });

    this.parser.on('result', (data: { text: string; costUsd: number; durationMs: number; usage?: Record<string, number> }) => {
      this._gotResult = true;
      this._status = 'completed';
      this._output = data.text;
      // ULTRACODE_PLAN.md — do NOT finalize the turn on this result. A background
      // workflow emits an early ack then (after the fleet finishes) the real
      // synthesis; only the last result before clean exit is canonical, flushed
      // in the exit handler. Hold this one; if a prior was held it's now
      // confirmed intermediate → surface as progress so the operator sees the
      // workflow advanced. Without this, WorkerManager settles on the first
      // (ack) result and the real answer is dropped.
      if (this.config.ultracode) {
        if (this._heldResult) {
          // A prior held result is now confirmed to be an interim ack (the
          // "launched the background workflow" preamble) — the fleet emitted a
          // newer, more complete result. Surface a terse marker so the operator
          // knows the workflow advanced, WITHOUT re-dumping the ack body (it
          // already streamed as primary_text during the turn; repeating 280
          // chars of it reads like a confusing duplicate answer).
          this.emit('system_notice', '[ultracode] interim launch ack superseded by the final fleet synthesis below');
        }
        this._heldResult = data;
        return;
      }
      // EFFICIENCY_PLAN.md Phase A — CLI doesn't expose its inner messages[]
      // to us. Emit the documented sentinel values: 0 thinking bytes,
      // -1 tool-result bytes (unknown). The Activity tab renders -1 as "—".
      this.emit('result', { ...data, thinkingBytes: 0, toolResultBytes: -1, toolResultBytesRaw: -1 });
    });

    this.parser.on('error', (error: string) => {
      this._status = 'failed';
      this._checkThrottle(error);
      this.emit('error', error);
    });

    // Transient API error in the stream. Surface as a chat-level system
    // notice (not as assistant text — the plan doc's top complaint was that
    // the raw error JSON rendered under ARCHON :: PASSTHROUGH). Mark the
    // signal so the exit handler can decide whether to retry — we don't
    // retry here because the CLI often continues streaming past the hiccup
    // and completes the turn on its own.
    this.parser.on('stream_error', (data: { errorType: string; message: string; transient: boolean }) => {
      // `authentication_error` = Anthropic 401. Hard stop (tokens are stale or
      // revoked; retry won't fix it). Prefix with `[AUTH:claude]` so the chat
      // renderer swaps in an inline RE-LOGIN action instead of the usual
      // system_notice italics. Do NOT set _lastTransientError — auth errors
      // must not trigger the retry path.
      if (data.errorType === 'authentication_error') {
        const detail = data.message || 'Invalid authentication credentials';
        this.emit('system_notice', `[AUTH:claude] Claude authentication failed: ${detail}. Re-login to continue.`);
        return;
      }
      const body = data.message ? `${data.errorType}: ${data.message}` : data.errorType;
      const suffix = data.transient ? ' — CLI is continuing; will retry on hard exit' : '';
      this.emit('system_notice', `Anthropic ${body}${suffix}`);
      if (data.transient) this._lastTransientError = data.errorType;
    });

    // stdout closes BEFORE the process exits. Settling here as `completed`
    // made every non-zero exit without a `result` look like an empty success,
    // so the retry ladder and the exit-code error almost never ran. Defer to
    // the exit handler; only a clean (or signal) exit settles as done.
    const proc = this.process;
    this.parser.on('done', () => {
      this._stdoutClosed = true;
      if (this._gotResult) return;
      if (!proc || this.process !== proc) return; // superseded by a retry
      if (proc.exitCode === null && proc.signalCode === null) {
        // Not exited yet — the exit handler settles. Backstop a CLI that
        // closes stdout but lingers, which the old path settled as done.
        setTimeout(() => {
          if (this.process !== proc || proc.exitCode !== null || proc.signalCode !== null) return;
          this._settleDone();
        }, 5000).unref();
        return;
      }
      // Already exited: non-zero is owned by the exit handler (retry/error).
      if (proc.exitCode === null || proc.exitCode === 0) this._settleDone();
    });
  }

  // No `result` event arrived but the turn ended cleanly — count it as a
  // completion with whatever text streamed.
  private _settleDone(): void {
    if (this._status !== 'running' && this._status !== 'spawning') return;
    this._gotResult = true;
    this._status = 'completed';
    this.emit('result', {
      text: this._output,
      costUsd: 0,
      durationMs: 0,
    });
  }

  // Slot 4 — called from error/exit paths. Inspects stderr + any error text
  // and flips the quota subsystem's claude state to throttled when a known
  // pattern matches. No-op otherwise.
  private _checkThrottle(extra?: string): void {
    const combined = [this._stderrBuf, extra].filter(Boolean).join('\n');
    const parsed = parseClaudeThrottle(combined);
    if (parsed) markThrottled('claude', combined.slice(-500), parsed.resetsAt);
  }
}

export const ClaudeProvider: Provider = {
  create(id, config) {
    return new ClaudeWorkerProcess(id, config);
  },
};
