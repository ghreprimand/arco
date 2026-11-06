// A real server whose Arco home is inside the temporary folder never contacts
// the hub named by ARCO_HUB_URL; with ARCO_HUB_ALLOW_TEMP_HOME=1 it does (the
// positive control proves the fake hub would see a contact). The server runs
// with a minimal environment built here, not the invoking shell's.
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
const HELD_BACK_NOTE = 'Set ARCO_HUB_ALLOW_TEMP_HOME=1 to join anyway.';

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

function minimalEnv(root: string, port: number, extra: Record<string, string>): Record<string, string> {
  // The server shares this process's temporary folder, so its home (under
  // `root`, which was made there) is inside it.
  const home = path.join(root, 'home'), temp = tmpdir();
  mkdirSync(home, { recursive: true });
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

async function startServer(root: string, extra: Record<string, string>): Promise<Running> {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let output = '';
  const child = spawn(process.execPath, ['--conditions', 'development', '--import', 'tsx', 'server/src/index.ts'], {
    cwd: repo, env: minimalEnv(root, port, extra), stdio: ['ignore', 'pipe', 'pipe'],
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

test('ARCO_HUB_ALLOW_TEMP_HOME=1 lets the same server join', { timeout: 180_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'arco-hub-guard-server-'));
  const hub = await startFakeHub();
  let server: Running | undefined;
  try {
    server = await startServer(root, { ARCO_HUB_URL: hub.url, ARCO_HUB_ALLOW_TEMP_HOME: '1' });
    await until('a hub contact', () => hub.contacts() > 0, 30_000);
    assert.ok(!server.output().includes(HELD_BACK_NOTE));
  } finally {
    if (server) await stopServer(server.child);
    await hub.close();
    rmSync(root, { recursive: true, force: true });
  }
});
