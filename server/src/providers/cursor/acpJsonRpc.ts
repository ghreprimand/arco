// JSON-RPC 2.0 client for `cursor-agent acp` (Agent Client Protocol).
//
// Forked from codex-appserver/jsonRpc.ts with two differences the Phase-0 spike
// confirmed against live `cursor-agent acp`:
//   1. ACP is REAL JSON-RPC 2.0 — every frame carries `"jsonrpc":"2.0"` (Codex's
//      app-server speaks bare NDJSON with no envelope). We add it on the way out
//      and don't require it on the way in.
//   2. ACP is BIDIRECTIONAL — mid-turn the agent sends REQUESTS back to us
//      (`fs/read_text_file`, `fs/write_text_file`, `session/request_permission`,
//      `terminal/*`). Those frames have BOTH `method` and `id` and MUST be
//      answered or the turn hangs. Codex's client never sees inbound requests;
//      here an `onRequest` handler replies to each.
//
// Wire framing is identical: newline-delimited JSON, one message per line.

import { EventEmitter } from 'events';
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

// A server→client request the agent made mid-turn. Answer it via the resolver
// the handler is given (or throw to send an error back).
export interface IncomingRequest {
  method: string;
  params: unknown;
}

export class JsonRpcRequestError extends Error {
  readonly rpcError: JsonRpcError;
  constructor(rpcError: JsonRpcError, method: string) {
    super(`JSON-RPC ${method} failed: ${rpcError.message}`);
    this.name = 'JsonRpcRequestError';
    this.rpcError = rpcError;
  }
}

// Throw from `onRequest` to reply with a specific JSON-RPC error code (e.g.
// -32601 method-not-found); any other throw replies -32603.
export class AcpReplyError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
    this.name = 'AcpReplyError';
  }
}

// EventEmitter surface mirrors codex's client: `notification` / `close` /
// `protocol_error`. Inbound requests are handled by the `onRequest` callback
// (not an event) because they must produce a reply — an async return value is
// the natural shape, and swallowing one silently would hang the turn.
export class AcpJsonRpcClient extends EventEmitter {
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private buf = '';
  private closed = false;

  // Server→client request handler. Return a result (or a Promise of one) to
  // reply; throw to send a JSON-RPC error. Default replies `{}` so an
  // unhandled request never hangs the agent.
  onRequest: (req: IncomingRequest) => Promise<unknown> | unknown = () => ({});

  constructor(
    private readonly stdin: Writable,
    stdout: Readable,
  ) {
    super();
    stdout.on('data', (chunk: Buffer) => this.onStdoutData(chunk));
    stdout.on('end', () => this.onClose('stdout ended'));
    stdout.on('error', (err: Error) => this.onClose(`stdout error: ${err.message}`));
    stdin.on('error', (err: Error) => this.onClose(`stdin error: ${err.message}`));
  }

  request<R = unknown>(method: string, params?: unknown): Promise<R> {
    if (this.closed) return Promise.reject(new Error('ACP transport closed'));
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise<R>((resolve, reject) => {
      this.pending.set(id, { resolve: (v) => resolve(v as R), reject, method });
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
      this.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    } catch (err) {
      this.onClose(`notify write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  close(reason = 'closed by client'): void {
    this.onClose(reason);
  }

  private onStdoutData(chunk: Buffer): void {
    this.buf += chunk.toString('utf8');
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

    const hasId = typeof msg.id === 'number';
    const hasMethod = typeof msg.method === 'string';

    // Server→client REQUEST: both method and id. Answer or the turn hangs.
    if (hasId && hasMethod) {
      void this.handleIncomingRequest(msg.id as number, msg.method as string, msg.params);
      return;
    }

    // Response to one of our requests: id, no method.
    if (hasId) {
      const id = msg.id as number;
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

    // Notification: method, no id.
    if (hasMethod) {
      this.emit('notification', { method: msg.method as string, params: msg.params } as JsonRpcNotification);
      return;
    }

    this.emit('protocol_error', `unrecognized message shape: ${line.slice(0, 200)}`);
  }

  private async handleIncomingRequest(id: number, method: string, params: unknown): Promise<void> {
    let result: unknown;
    try {
      result = await this.onRequest({ method, params });
    } catch (err) {
      const code = err instanceof AcpReplyError ? err.code : -32603;
      this.writeReply({ jsonrpc: '2.0', id, error: { code, message: err instanceof Error ? err.message : String(err) } });
      return;
    }
    this.writeReply({ jsonrpc: '2.0', id, result: result ?? null });
  }

  private writeReply(payload: Record<string, unknown>): void {
    if (this.closed) return;
    try {
      this.stdin.write(JSON.stringify(payload) + '\n');
    } catch {
      // Transport is going down; the pending-request cleanup covers the rest.
    }
  }

  private onClose(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    const err = new Error(`ACP transport: ${reason}`);
    for (const [id, p] of this.pending) {
      p.reject(err);
      this.pending.delete(id);
    }
    this.emit('close', reason);
  }
}
