import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerClusterTools } from './clusterMcpTools.js';

const MAX_BODY = 1024 * 1024;
const MAX_CONNECTIONS = 16;
const ID = /^[a-zA-Z0-9_-]+$/;

async function bodyFor(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += part.length;
    if (bytes > MAX_BODY) throw new Error('Request is too large.');
    chunks.push(part);
  }
  if (!bytes) return undefined;
  return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')) as unknown;
}

/** A mailbox-only MCP endpoint with one immutable worker identity. */
export async function startWorkerMailBridge(options: {
  parentDir: string;
  clusterId: string;
  workflowId: string;
  arcoPort: number;
} & ({ mode: 'researcher'; directorWorkflowId: string } | { mode: 'isolated'; directorWorkflowId?: never })): Promise<{ socketPath: string; token: string; close: () => Promise<void> }> {
  if (typeof options.clusterId !== 'string' || typeof options.workflowId !== 'string'
    || !ID.test(options.clusterId) || !ID.test(options.workflowId)
    || (options.mode !== 'isolated' && options.mode !== 'researcher')
    || !Number.isInteger(options.arcoPort) || options.arcoPort < 1 || options.arcoPort > 65535) {
    throw new Error('Invalid worker mail identity.');
  }
  if (options.mode === 'researcher' && (typeof options.directorWorkflowId !== 'string' || !ID.test(options.directorWorkflowId) || options.directorWorkflowId === options.workflowId)) {
    throw new Error('A researcher mail bridge requires its Research Director.');
  }
  const { clusterId, workflowId, arcoPort } = options;
  const onlyRecipientWorkflowId = options.mode === 'researcher' ? options.directorWorkflowId : undefined;
  const directory = await mkdtemp(join(options.parentDir, 'worker-mail-'));
  const socketPath = join(directory, 'mail.sock');
  const token = randomBytes(32).toString('hex');
  const expected = Buffer.from(token, 'ascii');
  const active = new Set<Socket>();
  const abort = new AbortController();
  const http = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    const candidate = path.startsWith('/mcp/') ? path.slice(5) : '';
    const supplied = Buffer.from(/^[a-f0-9]{64}$/.test(candidate) ? candidate : '', 'ascii');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      res.writeHead(404); res.end(); return;
    }
    void (async () => {
      const body = req.method === 'POST' ? await bodyFor(req) : undefined;
      if (res.destroyed) return;
      const server = new McpServer({ name: 'arco-cluster', version: '1.0.0' });
      registerClusterTools(server, {
        clusterId,
        workflowId,
        arcoPort,
        taskBoardAttached: false,
        accessMode: 'isolated',
        signal: abort.signal,
        ...(onlyRecipientWorkflowId ? { onlyRecipientWorkflowId } : {}),
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.once('close', () => { void transport.close(); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    })().catch(() => { if (!res.headersSent) res.writeHead(400); res.end(); });
  });
  http.maxConnections = MAX_CONNECTIONS;
  http.headersTimeout = 10_000;
  http.requestTimeout = 30_000;
  http.on('connection', (socket) => {
    active.add(socket); socket.setTimeout(30_000, () => socket.destroy());
    socket.once('close', () => active.delete(socket));
  });
  http.on('clientError', (_error, socket) => socket.destroy());
  try {
    await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(socketPath, resolve); });
    await chmod(socketPath, 0o600);
  } catch (error) { http.close(); await rm(directory, { recursive: true, force: true }); throw error; }
  return {
    socketPath,
    token,
    close: async () => {
      abort.abort();
      for (const socket of active) socket.destroy();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}
