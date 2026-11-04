// docs/PROVIDERS.md - in-process loopback HTTP MCP server for
// Cursor cluster members.
//
// Cursor ACP advertises `mcpCapabilities:{http:true,sse:true}` and NO stdio, so
// the stdio child Claude CLI / Codex members spawn (clusterMcpServer.ts) can't
// carry Cursor's peer tools. Instead each Cursor member gets an in-process
// StreamableHTTP MCP server bound to 127.0.0.1:<ephemeral>, whose URL is passed
// in `session/new`'s `mcpServers`. The Phase-6 SSE micro-probe
// (scripts/cursor-sse-mcp-probe.ts) confirmed a loopback network MCP's tools
// appear + are callable over ACP; streamable-HTTP is the chosen transport.
//
// One listener per WORKFLOW (member), mirroring the stdio child's one-per-spawn
// identity model — peer_send stamps `from: workflowId`, so the workflowId must
// be baked per server, and N Cursor members of one cluster can't share a URL.
// Unlike the stdio child (fresh per turn), a Cursor worker is long-lived and
// reuses its ACP session across turns, so the listener is long-lived too:
// created lazily at bootstrap, closed on worker dispose. The (clusterId,
// taskBoardAttached) context is held in a mutable ref and refreshed each turn,
// so a mid-life task-board attach/detach is picked up on the next tool call
// (tools are rebuilt per HTTP request in the stateless pattern below).
//
// Hardening: the URL carries an unguessable random path token so a stray local
// process can't trivially drive a member's peer tools. Same loopback trust
// model as the REST API the tools call through.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerClusterTools, type ClusterMcpToolCtx } from './clusterMcpTools.js';
import { registerPlanTools } from './planMcpTools.js';
import type { ClusterMemberAccessMode } from '@arco/shared';

export interface ClusterLoopbackCtx {
  clusterId: string;
  workflowId: string;
  arcoPort: number;
  // Workflow cwd — carries the workflow-scoped `arco` plan tools onto the
  // same loopback server. Cursor ACP honors MCP over http/sse only, so it
  // can't use the `arco` stdio child every other transport gets; folding
  // the plan tools in here is how a Cursor member reaches plan_create.
  // Absent ⇒ plan tools omitted (cluster tools still register).
  cwd?: string;
  taskBoardAttached: boolean;
  accessMode?: ClusterMemberAccessMode;
}

interface LoopbackEntry {
  http: Server;
  port: number;
  token: string;
  // Mutable — refreshed each turn via ensureClusterLoopbackMcp so board
  // attach/detach and (defensively) clusterId changes land without a respawn.
  ctx: ClusterLoopbackCtx;
}

const servers = new Map<string, LoopbackEntry>();

function tag(workflowId: string): string {
  return `[cluster-mcp-loopback:${workflowId.slice(0, 8)}]`;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return undefined;
  try { return JSON.parse(raw); } catch { return undefined; }
}

// Stateless streamable-HTTP: a fresh McpServer + transport per request, reading
// the CURRENT ctx from the entry so board attach/detach is reflected. Matches
// the pattern validated by the Phase-6 probe.
async function handleMcpRequest(entry: LoopbackEntry, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = req.method === 'POST' ? await readBody(req) : undefined;
  const toolCtx: ClusterMcpToolCtx = {
    clusterId: entry.ctx.clusterId,
    workflowId: entry.ctx.workflowId,
    arcoPort: entry.ctx.arcoPort,
    taskBoardAttached: entry.ctx.taskBoardAttached,
    accessMode: entry.ctx.accessMode,
    logErr: (...args: unknown[]) => console.error(tag(entry.ctx.workflowId), ...args),
  };
  const server = new McpServer({ name: 'arco-cluster', version: '1.0.0' });
  registerClusterTools(server, toolCtx);
  if (entry.ctx.cwd) {
    registerPlanTools(server, {
      workflowId: entry.ctx.workflowId,
      cwd: entry.ctx.cwd,
      arcoPort: entry.ctx.arcoPort,
      logErr: toolCtx.logErr,
    });
  }
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { void transport.close(); void server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

/**
 * Ensure a loopback HTTP MCP server exists for this member and return the URL to
 * hand to Cursor's `session/new` mcpServers. Idempotent — a second call for the
 * same workflowId refreshes the ctx (board attach/detach) and returns the same
 * URL. The returned descriptor is the ACP HTTP MCP shape.
 */
export async function ensureClusterLoopbackMcp(
  ctx: ClusterLoopbackCtx,
): Promise<{ name: string; url: string }> {
  const existing = servers.get(ctx.workflowId);
  if (existing) {
    // Refresh board/cluster context for subsequent requests. cwd is merged, not
    // replaced: a refresh that omits it must not unregister the plan_* tools
    // (the per-turn Cursor refresh once did exactly that after turn one).
    existing.ctx = { ...ctx, cwd: ctx.cwd ?? existing.ctx.cwd };
    return { name: 'arco-cluster', url: urlFor(existing) };
  }

  const token = randomBytes(16).toString('hex');
  const entry: LoopbackEntry = { http: undefined as unknown as Server, port: 0, token, ctx };
  const http = createServer((req, res) => {
    const path = (req.url || '/').split('?')[0];
    if (path !== `/mcp/${token}`) { res.statusCode = 404; res.end('not found'); return; }
    handleMcpRequest(entry, req, res).catch((err) => {
      console.error(tag(ctx.workflowId), 'request failed:', err instanceof Error ? err.message : String(err));
      if (!res.headersSent) { res.statusCode = 500; res.end('cluster mcp error'); }
    });
  });
  entry.http = http;

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(0, '127.0.0.1', () => {
      const addr = http.address();
      entry.port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve();
    });
  });

  servers.set(ctx.workflowId, entry);
  console.log(`${tag(ctx.workflowId)} listening on 127.0.0.1:${entry.port} (cluster=${ctx.clusterId.slice(0, 8)} taskBoard=${ctx.taskBoardAttached ? 'attached' : 'detached'})`);
  return { name: 'arco-cluster', url: urlFor(entry) };
}

function urlFor(entry: LoopbackEntry): string {
  return `http://127.0.0.1:${entry.port}/mcp/${entry.token}`;
}

/** Tear down a member's loopback server (called on Cursor worker dispose). */
export function closeClusterLoopbackMcp(workflowId: string): void {
  const entry = servers.get(workflowId);
  if (!entry) return;
  servers.delete(workflowId);
  try { entry.http.close(); } catch { /* already closing */ }
  console.log(`${tag(workflowId)} closed`);
}
