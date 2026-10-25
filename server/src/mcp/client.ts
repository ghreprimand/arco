// ARCO_OPS_PLAN.md §E1 — minimal MCP stdio client.
//
// Speaks newline-delimited JSON-RPC 2.0 over a spawned stdio child (the same
// framing clusterMcpServer.ts uses on the server side). Dependency-free on
// purpose: no @modelcontextprotocol SDK client, so this stays a tiny,
// auditable surface that E1-Native (pass 2) can import to make the Native
// worker an MCP host without dragging in the SDK's transport machinery.
//
// SECURITY (hard rules from the phase brief):
//   - Spawn is argv-array via `spawn(command, args, …)` — NEVER shell:true,
//     NEVER sudo. The caller's `command`/`args` come straight from the
//     operator-curated registry def.
//   - `env` is allowlisted via buildSafeEnv (H20): the child sees only a small
//     non-secret base (PATH/HOME/locale/temp/XDG_*) plus the operator-declared
//     `def.env`. The host's full environment (OAuth token, PATs, API keys) is
//     NEVER inherited. env values are also NEVER logged; classifyDangerous +
//     tool names are safe to log, env is not.
//   - Bounded by `timeoutMs` — a hung child must not wedge the server. On
//     timeout (or any error) the child is force-killed and the probe rejects.
//
// This module's exports:
//   - classifyDangerous(name)  — pure denylist regex; exported so the smoke
//     and the providers can classify without spawning anything.
//   - probeServer(def, opts)   — spawn → initialize → tools/list → classify →
//     tear down. Powers diagnostics AND the visible tool list. One-shot.
//   - connectServer(def, opts) — E1-Native: a LONG-LIVED session (spawn →
//     initialize → ready for repeated tools/call). The Claude Native in-process
//     worker is an MCP host: it opens one session per allowed registry server
//     and calls tools across operator turns. close() force-kills the child
//     (idempotent). A spawn/initialize failure resolves to a CLOSED session
//     that reports errors rather than throwing into the worker's turn loop.
//
// Both spawn paths share the same newline-delimited JSON-RPC framing helper
// (writeRpc / parseRpcLines) so the wire contract lives in one place.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { McpServerDef, McpToolInfo } from '@arco/shared';

// SECURITY (H20) — env allowlist for spawned MCP children.
//
// Both spawn paths used to merge the FULL `process.env` into every `npx`/`uvx`
// MCP child (`{ ...process.env, ...def.env }`). That handed each third-party
// MCP server the Arco server's entire environment — the Claude OAuth token, a
// GitHub PAT, provider API keys, and anything else the operator's shell exports.
// An MCP server is untrusted code; it has no business seeing host credentials.
//
// buildSafeEnv returns an ALLOWLISTED environment: the small set of vars a child
// legitimately needs to run (PATH/HOME/SHELL, locale, temp dir, XDG_* config
// locations) PLUS the operator-declared `def.env` — which IS the intended way to
// pass a server its own credentials. Everything else is dropped. Operator-
// declared values win over the inherited base.
//
// POSIX-focused (Arco runs Linux + macOS on this branch; the windows-port
// worktree owns its own env shape). Exported so the unit test can assert no
// host secret survives the filter.
const SAFE_ENV_KEYS = new Set<string>([
  'PATH', 'HOME', 'SHELL', 'LANG', 'TMPDIR', 'TMP', 'TEMP', 'USER', 'LOGNAME', 'TERM',
]);

export function buildSafeEnv(declared?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    // Exact-match safe keys, plus the LC_* (locale) and XDG_* (base-dir spec)
    // families a child may rely on for correct rendering / config discovery.
    if (SAFE_ENV_KEYS.has(k) || k.startsWith('LC_') || k.startsWith('XDG_')) {
      out[k] = v;
    }
  }
  // Operator-declared env is the intended secret channel — always applied,
  // overriding any inherited base value.
  if (declared) {
    for (const [k, v] of Object.entries(declared)) out[k] = v;
  }
  return out;
}

// Curated dangerous-tool denylist (LOCKED operator decision §1). A tool whose
// NAME contains any of these TOKENS is dangerous-by-default: it stays OFF for a
// tab until the operator explicitly ticks it.
//
// Rationale per token: mutation/destruction verbs (write/delete/remove/drop/
// truncate/destroy), code-execution (exec/eval/shell/spawn/run/command/sudo),
// process control (kill/terminate), and HTTP write verbs (put/post/patch) —
// the latter because a "post" tool against an arbitrary endpoint is a
// side-effecting network write. Read-side verbs (read/list/get/search/query/
// describe) are NOT here and stay enabled by default.
//
// Matching is TOKEN-based, not substring: the tool name is split on `_`, `-`,
// `.`, whitespace, AND camelCase boundaries, then each token is checked
// against the set. This is why `readme` (token "readme") does NOT match `rm`,
// and `description` does NOT match — substring matching would mis-flag both.
const DANGEROUS_TOKENS = new Set<string>([
  'write', 'delete', 'del', 'remove', 'rm', 'drop', 'truncate', 'destroy',
  'exec', 'execute', 'eval', 'shell', 'spawn', 'run', 'kill', 'terminate',
  'sudo', 'command', 'cmd', 'put', 'post', 'patch', 'create', 'update',
  'modify', 'move', 'mv', 'rename', 'set', 'send', 'push', 'upload',
  'overwrite', 'replace', 'insert',
]);

// Split a tool name into lowercased word tokens across snake_case, kebab-case,
// dotted, whitespace, and camelCase boundaries.
function tokenize(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // camelCase → camel Case
    .split(/[^a-zA-Z0-9]+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length > 0);
}

// Pure helper — true iff any token of the tool name is in the dangerous set.
// Operates on the BARE tool name (e.g. `delete_file`), not the namespaced
// `mcp__<server>__<tool>` wire form. Exported so the smoke tests it directly.
export function classifyDangerous(toolName: string): boolean {
  return tokenize(toolName).some((tok) => DANGEROUS_TOKENS.has(tok));
}

// MCP tool annotations (per the spec's `Tool.annotations`). Servers MAY declare
// behaviour hints; we read the two that matter for the plan-mode gate. All
// optional — most servers emit none, which is why the verb fallback below exists.
export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

// Positive read-verb tokens. A tool whose name contains one of these (and NO
// dangerous token) is treated as read-only by the verb fallback. This is the
// inverse-leaning companion to DANGEROUS_TOKENS — note these two sets do not
// cover the whole space, which is what makes the classifier fail-closed.
const READONLY_TOKENS = new Set<string>([
  'read', 'list', 'get', 'search', 'query', 'describe', 'fetch', 'find',
  'show', 'view', 'info', 'status', 'check', 'inspect', 'lookup', 'resolve',
  'count', 'stat', 'ls', 'cat', 'head', 'tail', 'peek',
]);

// PLAN-MODE read-only classifier (DD11a). OPPOSITE POLARITY to
// classifyDangerous: returns true only when we are CONFIDENT the tool does not
// mutate state, so plan-mode can hide/reject everything else. Resolution order:
//   1. annotation-first — the server's own `readOnlyHint` / `destructiveHint`;
//   2. verb fallback — a clear read-verb name with no dangerous token;
//   3. FAIL-CLOSED — anything ambiguous is treated as NOT read-only.
// (`readOnlyHint:true` wins even over a scary-looking name: it's the server's
// explicit declaration. `destructiveHint:false` alone is NOT a read-only
// assertion — a tool can be non-destructive and still write — so it falls
// through to the verb check.)
export function isMcpToolReadOnly(tool: { name: string; annotations?: McpToolAnnotations }): boolean {
  const ann = tool.annotations;
  if (ann) {
    if (ann.readOnlyHint === true) return true;
    if (ann.readOnlyHint === false || ann.destructiveHint === true) return false;
  }
  const toks = tokenize(tool.name);
  if (toks.some((t) => DANGEROUS_TOKENS.has(t))) return false;
  if (toks.some((t) => READONLY_TOKENS.has(t))) return true;
  return false; // fail-closed: no signal ⇒ assume it can mutate
}

export interface ProbeResult {
  ok: boolean;
  tools: McpToolInfo[];
  error?: string;
}

export interface ProbeOptions {
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

// Spawn the server's stdio child, run the MCP handshake, list tools, classify
// each, and tear the child down. Always resolves (never rejects) — failure is
// reported as `{ ok:false, error }` so callers can surface it as diagnostics.
export async function probeServer(def: McpServerDef, opts: ProbeOptions = {}): Promise<ProbeResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let child: ChildProcessWithoutNullStreams | null = null;

  return new Promise<ProbeResult>((resolve) => {
    let settled = false;
    let stdoutBuf = '';
    let nextId = 1;
    let timer: NodeJS.Timeout | null = null;

    const finish = (res: ProbeResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      // Force-kill the whole child; the probe is short-lived and stateless.
      try { child?.kill('SIGKILL'); } catch { /* already gone */ }
      resolve(res);
    };

    try {
      // argv array, no shell. env is allowlisted (H20 — no host secrets leak to
      // the child) and never logged.
      child = spawn(def.command, def.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: buildSafeEnv(def.env),
      }) as ChildProcessWithoutNullStreams;
    } catch (err) {
      finish({ ok: false, tools: [], error: `spawn failed: ${errMsg(err)}` });
      return;
    }

    timer = setTimeout(() => {
      finish({ ok: false, tools: [], error: `timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    child.on('error', (err) => {
      finish({ ok: false, tools: [], error: `spawn error: ${errMsg(err)}` });
    });
    child.on('exit', (code, signal) => {
      // If the child dies before we got tools/list, that's a failure. After
      // we've settled (force-kill on success) this is a no-op.
      if (!settled) {
        finish({ ok: false, tools: [], error: `child exited (code=${code} signal=${signal})` });
      }
    });

    const send = (method: string, params: unknown, id?: number): void => {
      const msg: Record<string, unknown> = { jsonrpc: '2.0', method };
      if (params !== undefined) msg.params = params;
      if (id !== undefined) msg.id = id;
      try { child?.stdin.write(JSON.stringify(msg) + '\n'); } catch { /* child gone */ }
    };

    const initId = nextId++;
    const listId = nextId++;

    const handleResponse = (resp: JsonRpcResponse): void => {
      if (resp.id === initId) {
        if (resp.error) {
          finish({ ok: false, tools: [], error: `initialize error: ${resp.error.message}` });
          return;
        }
        // Per MCP: send `notifications/initialized` then list tools.
        send('notifications/initialized', {});
        send('tools/list', {}, listId);
        return;
      }
      if (resp.id === listId) {
        if (resp.error) {
          finish({ ok: false, tools: [], error: `tools/list error: ${resp.error.message}` });
          return;
        }
        const result = resp.result as { tools?: Array<{ name: string; description?: string }> } | undefined;
        const raw = Array.isArray(result?.tools) ? result!.tools : [];
        const tools: McpToolInfo[] = raw
          .filter((t) => t && typeof t.name === 'string')
          .map((t) => ({
            name: t.name,
            ...(typeof t.description === 'string' ? { description: t.description } : {}),
            dangerous: classifyDangerous(t.name),
          }));
        finish({ ok: true, tools });
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdoutBuf += chunk;
      let idx: number;
      while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (!line) continue;
        let resp: JsonRpcResponse;
        try { resp = JSON.parse(line) as JsonRpcResponse; } catch { continue; }
        // Ignore server-initiated notifications/requests (no matching id).
        if (resp.id === undefined || resp.id === null) continue;
        handleResponse(resp);
      }
    });
    // stderr is the child's log channel; drain it so the pipe can't fill, but
    // do NOT surface it (may contain paths / non-secret diagnostics; keep the
    // probe result clean). Never logged here.
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', () => { /* drained, intentionally ignored */ });

    // Kick off the handshake.
    send(
      'initialize',
      {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'arco-mcp-probe', version: '1.0.0' },
      },
      initId,
    );
  });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── E1-Native: persistent session ──────────────────────────────────────────
//
// A tool as the session caches it from `initialize`/`tools/list`, carrying the
// raw `inputSchema` the worker needs to build an Anthropic tool def (the
// registry's McpToolInfo deliberately drops the schema — it's only the visible
// name/description/dangerous triple). `dangerous` is the same name-based
// classification so the worker can filter without re-tokenizing.
export interface McpSessionTool {
  name: string;
  description?: string;
  dangerous: boolean;
  inputSchema?: Record<string, unknown>;
  // DD11a — server-declared behaviour hints, captured for the plan-mode
  // read-only gate (isMcpToolReadOnly). Absent for servers that emit none.
  annotations?: McpToolAnnotations;
}

export interface McpSession {
  // Cached from initialize/tools-list. Empty on a failed/closed session.
  listTools(): McpSessionTool[];
  // Repeated tool calls. Resolves (never rejects) — a closed/errored session
  // or a timed-out call returns `{ text: '[error] …', isError: true }` so a
  // hung child can never wedge the worker's turn loop.
  callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
  // Force-kill the child. Idempotent — safe to call from dispose AND cancel.
  close(): void;
}

export interface ConnectOptions {
  // Spawn/initialize ceiling. A child that never completes the handshake within
  // this window resolves to a closed session that reports the timeout.
  initTimeoutMs?: number;
  // Per-tool-call ceiling. A tools/call that doesn't respond is reported as an
  // error tool result, not a hang.
  callTimeoutMs?: number;
}

const DEFAULT_INIT_TIMEOUT_MS = 10_000;
const DEFAULT_CALL_TIMEOUT_MS = 60_000;

// A session that is permanently closed (spawn/initialize failed). Every call
// reports the captured error; listTools is empty; close is a no-op. Returned
// instead of throwing so the worker never crashes a turn on a dead server.
function closedSession(error: string): McpSession {
  return {
    listTools: () => [],
    callTool: async () => ({ text: `[error] mcp session unavailable: ${error}`, isError: true }),
    close: () => { /* nothing to kill */ },
  };
}

// Spawn the stdio child, run the MCP handshake, cache the tool list, and hand
// back a session ready for repeated tools/call. NEVER rejects: a spawn or
// initialize failure resolves to closedSession(error). Mirrors probeServer's
// framing (newline-delimited JSON-RPC 2.0, argv array, no shell, env merged
// but never logged) but keeps the child alive.
export async function connectServer(def: McpServerDef, opts: ConnectOptions = {}): Promise<McpSession> {
  const initTimeoutMs = opts.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
  const callTimeoutMs = opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(def.command, def.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildSafeEnv(def.env), // H20 — allowlisted env, no host secrets leak
    }) as ChildProcessWithoutNullStreams;
  } catch (err) {
    return closedSession(`spawn failed: ${errMsg(err)}`);
  }

  // Shared per-child JSON-RPC state. `pending` maps a request id to its
  // resolver; `nextId` mints request ids. stdout is line-buffered. Any line
  // without a matching id (server notification/request) is ignored.
  let stdoutBuf = '';
  let nextId = 1;
  let closed = false;
  const pending = new Map<number, (resp: JsonRpcResponse) => void>();

  const killChild = (): void => {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdoutBuf += chunk;
    let idx: number;
    while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line) continue;
      let resp: JsonRpcResponse;
      try { resp = JSON.parse(line) as JsonRpcResponse; } catch { continue; }
      if (resp.id === undefined || resp.id === null) continue; // notification
      const cb = pending.get(resp.id as number);
      if (cb) { pending.delete(resp.id as number); cb(resp); }
    }
  });
  // Drain stderr (the child's log channel) so the pipe can't fill. Never
  // surfaced — may carry non-secret diagnostics, but env/secrets are not logged.
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', () => { /* drained, intentionally ignored */ });

  // On unexpected exit/error, mark closed and fail every awaiting call so a
  // dead child can't leave a callTool promise hanging forever.
  const onGone = (why: string): void => {
    if (closed) return;
    closed = true;
    for (const [, cb] of pending) {
      cb({ jsonrpc: '2.0', error: { code: -1, message: why } });
    }
    pending.clear();
  };
  child.on('exit', (code, signal) => onGone(`child exited (code=${code} signal=${signal})`));
  child.on('error', (err) => onGone(`child error: ${errMsg(err)}`));

  // Send a request and await its response, bounded by `timeoutMs`. Resolves
  // with the response (which may carry an `error`); on timeout resolves a
  // synthetic error response so the caller branches uniformly.
  const request = (method: string, params: unknown, timeoutMs: number): Promise<JsonRpcResponse> => {
    if (closed) return Promise.resolve({ jsonrpc: '2.0', error: { code: -1, message: 'session closed' } });
    const id = nextId++;
    return new Promise<JsonRpcResponse>((resolve) => {
      let timer: NodeJS.Timeout | null = setTimeout(() => {
        if (pending.delete(id)) resolve({ jsonrpc: '2.0', error: { code: -1, message: `timed out after ${timeoutMs}ms` } });
      }, timeoutMs);
      pending.set(id, (resp) => { if (timer) { clearTimeout(timer); timer = null; } resolve(resp); });
      const msg: Record<string, unknown> = { jsonrpc: '2.0', method, id };
      if (params !== undefined) msg.params = params;
      try { child.stdin.write(JSON.stringify(msg) + '\n'); }
      catch { if (pending.delete(id)) resolve({ jsonrpc: '2.0', error: { code: -1, message: 'stdin write failed' } }); }
    });
  };

  const notify = (method: string, params: unknown): void => {
    const msg: Record<string, unknown> = { jsonrpc: '2.0', method };
    if (params !== undefined) msg.params = params;
    try { child.stdin.write(JSON.stringify(msg) + '\n'); } catch { /* child gone */ }
  };

  // Handshake. Any failure ⇒ kill child + return a closedSession.
  const initResp = await request(
    'initialize',
    {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'arco-mcp-native', version: '1.0.0' },
    },
    initTimeoutMs,
  );
  if (initResp.error) {
    killChild();
    return closedSession(`initialize error: ${initResp.error.message}`);
  }
  notify('notifications/initialized', {});

  const listResp = await request('tools/list', {}, initTimeoutMs);
  if (listResp.error) {
    killChild();
    return closedSession(`tools/list error: ${listResp.error.message}`);
  }
  const listResult = listResp.result as { tools?: Array<{ name: string; description?: string; inputSchema?: unknown; annotations?: unknown }> } | undefined;
  const rawTools = Array.isArray(listResult?.tools) ? listResult!.tools : [];
  const tools: McpSessionTool[] = rawTools
    .filter((t) => t && typeof t.name === 'string')
    .map((t) => ({
      name: t.name,
      ...(typeof t.description === 'string' ? { description: t.description } : {}),
      dangerous: classifyDangerous(t.name),
      ...(t.inputSchema && typeof t.inputSchema === 'object' ? { inputSchema: t.inputSchema as Record<string, unknown> } : {}),
      ...(t.annotations && typeof t.annotations === 'object' ? { annotations: t.annotations as McpToolAnnotations } : {}),
    }));

  return {
    listTools: () => tools.slice(),
    callTool: async (name, args) => {
      if (closed) return { text: '[error] mcp session closed', isError: true };
      const resp = await request('tools/call', { name, arguments: args ?? {} }, callTimeoutMs);
      if (resp.error) return { text: `[error] ${resp.error.message}`, isError: true };
      // MCP tools/call result: { content: [{type:'text', text}], isError? }.
      const result = resp.result as { content?: Array<{ type?: string; text?: string }>; isError?: boolean } | undefined;
      const parts = Array.isArray(result?.content)
        ? result!.content.filter((c) => c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text as string)
        : [];
      const text = parts.length > 0 ? parts.join('\n') : JSON.stringify(result?.content ?? result ?? {});
      const isError = result?.isError === true;
      return { text, isError };
    },
    close: () => {
      if (closed) { killChild(); return; }
      closed = true;
      killChild();
    },
  };
}
