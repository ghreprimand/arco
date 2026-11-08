import { nativeOAuthBaseUrl } from './providers/claude-native/apiEndpoint.js';
// Smart AUTO-PICKUP evaluator adapters. Each makes one bounded request with
// no tools and nothing Arco keeps or resumes afterwards: a time limit, an
// abort signal and an output cap. Any error, tool attempt or oversized answer
// rejects, and callers treat a rejection as "no decision" (never a wake).
//
// Capability per provider:
//   ollama  - /api/chat, stream off, JSON-schema format, no tools field.
//   claude  - Claude Native credentials, one Messages API request without tools.
//             (The CLI transport cannot be restricted this way.)
//   cursor  - a fresh `cursor-agent acp` in an empty temporary folder with no
//             file or terminal capability, switched to Ask mode (no edits or
//             command execution); every permission request is refused and any
//             tool call aborts the request.
//   codex   - a one-shot `codex app-server` (no MCP servers) in an empty
//             temporary folder: read-only sandbox, approvals never, web
//             search off, ephemeral thread, never resumed. Only the final
//             agent message is kept. Any command, file change, tool or web
//             item, or any approval or other server request, interrupts the
//             turn, kills the process and gives no decision.
import { spawn } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import Anthropic from '@anthropic-ai/sdk';
import type { SmartPickupEvaluatorCapability, SmartPickupEvaluatorProvider } from '@arco/shared';
import { SMART_PICKUP_EVALUATOR_PROVIDERS, SMART_PICKUP_REASONS } from '@arco/shared';
import { commandArgs } from './windowsCommand.js';
import { killProcessTree } from './workers/processKill.js';
import { AcpJsonRpcClient, AcpReplyError, type IncomingRequest, type JsonRpcNotification } from './providers/cursor/acpJsonRpc.js';
import { resolveCatalogModel, setAcpSessionModel, type AcpModel } from './providers/cursor/modelMap.js';
import { getCursorCatalog } from './providers/cursor/catalog.js';
import { JsonRpcClient } from './providers/codex-appserver/jsonRpc.js';
import { getOllamaBase } from './providers/ollama.js';
import { ensureLiveTokens } from './providers/claude-native/oauth.js';
import { loadTokens } from './providers/claude-native/auth.js';
import { CLAUDE_CLI_USER_AGENT } from './providers/claude-native/wireFingerprint.js';
import { resolveClaudeAliasFromCatalog } from './providers/claude-native/catalog.js';
import { getLmstudioBase, probeLmstudio } from './providers/lmstudio.js';
import { getStrataBase, probeStrata } from './providers/strata.js';
import { getDeepSeekBase, probeDeepSeek } from './providers/deepseek.js';
import { llamacppManager, llamacppBaseUrl } from './providers/llamacppManager.js';
import { probeLlamacppLive } from './providers/llamacpp.js';
import { queueLocalProvider, type LocalProviderName } from './providers/localProviderQueue.js';
import { localModelsUnloading } from './providers/localModelControl.js';

export interface EvaluatorRequest {
  model: string;
  instructions: string;
  prompt: string;
  timeoutMs: number;
  maxOutputTokens: number;
  signal?: AbortSignal;
  // Free-text answer: no JSON schema is imposed (utility jobs). The evaluator
  // leaves this unset and keeps its schema-constrained answer.
  freeText?: boolean;
  // Start-up allowance for adapters that launch an agent (Cursor), separate
  // from timeoutMs, which bounds the answer itself.
  startupTimeoutMs?: number;
  // Diagnostic trace (scripts/smart-pickup-eval.ts --verbose): phase timings
  // and protocol frames, bodies clipped.
  trace?: (line: string) => void;
}

// Cursor start-up measured about 2 to 2.5 s warm on Linux (spawn and
// initialize about 0.25 s, session/new about 2 s); the allowance covers a cold
// agent start (update, sign-in refresh) without touching the answer limit.
export const EVALUATOR_STARTUP_TIMEOUT_MS = 30_000;

// A failure before the agent session was ready (reason prefix startup_). The
// observer retries such a failure once for the same mail.
export function isStartupFailure(reason: string): boolean {
  return reason.startsWith('startup_');
}

function clip(s: string, n = 400): string {
  const t = s.replace(/\s+$/, '');
  return t.length > n ? `${t.slice(0, n)}... (${t.length} chars)` : t;
}

export interface EvaluatorAdapter {
  provider: SmartPickupEvaluatorProvider;
  capability(): Promise<SmartPickupEvaluatorCapability>;
  // Resolves with the raw answer text.
  evaluate(req: EvaluatorRequest): Promise<string>;
}

export class EvaluatorRefused extends Error {}

// Rough character ceiling for an answer of maxOutputTokens tokens; anything
// longer is not the small JSON object asked for.
export function outputCharCap(maxOutputTokens: number): number {
  return Math.max(64, maxOutputTokens * 8);
}

// One timer and one abort for the whole request, honoring the caller's signal.
function deadline(req: EvaluatorRequest): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new EvaluatorRefused('timeout')), req.timeoutMs);
  const onAbort = () => controller.abort(new EvaluatorRefused('cancelled'));
  req.signal?.addEventListener('abort', onAbort, { once: true });
  if (req.signal?.aborted) onAbort();
  return { signal: controller.signal, done: () => { clearTimeout(timer); req.signal?.removeEventListener('abort', onAbort); } };
}

const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['wake', 'defer', 'ask'] },
    reason: { type: 'string', enum: [...SMART_PICKUP_REASONS] },
  },
  required: ['action', 'reason'],
  additionalProperties: false,
};

export function ollamaAdapter(opts: { base?: () => Promise<string>; fetchImpl?: typeof fetch } = {}): EvaluatorAdapter {
  const base = opts.base ?? getOllamaBase;
  const fetchImpl = opts.fetchImpl ?? fetch;
  return {
    provider: 'ollama',
    async capability() { return { provider: 'ollama', available: true }; },
    async evaluate(req) {
      const { signal, done } = deadline(req);
      try {
        const res = await fetchImpl(`${(await base()).replace(/\/$/, '')}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal,
          body: JSON.stringify({
            model: req.model,
            stream: false,
            ...(req.freeText ? {} : { format: ANSWER_SCHEMA }),
            options: { num_predict: req.maxOutputTokens, temperature: 0 },
            messages: [{ role: 'system', content: req.instructions }, { role: 'user', content: req.prompt }],
          }),
        });
        if (!res.ok) throw new EvaluatorRefused(`http_${res.status}`);
        const body = await res.json() as { message?: { content?: unknown; tool_calls?: unknown } };
        if (body.message?.tool_calls) throw new EvaluatorRefused('tool_attempted');
        const text = typeof body.message?.content === 'string' ? body.message.content : '';
        if (text.length > outputCharCap(req.maxOutputTokens)) throw new EvaluatorRefused('output_too_long');
        return text;
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        if (error instanceof SyntaxError) throw new EvaluatorRefused('unreadable_answer');
        throw error;
      } finally { done(); }
    },
  };
}

const CLAUDE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

export function claudeAdapter(opts: { fetchImpl?: typeof fetch; tokens?: () => Promise<{ accessToken: string }>; hasCredentials?: () => Promise<boolean> } = {}): EvaluatorAdapter {
  const tokens = opts.tokens ?? ensureLiveTokens;
  const hasCredentials = opts.hasCredentials ?? (async () => Boolean(await loadTokens().catch(() => null)));
  return {
    provider: 'claude',
    async capability() {
      return await hasCredentials()
        ? { provider: 'claude', available: true }
        : { provider: 'claude', available: false, reason: 'Needs Claude Native sign-in. The Claude CLI transport cannot make a single request without tools.' };
    },
    async evaluate(req) {
      const { signal, done } = deadline(req);
      try {
        const { accessToken } = await tokens().catch(() => { throw new EvaluatorRefused('not_signed_in'); });
        const client = new Anthropic({
          authToken: accessToken,
          apiKey: null,
          baseURL: await nativeOAuthBaseUrl(),
          maxRetries: 0,
          defaultHeaders: { 'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20', 'anthropic-dangerous-direct-browser-access': 'true', 'user-agent': CLAUDE_CLI_USER_AGENT, 'x-app': 'cli' },
          ...(opts.fetchImpl ? { fetch: opts.fetchImpl } : {}),
        } as ConstructorParameters<typeof Anthropic>[0]);
        const resp = await client.messages.create({
          model: resolveClaudeAliasFromCatalog(req.model),
          max_tokens: req.maxOutputTokens,
          system: [{ type: 'text', text: CLAUDE_IDENTITY }, { type: 'text', text: req.instructions }],
          messages: [{ role: 'user', content: req.prompt }],
        }, { signal });
        const blocks: unknown = resp.content;
        const types = Array.isArray(blocks) ? blocks.map((block: unknown) => {
          const type = block && typeof block === 'object' && 'type' in block ? (block as { type?: unknown }).type : undefined;
          return typeof type === 'string' && ['text', 'thinking', 'redacted_thinking', 'tool_use'].includes(type) ? type : 'other';
        }) : [];
        const refuse = (reason: string): never => {
          console.warn(`[arco] Claude evaluator refused: ${reason}; block types: ${types.slice(0, 20).join(',') || 'none'}`);
          throw new EvaluatorRefused(reason);
        };
        if (!Array.isArray(blocks)) return refuse('unreadable_answer');
        if (resp.stop_reason === 'tool_use' || types.includes('tool_use') || types.includes('other')) return refuse('non_text_answer');
        if (blocks.some((b: unknown) => b && typeof b === 'object' && 'type' in b && b.type === 'text' && (!('text' in b) || typeof b.text !== 'string'))) return refuse('unreadable_answer');
        const text = blocks.filter((b: { type?: string }) => b?.type === 'text').map((b: { text: string }) => b.text).join('');
        if (resp.stop_reason === 'max_tokens' || text.length > outputCharCap(req.maxOutputTokens)) return refuse('output_too_long');
        if (!text.trim()) return refuse('empty_answer');
        return text;
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        if (error instanceof EvaluatorRefused) throw error;
        if (error instanceof SyntaxError) {
          console.warn('[arco] Claude evaluator refused: unreadable_answer; block types: none');
          throw new EvaluatorRefused('unreadable_answer');
        }
        if (error instanceof Anthropic.APIError) {
          if (error.status === 401) throw new EvaluatorRefused('not_signed_in');
          if (error.status) throw new EvaluatorRefused(`provider_http_${error.status}`);
        }
        throw error;
      } finally { done(); }
    },
  };
}

export function cursorAdapter(opts: { launch?: (model: string) => [string, string[]]; installed?: () => Promise<boolean>; catalog?: () => Promise<string[]> } = {}): EvaluatorAdapter {
  // `cursor-agent acp` ignores `--model`; the model is selected over ACP after
  // session/new and confirmed, and the evaluator refuses rather than answer
  // on any other model (providers/cursor/modelMap.ts).
  const launch = opts.launch ?? ((_model: string) => commandArgs('cursor-agent', ['acp']));
  const catalog = opts.catalog ?? (async () => (await getCursorCatalog()).models.map((m) => m.id));
  return {
    provider: 'cursor',
    async capability() {
      if (opts.installed && !(await opts.installed())) return { provider: 'cursor', available: false, reason: 'Cursor Agent is not installed or signed in.' };
      return { provider: 'cursor', available: true };
    },
    async evaluate(req) {
      // Two bounded phases. Start-up (spawn, initialize, session/new, Ask
      // mode) has its own allowance so a cold agent start does not eat the
      // answer time; the answer phase (session/prompt) has req.timeoutMs.
      const trace = req.trace;
      const t0 = Date.now();
      let phaseAt = t0;
      const phase = (name: string) => { const now = Date.now(); trace?.(`phase ${name} ${now - phaseAt}ms (total ${now - t0}ms)`); phaseAt = now; };
      // The real path, so the folder the agent is told matches the child's
      // process folder even when the temporary directory is reached through a link.
      const cwd = await realpath(await mkdtemp(join(tmpdir(), 'arco-evaluator-')));
      const proc = spawn(...launch(req.model), { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env }, detached: process.platform !== 'win32' });
      let rpc: AcpJsonRpcClient | null = null;
      let text = '';
      let started = false;
      let stopped = false;
      let refused: EvaluatorRefused | null = null;
      let rejectAborted: (err: EvaluatorRefused) => void = () => {};
      const aborted = new Promise<never>((_, reject) => { rejectAborted = reject; });
      aborted.catch(() => undefined);
      // Stops the agent once, however many paths end the request.
      const stop = () => {
        if (stopped) return;
        stopped = true;
        rpc?.close('evaluator done');
        if (proc.pid && proc.exitCode === null && proc.signalCode === null) killProcessTree(proc.pid, { graceMs: 200, label: 'smart-pickup:cursor' });
      };
      // Failures before the session is ready are start-up failures.
      const fail = (reason: string) => {
        if (!refused) refused = new EvaluatorRefused(started || reason.startsWith('tool_attempted') || reason === 'cancelled' ? reason : `startup_${reason}`);
        stop();
        rejectAborted(refused);
      };
      let timer = setTimeout(() => fail('timeout'), req.startupTimeoutMs ?? EVALUATOR_STARTUP_TIMEOUT_MS);
      const onAbort = () => fail('cancelled');
      req.signal?.addEventListener('abort', onAbort, { once: true });
      if (req.signal?.aborted) onAbort();
      proc.on('error', (err) => fail(`spawn_failed: ${err.message}`));
      proc.on('exit', (code, sig) => { trace?.(`exit code=${code} signal=${sig}`); fail('exited'); });
      try {
        if (!proc.stdin || !proc.stdout) throw new EvaluatorRefused('startup_no_stdio');
        let stdin: Writable = proc.stdin;
        if (trace) {
          const out = proc.stdin;
          stdin = new Writable({ write(chunk, enc, cb) { trace(`-> ${clip(String(chunk))}`); out.write(chunk, enc, cb); } });
          let inbuf = '';
          proc.stdout.on('data', (d: Buffer) => { inbuf += d.toString(); let i; while ((i = inbuf.indexOf('\n')) >= 0) { const line = inbuf.slice(0, i); inbuf = inbuf.slice(i + 1); if (line.trim()) trace(`<- ${clip(line)}`); } });
          proc.stderr?.on('data', (d: Buffer) => trace(`stderr ${clip(d.toString())}`));
        }
        rpc = new AcpJsonRpcClient(stdin, proc.stdout);
        // No file or terminal capability is advertised, so any such request is
        // an attempt to use a tool.
        rpc.onRequest = (r: IncomingRequest) => {
          fail(`tool_attempted:${r.method}`);
          if (r.method === 'session/request_permission') return { outcome: { outcome: 'cancelled' } };
          throw new AcpReplyError(-32601, 'Not available to the evaluator.');
        };
        rpc.on('notification', (n: JsonRpcNotification) => {
          if (n.method !== 'session/update') return;
          const u = (n.params as { update?: { sessionUpdate?: string; content?: { text?: string }; text?: string } } | undefined)?.update;
          if (!u) return;
          if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') { fail('tool_attempted'); return; }
          if (u.sessionUpdate === 'agent_message_chunk') {
            if (!text) phase('first_token');
            const t = u.content?.text ?? u.text;
            if (typeof t === 'string') text += t;
            if (text.length > outputCharCap(req.maxOutputTokens)) fail('output_too_long');
          }
        });
        const run = (async () => {
          await rpc!.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
          phase('initialize');
          const session = await rpc!.request<{ sessionId?: string; modes?: { availableModes?: { id?: string }[] }; models?: { availableModels?: AcpModel[] } }>('session/new', { cwd, mcpServers: [] });
          phase('session_new');
          if (!session?.sessionId) throw new EvaluatorRefused('startup_no_session');
          // The exact model asked for, confirmed, or no answer at all.
          const offered = (session.models?.availableModels ?? []).filter((m) => typeof m?.modelId === 'string');
          const pick = resolveCatalogModel(req.model, offered, await catalog().catch(() => []));
          if (pick.kind !== 'exact') throw new EvaluatorRefused('startup_model_unavailable');
          if (await setAcpSessionModel(rpc!, session.sessionId, pick.acpId) !== pick.acpId) throw new EvaluatorRefused('startup_model_unconfirmed');
          phase('set_model');
          // Ask mode: no edits or command execution. Fail closed without it.
          if (!session.modes?.availableModes?.some((m) => m.id === 'ask')) throw new EvaluatorRefused('startup_no_ask_mode');
          await rpc!.request('session/set_mode', { sessionId: session.sessionId, modeId: 'ask' });
          phase('set_mode');
          if (refused) return;
          started = true;
          clearTimeout(timer);
          timer = setTimeout(() => fail('timeout'), req.timeoutMs);
          await rpc!.request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: `${req.instructions}\n\n${req.prompt}` }] });
          phase('prompt');
        })();
        await Promise.race([run, aborted]);
        if (refused) throw refused;
        return text;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw refused ?? (err instanceof EvaluatorRefused ? err : new EvaluatorRefused(started ? reason : `startup_${reason}`));
      } finally {
        clearTimeout(timer);
        req.signal?.removeEventListener('abort', onAbort);
        stop();
        await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}

// Item types a one-shot Codex turn may produce: the prompt echo, reasoning and
// agent messages. Anything else (commands, file changes, MCP, dynamic or web
// tools, sub-agents, images) is a tool attempt.
const CODEX_ALLOWED_ITEMS = new Set(['userMessage', 'agentMessage', 'reasoning']);

export function codexAdapter(opts: { launch?: () => [string, string[]]; usable?: () => Promise<{ available: boolean; reason?: string }> } = {}): EvaluatorAdapter {
  const launch = opts.launch ?? (() => commandArgs('codex', ['-c', 'mcp_servers={}', 'app-server']));
  const usable = opts.usable ?? (async () => {
    const { readSettings } = await import('./settings.js');
    const { probeCodexLoggedIn } = await import('./providers/codex.js');
    if ((await readSettings()).enabledProviders?.codex === false) return { available: false, reason: 'Codex is turned off in Settings.' };
    return (await probeCodexLoggedIn()).loggedIn ? { available: true } : { available: false, reason: 'Codex is not signed in.' };
  });
  return {
    provider: 'codex',
    async capability() {
      const state = await usable();
      return state.available ? { provider: 'codex', available: true } : { provider: 'codex', available: false, reason: state.reason ?? 'Codex is not available.' };
    },
    async evaluate(req) {
      // The real path, so the folder the agent is told matches the child's
      // process folder even when the temporary directory is reached through a link.
      const cwd = await realpath(await mkdtemp(join(tmpdir(), 'arco-evaluator-')));
      const proc = spawn(...launch(), { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env }, detached: process.platform !== 'win32' });
      let rpc: JsonRpcClient | null = null;
      let threadId = '';
      let turnId = '';
      let started = false;
      let stopped = false;
      let refused: EvaluatorRefused | null = null;
      let streamed = 0;
      let finalText: string | null = null;
      let rejectAborted: (err: EvaluatorRefused) => void = () => {};
      const aborted = new Promise<never>((_, reject) => { rejectAborted = reject; });
      aborted.catch(() => undefined);
      let settle: () => void = () => {};
      const completed = new Promise<void>((resolve) => { settle = resolve; });
      const stop = () => {
        if (stopped) return;
        stopped = true;
        if (rpc && threadId && turnId) rpc.request('turn/interrupt', { threadId, turnId }).catch(() => undefined);
        rpc?.close('evaluator done');
        if (proc.pid && proc.exitCode === null && proc.signalCode === null) killProcessTree(proc.pid, { graceMs: 200, label: 'smart-pickup:codex' });
      };
      const fail = (reason: string) => {
        if (!refused) refused = new EvaluatorRefused(started || reason.startsWith('tool_attempted') || reason === 'cancelled' ? reason : `startup_${reason}`);
        stop();
        rejectAborted(refused);
      };
      let timer = setTimeout(() => fail('timeout'), req.startupTimeoutMs ?? EVALUATOR_STARTUP_TIMEOUT_MS);
      const onAbort = () => fail('cancelled');
      req.signal?.addEventListener('abort', onAbort, { once: true });
      if (req.signal?.aborted) onAbort();
      proc.on('error', (err) => fail(`spawn_failed: ${err.message}`));
      proc.on('exit', () => fail('exited'));
      const cap = outputCharCap(req.maxOutputTokens);
      try {
        if (!proc.stdin || !proc.stdout) throw new EvaluatorRefused('startup_no_stdio');
        proc.stderr?.on('data', (d: Buffer) => req.trace?.(`stderr ${clip(d.toString())}`));
        // Any request the server makes of us (approvals, questions, dynamic
        // tools, token refresh) is an attempt to go beyond the text answer.
        rpc = new JsonRpcClient(proc.stdin, proc.stdout, (r) => {
          fail(`tool_attempted:${r.method}`);
          rpc?.respondError(r.id, { code: -32601, message: 'Not available to the evaluator.' });
          return true;
        });
        rpc.on('notification', (n: { method: string; params: unknown }) => {
          const p = (n.params ?? {}) as { delta?: string; item?: { type?: string; text?: string; phase?: string | null }; turn?: { status?: string; error?: { message?: string } | null } };
          if (n.method === 'item/started' || n.method === 'item/completed') {
            const type = p.item?.type ?? '';
            if (!CODEX_ALLOWED_ITEMS.has(type)) { fail(`tool_attempted:${type || 'unknown'}`); return; }
            if (n.method === 'item/completed' && type === 'agentMessage' && typeof p.item?.text === 'string') {
              // The last final-answer message wins; with no phase, the last message.
              if (p.item.phase === 'final_answer' || p.item.phase == null || finalText === null) finalText = p.item.text;
              if (finalText.length > cap) fail('output_too_long');
            }
          } else if (n.method === 'item/agentMessage/delta') {
            streamed += typeof p.delta === 'string' ? p.delta.length : 0;
            if (streamed > cap * 4) fail('output_too_long');
          } else if (n.method === 'turn/completed') {
            if (p.turn?.status === 'completed') settle();
            else fail(p.turn?.status === 'interrupted' ? 'cancelled' : `turn_${p.turn?.status ?? 'failed'}`);
          } else if (n.method === 'error') fail('provider_error');
        });
        const run = (async () => {
          await rpc!.request('initialize', { clientInfo: { name: 'arco-evaluator', title: 'Arco evaluator', version: '1' }, capabilities: { experimentalApi: true, optOutNotificationMethods: null } });
          rpc!.notify('initialized');
          const thread = await rpc!.request<{ thread?: { id?: string } }>('thread/start', {
            model: req.model, cwd, approvalPolicy: 'never', sandbox: 'read-only',
            config: { web_search: 'disabled' }, ephemeral: true, baseInstructions: null, developerInstructions: null,
          });
          if (!thread?.thread?.id) throw new EvaluatorRefused('startup_no_thread');
          threadId = thread.thread.id;
          if (refused) return;
          started = true;
          clearTimeout(timer);
          timer = setTimeout(() => fail('timeout'), req.timeoutMs);
          const turn = await rpc!.request<{ turn?: { id?: string } }>('turn/start', {
            threadId, cwd, approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false }, model: req.model,
            input: [{ type: 'text', text: `${req.instructions}\n\n${req.prompt}`, text_elements: [] }],
          });
          turnId = turn?.turn?.id ?? '';
          await completed;
        })();
        await Promise.race([run, aborted]);
        if (refused) throw refused;
        const answer = finalText as string | null;
        if (answer === null) throw new EvaluatorRefused('no_answer');
        if (answer.length > cap) throw new EvaluatorRefused('output_too_long');
        return answer;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw refused ?? (err instanceof EvaluatorRefused ? err : new EvaluatorRefused(started ? reason : `startup_${reason}`));
      } finally {
        clearTimeout(timer);
        req.signal?.removeEventListener('abort', onAbort);
        stop();
        await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}

async function boundedLocalResponse(response: Response, maxBytes: number): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new EvaluatorRefused('output_too_long');
  if (!response.body) throw new EvaluatorRefused('unreadable_answer');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new EvaluatorRefused('output_too_long'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const data = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)); }
  catch { throw new EvaluatorRefused('unreadable_answer'); }
}

// A single bounded, non-streaming OpenAI-compatible request for local models.
export function openAiCompatibleAdapter(provider: SmartPickupEvaluatorProvider, opts: {
  base: (model: string, signal: AbortSignal) => Promise<string>;
  available: () => Promise<boolean>;
  fetchImpl?: typeof fetch;
  run?: <T>(work: () => Promise<T>) => Promise<T>;
}): EvaluatorAdapter {
  const fetchImpl = opts.fetchImpl ?? fetch;
  return {
    provider,
    async capability() { try { return { provider, available: await opts.available() }; } catch { return { provider, available: false, reason: 'Local provider is unavailable.' }; } },
    async evaluate(req) {
      const { signal, done } = deadline(req);
      let onAbort: (() => void) | undefined;
      try {
        const perform = async () => {
        signal.throwIfAborted();
        const base = (await opts.base(req.model, signal)).replace(/\/$/, '');
        signal.throwIfAborted();
        const response = await fetchImpl(`${base}/chat/completions`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
          body: JSON.stringify({ model: req.model, stream: false, max_tokens: req.maxOutputTokens, temperature: 0,
            messages: [{ role: 'system', content: req.instructions }, { role: 'user', content: req.prompt }] }),
        });
        if (!response.ok) throw new EvaluatorRefused(response.status === 401 || response.status === 403 ? 'not_signed_in' : `provider_http_${response.status}`);
        const result = await boundedLocalResponse(response, outputCharCap(req.maxOutputTokens) * 4 + 16_384) as { choices?: Array<{ message?: { content?: unknown; tool_calls?: unknown; function_call?: unknown }; finish_reason?: string }> };
        const choice = result && Array.isArray(result.choices) ? result.choices[0] : undefined;
        if ((choice?.message?.tool_calls != null && (!Array.isArray(choice.message.tool_calls) || choice.message.tool_calls.length > 0)) || choice?.message?.function_call || (choice?.finish_reason === 'tool_calls' || choice?.finish_reason === 'function_call')) throw new EvaluatorRefused('tool_attempted');
        if (!choice?.message || !('content' in choice.message)) throw new EvaluatorRefused('unreadable_answer');
        if (typeof choice.message.content !== 'string') throw new EvaluatorRefused('non_text_answer');
        const answer = choice.message.content;
        if (choice.finish_reason === 'length' || answer.length > outputCharCap(req.maxOutputTokens)) throw new EvaluatorRefused('output_too_long');
        if (!answer.trim()) throw new EvaluatorRefused('empty_answer');
        return answer;
        };
        const work = opts.run ? opts.run(perform) : perform();
        const aborted = new Promise<never>((_, reject) => {
          onAbort = () => reject(signal.reason);
          signal.addEventListener('abort', onAbort, { once: true });
          if (signal.aborted) onAbort();
        });
        return await Promise.race([work, aborted]);
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        if (error instanceof EvaluatorRefused) throw error;
        if (error instanceof SyntaxError) throw new EvaluatorRefused('unreadable_answer');
        throw new EvaluatorRefused('unavailable');
      } finally { if (onAbort) signal.removeEventListener('abort', onAbort); done(); }
    },
  };
}

function localRun<T>(provider: LocalProviderName, work: () => Promise<T>): Promise<T> {
  return queueLocalProvider(provider, async () => {
    if (localModelsUnloading()) throw new EvaluatorRefused('unavailable');
    return work();
  });
}

export async function requireLoadedLocalModel(provider: 'lmstudio' | 'strata' | 'deepseek', base: string, model: string, signal: AbortSignal): Promise<string> {
  const url = provider === 'lmstudio' ? `${base.replace(/\/v\d+$/, '')}/api/v1/models` : `${base}/status`;
  const response = await fetch(url, { signal });
  if (!response.ok) throw new EvaluatorRefused('unavailable');
  const body = await boundedLocalResponse(response, 128_000) as { model?: string; loaded?: boolean; models?: Array<{ key?: string; loaded_instances?: Array<{ id?: string }> }> };
  const loaded = provider === 'lmstudio'
    ? body.models?.some((entry) => (entry.key === model && !!entry.loaded_instances?.length) || entry.loaded_instances?.some((instance) => instance.id === model))
    : body.model === model && body.loaded === true;
  if (!loaded) throw new EvaluatorRefused(`model_not_loaded_${provider}`);
  return base;
}

let adapters: Record<SmartPickupEvaluatorProvider, EvaluatorAdapter> = {
  ollama: ollamaAdapter(),
  claude: claudeAdapter(),
  cursor: cursorAdapter(),
  codex: codexAdapter(),
  lmstudio: openAiCompatibleAdapter('lmstudio', { base: async (model, signal) => requireLoadedLocalModel('lmstudio', await getLmstudioBase(), model, signal), available: async () => (await probeLmstudio()).up, run: (work) => localRun('lmstudio', work) }),
  strata: openAiCompatibleAdapter('strata', { base: async (model, signal) => requireLoadedLocalModel('strata', await getStrataBase(), model, signal), available: async () => (await probeStrata()).up, run: (work) => localRun('strata', work) }),
  deepseek: openAiCompatibleAdapter('deepseek', { base: async (model, signal) => requireLoadedLocalModel('deepseek', await getDeepSeekBase(), model, signal), available: async () => (await probeDeepSeek()).up, run: (work) => localRun('deepseek', work) }),
  llamacpp: openAiCompatibleAdapter('llamacpp', { base: async (model) => {
    const status = llamacppManager.getStatus();
    if (status.state !== 'ready' || status.alias !== model || !status.port) throw new EvaluatorRefused('model_not_loaded_llamacpp');
    return `${llamacppBaseUrl({host:llamacppManager.getEndpoint().host,port:status.port})}/v1`;
  }, available: async () => (await probeLlamacppLive()).up, run: (work) => localRun('llamacpp', async () => {
    const release = llamacppManager.acquire(); try { return await work(); } finally { release(); }
  }) }),
};

export function evaluatorAdapter(provider: SmartPickupEvaluatorProvider): EvaluatorAdapter {
  return adapters[provider];
}

// Tests replace adapters with fakes; returns a restore function.
export function setEvaluatorAdaptersForTest(next: Partial<Record<SmartPickupEvaluatorProvider, EvaluatorAdapter>>): () => void {
  const prior = adapters;
  adapters = { ...adapters, ...next };
  return () => { adapters = prior; };
}

export async function evaluatorCapabilities(): Promise<SmartPickupEvaluatorCapability[]> {
  return Promise.all(SMART_PICKUP_EVALUATOR_PROVIDERS.map((p) => adapters[p].capability().catch((err) => ({ provider: p, available: false, reason: String(err) }))));
}
