// Fenced Cursor transport for researchers and isolated cluster members.
//
// Cursor applies its own sandbox only in print mode; its ACP mode ignores it.
// Each turn therefore runs one `cursor-agent --print` process inside Arco's
// Linux fence, with Cursor's sandbox limiting the agent's shell and file tools
// to the workspace. The conversation continues across turns with `--resume`.
// Ordinary Cursor tabs and members keep the ACP worker. docs/PROVIDERS.md

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { resolve as resolvePath } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { buildTurnWaitInstructions, type WorkerConfig, type WorkerStatus } from '@arco/shared';
import { findDiagnosticExecutable } from '../../diagnostics/executableLookup.js';
import { loadResearch, researcherFor } from '../../research/researchState.js';
import { setResearcherIsolation } from '../../research/researchRounds.js';
import { ensureResearchTripwires, observeResearchText } from '../../research/researchTripwires.js';
import { PORT } from '../../server/constants.js';
import { prepareCursorIsolatedLaunch } from '../../workers/cursorIsolatedLaunch.js';
import { killProcessTree } from '../../workers/processKill.js';
import { isChildRunning } from '../../workers/processStartTime.js';
import { goalBlock } from '../goalBlock.js';
import { outputStyleAddendum } from '../outputStyle.js';
import { prepareProviderAttachments } from '../providerFileContent.js';
import type { Provider, ProviderProcess } from '../types.js';
import { readCursorAccessToken } from './authToken.js';
import { cursorIsolationVersionReason, installedCursorRuntimeVersion } from './isolatedVersion.js';

const STDERR_CAP = 32 * 1024;
const LINE_CAP = 4 * 1024 * 1024;
const TOOL_TEXT_CAP = 4 * 1024;
const SELF_CHECK_FAILED = 'Worker isolation self-check failed.';

type Line = Record<string, unknown>;

function record(value: unknown): Line | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Line : undefined;
}

function clip(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return text.length > TOOL_TEXT_CAP ? `${text.slice(0, TOOL_TEXT_CAP)}...` : text;
}

/** `shellToolCall` -> `Shell`; unknown shapes keep their key. */
export function cursorToolName(key: string): string {
  const base = key.replace(/ToolCall$/, '');
  return base ? base[0].toUpperCase() + base.slice(1) : key;
}

/** Map Cursor's stream-json usage to the token fields the turn engine reads. */
export function cursorUsage(value: unknown): Record<string, number> | undefined {
  const usage = record(value);
  if (!usage) return undefined;
  const out: Record<string, number> = {};
  for (const [from, to] of [['inputTokens', 'input_tokens'], ['outputTokens', 'output_tokens'], ['cacheReadTokens', 'cache_read_input_tokens'], ['cacheWriteTokens', 'cache_creation_input_tokens']] as const) {
    if (typeof usage[from] === 'number' && Number.isFinite(usage[from])) out[to] = usage[from] as number;
  }
  return Object.keys(out).length ? out : undefined;
}

class CursorIsolatedProcess extends EventEmitter implements ProviderProcess {
  readonly id: string;
  private proc: ChildProcess | null = null;
  private _status: WorkerStatus = 'spawning';
  private _output = '';
  private stderr = '';
  private buffer = '';
  private decoder = new StringDecoder('utf8');
  private settled = false;
  private sawInit = false;
  private sawResult = false;
  private startedAt = 0;
  private resumeFailedOnce = false;
  private abort = new AbortController();
  private cleanup: Promise<void> = Promise.resolve();
  private prompt = '';
  private withdrawPass: (() => Promise<void>) | undefined;

  constructor(id: string, private readonly config: WorkerConfig) {
    super();
    this.id = id;
  }

  get status(): WorkerStatus { return this._status; }
  get output(): string { return this._output; }
  get pid(): number | undefined { return this.proc?.pid; }
  get processRunning(): boolean { return isChildRunning(this.proc); }

  spawn(prompt: string): void {
    this.prompt = prompt;
    this.startedAt = Date.now();
    void this.launch(this.config.resumeSessionId).catch(error => this.fail(String(error instanceof Error ? error.message : error), true));
  }

  private async launch(resumeSessionId: string | undefined): Promise<void> {
    await this.cleanup;
    if (this.settled) return;
    const { clusterId, workflowId, clusterAccessMode } = this.config;
    if (!clusterId || !workflowId || (clusterAccessMode !== 'isolated' && clusterAccessMode !== 'researcher')) throw new Error('Cursor isolation is unavailable.');
    const binary = findDiagnosticExecutable('cursor-agent');
    if (!binary) throw new Error('Cursor is not installed.');
    const versionReason = cursorIsolationVersionReason(installedCursorRuntimeVersion(binary));
    if (versionReason) throw new Error(versionReason);
    const research = clusterAccessMode === 'researcher' ? await loadResearch(clusterId) : null;
    if (clusterAccessMode === 'researcher' && (!research || !researcherFor(research, workflowId))) throw new Error('Research identity is unavailable.');
    if (research) {
      await ensureResearchTripwires(clusterId);
      await setResearcherIsolation(clusterId, workflowId, 'checking');
    }
    const token = await readCursorAccessToken();
    if (token.token === null) throw new Error(`Cursor sign-in needs renewing. ${token.detail ?? 'Sign in to Cursor again from Connections.'}`);
    let attachmentText = '';
    if (this.config.attachments?.length) {
      const prepared = await prepareProviderAttachments(this.config.attachments, false, this.abort.signal, false, true);
      attachmentText = prepared.text;
    }
    if (this.settled) return;
    const args = ['--model', typeof this.config.model === 'string' && this.config.model.trim() ? this.config.model.trim() : 'auto'];
    if (resumeSessionId) args.push('--resume', resumeSessionId);
    const launch = await prepareCursorIsolatedLaunch({
      clusterId, workflowId, arcoPort: PORT, binary: resolvePath(binary), credentials: { accessToken: token.token },
      webAccess: this.config.clusterWebAccess !== false, args,
      ...(research ? { mode: 'researcher' as const, directorWorkflowId: research.directorWorkflowId } : { mode: 'isolated' as const }),
    });
    if (this.settled) { await launch.close(); return; }
    const prefix = [buildTurnWaitInstructions(this.config.clusterRole), goalBlock(this.config.goal), this.config.appendSystemPrompt, outputStyleAddendum(this.config.outputStyle)]
      .filter((part): part is string => typeof part === 'string' && part.trim().length > 0).join('\n\n');
    const body = [this.prompt, attachmentText].filter(Boolean).join('\n\n');
    // A resumed conversation already holds the instructions; they are sent again
    // because Arco may have changed the role, plan or goal since the last turn.
    const fullPrompt = prefix ? `${prefix}\n\n---\n\n${body}` : body;
    try {
      this.proc = spawn(launch.command.file, launch.command.args, { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin' }, cwd: '/', detached: true });
    } catch (error) { await launch.close(); throw error; }
    const proc = this.proc;
    this.withdrawPass = launch.withdrawPass;
    this.cleanup = new Promise<void>((resolve) => {
      proc.once('close', () => { void launch.close().catch(() => this.emit('system_notice', 'Worker isolation cleanup failed.')).finally(resolve); });
    });
    this._status = 'running';
    proc.stdin?.on('error', () => { /* Early exit: process events report the failure. */ });
    proc.on('error', (error) => this.fail(`cursor-agent spawn error: ${error.message}`, true));
    proc.on('close', (code, signal) => this.onExit(code, signal, resumeSessionId));
    proc.stdout?.on('data', (chunk: Buffer) => this.onStdout(chunk));
    proc.stderr?.on('data', (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString()).slice(-STDERR_CAP); });
    proc.stdin?.end(fullPrompt);
  }

  private onStdout(chunk: Buffer): void {
    if (this.settled) return;
    this.buffer += this.decoder.write(chunk);
    if (this.buffer.length > LINE_CAP) { this.kill(); return; }
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) this.onLine(line);
    }
  }

  private markSandboxed(): void {
    const { clusterId, workflowId, clusterAccessMode } = this.config;
    if (!workflowId) return;
    if (clusterAccessMode === 'isolated') void import('../../clusterStore.js').then(({ setMemberFenceState }) => setMemberFenceState(workflowId, 'sandboxed')).catch(() => undefined);
    if (clusterAccessMode === 'researcher' && clusterId) void setResearcherIsolation(clusterId, workflowId, 'sandboxed').catch(() => undefined);
  }

  private observe(text: string, channel: string): void {
    if (this.config.clusterAccessMode === 'researcher' && this.config.workflowId) observeResearchText(this.config.clusterId, this.config.workflowId, text, false, channel);
  }

  private onLine(line: string): void {
    let event: Line;
    try { event = JSON.parse(line) as Line; } catch { return; }
    const type = event.type;
    if (type === 'system' && event.subtype === 'init') {
      // The agent has read its sign-in before it reports the start. Empty the
      // pass before the model can call a tool; if that fails, stop the turn.
      if (!this.sawInit) {
        const withdraw = this.withdrawPass;
        this.withdrawPass = undefined;
        if (withdraw) void withdraw().catch(() => { this.kill('The Cursor sign-in could not be removed from the sandbox; the turn was stopped.'); });
        this.markSandboxed();
      }
      this.sawInit = true;
      this.emit('init', { model: typeof event.model === 'string' ? event.model : undefined, sessionId: typeof event.session_id === 'string' ? event.session_id : undefined });
      return;
    }
    if (type === 'thinking' && event.subtype === 'delta' && typeof event.text === 'string') { this.emit('thinking', event.text); return; }
    if (type === 'assistant') {
      const content = record(event.message)?.content;
      const text = Array.isArray(content) ? content.map(part => record(part)?.type === 'text' && typeof record(part)?.text === 'string' ? record(part)!.text as string : '').join('') : '';
      if (text) { this._output += text; this.observe(text, 'text'); this.emit('text', text); }
      return;
    }
    if (type === 'tool_call') {
      const call = record(event.tool_call);
      const key = call ? Object.keys(call)[0] : undefined;
      const detail = key ? record(call![key]) : undefined;
      if (!key || !detail) return;
      const completed = event.subtype === 'completed';
      const result = record(detail.result);
      const output = completed ? clip(result?.success ?? result?.rejected ?? result?.error ?? result) : undefined;
      if (output) this.observe(output, 'tool');
      this.emit('tool_use', {
        id: typeof event.call_id === 'string' ? event.call_id : undefined,
        name: cursorToolName(key),
        input: clip(detail.args),
        status: completed ? (result?.success ? 'completed' : 'failed') : 'started',
        provider: 'cursor',
        ...(output ? { output } : {}),
      });
      return;
    }
    if (type === 'result') {
      this.sawResult = true;
      if (event.is_error === true) { this.fail(typeof event.result === 'string' && event.result ? event.result : 'Cursor reported an error.'); return; }
      this.settled = true;
      this._status = 'completed';
      const usage = cursorUsage(event.usage);
      this.emit('result', {
        text: typeof event.result === 'string' ? event.result : this._output,
        costUsd: 0,
        durationMs: typeof event.duration_ms === 'number' ? event.duration_ms : Date.now() - this.startedAt,
        ...(usage ? { usage } : {}),
        thinkingBytes: 0,
        toolResultBytes: -1,
        toolResultBytesRaw: -1,
      });
    }
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null, resumeSessionId: string | undefined): void {
    const tail = this.decoder.end();
    if (tail) this.buffer += tail;
    if (this.buffer.trim() && !this.settled) this.onLine(this.buffer.trim());
    this.buffer = '';
    if (this.settled) return;
    // A saved conversation can be missing after the private home was replaced.
    // Start a new one once, but never after a failed fence self-check.
    if (resumeSessionId && !this.sawInit && !this.resumeFailedOnce && !this.stderr.includes(SELF_CHECK_FAILED) && !this.abort.signal.aborted) {
      this.resumeFailedOnce = true;
      this.stderr = '';
      this.proc = null;
      this.emit('system_notice', 'Cursor could not continue the earlier conversation; this turn starts a new one.');
      void this.launch(undefined).catch(error => this.fail(String(error instanceof Error ? error.message : error), true));
      return;
    }
    const reason = code !== null ? `exited ${code}` : `killed by ${signal ?? 'signal'}`;
    const errorTail = this.stderr.trim().slice(-400);
    this.fail(this.stderr.includes(SELF_CHECK_FAILED)
      ? 'Sandbox could not start; check Cursor, bubblewrap and socat.'
      : `cursor-agent ${reason}${errorTail ? `: ${errorTail}` : ''}`, !this.sawInit);
  }

  kill(reason = 'Worker killed'): void {
    this.abort.abort();
    const pid = this.proc?.pid;
    if (pid && !this.settled) killProcessTree(pid, { graceMs: 500, label: `cursor-isolated:${this.id.slice(0, 8)}` });
    this.fail(reason);
  }

  private fail(reason: string, beforeStart = false): void {
    if (this.settled) return;
    this.settled = true;
    this._status = 'failed';
    const { workflowId, clusterAccessMode } = this.config;
    if (beforeStart && clusterAccessMode === 'isolated' && workflowId && reason !== 'Worker killed') {
      const fence = /sign-in needs renewing/i.test(reason) ? 'Cursor sign-in needs renewing.' : /needs Cursor/.test(reason) ? reason : 'Sandbox could not start; check Cursor, bubblewrap and socat.';
      void import('../../clusterStore.js').then(({ setMemberFenceState }) => setMemberFenceState(workflowId, 'unavailable', fence)).catch(() => undefined);
    }
    if (/sign-in needs renewing/i.test(reason)) this.emit('system_notice', '[AUTH:cursor] Cursor sign-in needs renewing. Re-login to continue.');
    this.emit('error', reason);
  }
}

export const CursorIsolatedProvider: Provider = {
  create(id, config) {
    return new CursorIsolatedProcess(id, config);
  },
};
