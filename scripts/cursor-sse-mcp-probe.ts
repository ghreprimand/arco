/**
 * THROWAWAY Phase-6 GATE probe for the Cursor (ACP) provider - docs/PROVIDERS.md
 * section Phase 6 (peer-tools / cluster membership). NOT shipped.
 *
 * The spike (item 8) established: Cursor ACP advertises `mcpCapabilities:{http:true,sse:true}`
 * and NO stdio - a stdio `mcpServers` entry was accepted but its tool was never called. Before
 * we wire the loopback `arco-cluster` peer-tools MCP for real, this micro-probe confirms the
 * OTHER half of that finding: that a loopback HTTP/SSE MCP server's tools DO appear + are
 * callable over ACP. GO/NO-GO for all Cursor cluster membership.
 *
 *   npx tsx scripts/cursor-sse-mcp-probe.ts
 *
 * ⚠️ METERED COST: makes real Cursor turns on `--model auto` (the Auto+Composer pool, not the
 * $20 frontier pool). Two tiny turns (one HTTP session, one SSE session). Kept minimal.
 *
 * It stands up ONE loopback MCP server (SDK McpServer, `arco_probe_ping`) exposed on
 * 127.0.0.1 over BOTH transports at once:
 *   - Streamable HTTP  at  http://127.0.0.1:<port>/mcp
 *   - Legacy SSE       at  http://127.0.0.1:<port>/sse  (+ POST /messages)
 * then drives two ACP sessions - one pointed at each - and asks the agent to call the tool.
 * The tool handler records which transport delivered the call. Verdict → stdout.
 *
 * Wire log → scratchpad (path printed at start).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const MODEL = process.env.PROBE_MODEL || 'auto';
const SCRATCH =
  process.env.SCRATCH ||
  join(tmpdir(), 'cursor-probe-scratch');
const WIRE_LOG = join(SCRATCH, 'cursor-sse-mcp-wire.log');
try { writeFileSync(WIRE_LOG, ''); } catch { /* dir may not exist */ }

const wire = (dir: string, s: string) => {
  try { appendFileSync(WIRE_LOG, `${dir} ${s}\n`); } catch { /* ignore */ }
};
const findings: Record<string, string> = {};
const note = (k: string, v: string) => { findings[k] = v; console.log(`  • ${k}: ${v}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Records which transport delivered a tools/call, set by the tool handler.
const toolCalls: Array<{ transport: string; word: string }> = [];

// ---- loopback MCP server (SDK), one instance, both transports ----------------
function buildMcpServer(transportLabel: string): McpServer {
  const server = new McpServer({ name: 'arco-probe', version: '0.0.0' });
  server.registerTool(
    'arco_probe_ping',
    {
      description:
        'Arco Phase-6 loopback-MCP probe. Call this tool with any word to confirm the ' +
        'per-session MCP wiring works over the network transport.',
      inputSchema: { word: z.string().describe('any word') },
    },
    async ({ word }: { word: string }) => {
      toolCalls.push({ transport: transportLabel, word });
      wire('MCP', `[${transportLabel}] tools/call arco_probe_ping word=${JSON.stringify(word)}`);
      return { content: [{ type: 'text' as const, text: `arco_probe_ping OK: received "${word}"` }] };
    },
  );
  return server;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return undefined;
  try { return JSON.parse(raw); } catch { return undefined; }
}

// SSE transports are stateful (one per GET /sse stream), keyed by their own sessionId.
const sseTransports = new Map<string, SSEServerTransport>();

function startLoopbackMcp(): Promise<{ port: number; close: () => void }> {
  const http = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    try {
      // --- Streamable HTTP (stateless: fresh server+transport per request) ---
      if (url.pathname === '/mcp') {
        const body = req.method === 'POST' ? await readBody(req) : undefined;
        const server = buildMcpServer('http');
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on('close', () => { void transport.close(); void server.close(); });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }
      // --- Legacy SSE: GET opens the stream, POST /messages feeds it ---
      if (url.pathname === '/sse' && req.method === 'GET') {
        const transport = new SSEServerTransport('/messages', res);
        sseTransports.set(transport.sessionId, transport);
        res.on('close', () => { sseTransports.delete(transport.sessionId); });
        const server = buildMcpServer('sse');
        await server.connect(transport); // begins the SSE stream
        return;
      }
      if (url.pathname === '/messages' && req.method === 'POST') {
        const sid = url.searchParams.get('sessionId') || '';
        const transport = sseTransports.get(sid);
        if (!transport) { res.statusCode = 404; res.end('no sse session'); return; }
        const body = await readBody(req);
        await transport.handlePostMessage(req, res, body);
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    } catch (e) {
      wire('MCPERR', `${url.pathname}: ${e instanceof Error ? e.message : String(e)}`);
      if (!res.headersSent) { res.statusCode = 500; res.end('probe mcp error'); }
    }
  });
  return new Promise((resolve) => {
    http.listen(0, '127.0.0.1', () => {
      const addr = http.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ port, close: () => http.close() });
    });
  });
}

// ---- JSON-RPC 2.0 peer over cursor-agent acp stdio (from cursor-acp-probe.ts) --
type Json = Record<string, unknown>;
class AcpPeer extends EventEmitter {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; method: string }>();
  private buf = '';
  private closed = false;
  onRequest: (method: string, params: unknown) => Promise<unknown> | unknown = () => ({});

  constructor(private child: ChildProcess) {
    super();
    child.stdout!.on('data', (c: Buffer) => this.feed(c));
    child.stdout!.on('end', () => this.die('stdout ended'));
    child.on('exit', (code, sig) => this.die(`child exit code=${code} sig=${sig}`));
    child.stderr!.on('data', (c: Buffer) => { const s = c.toString('utf8').trimEnd(); if (s) wire('ERR', s); });
  }
  request<R = unknown>(method: string, params?: unknown): Promise<R> {
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    wire('-->', JSON.stringify(payload));
    return new Promise<R>((resolve, reject) => {
      this.pending.set(id, { resolve: (v) => resolve(v as R), reject, method });
      this.child.stdin!.write(JSON.stringify(payload) + '\n');
    });
  }
  private feed(chunk: Buffer): void {
    this.buf += chunk.toString('utf8');
    let nl = this.buf.indexOf('\n');
    while (nl !== -1) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line) void this.handle(line);
      nl = this.buf.indexOf('\n');
    }
  }
  private async handle(line: string): Promise<void> {
    wire('<--', line);
    let msg: Json;
    try { msg = JSON.parse(line) as Json; } catch { return; }
    if (typeof msg.id === 'number' && (('result' in msg) || ('error' in msg)) && !('method' in msg)) {
      const p = this.pending.get(msg.id as number);
      if (!p) return;
      this.pending.delete(msg.id as number);
      if (msg.error) p.reject(new Error(`RPC ${p.method}: ${JSON.stringify(msg.error)}`));
      else p.resolve(msg.result);
      return;
    }
    if (typeof msg.method === 'string' && msg.id === undefined) {
      this.emit('notification', msg.method as string, msg.params);
      return;
    }
    if (typeof msg.method === 'string' && msg.id !== undefined) {
      let result: unknown;
      try { result = await this.onRequest(msg.method as string, msg.params); }
      catch (e) {
        this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(e) } }) + '\n');
        return;
      }
      this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
    }
  }
  private die(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) p.reject(new Error(`transport closed: ${reason}`));
    this.pending.clear();
    this.emit('close', reason);
  }
}

async function driveSession(
  peer: AcpPeer,
  cwd: string,
  label: string,
  mcpEntry: Json,
): Promise<{ ok: boolean; note: string }> {
  console.log(`\n## ${label} — session/new + prompt`);
  let sessionId: string | undefined;
  try {
    const s = await Promise.race([
      peer.request('session/new', { cwd, mcpServers: [mcpEntry] }),
      sleep(20000).then(() => { throw new Error('session/new timeout (20s)'); }),
    ]) as any;
    sessionId = s?.sessionId ?? s?.session_id;
    note(`${label} session/new`, sessionId ? `ok (${sessionId})` : `no sessionId: ${JSON.stringify(s).slice(0, 200)}`);
  } catch (e) {
    note(`${label} session/new`, `FAILED: ${e}`);
    return { ok: false, note: 'session/new rejected the descriptor' };
  }
  if (!sessionId) return { ok: false, note: 'no sessionId' };

  const before = toolCalls.length;
  try {
    await Promise.race([
      peer.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'Call the tool named arco_probe_ping with word="hello". Then reply DONE.' }],
      }),
      sleep(90000).then(() => { throw new Error('prompt timeout (90s)'); }),
    ]);
  } catch (e) {
    note(`${label} prompt`, `FAILED: ${e}`);
  }
  // Match by the transport tag the handler recorded for this label.
  const tag = label.toLowerCase().includes('sse') ? 'sse' : 'http';
  const got = toolCalls.slice(before).filter((c) => c.transport === tag);
  note(`${label} tool handler fired`, got.length ? `YES (word=${JSON.stringify(got[0].word)})` : 'NO');
  return { ok: got.length > 0, note: got.length ? 'tool call reached the loopback server' : 'no tool call reached the server' };
}

// SELFTEST=1 → drive the loopback MCP over both transports with the SDK client
// (no cursor-agent, no metered cost). Validates the server wiring before the ACP run.
async function selfTest(): Promise<void> {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');
  const mcp = await startLoopbackMcp();
  console.log(`[selftest] loopback MCP on 127.0.0.1:${mcp.port}`);
  for (const [label, makeTransport] of [
    ['http', () => new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcp.port}/mcp`))],
    ['sse', () => new SSEClientTransport(new URL(`http://127.0.0.1:${mcp.port}/sse`))],
  ] as [string, () => any][]) {
    const before = toolCalls.length;
    const client = new Client({ name: 'selftest', version: '0.0.0' });
    await client.connect(makeTransport());
    const tools = await client.listTools();
    const hasPing = tools.tools.some((t: any) => t.name === 'arco_probe_ping');
    const r: any = await client.callTool({ name: 'arco_probe_ping', arguments: { word: `st-${label}` } });
    const fired = toolCalls.slice(before).some((c) => c.transport === label);
    note(`selftest ${label}`, `tools/list has ping=${hasPing}, handler fired=${fired}, result=${JSON.stringify(r?.content?.[0]?.text).slice(0, 60)}`);
    await client.close();
  }
  mcp.close();
  await sleep(150);
}

async function main(): Promise<void> {
  console.log(`cursor-sse-mcp-probe — model=${MODEL}`);
  console.log(`wire log → ${WIRE_LOG}`);

  if (process.env.SELFTEST === '1') { await selfTest(); process.exit(0); }

  const mcp = await startLoopbackMcp();
  console.log(`loopback MCP listening on 127.0.0.1:${mcp.port} (/mcp streamable-http, /sse legacy)\n`);

  const cwd = mkdtempSync(join(tmpdir(), 'cursor-sse-mcp-'));
  writeFileSync(join(cwd, 'README.md'), '# probe sandbox\n');
  const child = spawn('cursor-agent', ['acp', '--model', MODEL, '--force'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  const peer = new AcpPeer(child);
  peer.onRequest = (method, params) => {
    if (method === 'session/request_permission') {
      const opts = (params as any)?.options as Array<{ optionId: string; kind?: string }> | undefined;
      const pick = opts?.find((o) => /allow|approve|yes|accept/i.test(o.optionId + (o.kind ?? ''))) ?? opts?.[0];
      return { outcome: pick ? { outcome: 'selected', optionId: pick.optionId } : { outcome: 'cancelled' } };
    }
    if (method === 'fs/read_text_file') return { content: '# probe sandbox\n' };
    if (method === 'fs/write_text_file') return null;
    if (method.startsWith('terminal/')) return {};
    return {};
  };
  let closedReason = '';
  peer.on('close', (r) => { closedReason = r; });

  // initialize
  try {
    const init = await Promise.race([
      peer.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } } }),
      sleep(15000).then(() => { throw new Error('initialize timeout (15s)'); }),
    ]) as any;
    note('initialize', 'ok');
    note('mcpCapabilities', JSON.stringify(init?.agentCapabilities?.mcpCapabilities ?? 'n/a'));
  } catch (e) {
    note('initialize', `FAILED: ${e}`);
    child.kill('SIGKILL'); mcp.close();
    return;
  }

  const httpUrl = `http://127.0.0.1:${mcp.port}/mcp`;
  const sseUrl = `http://127.0.0.1:${mcp.port}/sse`;

  // ACP HTTP MCP descriptor. The ACP McpServer union tags network variants with `type`.
  const httpRes = await driveSession(peer, cwd, 'HTTP', {
    type: 'http', name: 'arco-probe', url: httpUrl, headers: [],
  });
  // ACP SSE MCP descriptor.
  const sseRes = await driveSession(peer, cwd, 'SSE', {
    type: 'sse', name: 'arco-probe', url: sseUrl, headers: [],
  });

  // ---- verdict ----
  console.log('\n===================== VERDICT =====================');
  note('HTTP (streamable) transport', httpRes.ok ? 'GO — tool callable over loopback' : `NO — ${httpRes.note}`);
  note('SSE (legacy) transport', sseRes.ok ? 'GO — tool callable over loopback' : `NO — ${sseRes.note}`);
  const gate = httpRes.ok || sseRes.ok;
  note('PHASE-6 GATE', gate
    ? `PASS — Cursor clusters are GO (use ${httpRes.ok ? 'streamable-HTTP' : 'SSE'})`
    : 'FAIL — no network MCP transport delivered a tool call; Cursor clusters BLOCKED, re-scope');
  if (closedReason) note('child closed', closedReason);

  child.kill('SIGKILL');
  mcp.close();
  await sleep(200);
  process.exit(gate ? 0 : 1);
}

main().catch((e) => { console.error('probe crashed:', e); process.exit(2); });
