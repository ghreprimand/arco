// Boundary + lifecycle acceptance against REAL server processes, fully isolated:
// fresh HOME/TMPDIR per instance, free loopback ports, node-only PATH (no
// provider CLIs, no credentials, no model calls). The only "model" is an
// in-process Ollama-protocol fixture on loopback. Covers the session gate,
// write confinement, legitimate reads, read confinement, saved-workflow
// survival (idle and mid-turn), and strict-incognito footprint (idle and with
// a real fixture turn).
//
// Read-confinement cases are required: they failed against the pre-fix code
// (authenticated arbitrary read) and now gate the confinement policy.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chmodSync } from 'node:fs';
import { createServer as createIsolationServer } from 'node:net';
const DENIED_COMMANDS = [
  'claude', 'codex', 'gemini', 'cursor-agent', 'agent', 'ollama', 'llama-server', 'llama-cli',
  'lms',  'xolotl', 'docker', 'podman', 'gh', 'systemctl', 'journalctl', 'ssh', 'curl', 'wget',
] as const;

async function closedPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const s = createIsolationServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)); });
  });
}

function installDenyStubs(root: string): { stubs: string; log: string } {
  const stubs = path.join(root, 'deny-bin'), log = path.join(root, 'deny.log');
  mkdirSync(stubs, { recursive: true });
  for (const name of DENIED_COMMANDS) {
    const file = path.join(stubs, name);
    writeFileSync(file, `#!/bin/sh\necho "${name} $*" >> "${log}"\necho "Host provider and service commands are disabled in acceptance tests." >&2\nexit 97\n`);
    chmodSync(file, 0o755);
  }
  return { stubs, log };
}

async function hardenServerEnv(env: Record<string, string>, root: string): Promise<{ env: Record<string, string>; denyLog: string }> {
  const { stubs, log } = installDenyStubs(root);
  const dead = `http://127.0.0.1:${await closedPort()}`;
  const home = env.HOME ?? path.join(root, 'home');
  const hardened: Record<string, string> = {
    ...env,
    PATH: [stubs, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
    DEEPSEEK_URL_BASE: `${dead}/v1`, OLLAMA_URL_BASE: dead, LMSTUDIO_URL_BASE: `${dead}/v1`, STRATA_URL_BASE: `${dead}/v1`,
    ARCO_LLAMACPP_BIN: path.join(stubs, 'llama-server'), ARCO_LLAMACPP_HOST: '127.0.0.1', ARCO_LLAMACPP_PORT: String(await closedPort()),
    ANTIGRAVITY_BINARY: path.join(stubs, 'antigravity'), ANTIGRAVITY_CDP_PORT: String(await closedPort()),
    ARCO_SEARXNG_URL: dead, ARCO_CHROME_BINARY: path.join(stubs, 'curl'), CHROME_PATH: path.join(stubs, 'curl'),
    CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'), XDG_CACHE_HOME: path.join(home, '.cache'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  };
  for (const key of ['ARCO_HUB_URL', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) delete hardened[key];
  return { env: hardened, denyLog: log };
}

import WebSocket from 'ws';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MODEL = 'arco-fixture:latest';

async function until<T>(what: string, probe: () => Promise<T | undefined | false> | T | undefined | false, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value) return value as T;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(40);
  }
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const s = createNetServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)); });
  });
}

// Ollama-protocol fixture. `holdTurns()` keeps the next chat response open
// until `release()`, which models a turn that is still running.
interface FakeModel { url: string; holdTurns(): void; release(): void; chatRequests(): number; close(): Promise<void> }
async function startFakeModel(): Promise<FakeModel> {
  let gate: Promise<void> | null = null;
  let open: () => void = () => undefined;
  let chats = 0;
  const server: Server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const json = (value: unknown) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.url === '/api/version') return json({ version: '0.0.0-fixture' });
    if (req.url === '/api/tags') return json({ models: [{ name: MODEL, model: MODEL, size: 0, digest: 'fixture', details: { family: 'fixture', parameter_size: '0B' } }] });
    if (req.url === '/api/ps') return json({ models: [] });
    if (req.url === '/api/show') return json({ capabilities: ['completion', 'tools'], parameters: 'num_ctx 8192', model_info: { 'fixture.context_length': 8192 } });
    if (req.url === '/api/chat') {
      chats += 1;
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.write(JSON.stringify({ model: MODEL, message: { role: 'assistant', content: 'FIXTURE-REPLY-TEXT' }, done: false }) + '\n');
      if (gate) await gate;
      res.end(JSON.stringify({ model: MODEL, message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 1, eval_count: 1 }) + '\n');
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    holdTurns() { gate = new Promise<void>((resolve) => { open = resolve; }); },
    release() { open(); gate = null; },
    chatRequests: () => chats,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

async function listTree(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full); else if (e.isFile()) out.push(full);
    }
  };
  await walk(dir);
  return out.sort();
}

type Msg = Record<string, unknown>;
interface Socket { ws: WebSocket; messages: Msg[]; seen(): string; waitFor(pred: (m: Msg) => boolean, ms?: number): Promise<Msg | undefined>; close(): Promise<void> }

class Instance {
  readonly root = mkdtempSync(path.join(tmpdir(), 'arco-isolation-'));
  readonly home = path.join(this.root, 'home');
  readonly scratch = path.join(this.root, 'tmp');
  readonly uploads = path.join(this.root, 'uploads');
  readonly project = path.join(this.root, 'project');
  readonly outside = path.join(this.root, 'outside');
  base = '';
  denyLog = '';
  cookie = '';
  private child?: ChildProcess;

  constructor() {
    for (const d of [this.home, this.scratch, this.uploads, this.project, this.outside, path.join(this.home, '.codex')]) mkdirSync(d, { recursive: true });
    writeFileSync(path.join(this.outside, 'secret.txt'), 'synthetic-outside\n');
    writeFileSync(path.join(this.home, '.codex', 'auth.json'), '{"synthetic":"not-a-credential"}\n');
  }

  async start(): Promise<void> {
    const port = await freePort();
    this.base = `http://127.0.0.1:${port}`;
    const guarded = await hardenServerEnv({
        HOME: this.home, TMPDIR: this.scratch,
        PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
        ARCO_PORT: String(port), ARCO_HOST: '127.0.0.1', ARCO_UPLOADS_DIR: this.uploads,
    }, this.root);
    this.denyLog = guarded.denyLog;
    this.child = spawn(process.execPath, ['--conditions', 'development', '--import', 'tsx', 'server/src/index.ts'], {
      cwd: repo,
      stdio: 'ignore',
      env: guarded.env,
    });
    await until('server readiness', async () => { try { return (await fetch(`${this.base}/readyz`)).ok; } catch { return false; } }, 60_000);
    const minted = await fetch(`${this.base}/api/session`, { method: 'POST', headers: this.mintHeaders() });
    assert.equal(minted.status, 204);
    this.cookie = minted.headers.get('set-cookie')!.split(';')[0];
  }

  async stop(): Promise<void> {
    this.child?.kill('SIGTERM');
    await delay(300);
    await fs.rm(this.root, { recursive: true, force: true }).catch(() => undefined);
  }

  mintHeaders() { return { Origin: this.base, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' }; }
  api = (p: string, init: RequestInit = {}) => fetch(`${this.base}${p}`, { ...init, headers: { Cookie: this.cookie, Origin: this.base, 'Content-Type': 'application/json', ...(init.headers as object) } });
  post = (p: string, body: unknown) => this.api(p, { method: 'POST', body: JSON.stringify(body) });
  register = (dir: string) => this.post('/api/settings', { defaultWorkingDirectory: dir });
  fileContent = async (query: string) => ((await (await this.api(`/api/file-content?${query}`)).json()) as { type?: string; content?: string });
  readsAsText = async (query: string) => (await this.fileContent(query)).type === 'text';

  async openSocket(): Promise<Socket> {
    const ws = new WebSocket(`${this.base.replace('http', 'ws')}/ws`, { headers: { Cookie: this.cookie, Origin: this.base } });
    const messages: Msg[] = [];
    ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
    await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
    const waitFor = async (pred: (m: Msg) => boolean, ms = 8000) => {
      try { return await until('socket message', () => { const i = messages.findIndex(pred); return i >= 0 ? messages.splice(i, 1)[0] : undefined; }, ms); } catch { return undefined; }
    };
    const close = () => new Promise<void>((resolve) => { ws.once('close', () => resolve()); ws.close(); });
    const seen = () => messages.map((m) => `${m.type}${m.type === 'error' || m.type === 'system_notice' ? `:${String(m.message ?? m.content).slice(0, 140)}` : ''}`).join(' | ');
    const socket: Socket = { ws, messages, seen, waitFor, close };
    await waitFor((m) => m.type === 'connected');
    return socket;
  }

  async useModel(url: string): Promise<void> {
    assert.equal((await this.post('/api/settings', { ollama: { baseUrl: url } })).status, 200);
  }

  async filesMentioning(needles: string[], dirs = [this.project, this.home, this.scratch, this.uploads]): Promise<string[]> {
    const hits: string[] = [];
    for (const dir of dirs) for (const f of await listTree(dir)) {
      const text = (await fs.readFile(f).catch(() => Buffer.alloc(0))).toString('latin1');
      if (needles.some((n) => text.includes(n) || f.includes(n))) hits.push(path.relative(this.root, f));
    }
    return hits;
  }
}

const config = (project: string, extra: Record<string, unknown>) => ({
  name: 'isolation-probe', primaryProvider: 'codex', primaryModel: 'gpt-5.5', primaryEffort: 'low',
  workingDirectory: project, skipPermissions: false, ...extra,
});
const chatConfig = (name: string, extra: Record<string, unknown> = {}) => ({
  kind: 'chat', name, primaryProvider: 'ollama', primaryModel: MODEL, primaryEffort: 'low', workingDirectory: tmpdir(), skipPermissions: false, ...extra,
});

let main: Instance;
let model: FakeModel;

before(async () => {
  model = await startFakeModel();
  main = new Instance();
  writeFileSync(path.join(main.project, 'ok.txt'), 'inside\n');
  mkdirSync(path.join(main.project, 'sub'));
  writeFileSync(path.join(main.project, 'sub', 'real.txt'), 'nested-real\n');
  symlinkSync(path.join(main.project, 'sub'), path.join(main.project, 'alias'));          // in-root symlink (legitimate)
  symlinkSync(main.outside, path.join(main.project, 'linkout'));                          // leaves the project
  symlinkSync(path.join(main.home, '.codex', 'auth.json'), path.join(main.project, 'alias-secret')); // alias to a provider secret
  symlinkSync(path.join(main.home, '.codex'), path.join(main.project, 'alias-secret-dir'));
  writeFileSync(path.join(main.uploads, 'upload.txt'), 'uploaded\n');
  await main.start();
  assert.equal((await main.register(main.project)).status, 200);
  await main.useModel(model.url);
});

after(async () => {
  model.release();
  await main?.stop();
  await model?.close();
});


// ── session gate ──────────────────────────────────────────────────────────
test('the HTTP surface needs a session cookie and the mint needs browser fetch metadata', async () => {
  for (const p of ['/api/file-content?path=/etc/hostname', '/api/files?path=/', '/api/list-dirs', '/api/settings']) {
    assert.equal((await fetch(`${main.base}${p}`)).status, 401, p);
  }
  assert.equal((await fetch(`${main.base}/api/session`, { method: 'POST', headers: { Origin: main.base } })).status, 403);
  assert.equal((await fetch(`${main.base}/api/session`, { method: 'POST', headers: { Origin: 'https://example.com' } })).status, 403);
});

// ── writes ────────────────────────────────────────────────────────────────
test('writes stay inside the project: absolute escape, symlink escape and unknown cwd are refused', async () => {
  assert.equal((await main.post('/api/files/write', { cwd: main.project, path: path.join(main.outside, 'w.txt'), content: 'x' })).status, 400);
  assert.equal((await main.post('/api/files/write', { cwd: main.project, path: 'linkout/w.txt', content: 'x' })).status, 400);
  assert.equal((await main.post('/api/files/write', { cwd: main.outside, path: 'w.txt', content: 'x' })).status, 400);
  assert.equal(existsSync(path.join(main.outside, 'w.txt')), false, 'nothing was written outside the project');
  const write = await main.post('/api/files/write', { cwd: main.project, path: 'new.txt', content: 'fine\n' });
  assert.equal(write.status, 200, await write.text());
  assert.equal(await fs.readFile(path.join(main.project, 'new.txt'), 'utf8'), 'fine\n');
  assert.equal((await main.post('/api/mkdir', { parent: main.outside, name: 'nd' })).status, 200);
});

// ── legitimate reads that confinement must keep allowing ──────────────────
test('legitimate reads keep working: project file, nested in-root symlink, listing, upload', async () => {
  const q = encodeURIComponent;
  assert.equal((await main.fileContent(`cwd=${q(main.project)}&path=ok.txt`)).content, 'inside\n');
  assert.equal((await main.fileContent(`cwd=${q(main.project)}&path=alias/real.txt`)).content, 'nested-real\n', 'a symlink that stays inside the project is legitimate');
  assert.equal((await main.fileContent(`path=${q(path.join(main.project, 'sub', 'real.txt'))}`)).content, 'nested-real\n', 'absolute path inside a registered project');
  const listing = await (await main.api(`/api/files?path=${q(main.project)}`)).json() as { files: Array<{ name: string }> };
  assert.ok(listing.files.some((f) => f.name === 'ok.txt'));
  assert.equal((await main.fileContent(`path=${q(path.join(main.uploads, 'upload.txt'))}`)).content, 'uploaded\n', 'the uploads directory stays readable');
});

test('legitimate reads keep working: a workflow artifact resolves through cwd + workflowId', async () => {
  const socket = await main.openSocket();
  socket.ws.send(JSON.stringify({ type: 'create_workflow', config: config(main.project, {}) }));
  const created = await socket.waitFor((m) => m.type === 'workflow_created');
  assert.ok(created);
  const id = created!.workflowId as string;
  const artifacts = path.join(main.project, '.arco', 'workflows', id, 'artifacts');
  await fs.mkdir(artifacts, { recursive: true });
  await fs.writeFile(path.join(artifacts, 'report.txt'), 'artifact-body\n');
  const q = encodeURIComponent;
  assert.equal((await main.fileContent(`cwd=${q(main.project)}&workflowId=${id}&path=report.txt`)).content, 'artifact-body\n');
  assert.equal((await main.fileContent(`path=${q(path.join(artifacts, 'report.txt'))}`)).content, 'artifact-body\n', 'absolute artifact path inside the project');
  await socket.close();
});

// ── read confinement ─────────────────────────────────────────
test('file-content refuses an absolute path outside every project', async () => {
  assert.equal(await main.readsAsText(`path=${encodeURIComponent(path.join(main.outside, 'secret.txt'))}`), false);
});
test('file-content refuses a symlink that leaves the project', async () => {
  assert.equal(await main.readsAsText(`cwd=${encodeURIComponent(main.project)}&path=linkout/secret.txt`), false);
});
test('file-content refuses provider credential files even under HOME', async () => {
  assert.equal(await main.readsAsText(`path=${encodeURIComponent(path.join(main.home, '.codex', 'auth.json'))}`), false);
  assert.equal(await main.readsAsText('path=/proc/self/environ'), false);
});
test('a symlink alias inside a project cannot reach provider credentials', async () => {
  const q = encodeURIComponent(main.project);
  assert.equal(await main.readsAsText(`cwd=${q}&path=alias-secret`), false, 'file alias');
  assert.equal(await main.readsAsText(`cwd=${q}&path=alias-secret-dir/auth.json`), false, 'directory alias');
  assert.equal(await main.readsAsText(`path=${encodeURIComponent(path.join(main.project, 'alias-secret'))}`), false, 'absolute alias path');
});
test('directory listings do not enumerate outside projects and HOME', async () => {
  const files = await (await main.api(`/api/files?path=${encodeURIComponent(main.outside)}`)).json() as { files: unknown[] };
  assert.equal(files.files.length, 0);
  const dirs = await (await main.api('/api/list-dirs?path=/')).json() as { parent: string };
  assert.notEqual(dirs.parent, '/');
  const home = await (await main.api(`/api/files?path=${encodeURIComponent(main.home)}`)).json() as { files: Array<{ name: string }> };
  assert.ok(!home.files.some((f) => f.name === '.codex'), 'credential directories are not listed');
});
test('media/raw refuses outside paths and symlink escapes by default', async () => {
  const abs = await main.api(`/api/media/raw?cwd=${encodeURIComponent(main.project)}&path=${encodeURIComponent(path.join(main.outside, 'secret.txt'))}`);
  const link = await main.api(`/api/media/raw?cwd=${encodeURIComponent(main.project)}&path=linkout/secret.txt`);
  const secret = await main.api(`/api/media/raw?cwd=${encodeURIComponent(main.project)}&path=alias-secret`);
  assert.equal(abs.status === 200 || link.status === 200 || secret.status === 200, false);
});

// ── hostile registration: the project registry must not widen secret access ─
test('registering "/" or a provider directory as a project cannot expose credentials', async () => {
  const hostile = new Instance();
  try {
    await hostile.start();
    const q = encodeURIComponent;
    const secret = path.join(hostile.home, '.codex', 'auth.json');
    const rootStatus = (await hostile.register('/')).status;
    const dirStatus = (await hostile.register(path.join(hostile.home, '.codex'))).status;
    // Either the registration is refused, or reads under it still deny secrets.
    if (rootStatus === 200) {
      assert.equal(await hostile.readsAsText(`cwd=/&path=${q(secret.slice(1))}`), false, 'secret via registered "/"');
      assert.equal(await hostile.readsAsText('cwd=/&path=proc/self/environ'), false, 'process environment via registered "/"');
    }
    if (dirStatus === 200) {
      assert.equal(await hostile.readsAsText(`cwd=${q(path.join(hostile.home, '.codex'))}&path=auth.json`), false, 'secret via registered provider dir');
    }
    assert.equal(await hostile.readsAsText(`path=${q(secret)}`), false, 'secret by absolute path after hostile registration');
  } finally {
    await hostile.stop();
  }
});

// ── lifecycle ─────────────────────────────────────────────────────────────
test('a saved workflow survives a socket drop and the reconnecting socket reclaims it', async () => {
  const first = await main.openSocket();
  first.ws.send(JSON.stringify({ type: 'create_workflow', config: config(main.project, {}) }));
  const created = await first.waitFor((m) => m.type === 'workflow_created');
  assert.ok(created, 'workflow_created');
  const id = created!.workflowId as string;
  await first.close();
  await until('persisted meta', () => existsSync(path.join(main.project, '.arco', 'workflows', id, 'meta.json')));
  const second = await main.openSocket();
  second.ws.send(JSON.stringify({ type: 'rehydrate_workflows', workflows: [{ workflowId: id, config: created!.config, currentSessionId: id, lastSeq: 0 }] }));
  assert.ok(await second.waitFor((m) => m.type === 'workflow_state_snapshot' && m.workflowId === id), 'live workflow reclaimed by the new socket');
  await second.close();
});

test('a RUNNING turn keeps going after its only observer disconnects, and its result is replayable', async () => {
  const tag = `RUNNING-TURN-${Date.now()}`;
  const socket = await main.openSocket();
  socket.ws.send(JSON.stringify({ type: 'create_workflow', config: config(main.project, { name: tag, primaryProvider: 'ollama', primaryModel: MODEL }) }));
  const created = await socket.waitFor((m) => m.type === 'workflow_created');
  assert.ok(created);
  const id = created!.workflowId as string;
  const before = model.chatRequests();
  model.holdTurns();
  try {
    socket.ws.send(JSON.stringify({ type: 'user_message', workflowId: id, content: 'hello fixture' }));
    await until(`provider call in flight (${socket.seen()})`, () => model.chatRequests() === before + 1);
    await socket.close(); // observer released while the provider call is still open
  } finally {
    model.release();
  }
  const events = path.join(main.project, '.arco', 'workflows', id, 'events.jsonl');
  await until('turn completion persisted without any observer', async () => (await fs.readFile(events, 'utf8').catch(() => '')).includes('primary_turn_ended'));
  const again = await main.openSocket();
  again.ws.send(JSON.stringify({ type: 'rehydrate_workflows', workflows: [{ workflowId: id, config: created!.config, currentSessionId: id, lastSeq: 0 }] }));
  const snapshot = await again.waitFor((m) => m.type === 'workflow_state_snapshot' && m.workflowId === id);
  assert.ok(snapshot, 'reconnect reclaims the workflow after its turn finished');
  assert.equal(snapshot!.busy, false, 'no stuck busy flag after the observer-less turn');
  await again.close();
});

test('strict incognito Chat leaves no id, name or file behind when idle and after teardown', async () => {
  const marker = `INCOGNITO-MARKER-${Date.now()}`;
  const before = { project: await listTree(main.project), home: await listTree(main.home) };
  const socket = await main.openSocket();
  // A provider that cannot guarantee a non-persistent session is refused outright.
  socket.ws.send(JSON.stringify({ type: 'create_workflow', config: chatConfig(marker, { incognito: true, primaryProvider: 'cursor', primaryModel: 'x' }) }));
  assert.ok(await socket.waitFor((m) => m.type === 'error' && /Incognito/i.test(String(m.message))), 'cursor is refused in Incognito Chat');
  socket.ws.send(JSON.stringify({ type: 'create_workflow', config: chatConfig(marker, { incognito: true }) }));
  const created = await socket.waitFor((m) => m.type === 'workflow_created');
  assert.ok(created, 'incognito workflow_created');
  const id = created!.workflowId as string;
  assert.notEqual((created!.config as { workingDirectory?: string }).workingDirectory, main.project, 'incognito never binds the project');
  assert.deepEqual(await listTree(main.project), before.project, 'project tree unchanged');
  assert.deepEqual(await main.filesMentioning([id, marker]), [], 'no file under project/HOME/TMPDIR/uploads names the id or title');
  await socket.close();
  await delay(11_500); // the server's 10 s observer-disconnect grace for incognito tabs
  const again = await main.openSocket();
  again.ws.send(JSON.stringify({ type: 'rehydrate_workflows', workflows: [{ workflowId: id, config: created!.config, currentSessionId: id, lastSeq: 0 }] }));
  // A rehydrate carrying the client's own config may recreate an empty
  // in-memory tab; it must never recover prior history from anywhere.
  const revived = await again.waitFor((m) => m.type === 'workflow_state_snapshot' && m.workflowId === id, 2500);
  if (revived) assert.deepEqual(revived.transcriptTail, [], 'nothing of the earlier conversation is recoverable');
  assert.deepEqual(await main.filesMentioning([id, marker]), [], 'still nothing on disk after teardown');
  await again.close();
});

test('a REAL incognito turn (fixture model) persists no prompt, reply or id; a saved Chat control does', async () => {
  const promptMarker = `PROMPT-MARKER-${Date.now()}`;
  const replyMarker = 'FIXTURE-REPLY-TEXT';
  const run = async (incognito: boolean) => {
    const socket = await main.openSocket();
    socket.ws.send(JSON.stringify({ type: 'create_workflow', config: chatConfig(`chat-${incognito ? 'private' : 'saved'}-${promptMarker}`, { incognito }) }));
    const created = await socket.waitFor((m) => m.type === 'workflow_created');
    assert.ok(created, 'workflow_created');
    const id = created!.workflowId as string;
    socket.ws.send(JSON.stringify({ type: 'user_message', workflowId: id, content: `${promptMarker}-${incognito ? 'private' : 'saved'}` }));
    assert.ok(await socket.waitFor((m) => m.type === 'primary_complete' && m.workflowId === id), `turn completed against the fixture (${socket.seen()})`);
    await until('turn end', () => socket.waitFor((m) => m.type === 'primary_turn_ended' && m.workflowId === id, 200));
    await socket.close();
    return id;
  };
  const savedId = await run(false);
  const savedHits = await main.filesMentioning([`${promptMarker}-saved`, replyMarker, savedId]);
  assert.ok(savedHits.length > 0, 'control: the scanner does see a saved Chat turn on disk');
  const privateId = await run(true);
  const privateHits = await main.filesMentioning([`${promptMarker}-private`, privateId]);
  assert.deepEqual(privateHits, [], 'incognito prompt text and id appear in no file under project/HOME/TMPDIR/uploads');
  const replyHits = (await main.filesMentioning([replyMarker])).filter((f) => !savedHits.includes(f));
  assert.deepEqual(replyHits, [], 'incognito reply text appears in no file beyond the saved control\'s own');
});
