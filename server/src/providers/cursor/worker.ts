// Long-lived Cursor (ACP) worker, cached per workflowId. Spawns
// `cursor-agent acp`, drives the Agent Client Protocol handshake, and adapts
// its "streams forever" surface to the per-turn events the CursorAcpTurn
// wrapper (index.ts) re-emits as an Archon ProviderProcess.
//
// Simpler than the Codex app-server worker it was forked from: ACP's
// `session/prompt` is a REQUEST that RESOLVES with `{stopReason}` when the turn
// ends, so turn-completion is the promise resolving — there is no separate
// turn/completed notification to correlate. Notifications carry only the
// streaming deltas (text / thinking / tool calls). The one genuinely new wrinkle
// vs Codex is that ACP is bidirectional: the agent sends fs / permission /
// terminal REQUESTS back mid-turn, answered in `handleAgentRequest`.
//
// Wire contract pinned by the Phase-0 spike — docs/CURSOR_TRANSPORT_PLAN.md §0.1.

import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { readFile, writeFile } from 'fs/promises';
import { isAbsolute, resolve as resolvePath } from 'path';
import type { WorkerConfig } from '@archon/shared';
import { killProcessTree } from '../../workers/processKill.js';
import { goalBlock } from '../goalBlock.js';
import { awaitModelImages, loadImages, splitAttachmentPaths, withAttachmentRefs } from '../attachments.js';
import { ensureClusterLoopbackMcp, closeClusterLoopbackMcp } from '../../mcp/clusterMcpLoopback.js';
import { AcpJsonRpcClient, AcpReplyError, type JsonRpcNotification, type IncomingRequest } from './acpJsonRpc.js';

// Hard-kill fallback if `session/cancel` doesn't settle the turn (Codex parity).
const INTERRUPT_ACK_TIMEOUT_MS = 5000;
const STDERR_CAP = 32 * 1024;

export interface ToolUseEvent {
  id?: string;
  name: string;
  input: string;
  status?: 'started' | 'in_progress' | 'completed' | 'failed';
  output?: string;
}

export interface TurnSettleData {
  text: string;
  costUsd: number;
  durationMs: number;
  usage?: Record<string, number>;
  modelContextWindow?: number;
}

// ── ACP wire shapes (only the fields we read; forward-compatible) ──
interface AcpSessionNewResult {
  sessionId: string;
  modes?: { currentModeId?: string; availableModes?: Array<{ id?: string }> };
  // Phase 3 — session/new (and session/load) advertise the sessionswappable
  // model list. `modelId` is the ACP bracket-param form
  // (`grok-4.5[effort=high,fast=true]`, Auto = `default[]`) that
  // `session/set_model` requires — NOT the bare id from `cursor-agent models`.
  models?: { currentModelId?: string; availableModels?: Array<{ modelId?: string; name?: string }> };
}
interface AcpPromptResult {
  stopReason?: string;
}
interface AcpAvailableCommand {
  name?: string;
  description?: string;
}
interface AcpUpdateParams {
  sessionId?: string;
  update?: AcpUpdate;
}
interface AcpUpdate {
  sessionUpdate?: string;
  content?: { type?: string; text?: string };
  text?: string;
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  availableCommands?: AcpAvailableCommand[];
}

export function resolveCursorCompressCommand(
  commandsSeen: boolean,
  commands: AcpAvailableCommand[],
): string | null {
  const names = new Set(commands.map((command) => command.name?.trim().toLowerCase()).filter(Boolean));
  if (names.has('compress')) return '/compress';
  // Older/newer Cursor builds may not advertise commands until after the first
  // prompt. `/compress` is the documented CLI command, so fail open only when
  // ACP has not supplied an authoritative command snapshot yet.
  return commandsSeen ? null : '/compress';
}

export class CursorAcpWorker extends EventEmitter {
  private proc: ChildProcess | null = null;
  private rpc: AcpJsonRpcClient | null = null;
  private sessionId: string | null = null;
  // `initialize` → agentCapabilities.promptCapabilities.image. cursor-agent
  // 2026.09 advertises true; if a build ever stops, images degrade to path refs
  // instead of a session/prompt the agent would reject.
  private promptImages = false;
  private resolvedModel: string | null = null;
  // Phase 3 — the ACP-form model list from session/new|load, and the bare
  // catalog id currently applied to the session. `appliedModel === null` after
  // a resume forces a set_model to the operator's configured model on the first
  // turn (the loaded session may have ended on a different model).
  private availableModels: Array<{ modelId: string; name?: string }> = [];
  private appliedModel: string | null = null;
  private starting: Promise<void> | null = null;
  private bootstrapped = false;
  private disposed = false;
  private stderrBuf = '';

  // Single in-flight turn (WorkerManager serializes; beginTurn guards too).
  private turnActive = false;
  // Set by cancelCurrentTurn when it lands before session/prompt was sent
  // (beginTurn is still awaiting the MCP refresh / set_model); a session/cancel
  // for a prompt that doesn't exist yet is a no-op, so beginTurn checks this.
  private turnCancelRequested = false;
  private turnText = '';
  private turnStartedAt = 0;
  private availableCommandsSeen = false;
  private availableCommands: AcpAvailableCommand[] = [];

  // Phase 6 — the loopback HTTP MCP descriptor for cluster peer tools, set at
  // bootstrap when this workflow is a cluster member (config.clusterId). Passed
  // in session/new|load's mcpServers; Cursor ACP honors MCP only over http/sse,
  // not stdio (spike-8), so peer tools ride an in-process loopback server.
  private clusterMcpDescriptor: { name: string; url: string } | undefined;

  constructor(
    private readonly workflowId: string,
    private config: WorkerConfig,
    private readonly resumeSessionId: string | undefined,
  ) {
    super();
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  get currentSessionId(): string | null {
    return this.sessionId;
  }

  updateConfig(next: WorkerConfig): void {
    this.config = next;
  }

  // Phase 6 — build the ACP `mcpServers` array for session/new|load. When this
  // workflow is a cluster member, stand up (or refresh) the loopback HTTP MCP
  // server carrying the archon-cluster peer tools and hand Cursor its URL. Cursor
  // ACP advertises MCP over http/sse only (spike-8), so this is an HTTP descriptor
  // — not the stdio child Claude CLI / Codex members spawn. Non-members → [].
  private async resolveMcpServers(): Promise<Array<Record<string, unknown>>> {
    if (!this.config.clusterId) {
      // Left a cluster (or never joined) — drop any stale loopback server.
      if (this.clusterMcpDescriptor) {
        closeClusterLoopbackMcp(this.workflowId);
        this.clusterMcpDescriptor = undefined;
      }
      return [];
    }
    const archonPort = parseInt(process.env.ARCHON_PORT || '3001', 10);
    try {
      this.clusterMcpDescriptor = await ensureClusterLoopbackMcp({
        clusterId: this.config.clusterId,
        workflowId: this.workflowId,
        archonPort,
        cwd: this.config.cwd,
        taskBoardAttached: this.config.clusterTaskBoardAttached === true,
        accessMode: this.config.clusterAccessMode,
      });
      return [{ type: 'http', name: this.clusterMcpDescriptor.name, url: this.clusterMcpDescriptor.url, headers: [] }];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[cursor:${this.workflowId.slice(0, 8)}] cluster loopback MCP failed (${msg}); peer tools unavailable this session`);
      this.emit('system_notice', `Cursor: couldn't start cluster peer tools (${msg}). This member can't peer_send/peer_read until the next spawn.`);
      return [];
    }
  }

  async ensureStarted(): Promise<void> {
    if (this.disposed) throw new Error('cursor worker disposed');
    if (this.bootstrapped && this.rpc) return;
    if (this.starting) return this.starting;
    this.starting = this.doStart().catch((err) => {
      // Reset so a later turn can retry a fresh spawn.
      this.starting = null;
      this.closeLoopbackMcp();
      this.teardownProcess();
      throw err;
    });
    return this.starting;
  }

  private async doStart(): Promise<void> {
    const model = this.resolveModelId();
    // `--force` skips the CLI's interactive trust prompt for the cwd (spike).
    const args = ['acp', '--model', model, '--force'];
    this.proc = spawn('cursor-agent', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
      cwd: this.config.cwd || undefined,
      detached: true,
    });

    this.proc.on('exit', (code, signal) => {
      const reason = code !== null ? `code ${code}` : `signal ${signal ?? 'unknown'}`;
      this.onChildDeath(`cursor-agent acp exited (${reason})`);
    });
    this.proc.on('error', (err) => {
      this.onChildDeath(`cursor-agent spawn error: ${err.message}`);
    });
    if (this.proc.stderr) {
      this.proc.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        this.stderrBuf = (this.stderrBuf + text).slice(-STDERR_CAP);
        process.stderr.write(`[cursor:${this.workflowId.slice(0, 8)}] ${text}`);
      });
    }
    if (!this.proc.stdin || !this.proc.stdout) {
      throw new Error('cursor-agent acp stdio not available');
    }
    console.log(`[cursor:${this.workflowId.slice(0, 8)}] spawned pid=${this.proc.pid} model=${model}`);

    this.rpc = new AcpJsonRpcClient(this.proc.stdin, this.proc.stdout);
    this.rpc.onRequest = (req) => this.handleAgentRequest(req);
    this.rpc.on('notification', (n: JsonRpcNotification) => this.onNotification(n));
    this.rpc.on('protocol_error', (msg: string) => {
      console.warn(`[cursor:${this.workflowId.slice(0, 8)}] protocol error: ${msg}`);
    });
    this.rpc.on('close', (reason: string) => {
      console.log(`[cursor:${this.workflowId.slice(0, 8)}] rpc closed: ${reason}`);
    });

    // Handshake — clientCapabilities.fs advertises that WE service file reads
    // (the agent then sends us fs/read_text_file requests we answer below).
    const init = await this.rpc.request<{ agentCapabilities?: { promptCapabilities?: { image?: boolean } } }>('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    });
    this.promptImages = init?.agentCapabilities?.promptCapabilities?.image === true;

    // Phase 3 — resume the prior ACP session when the workflow persisted one
    // (session/load, loadSession capability = true), else open a fresh session.
    // Phase 6 — a cluster member also carries the loopback peer-tools MCP in
    // mcpServers. The resolved sessionId is reused for every prompt on this
    // long-lived child.
    const cwd = this.config.cwd || process.cwd();
    const mcpServers = await this.resolveMcpServers();
    console.log(`[cursor:${this.workflowId.slice(0, 8)}] initialized`);

    let loaded = false;
    if (this.resumeSessionId) {
      try {
        // session/load replays the prior transcript back to us as session/update
        // notifications; onNotification ignores them (turnActive is false here),
        // so there's no double-emit. It also re-advertises the model list.
        const lr = await this.rpc.request<AcpSessionNewResult>('session/load', {
          sessionId: this.resumeSessionId,
          cwd,
          mcpServers,
        });
        this.sessionId = this.resumeSessionId;
        this.captureModels(lr);
        // Force a set_model to the operator's configured model on the first turn
        // — the loaded session may have ended on a different one.
        this.appliedModel = null;
        loaded = true;
        console.log(`[cursor:${this.workflowId.slice(0, 8)}] resumed session ${this.resumeSessionId}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`[cursor:${this.workflowId.slice(0, 8)}] session/load failed (${msg}); opening fresh session`);
        this.emit('system_notice', `Cursor: couldn't resume the prior session (${msg}); started a fresh session — earlier transcript context is not restored.`);
      }
    }

    if (!loaded) {
      const s = await this.rpc.request<AcpSessionNewResult>('session/new', { cwd, mcpServers });
      if (!s?.sessionId) throw new Error('cursor session/new returned no sessionId');
      this.sessionId = s.sessionId;
      this.captureModels(s);
      // Fresh session was spawned with `--model <model>`, so it already reflects
      // the configured model — no swap needed until the operator changes it.
      this.appliedModel = this.resolveModelId();
      console.log(`[cursor:${this.workflowId.slice(0, 8)}] session ${s.sessionId}`);
    }

    this.resolvedModel = model;
    this.bootstrapped = true;
  }

  async beginTurn(prompt: string, appendSystemPrompt?: string): Promise<void> {
    if (this.disposed) throw new Error('cursor worker disposed');
    if (!this.bootstrapped || !this.rpc || !this.sessionId) throw new Error('cursor worker not started');
    if (this.turnActive) throw new Error('cursor turn already in flight');

    this.turnActive = true;
    this.turnCancelRequested = false;
    this.turnText = '';
    this.turnStartedAt = Date.now();

    // Phase 6 — refresh the loopback MCP ctx each turn so a mid-life task-board
    // attach/detach is reflected on the next peer/board tool call. Idempotent:
    // reuses the existing listener + URL, only updates its mutable ctx. The URL
    // was already handed to Cursor at session bootstrap, so nothing re-sends.
    if (this.clusterMcpDescriptor && this.config.clusterId) {
      await ensureClusterLoopbackMcp({
        clusterId: this.config.clusterId,
        workflowId: this.workflowId,
        archonPort: parseInt(process.env.ARCHON_PORT || '3001', 10),
        // cwd carries the plan_* tools; omitting it here dropped them after
        // the first turn.
        cwd: this.config.cwd,
        taskBoardAttached: this.config.clusterTaskBoardAttached === true,
        accessMode: this.config.clusterAccessMode,
      }).catch(() => { /* refresh is best-effort; the turn proceeds regardless */ });
    }

    // Phase 3 — apply a live model swap in-session (no respawn) when the
    // operator changed the CONFIG model since the last turn, BEFORE emitting
    // `init` so the UI reflects the model the turn actually runs on.
    await this.applyModelIfChanged();
    // Bounded wait for upload-time downscaled copies (loadImages below reads
    // them); inside the cancel/child-death checks that follow.
    if (this.promptImages) await awaitModelImages(splitAttachmentPaths(this.config.attachments).imagePaths);
    if (!this.turnActive) return; // child died during the awaits above
    if (this.turnCancelRequested) {
      this.settleTurn({ error: 'Worker killed' });
      return;
    }

    // `init` before any delta so the model/sessionId lands first (seedWorker
    // persists sessionId for resume; Phase 3 reuses it).
    this.emit('init', { model: this.resolvedModel ?? this.resolveModelId(), sessionId: this.sessionId });

    // Fold the operator's north-star + any appendSystemPrompt (which already
    // carries the cluster plan/role/doctrine — turnEngine's needsStringFormCluster
    // now includes 'cursor') as a leading block, mirroring how the CLI providers
    // pass --append-system-prompt every turn. Ordering matches codex.ts: north-star
    // above appendSystemPrompt, both above the `---` prompt separator. goalBlock is
    // null-when-empty so the default path is byte-identical to pre-Phase-4.
    const northStarBlock = goalBlock(this.config.goal);
    const append = appendSystemPrompt && appendSystemPrompt.trim() ? appendSystemPrompt : undefined;
    const prefix = northStarBlock
      ? append ? `${northStarBlock}\n\n${append}` : northStarBlock
      : append;
    // Operator attachments: images ride as ACP `image` content blocks when the
    // agent advertised promptCapabilities.image; everything else (and images on
    // an agent without the capability) folds to the `[attached file: …]` path
    // refs every other provider uses — the agent reads them via fs/read_text_file.
    // Before this, attachments never left the server on Cursor.
    const { imagePaths, nonImagePaths } = splitAttachmentPaths(this.config.attachments);
    const { images, skipped } = this.promptImages ? loadImages(imagePaths) : { images: [], skipped: [] };
    for (const note of skipped) this.emit('system_notice', `Cursor: ${note}`);
    const refPaths = this.promptImages ? nonImagePaths : [...imagePaths, ...nonImagePaths];
    const body = withAttachmentRefs(prompt, refPaths);
    const text = prefix ? `${prefix}\n\n---\n\n${body}` : body;
    const promptBlocks: Array<Record<string, unknown>> = [
      { type: 'text', text },
      ...images.map((img) => ({ type: 'image', mimeType: img.mimeType, data: img.data })),
    ];

    let res: AcpPromptResult;
    try {
      res = await this.rpc.request<AcpPromptResult>('session/prompt', {
        sessionId: this.sessionId,
        prompt: promptBlocks,
      });
    } catch (err) {
      // onChildDeath already settled the turn if the transport died; only settle
      // here for a live-transport rejection.
      if (!this.turnActive) return;
      this.settleTurn({ error: err instanceof Error ? err.message : String(err) });
      return;
    }

    if (!this.turnActive) return; // settled by cancel / child death mid-flight
    if (res.stopReason === 'cancelled') {
      this.settleTurn({ error: 'Worker killed' });
      return;
    }
    // ACP ends a turn early with these without an error; surfacing them keeps a
    // truncated or refused answer from reading as a clean success.
    const stopNotice = describeAbnormalStop(res.stopReason);
    if (stopNotice) this.emit('system_notice', stopNotice);
    this.settleTurn({
      result: {
        text: this.turnText,
        costUsd: 0,
        durationMs: Date.now() - this.turnStartedAt,
      },
    });
  }

  // Cursor owns its retained conversation inside the ACP session. Run its
  // documented `/compress` command as the ENTIRE prompt so handleSlashCommand
  // sees it before normal model dispatch. In particular, never route this
  // through beginTurn(): that method deliberately prefixes north-star and
  // cluster doctrine, which would turn `/compress` into ordinary prompt text.
  async compressConversation(): Promise<{ ok: boolean; error?: string }> {
    if (this.disposed) return { ok: false, error: 'Cursor worker is disposed' };
    if (!this.bootstrapped || !this.rpc || !this.sessionId) {
      return { ok: false, error: 'no active Cursor ACP session to compress' };
    }
    if (this.turnActive) return { ok: false, error: 'Cursor turn already in flight' };

    const command = resolveCursorCompressCommand(this.availableCommandsSeen, this.availableCommands);
    if (!command) {
      return { ok: false, error: 'this Cursor ACP build does not advertise the /compress command' };
    }

    this.turnActive = true;
    this.turnText = '';
    this.turnStartedAt = Date.now();
    try {
      // A config/model change made since the previous operator turn should also
      // govern the summarizer command. session/set_model is cheap and no-ops
      // when the session already has the requested model.
      await this.applyModelIfChanged();
      const res = await this.rpc.request<AcpPromptResult>('session/prompt', {
        sessionId: this.sessionId,
        prompt: [{ type: 'text', text: command }],
      });
      if (res.stopReason === 'cancelled') return { ok: false, error: 'Cursor compression was cancelled' };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      // Child-death/cancel paths may already have cleared this through
      // settleTurn(); assigning false again is harmless and releases the guard.
      this.turnActive = false;
      this.turnText = '';
    }
  }

  // Operator cancel. session/cancel is a notification; the in-flight
  // session/prompt then resolves with stopReason 'cancelled' → beginTurn
  // settles 'Worker killed'. Hard-kill fallback if it never settles.
  async cancelCurrentTurn(): Promise<void> {
    if (!this.turnActive) return;
    this.turnCancelRequested = true;
    if (this.rpc && this.sessionId) this.rpc.notify('session/cancel', { sessionId: this.sessionId });
    await new Promise<void>((resolve) => {
      if (!this.turnActive) return resolve();
      const timer = setTimeout(() => {
        this.off('turn_settled', onDone);
        this.hardKill();
        this.settleTurn({ error: 'Worker killed (cancel timed out)' });
        resolve();
      }, INTERRUPT_ACK_TIMEOUT_MS);
      const onDone = (): void => {
        clearTimeout(timer);
        resolve();
      };
      this.once('turn_settled', onDone);
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.turnActive) this.settleTurn({ error: 'Worker killed' });
    // Phase 6 — tear down this member's loopback peer-tools MCP listener.
    this.closeLoopbackMcp();
    const pid = this.proc?.pid;
    try { this.proc?.stdin?.end(); } catch { /* going down anyway */ }
    if (pid) killProcessTree(pid, { graceMs: 500, label: `cursor:${this.workflowId.slice(0, 8)}` });
    this.teardownProcess();
  }

  // ── internals ──

  private settleTurn(data: { error?: string; result?: TurnSettleData }): void {
    if (!this.turnActive) return;
    this.turnActive = false;
    this.emit('turn_settled', data);
  }

  private onNotification(n: JsonRpcNotification): void {
    if (n.method !== 'session/update') return;
    const u = (n.params as AcpUpdateParams | undefined)?.update;
    if (!u) return;
    // ACP sends this after session/new|load, while no operator turn is active.
    // Cache the complete replacement snapshot so native commands can be
    // dispatched without guessing what this Cursor build supports.
    if (u.sessionUpdate === 'available_commands_update') {
      this.availableCommandsSeen = true;
      this.availableCommands = Array.isArray(u.availableCommands) ? u.availableCommands : [];
      return;
    }
    if (!this.turnActive) return;
    switch (u.sessionUpdate) {
      case 'agent_message_chunk': {
        const t = u.content?.text ?? u.text;
        if (typeof t === 'string' && t) {
          this.turnText += t;
          this.emit('text', t);
        }
        break;
      }
      case 'agent_thought_chunk': {
        const t = u.content?.text ?? u.text;
        if (typeof t === 'string' && t) this.emit('thinking', t);
        break;
      }
      case 'tool_call': {
        this.emit('tool_use', {
          id: u.toolCallId,
          name: u.title || u.kind || 'tool',
          input: stringifyValue(u.rawInput),
          status: mapToolStatus(u.status) ?? 'started',
        } satisfies ToolUseEvent);
        break;
      }
      case 'tool_call_update': {
        this.emit('tool_use', {
          id: u.toolCallId,
          name: u.title || u.kind || 'tool',
          input: stringifyValue(u.rawInput),
          status: mapToolStatus(u.status),
          ...(u.rawOutput !== undefined ? { output: stringifyValue(u.rawOutput) } : {}),
        } satisfies ToolUseEvent);
        break;
      }
      // plan / current_mode_update / usage_update → not surfaced in v1.
      default:
        break;
    }
  }

  // Server→client requests. ACP routes file I/O, permission prompts, and
  // terminal ops back through the client (us) mid-turn — each MUST be answered
  // or the turn hangs.
  private async handleAgentRequest(req: IncomingRequest): Promise<unknown> {
    const p = req.params as Record<string, unknown> | undefined;
    switch (req.method) {
      case 'session/request_permission': {
        // Phase 1: auto-approve (full tool posture, like Claude/Codex tabs).
        // DEBAG-style gating is a later refinement. Approve ONCE only, matched
        // by ACP kind `allow_once` / Cursor's documented optionId `allow-once`.
        // The old regex + `?? opts[0]` fallback could land on allow-always
        // (persisting a rule) or on a reject option.
        const opts = p?.options as Array<{ optionId?: string; kind?: string; name?: string }> | undefined;
        const allow = opts?.find((o) => o.kind === 'allow_once' || o.optionId === 'allow-once');
        if (allow?.optionId) return { outcome: { outcome: 'selected', optionId: allow.optionId } };
        this.emit('system_notice', `Cursor: permission request offered no allow-once option (${(opts ?? []).map((o) => o.optionId ?? o.kind).join(', ') || 'none'}); declined.`);
        return { outcome: { outcome: 'cancelled' } };
      }
      // Blocking Cursor extensions that wait on an interactive UI Archon doesn't
      // have. Answer explicitly (docs: cursor.com/docs/cli/acp) — an empty `{}`
      // has no `outcome` and leaves the agent guessing.
      case 'cursor/ask_question': {
        this.emit('system_notice', 'Cursor asked a multiple-choice question; Arco has no picker for it, so it was skipped. Answer in your next message if needed.');
        return { outcome: { outcome: 'skipped', reason: 'Arco cannot present interactive questions; ask in plain text instead.' } };
      }
      case 'cursor/create_plan': {
        this.emit('system_notice', 'Cursor requested plan approval; Arco has no plan-approval UI, so the request was cancelled.');
        return { outcome: { outcome: 'cancelled' } };
      }
      case 'fs/read_text_file': {
        const content = await readFile(this.resolveAgentPath(p?.path), 'utf8');
        return { content };
      }
      case 'fs/write_text_file': {
        await writeFile(this.resolveAgentPath(p?.path), typeof p?.content === 'string' ? p.content : '', 'utf8');
        return null;
      }
      default:
        // terminal/* (not advertised in clientCapabilities) and any future
        // method. A fake `{}` success made the agent treat a no-op as done.
        throw new AcpReplyError(-32601, `Method not found: ${req.method}`);
    }
  }

  private resolveAgentPath(path: unknown): string {
    if (typeof path !== 'string' || !path) throw new Error('fs request missing path');
    return isAbsolute(path) ? path : resolvePath(this.config.cwd || process.cwd(), path);
  }

  private onChildDeath(reason: string): void {
    if (this.disposed) return;
    // Settle any in-flight turn first (wrapper latches on the first of
    // turn_settled/fatal), then tear down and signal the dispatcher to drop
    // this worker from its cache.
    if (this.turnActive) this.settleTurn({ error: reason });
    // The dispatcher drops this worker on `fatal` without dispose(), so the
    // tokenized loopback listener must close here or it leaks per crash.
    this.closeLoopbackMcp();
    this.teardownProcess();
    this.emit('fatal', reason);
  }

  private closeLoopbackMcp(): void {
    if (!this.clusterMcpDescriptor) return;
    closeClusterLoopbackMcp(this.workflowId);
    this.clusterMcpDescriptor = undefined;
  }

  private teardownProcess(): void {
    try { this.rpc?.close('worker teardown'); } catch { /* ignore */ }
    this.rpc = null;
    this.proc = null;
    this.bootstrapped = false;
    this.starting = null;
    // The next ensureStarted() re-attaches via session/load (constructor
    // resumeSessionId) or opens fresh; clear the per-session model state so it
    // repopulates from the new session/new|load response.
    this.sessionId = null;
    this.availableModels = [];
    this.appliedModel = null;
  }

  private hardKill(): void {
    const pid = this.proc?.pid;
    if (pid) killProcessTree(pid, { label: `cursor:${this.workflowId.slice(0, 8)}` });
  }

  private resolveModelId(): string {
    const m = this.config.model;
    return typeof m === 'string' && m.trim() ? m.trim() : 'auto';
  }

  // Cache the ACP-form model list advertised by session/new|load.
  private captureModels(result: AcpSessionNewResult | undefined): void {
    const list = result?.models?.availableModels;
    if (!Array.isArray(list) || list.length === 0) return;
    this.availableModels = list
      .filter((m): m is { modelId: string; name?: string } => typeof m?.modelId === 'string')
      .map((m) => ({ modelId: m.modelId, name: m.name }));
  }

  // Map a bare catalog id (from `cursor-agent models` — e.g. `grok-4.5`, `auto`)
  // to the ACP bracket-param `modelId` that session/set_model requires (e.g.
  // `grok-4.5[effort=high,fast=true]`, Auto = `default[]`). Returns null when we
  // have no advertised list or no confident match.
  private resolveAcpModelId(bare: string): string | null {
    if (this.availableModels.length === 0) return null;
    const norm = (s: string): string => s.trim().toLowerCase();
    const baseOf = (id: string): string => (id.split('[')[0] ?? '').trim().toLowerCase();
    const target = norm(bare);
    const isAuto = target === 'auto' || target === 'default';
    const pick = this.availableModels.find((m) => {
      if (isAuto) return baseOf(m.modelId) === 'default' || norm(m.name ?? '') === 'auto';
      return baseOf(m.modelId) === target || norm(m.name ?? '') === target;
    });
    return pick?.modelId ?? null;
  }

  // Live model swap: if the configured model differs from what's applied to the
  // session, issue session/set_model (no respawn — confirmed by the Phase-0
  // spike). Best-effort and non-fatal: a swap that can't be mapped or is
  // rejected leaves the session on its current model with an operator notice.
  private async applyModelIfChanged(): Promise<void> {
    if (!this.rpc || !this.sessionId) return;
    const want = this.resolveModelId();
    if (this.appliedModel !== null && want === this.appliedModel) return;

    const acpId = this.resolveAcpModelId(want);
    if (!acpId) {
      // No mapping. On a fresh session the spawn `--model` already applied the
      // configured model, so just record it; otherwise keep the current model.
      if (this.appliedModel === null) {
        this.appliedModel = want;
      } else {
        this.emit('system_notice', `Cursor: couldn't map model "${want}" to an ACP model id; staying on "${this.appliedModel}".`);
      }
      return;
    }

    try {
      await this.rpc.request('session/set_model', { sessionId: this.sessionId, modelId: acpId });
      const prev = this.appliedModel;
      this.appliedModel = want;
      this.resolvedModel = want;
      if (prev !== null && prev !== want) {
        this.emit('system_notice', `Cursor model swapped ${prev} → ${want} (in-session, no respawn).`);
      }
      console.log(`[cursor:${this.workflowId.slice(0, 8)}] model applied ${prev ?? '(resume)'} → ${want} (${acpId})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (this.appliedModel === null) this.appliedModel = want; // spawn model stands
      this.emit('system_notice', `Cursor: model swap to "${want}" failed (${msg}); continuing on the current model.`);
    }
  }
}

function describeAbnormalStop(stopReason: string | undefined): string | null {
  switch (stopReason) {
    case 'max_tokens':
      return 'Cursor: the response hit the model\'s output-token limit (stopReason=max_tokens) — this turn was truncated. Ask it to continue.';
    case 'max_turn_requests':
      return 'Cursor: the turn hit the agent\'s per-turn request limit (stopReason=max_turn_requests) — the work may be incomplete. Ask it to continue.';
    case 'refusal':
      return 'Cursor: the model refused this request (stopReason=refusal).';
    default:
      return null;
  }
}

function mapToolStatus(status: string | undefined): ToolUseEvent['status'] | undefined {
  switch (status) {
    case 'pending':
    case 'started':
      return 'started';
    case 'in_progress':
      return 'in_progress';
    case 'completed':
      return 'completed';
    case 'failed':
    case 'error':
      return 'failed';
    default:
      return undefined;
  }
}

function stringifyValue(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
