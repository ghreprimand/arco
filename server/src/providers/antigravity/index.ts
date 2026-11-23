import { resolve as resolvePath } from 'node:path';
import { findDiagnosticExecutable } from '../../diagnostics/executableLookup.js';
import { loadResearch, researcherFor } from '../../research/researchState.js';
import { setResearcherIsolation } from '../../research/researchRounds.js';
import { ensureResearchTripwires } from '../../research/researchTripwires.js';
import { PORT } from '../../server/constants.js';
import { prepareAntigravityIsolatedLaunch } from '../../workers/antigravityIsolatedLaunch.js';
import { GEMINI_RESEARCH_SIGN_IN_NEEDED, noteGeminiResearchSignInExpired, readGeminiResearchCredentials } from './researchSignIn.js';
import { historyBinding } from '../handoffHistoryBinding.js';
import { ensureClusterLoopbackMcp, closeClusterLoopbackMcp } from '../../mcp/clusterMcpLoopback.js';
import { prepareProviderAttachments } from '../providerFileContent.js';
import { noteAntigravityTurnSuccess, noteAntigravitySignInRequired } from './status.js';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, sep } from 'node:path';
import { arcoHome } from '../../arcoHome.js';
import { isIncognitoChatCwd, antigravityChatWorkspace } from '../../chatMode.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { WorkerConfig, WorkerStatus } from '@arco/shared';
import type { Provider, ProviderProcess } from '../types.js';
import { AcpJsonRpcClient, AcpReplyError, type IncomingRequest, type JsonRpcNotification } from '../acp/acpJsonRpc.js';
import { cancelAcpPermissions, requestAcpPermission } from '../acp/permissionGate.js';
import { commandArgs } from '../../windowsCommand.js';
import { killProcessTree } from '../../workers/processKill.js';
import { probeVersion } from '../../capabilities.js';
import { compareVersions } from '../../updateCheck.js';

export class AntigravitySubagentNotice {
  private shown = false;
  constructor(private version: string) {}
  observe(update: { sessionUpdate?: string; name?: string }): string | undefined {
    if (this.shown || update.sessionUpdate !== 'tool_call' || update.name !== 'invoke_subagent') return;
    const comparison = compareVersions(this.version, '1.5.15');
    if (comparison === null || comparison >= 0) return;
    this.shown = true;
    return 'This Antigravity CLI version can end the turn before sub-agents report. Update Antigravity from the Versions menu.';
  }
}

export function permittedAgyModel(id: string): boolean { return /^gemini-[a-z0-9.-]+$/.test(id); }

class AntigravityTurn extends EventEmitter implements ProviderProcess {
  private proc: ChildProcess | null = null;
  private rpc: AcpJsonRpcClient | null = null;
  private _status: WorkerStatus = 'spawning';
  private _output = '';
  private finished = false;
  private startedAt = 0;
  private contextSize: number | undefined;
  private contextUsed: number | undefined;
  constructor(readonly id: string, private config: WorkerConfig) { super(); }
  get status(): WorkerStatus { return this._status; }
  get output(): string { return this._output; }
  get pid(): number | undefined { return this.proc?.pid; }
  spawn(prompt: string): void { void this.run(prompt).catch(error => this.fail(error)); }
  private fail(error: unknown): void {
    if (this.finished) return;
    this.finished = true; this._status = 'failed';
    let message = error instanceof Error ? error.message : String(error);
    if (/authentication required|sign in to continue|login required/i.test(message)) {
      if (this.config.clusterAccessMode === 'researcher') { noteGeminiResearchSignInExpired(true); message = GEMINI_RESEARCH_SIGN_IN_NEEDED; }
      else noteAntigravitySignInRequired();
    }
    cancelAcpPermissions(this.config.workflowId ?? '');
    if (this.config.workflowId) closeClusterLoopbackMcp(this.config.workflowId);
    this.rpc?.close('turn finished');
    if (this.proc?.pid) killProcessTree(this.proc.pid, { graceMs: 1000, label: 'Antigravity turn' });
    this.emit('error', message);
  }
  kill(): void { this.fail(new Error('Turn cancelled.')); }
  // docs/RESEARCH.md "Gemini researchers": a researcher runs only inside the
  // worker fence, with its own copy of the separate research sign-in.
  private async prepareFence(workflowId: string): Promise<Awaited<ReturnType<typeof prepareAntigravityIsolatedLaunch>>> {
    const clusterId = this.config.clusterId;
    if (!clusterId || process.platform !== 'linux') throw new Error('Gemini researchers need the Linux worker sandbox.');
    const research = await loadResearch(clusterId);
    if (!research || !researcherFor(research, workflowId)) throw new Error('Research identity is unavailable.');
    const binary = findDiagnosticExecutable('agy');
    if (!binary) throw new Error('The Antigravity CLI is not installed.');
    const credentials = await readGeminiResearchCredentials();
    if (!credentials) throw new Error(GEMINI_RESEARCH_SIGN_IN_NEEDED);
    await ensureResearchTripwires(clusterId);
    await setResearcherIsolation(clusterId, workflowId, 'checking');
    const launch = await prepareAntigravityIsolatedLaunch({ clusterId, workflowId, directorWorkflowId: research.directorWorkflowId, arcoPort: PORT,
      binary: resolvePath(binary), credentials, webAccess: this.config.clusterWebAccess !== false });
    if (this.finished) { await launch.close(); throw new Error('Turn cancelled.'); }
    return launch;
  }
  private async run(prompt: string): Promise<void> {
    const workflowId = this.config.workflowId;
    if (!workflowId || this.config.antigravityInteractive !== true || this.config.interactionMode !== 'agent' || this.config.sandbox || this.config.voiceOperator) throw new Error('Antigravity runs only on an interactive message the operator sent.');
    if (!permittedAgyModel(this.config.model)) throw new Error('Antigravity requires a Gemini model.');
    const subagentNotice = new AntigravitySubagentNotice(await probeVersion('agy'));
    if (this.finished) return;
    const researcher = this.config.clusterAccessMode === 'researcher';
    let fenced: Awaited<ReturnType<typeof prepareAntigravityIsolatedLaunch>> | undefined;
    let cwd: string;
    if (researcher) {
      fenced = await this.prepareFence(workflowId);
      cwd = fenced.workspace;
      this.startedAt = Date.now();
    } else {
      if (!this.config.cwd) throw new Error('Antigravity needs the working folder chosen for this agent tab.');
      cwd = await realpath(this.config.cwd);
      const home = await realpath(arcoHome());
      const rel = relative(home, cwd);
      const insideHome = !rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep));
      let managedChat = false;
      if (this.config.antigravityChatWorkspace === true) {
        const expected = antigravityChatWorkspace(workflowId);
        const rootInfo = await lstat(dirname(expected));
        const folderInfo = await lstat(expected);
        managedChat = !rootInfo.isSymbolicLink() && folderInfo.isDirectory() && !folderInfo.isSymbolicLink() && cwd === await realpath(expected);
      }
      if ((insideHome && !managedChat) || isIncognitoChatCwd(cwd)) throw new Error('Antigravity cannot run inside the Arco home except its own Chat working folder.');
      if (this.config.antigravityChatWorkspace && !managedChat) throw new Error('The Antigravity Chat working folder does not match this Chat.');
      this.startedAt = Date.now();
    }
    const proc = fenced
      ? spawn(fenced.command.file, fenced.command.args, { cwd: '/', env: { PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
      : spawn(...commandArgs('agy', ['acp']), { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
    if (fenced) { const launch = fenced; proc.once('close', () => { void launch.close().catch(() => this.emit('system_notice', 'Worker isolation cleanup failed.')); }); }
    this.proc = proc;
    proc.once('error', error => this.fail(error));
    proc.once('exit', () => { if (!this.finished) this.fail(new Error('Antigravity ACP stopped during the turn.')); });
    proc.stderr?.resume();
    if (!proc.stdin || !proc.stdout) throw new Error('Antigravity ACP streams unavailable.');
    const rpc = this.rpc = new AcpJsonRpcClient(proc.stdin, proc.stdout);
    rpc.onRequest = async (request: IncomingRequest) => {
      if (request.method === 'session/request_permission') return requestAcpPermission(workflowId, request.params as Record<string, unknown>, this.config.skipPermissions === true);
      throw new AcpReplyError(-32601, `Method not supported: ${request.method}`);
    };
    rpc.on('notification', (notification: JsonRpcNotification) => {
      if (notification.method !== 'session/update') return;
      const update = (notification.params as { update?: Record<string, any> })?.update;
      if (!update || this._status !== 'running') return;
      if (update.sessionUpdate === 'agent_message_chunk' && typeof update.content?.text === 'string') { this._output += update.content.text; this.emit('text', update.content.text); }
      else if (update.sessionUpdate === 'agent_thought_chunk' && typeof update.content?.text === 'string') this.emit('thinking', update.content.text);
      else if (update.sessionUpdate === 'usage_update') { this.contextSize = typeof update.size === 'number' ? update.size : undefined; this.contextUsed = typeof update.used === 'number' ? update.used : undefined; }
      else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
        const notice = subagentNotice.observe(update);
        if (notice) this.emit('system_notice', notice);
        this.emit('tool_use', { id: update.toolCallId, name: update.name === 'invoke_subagent' ? 'invoke_subagent' : update.title ?? 'Antigravity tool', input: JSON.stringify(update.rawInput ?? {}), status: update.status === 'completed' ? 'completed' : update.status === 'failed' ? 'failed' : 'in_progress', ...(update.rawOutput !== undefined ? { output: JSON.stringify(update.rawOutput) } : {}) });
      }
    });
    await rpc.request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'Arco', version: '1' } });
    const bridge = fenced ? { name: 'arco-cluster', url: fenced.mailUrl } : await ensureClusterLoopbackMcp({
      workflowId, clusterId: this.config.clusterId ?? '', cwd,
      arcoPort: parseInt(process.env.ARCO_PORT || '3001', 10),
      taskBoardAttached: this.config.clusterTaskBoardAttached === true,
      accessMode: this.config.clusterAccessMode,
      researchDirector: this.config.clusterResearchDirector === true,
      registryServers: this.config.mcpRegistryServers,
      handoffHistoryToken: historyBinding(this.config)?.token,
      readOnly: this.config.sandbox === 'read-only',
    });
    if (this.finished) { closeClusterLoopbackMcp(workflowId); return; }
    const args = { cwd, mcpServers: [{ type: 'http', name: bridge.name, url: bridge.url, headers: [] }] };
    const result = await rpc.request<{ sessionId: string; configOptions?: Array<{ id: string; options?: Array<{ value: string }> }> }>(this.config.resumeSessionId ? 'session/load' : 'session/new', this.config.resumeSessionId ? { ...args, sessionId: this.config.resumeSessionId } : args);
    const mode = result.configOptions?.find(x => x.id === 'mode');
    if (mode?.options?.some(x => x.value === 'default')) await rpc.request('session/set_config_option', { sessionId: result.sessionId, configId: 'mode', value: 'default' });
    else throw new Error('Antigravity cannot set the interactive default mode.');
    const model = result.configOptions?.find(x => x.id === 'model');
    if (!model?.options?.some(x => x.value === this.config.model)) throw new Error('The selected Gemini model is not available in this ACP session.');
    const configured = await rpc.request<{ configOptions?: Array<{ id: string; options?: Array<{ value: string }> }> }>('session/set_config_option', { sessionId: result.sessionId, configId: 'model', value: this.config.model });
    const effort = (configured.configOptions ?? result.configOptions)?.find(x => x.id === 'thought_level');
    if (effort && !effort.options?.some(x => x.value === this.config.effort)) throw new Error('This thinking level is not offered for the selected Antigravity model.');
    if (effort) await rpc.request('session/set_config_option', { sessionId: result.sessionId, configId: 'thought_level', value: this.config.effort });
    this._status = 'running'; this.emit('init', { model: this.config.model, sessionId: result.sessionId });
    if (fenced && this.config.clusterId) void setResearcherIsolation(this.config.clusterId, workflowId, 'sandboxed').catch(() => undefined);
    const prepared = await prepareProviderAttachments(this.config.attachments, true, undefined, false, true);
    const content = [{ type: 'text', text: prompt }, ...(prepared.text ? [{ type: 'text', text: prepared.text }] : []), ...prepared.images.map(image => ({ type: 'image', mimeType: image.mediaType, data: image.data }))];
    const answer = await rpc.request<{ usage?: Record<string, number>; stopReason?: string }>('session/prompt', { sessionId: result.sessionId, prompt: content });
    if (answer.stopReason === 'cancelled') throw new Error('Turn cancelled.');
    if (this.finished) return;
    this.finished = true; this._status = 'completed'; if (this.config.clusterAccessMode === 'researcher') noteGeminiResearchSignInExpired(false); else noteAntigravityTurnSuccess();
    this.emit('result', { text: this._output, costUsd: 0, durationMs: Date.now() - this.startedAt, usage: answer.usage ? { input_tokens: answer.usage.inputTokens ?? 0, output_tokens: answer.usage.outputTokens ?? 0, cache_read_input_tokens: answer.usage.cachedReadTokens ?? 0, cache_creation_input_tokens: answer.usage.cachedWriteTokens ?? 0, reasoning_output_tokens: answer.usage.thoughtTokens ?? 0, total_tokens: answer.usage.totalTokens ?? 0 } : undefined, modelContextWindow: this.contextSize, lastPromptTokens: this.contextUsed });
    closeClusterLoopbackMcp(workflowId);
    rpc.close('turn completed'); if (proc.pid) killProcessTree(proc.pid, { graceMs: 1000, label: 'Antigravity turn' });
  }
}
export const AntigravityProvider: Provider = { create: (id, config) => new AntigravityTurn(id, config) };

const compactProcesses = new Map<string, ProviderProcess>();
export function registerAntigravityCompact(workflowId: string, process: ProviderProcess): void { compactProcesses.set(workflowId, process); }
export function clearAntigravityCompact(workflowId: string, process: ProviderProcess): void { if (compactProcesses.get(workflowId) === process) compactProcesses.delete(workflowId); }
export function cancelAntigravityCompact(workflowId: string): void { compactProcesses.get(workflowId)?.kill(); }
