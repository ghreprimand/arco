import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { PreviewGateways, parsePreviewPorts } from './previewProxy.js';
import { checkRequestOrigin } from './http/originGuard.js';
import { WebSocket, WebSocketServer } from 'ws';

async function listen(server: http.Server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return (server.address() as { port: number }).port; }
async function fixture(run: (context: { gateway: PreviewGateways; backend: number; seen: http.IncomingHttpHeaders[]; range: number; workflows: Map<string, number> }) => Promise<void>) {
  const seen: http.IncomingHttpHeaders[] = [];
  const backendServer = http.createServer((req, res) => { seen.push(req.headers); res.setHeader('set-cookie', ['arco_session_3001=poison; Path=/', 'arco_preview_4300=poison', 'app_cookie=ok; Path=/']); res.end(req.url); });
  const backend = await listen(backendServer);
  const socketServer = new WebSocketServer({ server: backendServer });
  socketServer.on('connection', (socket, req) => { seen.push(req.headers); socket.send('hmr-fixture'); socket.on('message', data => socket.send(data)); });
  // Temporary free ports avoid competing with other local test suites.
  const probe = http.createServer(); const range = await listen(probe); await new Promise<void>(resolve => probe.close(() => resolve()));
  const workflows = new Map([['first', backend], ['second', backend], ['third', backend]]);
  const gateway = new PreviewGateways({ host: '127.0.0.1', range: async () => `${range}-${range + 2}`, lookup: id => workflows.get(id), excludedPorts: () => [] });
  try { await run({ gateway, backend, seen, range, workflows }); }
  finally { gateway.close(); for (const socket of socketServer.clients) socket.terminate(); socketServer.close(); backendServer.closeAllConnections(); await new Promise<void>(resolve => backendServer.close(() => resolve())); }
}
const control = 'http://127.0.0.1:3001';
const address = (port: number) => `http://127.0.0.1:${port}`;
const cookie = (lease: { port: number; capability: string }) => `arco_preview_${lease.port}=${lease.capability}`;

test('L02: control listener and Vite no longer proxy preview paths', async () => {
  const router = await readFile(new URL('./http/router.ts', import.meta.url), 'utf8');
  const index = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
  const vite = await readFile(new URL('../../client/vite.config.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(router, /tryHandlePreviewRequest/); assert.doesNotMatch(index, /tryHandlePreviewUpgrade/); assert.doesNotMatch(vite, /blessedPaths|previewWfidForRequest/);
});

test('L02: preview credentials stay at the gateway, application cookies survive and controls are absent', async () => fixture(async ({ gateway, seen }) => {
  const lease = await gateway.acquire('first', control);
  const base = address(lease.port);
  assert.equal((await fetch(base)).status, 403);
  assert.equal((await fetch(`${base}/.arco-preview?cap=${encodeURIComponent('ä'.repeat(64))}`, { headers: { referer: control } })).status, 403);
  assert.equal((await fetch(base, { headers: { cookie: `arco_preview_${lease.port}=${'x'.repeat(64)}` } })).status, 403);
  assert.equal((await fetch(`${base}/.arco-preview?cap=${lease.capability}`, { headers: { referer: control, 'sec-fetch-site': 'same-site' } })).status, 200);
  assert.equal((await fetch(`${base}/.arco-preview?cap=${lease.capability}`, { headers: { referer: 'http://127.0.0.1:4309/', 'sec-fetch-site': 'same-site' } })).status, 403);
  const response = await fetch(`${base}/assets/app.js`, { headers: { cookie: `${cookie(lease)}; arco_session_3001=secret; app_cookie=ok`, authorization: 'Bearer secret', referer: base + '/', 'sec-fetch-site': 'same-origin' } });
  assert.equal(await response.text(), '/assets/app.js');
  assert.equal(seen.at(-1)?.cookie, 'app_cookie=ok'); assert.equal(seen.at(-1)?.authorization, undefined); assert.equal(seen.at(-1)?.referer, undefined);
  assert.deepEqual(response.headers.getSetCookie(), ['app_cookie=ok; Path=/']);
  assert.equal((await fetch(`${base}/api/session`)).status, 403);
  assert.equal((await fetch(`${base}/sw.js`, { headers: { cookie: cookie(lease), referer: base, 'service-worker': 'script' } })).status, 403);
}));

test('L02: same-site previews cannot read another preview or the operator API, even with shared cookies', async () => fixture(async ({ gateway }) => {
  const first = await gateway.acquire('first', control), second = await gateway.acquire('second', control);
  const cookies = `${cookie(first)}; ${cookie(second)}; arco_session_3001=fixture`;
  for (const headers of ([{ origin: address(first.port) }, { referer: address(first.port) + '/', 'sec-fetch-site': 'same-site' }, { 'sec-fetch-site': 'same-site' }] as Record<string, string>[])) {
    assert.equal((await fetch(address(second.port), { headers: { cookie: cookies, ...headers } })).status, 403);
  }
  assert.equal((await fetch(address(first.port), { headers: { cookie: cookies, origin: address(first.port) } })).status, 200);
  for (const method of ['GET', 'POST', 'OPTIONS']) assert.equal(checkRequestOrigin({ method, url: '/api/settings', headers: { host: '127.0.0.1:3001', origin: address(first.port) }, socket: { localPort: 3001 } } as http.IncomingMessage).ok, false);
}));

test('L02: lazy allocation skips occupied and excluded ports, shares a workflow and releases the last observer', async () => fixture(async ({ gateway, range, backend }) => {
  const occupied = http.createServer(); occupied.listen(range, '127.0.0.1'); await once(occupied, 'listening');
  try {
    const first = await gateway.acquire('first', control), other = await gateway.acquire('first', control);
    assert.equal(first.port, range + 1); assert.equal(other.port, first.port);
    const second = await gateway.acquire('second', control); assert.equal(second.port, range + 2);
    await assert.rejects(gateway.acquire('third', control), /No preview port is free.*PREVIEW PORTS/);
    gateway.release('first', first.id); assert.equal(gateway.renew('first', other.id), true);
    gateway.release('first', other.id); assert.equal(gateway.renew('first', other.id), false);
    const third = await gateway.acquire('third', control); assert.equal(third.port, range + 1);
    const excluded = new PreviewGateways({ host: '127.0.0.1', range: async () => `${range}-${range}`, lookup: () => backend, excludedPorts: () => [range] });
    try { await assert.rejects(excluded.acquire('fixture', control), /No preview port is free/); } finally { excluded.close(); }
  } finally { await new Promise<void>(resolve => occupied.close(() => resolve())); }
}));

test('L02: the newest observer cookie stays usable after that observer closes', async () => fixture(async ({ gateway }) => {
  const first = await gateway.acquire('first', control), second = await gateway.acquire('first', control);
  gateway.release('first', second.id);
  const response = await fetch(address(first.port), { headers: { cookie: cookie(second), referer: address(first.port) + '/', 'sec-fetch-site': 'same-origin' } });
  assert.equal(response.status, 200);
}));

test('L02: removed workflows, changed backends and expired leases cannot serve stale content', async () => fixture(async ({ gateway, workflows, backend, range }) => {
  const lease = await gateway.acquire('first', control); workflows.delete('first');
  assert.equal(gateway.renew('first', lease.id), false);
  const expiring = new PreviewGateways({ host: '127.0.0.1', range: async () => `${range}-${range + 2}`, lookup: () => backend, excludedPorts: () => [], ttlMs: 1 });
  try { const lease = await expiring.acquire('fixture', control); await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(expiring.renew('fixture', lease.id), false); }
  finally { expiring.close(); }
}));

test('L02: live-reload WebSockets keep application traffic and strip operator credentials', async () => fixture(async ({ gateway, seen }) => {
  const lease = await gateway.acquire('first', control);
  const socket = new WebSocket(`ws://127.0.0.1:${lease.port}/hmr`, { origin: address(lease.port), headers: { cookie: `${cookie(lease)}; arco_session_3001=secret`, authorization: 'Bearer secret' } });
  try { const [data] = await once(socket, 'message'); assert.equal(data.toString(), 'hmr-fixture'); assert.equal(seen.at(-1)?.cookie, undefined); assert.equal(seen.at(-1)?.authorization, undefined); }
  finally { socket.terminate(); }
  const denied = new WebSocket(`ws://127.0.0.1:${lease.port}/hmr`, { origin: 'http://127.0.0.1:4309', headers: { cookie: cookie(lease) } });
  const error = await once(denied, 'error'); assert.match(String(error[0]), /403/);
}));

test('L02: preview ranges reject malformed, privileged, excessive and temporary ports', () => {
  assert.deepEqual(parsePreviewPorts('4300-4309'), [4300, 4309]);
  for (const value of ['4300', '0-10', '1023-1030', '5000-4300', '4300-4500', '32768-32769', '', null]) assert.throws(() => parsePreviewPorts(value));
  assert.throws(() => parsePreviewPorts('4300-4309', 4305));
});

test('L02: the service environment overrides a saved preview range', async () => {
  const { previewPortRange } = await import('./previewPortConfiguration.js');
  const previous = process.env.ARCO_PREVIEW_PORTS;
  try {
    delete process.env.ARCO_PREVIEW_PORTS; assert.equal(await previewPortRange(), '4300-4309');
    assert.equal(await previewPortRange('4310-4312'), '4310-4312');
    process.env.ARCO_PREVIEW_PORTS = '4320-4322'; assert.equal(await previewPortRange('4310-4312'), '4320-4322');
    process.env.ARCO_PREVIEW_PORTS = 'invalid'; await assert.rejects(previewPortRange());
  } finally { if (previous === undefined) delete process.env.ARCO_PREVIEW_PORTS; else process.env.ARCO_PREVIEW_PORTS = previous; }
});
