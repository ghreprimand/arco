/**
 * THROWAWAY spike probe for the Cursor (ACP) provider - docs/PROVIDERS.md
 * NOT shipped. Drives `cursor-agent acp` directly to learn the real wire contract before
 * any Arco code. Walks the 10-item spike checklist and dumps raw traffic for analysis.
 *
 *   npx tsx scripts/cursor-acp-probe.ts
 *
 * ⚠️ METERED COST: this makes real Cursor turns against your subscription pool. It runs on
 * `--model auto` (draws the separate Auto+Composer pool, not the $20 frontier pool) with tiny
 * prompts to keep burn minimal. Item 5b (which pool) must be confirmed by YOU watching
 * cursor.com/dashboard while it runs - the CLI exposes no usage command.
 *
 * Raw wire log → scratchpad (path printed at start). Findings summary → stdout at the end.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const MCP_SERVER = join(HERE, 'cursor-acp-probe-mcp.mjs');
const MODEL = process.env.PROBE_MODEL || 'auto';
const WIRE_LOG = join(
  process.env.SCRATCH || join(tmpdir(), 'cursor-probe-scratch'),
  'cursor-acp-wire.log',
);
try { writeFileSync(WIRE_LOG, ''); } catch { /* dir may not exist; falls back below */ }

const wire = (dir: string, s: string) => {
  const line = `${dir} ${s}\n`;
  try { appendFileSync(WIRE_LOG, line); } catch { /* ignore */ }
};

// ---- findings accumulator -------------------------------------------------
const findings: Record<string, string> = {};
const note = (k: string, v: string) => { findings[k] = v; console.log(`  • ${k}: ${v}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- JSON-RPC 2.0 peer (bidirectional — ACP servers call US back) ---------
type Json = Record<string, unknown>;
class AcpPeer extends EventEmitter {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; method: string }>();
  private buf = '';
  private closed = false;
  // Server→client request handlers (fs/*, session/request_permission, terminal/*)
  onRequest: (method: string, params: unknown) => Promise<unknown> | unknown = () => ({});

  constructor(private child: ChildProcess) {
    super();
    child.stdout!.on('data', (c: Buffer) => this.feed(c));
    child.stdout!.on('end', () => this.die('stdout ended'));
    child.on('exit', (code, sig) => this.die(`child exit code=${code} sig=${sig}`));
    child.stderr!.on('data', (c: Buffer) => {
      const s = c.toString('utf8').trimEnd();
      if (s) wire('ERR', s);
    });
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

  notify(method: string, params?: unknown): void {
    const payload = { jsonrpc: '2.0', method, params };
    wire('-->', JSON.stringify(payload));
    this.child.stdin!.write(JSON.stringify(payload) + '\n');
  }

  private feed(chunk: Buffer): void {
    this.buf += chunk.toString('utf8');
    let nl = this.buf.indexOf('\n');
    while (nl !== -1) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line) this.handle(line);
      nl = this.buf.indexOf('\n');
    }
  }

  private async handle(line: string): Promise<void> {
    wire('<--', line);
    let msg: Json;
    try { msg = JSON.parse(line) as Json; } catch { this.emit('protocol_error', line.slice(0, 200)); return; }

    // Response to one of our requests
    if (typeof msg.id === 'number' && (('result' in msg) || ('error' in msg)) && !('method' in msg)) {
      const p = this.pending.get(msg.id as number);
      if (!p) return;
      this.pending.delete(msg.id as number);
      if (msg.error) p.reject(Object.assign(new Error(`RPC ${p.method}: ${JSON.stringify(msg.error)}`), { rpc: msg.error }));
      else p.resolve(msg.result);
      return;
    }

    // Notification from server
    if (typeof msg.method === 'string' && msg.id === undefined) {
      this.emit('notification', msg.method as string, msg.params);
      return;
    }

    // Server→client REQUEST (has both method and id) — must answer or turn hangs
    if (typeof msg.method === 'string' && msg.id !== undefined) {
      this.emit('server_request', msg.method as string, msg.params);
      let result: unknown;
      try { result = await this.onRequest(msg.method as string, msg.params); }
      catch (e) {
        const reply = { jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(e) } };
        wire('-->', JSON.stringify(reply));
        this.child.stdin!.write(JSON.stringify(reply) + '\n');
        return;
      }
      const reply = { jsonrpc: '2.0', id: msg.id, result };
      wire('-->', JSON.stringify(reply));
      this.child.stdin!.write(JSON.stringify(reply) + '\n');
      return;
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

// ---- side probes (no ACP) -------------------------------------------------
function run(cmd: string, args: string[], timeoutMs = 20000): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const t = setTimeout(() => { c.kill('SIGKILL'); }, timeoutMs);
    c.stdout.on('data', (b) => { out += b.toString('utf8'); });
    c.stderr.on('data', (b) => { err += b.toString('utf8'); });
    c.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
    c.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out, err: err + String(e) }); });
  });
}

// ---- collector for a single prompt turn -----------------------------------
interface TurnCapture {
  text: string;
  updateKinds: Set<string>;
  toolCalls: Array<{ name?: string; kind?: string; status?: string }>;
  usageSeen: unknown[];
  serverRequests: Set<string>;
  stopReason?: string;
  raw: unknown[];
}

async function main(): Promise<void> {
  console.log(`cursor-acp-probe — model=${MODEL}`);
  console.log(`wire log → ${WIRE_LOG}\n`);

  // ---- Item: catalog (side probe) ----
  console.log('## catalog (`cursor-agent models`)');
  const models = await run('cursor-agent', ['models']);
  const modelLines = models.out.split('\n').map((l) => l.trim()).filter(Boolean);
  note('model count', String(modelLines.length));
  note('has grok', String(modelLines.some((l) => /grok/i.test(l))));
  note('has auto', String(modelLines.some((l) => /^auto\b/i.test(l) || /\bauto\b/i.test(l))));
  console.log('  sample:', modelLines.slice(0, 3).join(' | '));

  // ---- Item 10: usage-pool polling (side probes) ----
  console.log('\n## item 10 — usage-pool / account JSON');
  for (const [label, args] of [
    ['status --format json', ['status', '--format', 'json']],
    ['about', ['about']],
    ['about --format json', ['about', '--format', 'json']],
    ['whoami --format json', ['whoami', '--format', 'json']],
  ] as [string, string[]][]) {
    const r = await run('cursor-agent', args, 15000);
    const body = (r.out || r.err).trim();
    const hasBalance = /balance|remaining|quota|usage|spend|pool|limit|credit/i.test(body);
    note(label, `exit=${r.code} bytes=${body.length} balance-ish=${hasBalance}`);
    if (body) wire('SIDE', `${label} => ${body.slice(0, 800)}`);
  }

  // ---- spin up cursor-agent acp ----
  console.log('\n## ACP handshake');
  const cwd = mkdtempSync(join(tmpdir(), 'cursor-acp-probe-'));
  writeFileSync(join(cwd, 'README.md'), '# probe sandbox\n');
  const acpArgs = ['acp', '--model', MODEL, '--force'];
  const child = spawn('cursor-agent', acpArgs, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  const peer = new AcpPeer(child);

  // Auto-answer server→client requests so turns don't hang.
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
  peer.on('protocol_error', (l) => console.log('  [protocol_error]', l));
  peer.on('server_request', (m) => wire('SRVREQ', m));

  let closedReason = '';
  peer.on('close', (r) => { closedReason = r; });

  // initialize
  try {
    const init = await Promise.race([
      peer.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      }),
      sleep(15000).then(() => { throw new Error('initialize timeout (15s)'); }),
    ]) as any;
    note('initialize ok', 'yes');
    note('protocolVersion', JSON.stringify(init?.protocolVersion));
    note('authMethods', JSON.stringify(init?.authMethods ?? []));
    const caps = init?.agentCapabilities ?? {};
    note('agentCapabilities keys', Object.keys(caps).join(',') || '(none)');
    note('promptCapabilities', JSON.stringify(caps?.promptCapabilities ?? {}));
    note('loadSession', JSON.stringify(caps?.loadSession ?? false));
    note('mcpCapabilities', JSON.stringify(caps?.mcpCapabilities ?? caps?.mcp ?? 'n/a'));
  } catch (e) {
    note('initialize', `FAILED: ${e}`);
    console.log('\nCannot proceed without handshake. See wire log.');
    child.kill('SIGKILL');
    return;
  }

  // ---- Item 8: session/new WITH mcpServers (peer-tools GO/NO-GO) ----
  console.log('\n## item 8 — session/new + mcpServers (peer-tools gate)');
  let sessionId: string | undefined;
  let sessionModes: unknown;
  const mcpServers = [{
    name: 'arco-cluster',
    command: process.execPath,
    args: [MCP_SERVER],
    env: [],
  }];
  try {
    const s = await Promise.race([
      peer.request('session/new', {
        cwd,
        mcpServers,
        // speculative extras — logged if rejected, harmless if ignored
      }),
      sleep(20000).then(() => { throw new Error('session/new timeout (20s)'); }),
    ]) as any;
    sessionId = s?.sessionId ?? s?.session_id;
    sessionModes = s?.modes;
    note('session/new ok', 'yes');
    note('sessionId', String(sessionId));
    note('modes returned', JSON.stringify(sessionModes ?? '(none)'));
  } catch (e) {
    note('session/new (with mcpServers)', `FAILED: ${e}`);
    // retry without mcpServers to isolate whether MCP was the rejection cause
    try {
      const s2 = await peer.request('session/new', { cwd, mcpServers: [] }) as any;
      sessionId = s2?.sessionId ?? s2?.session_id;
      sessionModes = s2?.modes;
      note('session/new (no mcp) ok', 'yes — MCP config was rejected; item 8 = investigate flag form');
      note('sessionId', String(sessionId));
    } catch (e2) {
      note('session/new (no mcp)', `ALSO FAILED: ${e2}`);
    }
  }

  // ---- Item 6/7: modes (system-prompt / read-only) ----
  console.log('\n## item 6/7 — modes & set_mode');
  if (sessionModes && (sessionModes as any).availableModes) {
    note('availableModes', JSON.stringify((sessionModes as any).availableModes.map((m: any) => m.id ?? m)));
    note('currentModeId', JSON.stringify((sessionModes as any).currentModeId));
  }

  // helper: drive one prompt turn, collecting everything
  async function turn(text: string, timeoutMs: number): Promise<TurnCapture> {
    const cap: TurnCapture = { text: '', updateKinds: new Set(), toolCalls: [], usageSeen: [], serverRequests: new Set(), raw: [] };
    const onNote = (method: string, params: any) => {
      if (method !== 'session/update') return;
      cap.raw.push(params);
      const u = params?.update ?? params;
      const kind = u?.sessionUpdate ?? u?.type ?? '(?)';
      cap.updateKinds.add(String(kind));
      // text
      const chunk = u?.content?.text ?? u?.text;
      if ((kind === 'agent_message_chunk' || kind === 'agent_message') && typeof chunk === 'string') cap.text += chunk;
      // tools
      if (String(kind).startsWith('tool_call')) cap.toolCalls.push({ name: u?.title ?? u?.toolName ?? u?.name, kind: u?.kind, status: u?.status });
      // usage — scan anywhere in the update
      const j = JSON.stringify(params);
      if (/token|usage/i.test(j)) cap.usageSeen.push(u?.usage ?? u?._meta ?? j.slice(0, 300));
    };
    const onSrv = (m: string) => cap.serverRequests.add(m);
    peer.on('notification', onNote);
    peer.on('server_request', onSrv);
    try {
      const res = await Promise.race([
        peer.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }),
        sleep(timeoutMs).then(() => { throw new Error(`prompt timeout (${timeoutMs}ms)`); }),
      ]) as any;
      cap.stopReason = res?.stopReason ?? res?.stop_reason;
      // usage sometimes rides on the final prompt response
      if (res && /token|usage/i.test(JSON.stringify(res))) cap.usageSeen.push(res?.usage ?? res);
    } finally {
      peer.off('notification', onNote);
      peer.off('server_request', onSrv);
    }
    return cap;
  }

  if (sessionId) {
    // ---- Item 1/2/9: a plain turn — chunk kinds, usage, tool/update shapes ----
    console.log('\n## item 1/2/9 — plain turn (chunks, usage, stopReason)');
    try {
      const c = await turn('Reply with exactly the single word: PONG. Nothing else.', 60000);
      note('turn completed', 'yes');
      note('stopReason', String(c.stopReason));
      note('update kinds', [...c.updateKinds].join(',') || '(none)');
      note('assistant text', JSON.stringify(c.text.slice(0, 80)));
      note('server requests during turn', [...c.serverRequests].join(',') || '(none)');
      note('item 2 — usage in stream', c.usageSeen.length ? `YES — ${JSON.stringify(c.usageSeen[0]).slice(0, 300)}` : 'NONE (parity risk — fallback needed)');
    } catch (e) {
      note('plain turn', `FAILED: ${e}`);
    }

    // ---- Item 8 (cont): make the agent CALL the MCP tool ----
    console.log('\n## item 8 (cont) — invoke MCP tool arco_probe_ping');
    try {
      const c = await turn('Call the tool named arco_probe_ping with word="hello". Then reply DONE.', 90000);
      const called = c.toolCalls.some((t) => /probe_ping/i.test(t.name ?? ''));
      note('tool_call for arco_probe_ping seen on stream', String(called));
      note('tool calls seen', JSON.stringify(c.toolCalls.slice(0, 5)));
      note('item 8 verdict', called ? 'GO — per-session MCP honored (check wire ERR for [probe-mcp] tools/call)' : 'INCONCLUSIVE — grep wire log for [probe-mcp]; tool may exist but agent declined');
    } catch (e) {
      note('mcp tool turn', `FAILED: ${e}`);
    }

    // ---- Item 3: mid-turn steer ----
    console.log('\n## item 3 — mid-turn steer (2nd prompt while 1st runs)');
    try {
      const cap: string[] = [];
      const onNote = (m: string, p: any) => { if (m === 'session/update') { const t = p?.update?.content?.text ?? p?.update?.text; if (t) cap.push(String(t)); } };
      peer.on('notification', onNote);
      const first = peer.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Count slowly from 1 to 20, one number per line.' }] }) as Promise<any>;
      await sleep(2500);
      let steerVerdict = '';
      try {
        const second = peer.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'STOP counting. Instead reply the word STEERED.' }] }) as Promise<any>;
        const r = await Promise.race([second, sleep(30000).then(() => ({ __timeout: true }))]) as any;
        steerVerdict = r?.__timeout ? 'second prompt pending (queued? sequential turns)' : `second prompt resolved stopReason=${r?.stopReason ?? r?.stop_reason}`;
      } catch (e: any) {
        steerVerdict = `second prompt REJECTED: ${e?.rpc ? JSON.stringify(e.rpc) : e}`;
      }
      await Promise.race([first, sleep(30000)]);
      peer.off('notification', onNote);
      note('steer behavior', steerVerdict);
      note('steered text present', String(cap.join('').toUpperCase().includes('STEERED')));
      note('item 3 note', 'if 2nd prompt errored "session busy" → steering needs a Cursor-specific method or cancel+resend; check wire log');
    } catch (e) {
      note('steer probe', `FAILED: ${e}`);
    }

    // ---- Item 4: cancel ----
    console.log('\n## item 4 — session/cancel');
    try {
      const t0 = Date.now();
      const running = peer.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Write a detailed 400-word essay about tries and radix trees.' }] }) as Promise<any>;
      await sleep(2000);
      peer.notify('session/cancel', { sessionId });
      const r = await Promise.race([running.then((x) => ({ x })), sleep(15000).then(() => ({ __timeout: true }))]) as any;
      const ackMs = Date.now() - t0;
      note('cancel outcome', r?.__timeout ? 'turn did NOT settle within 15s (hard-kill fallback required)' : `turn settled stopReason=${r?.x?.stopReason ?? r?.x?.stop_reason} after ${ackMs}ms`);
    } catch (e) {
      note('cancel probe', `FAILED: ${e}`);
    }

    // ---- Item 5: model swap per session ----
    console.log('\n## item 5 — model set/swap surface');
    for (const m of ['session/set_model', 'session/select_model']) {
      try {
        await peer.request(m, { sessionId, model: 'grok-4.5-medium' });
        note(m, 'accepted — per-session model swap possible');
      } catch (e: any) {
        note(m, e?.rpc?.code === -32601 ? 'method not found' : `err: ${e?.rpc ? JSON.stringify(e.rpc) : String(e).slice(0, 120)}`);
      }
    }
    note('item 5 note', '--model at spawn is confirmed; live-swap likely = new session with new --model (like Codex re-spawn) unless a set_model method exists above');
  }

  // ---- teardown ----
  console.log('\n## teardown');
  try { peer.notify('session/cancel', { sessionId }); } catch { /* */ }
  child.kill('SIGTERM');
  await sleep(500);
  child.kill('SIGKILL');
  note('closed', closedReason || 'killed');

  // ---- summary ----
  console.log('\n' + '='.repeat(70));
  console.log('SPIKE SUMMARY (paste into CURSOR_TRANSPORT_PLAN.md §0/§3)');
  console.log('='.repeat(70));
  for (const [k, v] of Object.entries(findings)) console.log(`${k.padEnd(34)} ${v}`);
  console.log(`\nfull wire trace: ${WIRE_LOG}`);
  console.log('grep peer-tools proof:  grep "\\[probe-mcp\\]" ' + WIRE_LOG);
  process.exit(0);
}

main().catch((e) => { console.error('probe crashed:', e); process.exit(1); });
