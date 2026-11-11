import { prepareProviderHistory, historyBinding } from '../handoffHistoryBinding.js';
import { createChatSandbox, CHAT_FLAGS, CHAT_GUIDANCE } from './chatSandbox.js';
import { prepareProviderAttachments, persistProviderImages, FILE_READ_GUIDANCE, type PreparedAttachments } from '../providerFileContent.js';
import { createFilePlugin } from './filePlugin.js';
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
// docs/PROVIDERS.md

import { StringDecoder } from 'node:string_decoder';
import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import type { WorkerConfig, WorkerStatus } from '@arco/shared';
import { killProcessTree } from '../../workers/processKill.js';
import { isChildRunning } from '../../workers/processStartTime.js';
import type { Provider, ProviderProcess } from '../types.js';
import { goalBlock } from '../goalBlock.js';
import { outputStyleAddendum } from '../outputStyle.js';
import { attachmentDirs, withAttachmentRefs } from '../attachments.js';
import { commandArgs } from '../../windowsCommand.js';

const STDERR_CAP = 32 * 1024;

class CursorPrintProcess extends EventEmitter implements ProviderProcess {
  readonly id: string;
  private proc: ChildProcess | null = null;
  private _status: WorkerStatus = 'spawning';
  private _output = '';
  private stderrBuf = '';
  private stdoutDecoder = new StringDecoder('utf8');
  private stderrDecoder = new StringDecoder('utf8');
  private settled = false;
  private startedAt = 0;

  constructor(id: string, private readonly config: WorkerConfig) {
    super();
    this.id = id;
  }

  get status(): WorkerStatus { return this._status; }
  get output(): string { return this._output; }
  get pid(): number | undefined { return this.proc?.pid; }
  get processRunning(): boolean { return isChildRunning(this.proc); }

  private chatSandbox: Awaited<ReturnType<typeof createChatSandbox>> | undefined;

  private preparationAbort = new AbortController();

  private filePlugin: Awaited<ReturnType<typeof createFilePlugin>> | undefined;

  spawn(prompt: string): void {
    if (this.config.interactionMode !== 'chat' && !this.config.cwd && !this.config.attachments?.length) { this.spawnPrepared(prompt); return; }
    void this.prepare(prompt).catch(error => this.fail(String(error)));
  }

  private async prepare(prompt:string):Promise<void> {
    await prepareProviderHistory(this.config);
    if (this.settled) return;
    const prepared = await prepareProviderAttachments(this.config.attachments, true, this.preparationAbort.signal);
    if (this.settled) return;
    if (this.config.interactionMode === 'chat') this.chatSandbox = await createChatSandbox(prepared, this.preparationAbort.signal);
    const imagePaths = this.chatSandbox?.imagePaths ?? await persistProviderImages(prepared.images);
    if (this.config.cwd && this.config.interactionMode !== 'chat') this.filePlugin = await createFilePlugin(this.config.cwd, this.config.workflowId, historyBinding(this.config)?.token);
    if (this.settled) { await this.cleanup(); return; }
    this.spawnPrepared(prompt,prepared,imagePaths);
  }

  private spawnPrepared(prompt: string, prepared?: PreparedAttachments, imagePaths:string[] = []): void {
    this.startedAt = Date.now();
    const model = resolveModelId(this.config.model);

    // `-p` = print/headless. `--mode ask` = read-only Q&A (the safety contract).
    // Reviews retain --force; Chat has an empty tool allowlist and explicit
    // deny rules instead. `--output-format text` streams the assistant answer
    // to stdout — no JSON envelope to
    // parse; incremental chunks map straight to `text` events.
    const chat = this.config.interactionMode === 'chat';
    const args = ['-p', '--output-format', 'text', '--mode', 'ask', '--trust'];
    if (chat) args.push(...CHAT_FLAGS);
    else args.push('--force');
    // Partial-output deltas require stream-json; this transport consumes text.
    // Always pass the catalog id, `auto` included: `cursor-agent models` lists
    // `auto`, and without `--model` the CLI runs the model saved as its own
    // default instead of the one chosen in Arco. In print mode the CLI takes
    // catalog variant ids (`grok-4.7-medium`) directly.
    args.push('--model', model);
    if (chat) {
      for (const path of imagePaths) args.push('--image', path);
    } else {
      for (const dir of attachmentDirs([...(this.config.attachments ?? []), ...imagePaths])) args.push('--add-dir', dir);
    }

    // Fold the operator's north-star + appendSystemPrompt (cluster plan/role, when
    // a cluster primitive supplies it) as a leading block, same ordering as the
    // ACP worker's beginTurn. goalBlock is null-when-empty so the default primitive
    // path is byte-identical to a bare prompt.
    // The output-style addendum closes the prefix (null for normal).
    const prefixParts = [chat ? CHAT_GUIDANCE : undefined, goalBlock(this.config.goal), this.config.appendSystemPrompt, this.filePlugin ? FILE_READ_GUIDANCE : undefined, outputStyleAddendum(this.config.outputStyle)]
      .filter((s): s is string => typeof s === 'string' && s.trim().length > 0);
    const prefix = prefixParts.length > 0 ? prefixParts.join('\n\n') : undefined;
    const body = [prompt, prepared?.text, chat ? undefined : withAttachmentRefs('', imagePaths)].filter(Boolean).join('\n\n');
    if (this.filePlugin) args.push('--plugin-dir', this.filePlugin.path);
    const fullPrompt = prefix ? `${prefix}\n\n---\n\n${body}` : body;

    this.proc = spawn(...commandArgs('cursor-agent', args), {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
      cwd: this.chatSandbox?.cwd ?? (this.config.cwd || undefined),
      detached: true,
    });

    this.proc.stdin?.on('error', () => { /* Early exit: process events report the failure. */ });
    this.proc.on('error', (err) => this.fail(`cursor-agent spawn error: ${err.message}`));
    this.proc.on('close', (code, signal) => this.onExit(code, signal));

    if (this.proc.stdout) {
      this.proc.stdout.on('data', (chunk: Buffer) => {
        if (this.settled) return;
        const t = this.stdoutDecoder.write(chunk);
        this._output += t;
        this.emit('text', t);
      });
    }
    if (this.proc.stderr) {
      this.proc.stderr.on('data', (chunk: Buffer) => {
        this.stderrBuf = (this.stderrBuf + this.stderrDecoder.write(chunk)).slice(-STDERR_CAP);
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
    this.preparationAbort.abort();
    const pid = this.proc?.pid;
    if (pid) killProcessTree(pid, { graceMs: 500, label: `cursor-print:${this.id.slice(0, 8)}` });
    this.fail('Worker killed');
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.settled) return;
    void this.cleanup();
    const tail = this.stdoutDecoder.end();
    if (tail) { this._output += tail; this.emit('text', tail); }
    this.stderrBuf = (this.stderrBuf + this.stderrDecoder.end()).slice(-STDERR_CAP);
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
    const errorTail = this.stderrBuf.trim().slice(-400);
    const refusal = this.stderrBuf.match(/\[(?:invalid_argument|permission_denied|failed_precondition)\]\s+([^\r\n.!?]+)/i)?.[1]?.trim();
    if (this.config.interactionMode === 'chat' && refusal && /not allowed|not enabled|not available|not supported|permission|access|account|team|model/i.test(refusal)) {
      this.fail(`Cursor refused this Chat request: ${refusal}.`); return;
    }
    this.fail(`cursor-agent -p ${reason}${errorTail ? `: ${errorTail}` : ''}`);
  }

  private async cleanup(): Promise<void> {
    await Promise.all([this.filePlugin?.close(), this.chatSandbox?.close()]);
  }

  private fail(reason: string): void {
    void this.cleanup();
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
