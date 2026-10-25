// Stateless one-shot Cursor process for read-only primitives — Phase 5.
//
// Reviewer / fresh-summarizer / DOCS-doc-edit / research / compare all spawn a
// SHORT-LIVED, READ-ONLY worker off the primary path. On Cursor they must NOT go
// through the long-lived `CursorAcpWorker` (cached per workflowId): a primitive
// carries the INITIATING tab's workflowId, so reusing the ACP cache would run the
// primitive INSIDE the operator's live session — polluting the transcript, using
// the primary's model, and running read-write. Codex dodges this by being
// per-turn stateless (`codex exec -s read-only`); Cursor gets the same shape here
// via `cursor-agent -p` (print / headless), which opens its own throwaway session.
//
// Read-only is enforced by `--mode ask` ("Q&A style … (read-only)" per the CLI):
// the model can Read/Grep the tree to ground its answer but cannot write or run
// shell. `--force`/`--trust` keep it from hanging on a permission / workspace-trust
// prompt in headless mode. The dispatcher (providers/index.ts) routes here only
// when `config.sandbox === 'read-only'`, which primary turns never set.
//
// docs/CURSOR_TRANSPORT_PLAN.md Phase 5.

import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import type { WorkerConfig, WorkerStatus } from '@archon/shared';
import { killProcessTree } from '../../workers/processKill.js';
import type { Provider, ProviderProcess } from '../types.js';
import { goalBlock } from '../goalBlock.js';
import { attachmentDirs, withAttachmentRefs } from '../attachments.js';

const STDERR_CAP = 32 * 1024;

class CursorPrintProcess extends EventEmitter implements ProviderProcess {
  readonly id: string;
  private proc: ChildProcess | null = null;
  private _status: WorkerStatus = 'spawning';
  private _output = '';
  private stderrBuf = '';
  private settled = false;
  private startedAt = 0;

  constructor(id: string, private readonly config: WorkerConfig) {
    super();
    this.id = id;
  }

  get status(): WorkerStatus { return this._status; }
  get output(): string { return this._output; }
  get pid(): number | undefined { return this.proc?.pid; }

  spawn(prompt: string): void {
    this.startedAt = Date.now();
    const model = resolveModelId(this.config.model);

    // `-p` = print/headless. `--mode ask` = read-only Q&A (the safety contract).
    // `--force`+`--trust` avoid a headless hang on tool-permission / trust prompts
    // (both no-ops for writes, which ask-mode forbids outright). `--output-format
    // text` streams the plain assistant answer to stdout — no JSON envelope to
    // parse; incremental chunks map straight to `text` events.
    const args = ['-p', '--output-format', 'text', '--mode', 'ask', '--force', '--trust'];
    if (this.config.interactionMode === 'chat') args.push('--stream-partial-output');
    // Omit `--model` for auto so the CLI keeps its own default (there's no `auto`
    // model id to pass). Any concrete catalog id is passed through verbatim.
    if (model && model !== 'auto') args.push('--model', model);
    // `-p` has no image-input flag, so attachments go in as path refs and the
    // upload dir joins the workspace roots — ask-mode's read tool is fenced to
    // them, and it opens images natively. Chat tabs route here, so without
    // this a pasted screenshot never reached a Cursor chat.
    for (const dir of attachmentDirs(this.config.attachments)) args.push('--add-dir', dir);

    // Fold the operator's north-star + appendSystemPrompt (cluster plan/role, when
    // a cluster primitive supplies it) as a leading block, same ordering as the
    // ACP worker's beginTurn. goalBlock is null-when-empty so the default primitive
    // path is byte-identical to a bare prompt.
    const northStarBlock = goalBlock(this.config.goal);
    const append = this.config.appendSystemPrompt && this.config.appendSystemPrompt.trim()
      ? this.config.appendSystemPrompt
      : undefined;
    const prefix = northStarBlock
      ? append ? `${northStarBlock}\n\n${append}` : northStarBlock
      : append;
    const body = withAttachmentRefs(prompt, this.config.attachments ?? []);
    const fullPrompt = prefix ? `${prefix}\n\n---\n\n${body}` : body;

    this.proc = spawn('cursor-agent', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
      cwd: this.config.cwd || undefined,
      detached: true,
    });

    this.proc.on('error', (err) => this.fail(`cursor-agent spawn error: ${err.message}`));
    this.proc.on('exit', (code, signal) => this.onExit(code, signal));

    if (this.proc.stdout) {
      this.proc.stdout.on('data', (chunk: Buffer) => {
        if (this.settled) return;
        const t = chunk.toString();
        this._output += t;
        this.emit('text', t);
      });
    }
    if (this.proc.stderr) {
      this.proc.stderr.on('data', (chunk: Buffer) => {
        this.stderrBuf = (this.stderrBuf + chunk.toString()).slice(-STDERR_CAP);
      });
    }

    // Large primitives (a full transcript review) exceed argv limits, so the
    // prompt goes over stdin. cursor-agent -p reads stdin when no positional
    // prompt is supplied.
    if (this.proc.stdin) {
      this.proc.stdin.write(fullPrompt);
      this.proc.stdin.end();
    }

    this._status = 'running';
    this.emit('init', { model });
  }

  kill(): void {
    if (this.settled) return;
    const pid = this.proc?.pid;
    if (pid) killProcessTree(pid, { graceMs: 500, label: `cursor-print:${this.id.slice(0, 8)}` });
    this.fail('Worker killed');
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.settled) return;
    if (code === 0) {
      this.settled = true;
      this._status = 'completed';
      this.emit('result', {
        text: this._output,
        costUsd: 0,
        durationMs: Date.now() - this.startedAt,
        // ACP/print exposes no per-turn tokens or inner tool bytes — sentinels
        // (-1 = unknown) match the ACP worker + CLI/Codex convention.
        thinkingBytes: 0,
        toolResultBytes: -1,
        toolResultBytesRaw: -1,
      });
      return;
    }
    const reason = code !== null ? `exited ${code}` : `killed by ${signal ?? 'signal'}`;
    const tail = this.stderrBuf.trim().slice(-400);
    this.fail(`cursor-agent -p ${reason}${tail ? `: ${tail}` : ''}`);
  }

  private fail(reason: string): void {
    if (this.settled) return;
    this.settled = true;
    this._status = 'failed';
    this.emit('error', reason);
  }
}

function resolveModelId(model: string | undefined): string {
  return typeof model === 'string' && model.trim() ? model.trim() : 'auto';
}

export const CursorPrintProvider: Provider = {
  create(id, config) {
    return new CursorPrintProcess(id, config);
  },
};
