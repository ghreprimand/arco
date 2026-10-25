// Minimal JSON-RPC client for `codex app-server`. The protocol is
// newline-delimited JSON over stdio (one message per line) — there's no
// `jsonrpc: "2.0"` envelope on the wire, just `{id, method, params}` for
// requests, `{id, result}` / `{id, error}` for responses, and `{method,
// params}` (no id) for notifications. Requests flow both ways: Codex sends
// `{id, method, params}` server→client requests (approvals, elicitation,
// requestUserInput, dynamic tool calls, token refresh) that MUST be answered
// or the turn blocks forever.
//
// Verified against codex-cli 0.128.0 with --listen stdio:// (the default).

import { EventEmitter } from 'events';
import { StringDecoder } from 'node:string_decoder';
import type { Readable, Writable } from 'stream';

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  method: string;
}

export interface JsonRpcNotification {
  method: string;
  params: unknown;
}

// Codex permits string or numeric ids on its own requests (bindings/RequestId).
export type JsonRpcId = string | number;

export interface JsonRpcServerRequest {
  id: JsonRpcId;
  method: string;
  params: unknown;
}

// Arco runs every thread with `approvalPolicy: 'never'` and no dynamic
// client tools. Clarification questions have an explicit
// interactive handler; other server requests use safe defaults (newer codex,
// MCP elicitation, guardian review), answer with the protocol's documented
// decline shape so the model sees a refusal and carries on — never leave it
// unanswered. `null` ⇒ no safe decline exists; reply -32601 instead.
// Shapes: bindings/ServerRequest.ts + the matching *Response bindings.
export function defaultServerRequestResult(method: string): unknown | null {
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return { decision: 'decline' };
    case 'execCommandApproval':
    case 'applyPatchApproval':
      return { decision: 'denied' };
    case 'item/permissions/requestApproval':
      // Grant nothing beyond the thread's sandbox.
      return { permissions: {}, scope: 'turn' };
    case 'item/tool/requestUserInput':
      return { answers: {} };
    case 'mcpServer/elicitation/request':
      return { action: 'decline', content: null, _meta: null };
    case 'item/tool/call':
      return {
        contentItems: [{ type: 'inputText', text: 'Arco does not implement client-side dynamic tools.' }],
        success: false,
      };
    // account/chatgptAuthTokens/refresh: Arco can't mint tokens — error out
    // so codex falls back to its own auth handling instead of hanging.
    default:
      return null;
  }
}

export const JSONRPC_METHOD_NOT_FOUND = -32601;

// Errors thrown from `request()` carry the structured RPC error so callers
// can branch on `.rpcError?.message` etc. without re-stringifying.
export class JsonRpcRequestError extends Error {
  readonly rpcError: JsonRpcError;
  constructor(rpcError: JsonRpcError, method: string) {
    super(`JSON-RPC ${method} failed: ${rpcError.message}`);
    this.name = 'JsonRpcRequestError';
    this.rpcError = rpcError;
  }
}

// EventEmitter so consumers can subscribe to incoming notifications via
// `client.on('notification', (n) => ...)` and to transport-level death via
// `client.on('close', () => ...)`. Outbound writes happen through `request()`
// (await) and `notify()` (fire-and-forget).
export class JsonRpcClient extends EventEmitter {
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private buf = '';
  private readonly decoder = new StringDecoder('utf8');
  private closed = false;

  constructor(
    private readonly stdin: Writable,
    stdout: Readable,
    private readonly handleInteractiveRequest?: (request: JsonRpcServerRequest) => boolean,
  ) {
    super();
    stdout.on('data', (chunk: Buffer) => this.onStdoutData(chunk));
    stdout.on('end', () => this.onClose('stdout ended'));
    stdout.on('error', (err: Error) => this.onClose(`stdout error: ${err.message}`));
    stdin.on('error', (err: Error) => this.onClose(`stdin error: ${err.message}`));
  }

  request<R = unknown>(method: string, params?: unknown): Promise<R> {
    if (this.closed) return Promise.reject(new Error('JSON-RPC transport closed'));
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise<R>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => resolve(v as R),
        reject,
        method,
      });
      try {
        this.stdin.write(payload + '\n');
      } catch (err) {
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    try {
      this.stdin.write(JSON.stringify({ method, params }) + '\n');
    } catch (err) {
      this.onClose(`notify write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Reply to a server→client request. Fire-and-forget like notify().
  respond(id: JsonRpcId, result: unknown): boolean {
    return this.writeLine({ id, result });
  }

  respondError(id: JsonRpcId, error: JsonRpcError): void {
    this.writeLine({ id, error });
  }

  private writeLine(msg: Record<string, unknown>): boolean {
    if (this.closed) return false;
    try {
      this.stdin.write(JSON.stringify(msg) + '\n');
      return true;
    } catch (err) {
      this.onClose(`write failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  // Close the local side. Pending requests reject with the supplied reason.
  // The remote process is NOT signalled here — the caller (worker) owns the
  // ChildProcess and decides whether to SIGTERM it after closing the RPC.
  close(reason = 'closed by client'): void {
    this.onClose(reason);
  }

  private onStdoutData(chunk: Buffer): void {
    this.buf += this.decoder.write(chunk);
    let nl = this.buf.indexOf('\n');
    while (nl !== -1) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line) this.handleLine(line);
      nl = this.buf.indexOf('\n');
    }
  }

  private handleLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch (err) {
      this.emit('protocol_error', `non-JSON line: ${line.slice(0, 200)} (${err instanceof Error ? err.message : String(err)})`);
      return;
    }
    // Check `method` before `id`: a server→client request carries both, and
    // routing it by id used to resolve an unrelated pending call of ours (the
    // id spaces overlap) or drop it as "no matching request" — either way
    // codex waited forever for the answer and the turn hung.
    if (typeof msg.method === 'string' && (typeof msg.id === 'number' || typeof msg.id === 'string')) {
      this.handleServerRequest({ id: msg.id, method: msg.method, params: msg.params });
      return;
    }
    if (typeof msg.id === 'number') {
      const id = msg.id;
      const pending = this.pending.get(id);
      if (!pending) {
        this.emit('protocol_error', `response id=${id} has no matching request`);
        return;
      }
      this.pending.delete(id);
      if ('error' in msg && msg.error) {
        const e = msg.error as Partial<JsonRpcError> & Record<string, unknown>;
        pending.reject(new JsonRpcRequestError(
          { code: typeof e.code === 'number' ? e.code : -32000,
            message: typeof e.message === 'string' ? e.message : 'unknown error',
            data: e.data },
          pending.method,
        ));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }
    if (typeof msg.method === 'string') {
      this.emit('notification', { method: msg.method, params: msg.params } as JsonRpcNotification);
      return;
    }
    this.emit('protocol_error', `unrecognized message shape: ${line.slice(0, 200)}`);
  }

  // Only an explicit handler can retain a question for an operator reply.
  // All other requests still receive the existing deterministic defaults.
  private handleServerRequest(req: JsonRpcServerRequest): void {
    if (this.handleInteractiveRequest?.(req)) return;
    const result = defaultServerRequestResult(req.method);
    this.emit('server_request', req, result !== null);
    if (result !== null) {
      this.respond(req.id, result);
    } else {
      this.respondError(req.id, {
        code: JSONRPC_METHOD_NOT_FOUND,
        message: `Arco does not handle server request ${req.method}`,
      });
    }
  }

  private onClose(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    const err = new Error(`JSON-RPC transport: ${reason}`);
    for (const [id, p] of this.pending) {
      p.reject(err);
      this.pending.delete(id);
    }
    this.emit('close', reason);
  }
}
