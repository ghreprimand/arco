// A real server whose Arco home is inside the temporary folder never contacts
// the hub named by ARCO_HUB_URL and sends no phone notice to ARCO_NTFY_URL; a
// phone address saved in its own Settings still works; with
// ARCO_ALLOW_TEMP_HOME=1 it uses both (the positive controls prove the fakes
// would see a contact); a home outside the temporary folder is unchanged. The
// server runs with a minimal environment built here, not the invoking shell's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HELD_BACK_NOTE = 'Set ARCO_ALLOW_TEMP_HOME=1 to join anyway.';
const NTFY_HELD_BACK_NOTE = 'Set ARCO_ALLOW_TEMP_HOME=1 to send anyway.';
const NTFY_ACTIVE_NOTE = '[ntfy] transport active';

async function until<T>(what: string, probe: () => Promise<T | undefined | false> | T | undefined | false, ms: number): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value) return value as T;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(50);
  }
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const s = createNetServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)); });
  });
}

// Counts every TCP connection, HTTP request and WebSocket upgrade attempt.
async function startFakeHub(): Promise<{ url: string; contacts: () => number; close: () => Promise<void> }> {
  let contacts = 0;
  const server: Server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  server.on('connection', (socket) => { contacts += 1; socket.on('error', () => undefined); });
  server.on('upgrade', (_req, socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `ws://127.0.0.1:${port}/agent`,
    contacts: () => contacts,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

// Records every request path; any request counts as a phone notice sent.
async function startFakeNtfy(): Promise<{ base: string; paths: string[]; close: () => Promise<void> }> {
  const paths: string[] = [];
  const server: Server = createServer((req, res) => { paths.push(req.url ?? ''); req.resume(); req.on('end', () => { res.writeHead(200); res.end('{}'); }); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    base: `http://127.0.0.1:${port}`,
    paths,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

function minimalEnv(root: string, port: number, extra: Record<string, string>, ownTemp = false): Record<string, string> {
  // By default the server shares this process's temporary folder, so its home
  // (under `root`, which was made there) is inside it. With `ownTemp` the
  // server gets its own temporary folder next to the home, so the home is
  // outside it, like a normal install.
  const home = path.join(root, 'home'), temp = ownTemp ? path.join(root, 'tmp') : tmpdir();
  mkdirSync(home, { recursive: true });
  mkdirSync(temp, { recursive: true });
  const env: Record<string, string> = {
    PATH: path.dirname(process.execPath),
    HOME: home, USERPROFILE: home, TMPDIR: temp, TMP: temp, TEMP: temp,
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'), XDG_CACHE_HOME: path.join(home, '.cache'),
    CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    ARCO_HOME: path.join(home, '.arco'), ARCO_PORT: String(port), ARCO_HOST: '127.0.0.1',
    ARCO_UPLOADS_DIR: path.join(root, 'uploads'), ARCO_UPDATE_CHECK: '0',
    GIT_CONFIG_NOSYSTEM: '1', LANG: 'C.UTF-8',
    ...extra,
  };
  if (process.platform === 'win32') {
    for (const name of ['SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR', 'ComSpec', 'COMSPEC', 'PATHEXT', 'SystemDrive']) {
      if (process.env[name] !== undefined) env[name] = process.env[name] as string;
    }
  }
  return env;
}

interface Running { base: string; output: () => string; child: ChildProcess }

async function startServer(root: string, extra: Record<string, string>, ownTemp = false): Promise<Running> {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let output = '';
  const child = spawn(process.execPath, ['--conditions', 'development', '--import', 'tsx', 'server/src/index.ts'], {
    cwd: repo, env: minimalEnv(root, port, extra, ownTemp), stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk) => { output += String(chunk); });
  child.stderr?.on('data', (chunk) => { output += String(chunk); });
  await until('server readiness', async () => {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${output.slice(-2000)}`);
    try { return (await fetch(`${base}/readyz`)).ok; } catch { return false; }
  }, 90_000);
  return { base, output: () => output, child };
}

async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGTERM');
  await Promise.race([exited, delay(5000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function session(base: string): Promise<string> {
  const minted = await fetch(`${base}/api/session`, { method: 'POST', headers: { Origin: base, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' } });
  assert.equal(minted.status, 204);
  return minted.headers.get('set-cookie')!.split(';')[0];
}

async function firstHubStatus(base: string, cookie: string): Promise<Record<string, unknown>> {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`, { headers: { Cookie: cookie, Origin: base } });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no hub_link_status message')), 15_000);
      ws.on('message', (raw) => {
        const message = JSON.parse(String(raw)) as Record<string, unknown>;
        if (message.type === 'hub_link_status') { clearTimeout(timer); resolve(message); }
      });
      ws.once('error', reject);
    });
  } finally { ws.close(); }
}

test('a server with its home in the temporary folder never contacts the hub', { timeout: 180_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'arco-hub-guard-server-'));
  const hub = await startFakeHub();
  let server: Running | undefined;
  try {
    server = await startServer(root, { ARCO_HUB_URL: hub.url });
    const cookie = await session(server.base);
    const headers = { Cookie: cookie, Origin: server.base };
    const status = await (await fetch(`${server.base}/api/cluster-snapshots/vault/status`, { headers })).json() as { hubConfigured?: boolean };
    assert.equal(status.hubConfigured, false, 'the cloud vault reports no hub');
    const vault = await fetch(`${server.base}/api/cluster-snapshots/cloud`, { headers });
    assert.notEqual(vault.status, 200, 'a cloud listing is refused without contacting the hub');
    const hubStatus = await firstHubStatus(server.base, cookie);
    assert.equal(hubStatus.hubUrl, undefined, 'the header hub chip stays hidden');
    assert.equal(hubStatus.connected, false);
    await delay(3000); // longer than the link's first connect and reconnect delay
    assert.equal(hub.contacts(), 0, 'the fake hub saw no connection');
    assert.ok(server.output().includes(HELD_BACK_NOTE), 'one log line names the override');
    assert.equal(server.output().split(HELD_BACK_NOTE).length - 1, 1, 'the note is logged once');
  } finally {
    if (server) await stopServer(server.child);
    await hub.close();
    rmSync(root, { recursive: true, force: true });
  }
});

async function phoneApi(base: string, cookie: string, method: 'GET' | 'PUT' | 'POST', route: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}${route}`, {
    method,
    headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.equal(res.status, 200, `${method} ${route}`);
  return await res.json() as Record<string, unknown>;
}

test('ARCO_ALLOW_TEMP_HOME=1 lets the same server join the hub and send phone notices', { timeout: 180_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'arco-hub-guard-server-'));
  const hub = await startFakeHub();
  const ntfy = await startFakeNtfy();
  let server: Running | undefined;
  try {
    server = await startServer(root, { ARCO_HUB_URL: hub.url, ARCO_NTFY_URL: `${ntfy.base}/arco-env-topic`, ARCO_ALLOW_TEMP_HOME: '1' });
    await until('a hub contact', () => hub.contacts() > 0, 30_000);
    assert.ok(!server.output().includes(HELD_BACK_NOTE));
    assert.ok(!server.output().includes(NTFY_HELD_BACK_NOTE));
    assert.ok(server.output().includes(NTFY_ACTIVE_NOTE), 'the inherited ntfy transport is active');
    const cookie = await session(server.base);
    assert.equal((await phoneApi(server.base, cookie, 'GET', '/api/notification-channels')).ntfyFromEnvironment, true);
    assert.equal((await phoneApi(server.base, cookie, 'POST', '/api/notification-channels/test', {})).ok, true);
    assert.deepEqual(ntfy.paths, ['/arco-env-topic']);
  } finally {
    if (server) await stopServer(server.child);
    await hub.close();
    await ntfy.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a temporary home sends nothing to an inherited ARCO_NTFY_URL, but an address saved in Settings works', { timeout: 180_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'arco-ntfy-guard-server-'));
  const ntfy = await startFakeNtfy();
  let server: Running | undefined;
  try {
    server = await startServer(root, { ARCO_NTFY_URL: `${ntfy.base}/arco-env-topic`, ARCO_NTFY_TOKEN: 'env-token' });
    const cookie = await session(server.base);
    const view = await phoneApi(server.base, cookie, 'GET', '/api/notification-channels');
    assert.equal(view.ntfyFromEnvironment, false);
    assert.equal(view.ntfyEnvironmentHeldBack, true);
    const test = await phoneApi(server.base, cookie, 'POST', '/api/notification-channels/test', {});
    assert.equal(test.ok, false, 'TEST has no address to send to');
    await delay(1000);
    assert.deepEqual(ntfy.paths, [], 'the fake ntfy server saw no request');
    assert.ok(!server.output().includes(NTFY_ACTIVE_NOTE), 'the inherited ntfy transport stays off');
    assert.equal(server.output().split(NTFY_HELD_BACK_NOTE).length - 1, 1, 'one log line names the override');
    assert.ok(!server.output().includes('env-token'));
    // A phone address saved deliberately in this home's own Settings is used.
    const saved = await phoneApi(server.base, cookie, 'PUT', '/api/notification-channels', { phone: { waiting: true }, ntfy: { server: ntfy.base, topic: 'arco-saved-topic' } });
    assert.equal(saved.ntfyEnvironmentHeldBack, false);
    assert.equal((await phoneApi(server.base, cookie, 'POST', '/api/notification-channels/test', {})).ok, true);
    assert.deepEqual(ntfy.paths, ['/arco-saved-topic']);
  } finally {
    if (server) await stopServer(server.child);
    await ntfy.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a home outside the temporary folder still sends to ARCO_NTFY_URL', { timeout: 180_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'arco-ntfy-guard-server-'));
  const ntfy = await startFakeNtfy();
  let server: Running | undefined;
  try {
    server = await startServer(root, { ARCO_NTFY_URL: `${ntfy.base}/arco-env-topic` }, true);
    assert.ok(!server.output().includes(NTFY_HELD_BACK_NOTE));
    assert.ok(server.output().includes(NTFY_ACTIVE_NOTE), 'the inherited ntfy transport is active');
    const cookie = await session(server.base);
    const view = await phoneApi(server.base, cookie, 'GET', '/api/notification-channels');
    assert.equal(view.ntfyFromEnvironment, true);
    assert.equal(view.ntfyEnvironmentHeldBack, false);
    assert.equal((await phoneApi(server.base, cookie, 'POST', '/api/notification-channels/test', {})).ok, true);
    assert.deepEqual(ntfy.paths, ['/arco-env-topic']);
  } finally {
    if (server) await stopServer(server.child);
    await ntfy.close();
    rmSync(root, { recursive: true, force: true });
  }
});
