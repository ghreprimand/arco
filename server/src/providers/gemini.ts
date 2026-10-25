import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { readdir, readFile } from 'fs/promises';
import { homedir } from 'os';
import { join, resolve as resolvePath } from 'path';
import { GeminiStreamParser } from './gemini-stream.js';
import { killProcessTree } from '../workers/processKill.js';
import { MAX_WORKER_OUTPUT_BYTES, OUTPUT_TRUNCATION_NOTICE } from '../workers/limits.js';
import { markThrottled, markAvailable } from '../quota.js';
import type { SessionInfo, WorkerConfig, WorkerStatus } from '@archon/shared';
import type { Provider, ProviderProcess } from './types.js';
import { attachmentDirs, withAttachmentRefs } from './attachments.js';

const GEMINI_TMP_ROOT = join(homedir(), '.gemini', 'tmp');
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// `gemini --list-sessions` lines look like:
//   "  21. Understand the Archon project. (Just now) [94200341-12ff-4a02-8c0c-8f9aaf5979fa]"
// We match the leading index + trailing UUID and ignore everything between
// (preview text + relative time) so wording drifts in the CLI don't break us.
const LIST_SESSIONS_LINE = /^\s*(\d+)\.\s+.*\[([0-9a-f-]{36})\]\s*$/i;

// Slot 4 — Gemini throttle detection. Signals surface as HTTP 429 in stderr,
// "quota exceeded" / "RESOURCE_EXHAUSTED" from the API error JSON, or daily-
// quota messages. Retry-After parses to an explicit resetsAt; daily quotas
// default to midnight UTC; other throttles leave resetsAt undefined.
export function parseGeminiThrottle(text: string): { resetsAt?: number } | null {
  if (!text) return null;
  const has429 = /\b429\b/.test(text);
  const looksExhausted =
    /quota (exceeded|exhausted)/i.test(text) ||
    /resource[_ ]exhausted/i.test(text) ||
    /rate limit/i.test(text) ||
    /too many requests/i.test(text) ||
    /daily quota/i.test(text);
  if (!has429 && !looksExhausted) return null;
  const retryAfter = /Retry-After:?\s*(\d+)/i.exec(text);
  if (retryAfter) return { resetsAt: Date.now() + parseInt(retryAfter[1], 10) * 1000 };
  const retryInSeconds = /"retryDelay":\s*"(\d+)s"/i.exec(text);
  if (retryInSeconds) return { resetsAt: Date.now() + parseInt(retryInSeconds[1], 10) * 1000 };
  if (/daily quota|resets at midnight/i.test(text)) {
    const now = new Date();
    const tomorrow = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0);
    return { resetsAt: tomorrow };
  }
  return {};
}

class GeminiWorkerProcess extends EventEmitter implements ProviderProcess {
  readonly id: string;
  readonly config: WorkerConfig;
  private process: ChildProcess | null = null;
  private parser: GeminiStreamParser | null = null;
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
    // Resume index lookup is async (`gemini --list-sessions` shellout). The
    // ProviderProcess interface is sync; we kick off resolution then spawn
    // off the back of the same call, surfacing failures via the 'error'
    // event the same way other providers do.
    void this.spawnAsync(prompt);
  }

  private async spawnAsync(prompt: string): Promise<void> {
    let resumeIndex: string | null = null;
    if (this.config.resumeSessionId) {
      resumeIndex = await resolveGeminiResumeIndex(
        this.config.resumeSessionId,
        this.config.cwd ?? process.cwd(),
      );
      // kill() during the `--list-sessions` shellout already settled this
      // turn as failed; spawning now would start a real `gemini --yolo`
      // whose pid nobody registered (orphan running after the cancel).
      if (this._status !== 'spawning') return;
      if (!resumeIndex) {
        this._status = 'failed';
        this.emit(
          'error',
          `Gemini resume failed: session ${this.config.resumeSessionId.slice(0, 8)} not found in --list-sessions for this cwd. The session may have been deleted, or the cwd's project mapping changed.`,
        );
        return;
      }
    }
    const args = this.buildArgs(resumeIndex);
    // Phase B — gemini CLI has no --append-system-prompt flag; GEMINI_SYSTEM_MD
    // pins the system prompt but is not a per-spawn injection channel. Under
    // the OAuth auth path gemini doesn't cache anyway (Probe 6 — cached=0
    // regardless of prefix stability), so prepending the transcript to stdin
    // is quality-only: the worker sees the conversation history but every
    // spawn pays full input price. Phase G flips to API-key auth + enables
    // caching; until then, we accept the cost for the continuity benefit.
    //
    // On resume, the CLI loads the prior transcript natively via -r <index>.
    // Skip the prepend so we don't double-feed history (and double-pay tokens).
    // Attachments go in as path refs: gemini's read_file ingests images/PDFs
    // natively, and buildArgs adds the upload dirs to --include-directories so
    // the workspace fence doesn't refuse them. Previously dropped outright.
    const promptWithAttachments = withAttachmentRefs(prompt, this.config.attachments ?? []);
    const fullPrompt = (this.config.appendSystemPrompt && !resumeIndex)
      ? `${this.config.appendSystemPrompt}\n\n---\n\n${promptWithAttachments}`
      : promptWithAttachments;

    this.process = spawn('gemini', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
      cwd: this.config.cwd || undefined,
      // detached:true → child is its own process group, so killProcessTree
      // can take down descendants (runaway find/du/etc.) on cancel or RSS cap.
      detached: true,
    });

    this.parser = new GeminiStreamParser();
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
      // failures (rate limits, OAuth refresh, model mismatch) are otherwise
      // invisible to the operator. Helps diagnose Gemini's slow-no-output
      // moments by showing what the CLI is actually doing. Also accumulate
      // for throttle detection (Slot 4).
      this.process.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        this._stderrBuf += text;
        if (this._stderrBuf.length > 64 * 1024) this._stderrBuf = this._stderrBuf.slice(-32 * 1024);
        process.stderr.write(`[worker:${this.id}:stderr] ${text}`);
      });
    }

    this.process.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      if (this._status === 'running' || this._status === 'spawning') {
        // code===null ⇒ killed by a signal we didn't send (external SIGKILL,
        // OOM killer) — kill() settles first, so reaching here is abnormal.
        // Previously treated as success and the partial output shipped as a
        // completed turn.
        if (code !== 0) {
          this._status = 'failed';
          this._checkThrottle();
          this.emit('error', code === null
            ? `Process terminated by signal ${signal ?? 'unknown'}`
            : `Process exited with code ${code}`);
        }
      }
    });

    this.process.on('error', (err: Error) => {
      this._status = 'failed';
      this._checkThrottle(err.message);
      this.emit('error', `Failed to spawn gemini: ${err.message}`);
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

  private buildArgs(resumeIndex: string | null): string[] {
    // Empty -p flag activates headless/non-interactive mode; actual prompt is
    // fed via stdin for symmetry with the Claude provider and to dodge
    // ARG_MAX limits on large prompts.
    const args = [
      '-p', '',
      '--output-format', 'stream-json',
    ];

    // Resume from a prior session. Gemini CLI's `-r` takes an INDEX (or
    // "latest"), not a UUID — indexes shift when sessions are added or
    // deleted, so the caller resolves UUID→index against `--list-sessions`
    // immediately before this build (resolveGeminiResumeIndex). Passing
    // the index by string is correct: --resume's type is `string`.
    if (resumeIndex) {
      args.push('-r', resumeIndex);
    }

    // Map Claude aliases to Gemini defaults so an orchestrator that speaks in
    // haiku/sonnet/opus still dispatches a reasonable Gemini worker. If the
    // orchestrator already specified a Gemini model ID (e.g. gemini-2.5-pro),
    // pass it through.
    const resolvedModel = resolveGeminiModel(this.config.model);
    args.push('-m', resolvedModel);

    // Gemini's equivalent of --dangerously-skip-permissions.
    if (this.config.skipPermissions) {
      args.push('--yolo');
    }

    const includeDirs = [...new Set([
      ...(this.config.additionalDirectories ?? []),
      ...attachmentDirs(this.config.attachments),
    ])];
    if (includeDirs.length > 0) {
      args.push('--include-directories', includeDirs.join(','));
    }

    // Effort, fallback-model, custom system-prompt, tool whitelist: no direct
    // Gemini CLI equivalent. Ignored for this first pass — UI can dim those
    // chips when a Gemini worker is selected.

    return args;
  }

  private wireEvents(): void {
    if (!this.parser) return;

    this.parser.on('init', (data) => {
      this._status = 'running';
      markAvailable('gemini');
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

    this.parser.on('tool_use', (data: { name: string; input: string }) => {
      this.emit('tool_use', data);
    });

    this.parser.on('result', (data: { text: string; costUsd: number; durationMs: number; usage?: Record<string, number> }) => {
      this._status = 'completed';
      this._output = data.text;
      this.emit('result', data);
    });

    this.parser.on('error', (error: string) => {
      this._status = 'failed';
      this._checkThrottle(error);
      this.emit('error', error);
    });

    this.parser.on('done', () => {
      // stdout can end before 'exit' fires; a signal death must not be read
      // as success, so defer the verdict until the exit status is known.
      const proc = this.process;
      if (proc && proc.exitCode === null && proc.signalCode === null) {
        proc.once('exit', () => this.settleOnStreamDone());
        return;
      }
      this.settleOnStreamDone();
    });
  }

  // The exit handler (registered first) has already failed a non-zero/signal
  // exit by the time this runs, so only a clean exit reaches the result.
  private settleOnStreamDone(): void {
    if (this._status === 'running' || this._status === 'spawning') {
      this._status = 'completed';
      this.emit('result', {
        text: this._output,
        costUsd: 0,
        durationMs: 0,
      });
    }
  }

  private _checkThrottle(extra?: string): void {
    const combined = [this._stderrBuf, extra].filter(Boolean).join('\n');
    const parsed = parseGeminiThrottle(combined);
    if (parsed) markThrottled('gemini', combined.slice(-500), parsed.resetsAt);
  }
}

function resolveGeminiModel(model: string): string {
  // 2.5 family is dropped from the system — if the orchestrator picks it (stale
  // catalog / training priors), coerce to the 3.x equivalent.
  if (model === 'gemini-2.5-pro') return 'gemini-3.1-pro-preview';
  if (model === 'gemini-2.5-flash') return 'gemini-3-flash-preview';
  if (model === 'gemini-2.5-flash-lite') return 'gemini-3.1-flash-lite-preview';
  if (model.startsWith('gemini-')) return model;
  if (model === 'haiku') return 'gemini-3.1-flash-lite-preview';
  if (model === 'sonnet') return 'gemini-3-flash-preview';
  if (model === 'opus' || model === 'opus[1m]') return 'gemini-3.1-pro-preview';
  return 'gemini-3-flash-preview';
}

export const GeminiProvider: Provider = {
  create(id, config) {
    return new GeminiWorkerProcess(id, config);
  },
};

// Walk ~/.gemini/tmp/* looking for project dirs whose `.project_root` matches
// the requested cwd. Each match holds chats/session-<ts>-<short-uuid>.json
// with the full sessionId in the JSON body, so we don't depend on the
// directory-naming convention (sometimes basename, sometimes a sha hash —
// Gemini picks one when there'd be a basename collision across projects).
//
// Output shape mirrors discoverClaudeSessions / discoverCodexSessions so
// discoverSessions() can concat all three. UUID validation matches the
// existing Codex/Claude path so the picker's UUID_PATTERN check at workflow
// creation accepts what we surface here.
interface GeminiSessionFile {
  sessionId?: string;
  startTime?: string;
  lastUpdated?: string;
  messages?: Array<{
    type?: string;
    content?: unknown;
    timestamp?: string;
  }>;
  kind?: string;
}

export async function discoverGeminiSessions(resolvedCwd: string): Promise<SessionInfo[]> {
  let projectDirs: string[];
  try {
    projectDirs = await readdir(GEMINI_TMP_ROOT);
  } catch {
    return [];
  }
  const matchingChatsDirs: string[] = [];
  await Promise.all(projectDirs.map(async (name) => {
    const projectRootPath = join(GEMINI_TMP_ROOT, name, '.project_root');
    try {
      const root = (await readFile(projectRootPath, 'utf-8')).trim();
      if (resolvePath(root) === resolvedCwd) {
        matchingChatsDirs.push(join(GEMINI_TMP_ROOT, name, 'chats'));
      }
    } catch {
      /* not a project dir, or unreadable — skip */
    }
  }));
  if (matchingChatsDirs.length === 0) return [];

  const out: SessionInfo[] = [];
  for (const chatsDir of matchingChatsDirs) {
    let files: string[];
    try {
      files = await readdir(chatsDir);
    } catch {
      continue;
    }
    await Promise.all(files.map(async (file) => {
      if (!file.startsWith('session-') || !file.endsWith('.json')) return;
      try {
        const raw = await readFile(join(chatsDir, file), 'utf-8');
        const data = JSON.parse(raw) as GeminiSessionFile;
        // Sub-session shapes ('checkpoint', 'restore') aren't directly
        // resumable from the picker — only `kind: 'main'` is the operator
        // conversation. Older files may omit `kind`; treat that as main.
        if (data.kind && data.kind !== 'main') return;
        if (!data.sessionId || !UUID_PATTERN.test(data.sessionId)) return;
        const startedAt = data.startTime ? Date.parse(data.startTime) : 0;
        if (!Number.isFinite(startedAt)) return;
        const messages = Array.isArray(data.messages) ? data.messages : [];
        out.push({
          sessionId: data.sessionId,
          cwd: resolvedCwd,
          name: extractGeminiUserPreview(messages, 'first'),
          startedAt,
          provider: 'gemini',
          lastUserPreview: extractGeminiUserPreview(messages, 'last'),
        });
      } catch {
        /* malformed session file — skip */
      }
    }));
  }
  return out;
}

// Pick the first or last user message and shape it like the Claude/Codex
// previews (one line, ≤80 chars). Gemini stores user content as an array
// of `{ text }` parts; assistant content is a string. We only care about
// user-typed text.
function extractGeminiUserPreview(
  messages: NonNullable<GeminiSessionFile['messages']>,
  pick: 'first' | 'last',
): string {
  const iterate = pick === 'first' ? messages : [...messages].reverse();
  for (const m of iterate) {
    if (m?.type !== 'user' || !m.content) continue;
    let text = '';
    if (Array.isArray(m.content)) {
      const part = m.content.find((p): p is { text: string } => typeof (p as { text?: unknown })?.text === 'string');
      if (part) text = part.text;
    } else if (typeof m.content === 'string') {
      text = m.content;
    }
    text = text.trim().replace(/\s+/g, ' ').slice(0, 80);
    if (text) return text;
  }
  return '';
}

// Map a stored Gemini session UUID back to its current `--list-sessions`
// index. Indexes are unstable — they renumber when sessions are deleted or
// added — so we re-resolve at every resume rather than caching. Returns the
// index as a string (suitable for `gemini -r <index>`), or null if the
// session no longer exists in the cwd's project scope.
export async function resolveGeminiResumeIndex(sessionId: string, cwd: string): Promise<string | null> {
  return new Promise((done) => {
    let buf = '';
    let settled = false;
    const finish = (val: string | null) => {
      if (settled) return;
      settled = true;
      done(val);
    };
    const proc = spawn('gemini', ['--list-sessions'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: process.env,
    });
    proc.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf-8');
    });
    proc.on('close', () => {
      for (const line of buf.split('\n')) {
        const m = LIST_SESSIONS_LINE.exec(line);
        if (m && m[2].toLowerCase() === sessionId.toLowerCase()) {
          finish(m[1]);
          return;
        }
      }
      finish(null);
    });
    proc.on('error', () => finish(null));
    // Hard cap. `gemini --list-sessions` is metadata-only and normally
    // sub-second; 5s catches a hung gemini process without making the
    // operator wait minutes for a "resume failed" error.
    setTimeout(() => {
      try { proc.kill(); } catch { /* already gone */ }
      finish(null);
    }, 5000);
  });
}
