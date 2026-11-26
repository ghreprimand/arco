import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { PreviewGateways, parsePreviewPorts } from './previewProxy.js';
import { checkRequestOrigin } from './http/originGuard.js';
import { WebSocket, WebSocketServer } from 'ws';

async function listen(server: http.Server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return (server.address() as { port: number }).port; }
interface Fixture {
  gateway: PreviewGateways;
  backend: number;
  seen: http.IncomingHttpHeaders[];
  range: string;
  occupiedPort: number;
  selection: { range: string; excluded: number[] };
  workflows: Map<string, number>;
}
async function fixture(run: (context: Fixture) => Promise<void>) {
  const seen: http.IncomingHttpHeaders[] = [];
  const backendServer = http.createServer((req, res) => { seen.push(req.headers); for (const name of ['Alt-Svc', 'Report-To', 'Reporting-Endpoints', 'NEL', 'Public-Key-Pins', 'Public-Key-Pins-Report-Only']) res.setHeader(name, 'fixture'); res.setHeader('Clear-Site-Data', '"cookies", "storage"'); res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains'); res.setHeader('Set-Cookie', ['arco_session_3001=poison; Path=/', 'app_cookie=ok; Path=/', 'domain_cookie=bad; Domain=localhost; Path=/']); res.end(req.url); });
  const backend = await listen(backendServer);
  const socketServer = new WebSocketServer({ server: backendServer });
  socketServer.on('headers', headers => headers.push(...['Alt-Svc', 'Report-To', 'Reporting-Endpoints', 'NEL', 'Public-Key-Pins', 'Public-Key-Pins-Report-Only'].map(name => `${name}: fixture`), 'Clear-Site-Data: "cookies"', 'Strict-Transport-Security: max-age=31536000', 'Set-Cookie: domain_cookie=bad; Domain=localhost', 'Set-Cookie: app_cookie=ok; Path=/'));
  socketServer.on('connection', (socket, req) => { seen.push(req.headers); socket.send('hmr-fixture'); socket.on('message', data => socket.send(data)); });
  // Keep the known occupied port bound. The other ports are candidates only:
  // the OS can assign them to a different listener or to a client connection.
  const occupied = http.createServer();
  const occupiedPort = await listen(occupied);
  const start = Math.min(occupiedPort, 65535 - 99);
  const range = `${start}-${start + 99}`;
  const selection = { range, excluded: [] as number[] };
  const workflows = new Map([['first', backend], ['second', backend], ['third', backend]]);
  const gateway = new PreviewGateways({ host: '127.0.0.1', range: async () => selection.range, lookup: id => workflows.get(id), excludedPorts: () => selection.excluded });
  try { await run({ gateway, backend, seen, range, occupiedPort, selection, workflows }); }
  finally {
    gateway.close();
    for (const socket of socketServer.clients) socket.terminate();
    socketServer.close();
    backendServer.closeAllConnections();
    await Promise.all([occupied, backendServer].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  }
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
  assert.equal(response.headers.get('clear-site-data'), null);
  assert.equal(response.headers.get('strict-transport-security'), null);
  for (const name of ['alt-svc', 'report-to', 'reporting-endpoints', 'nel', 'public-key-pins', 'public-key-pins-report-only']) assert.equal(response.headers.get(name), null);
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

test('L02: lazy allocation skips occupied and excluded ports, shares a workflow and releases the last observer', async (t) => fixture(async ({ gateway, range, backend, occupiedPort, selection }) => {
  selection.range = `${occupiedPort}-${occupiedPort}`;
  await assert.rejects(gateway.acquire('first', control), /No preview port is free.*PREVIEW PORTS/);

  selection.range = range;
  const first = await gateway.acquire('first', control);
  const other = await gateway.acquire('first', control);
  const second = await gateway.acquire('second', control);
  assert.notEqual(first.port, occupiedPort);
  assert.equal(other.port, first.port);
  assert.notEqual(second.port, first.port);

  const lower = Math.min(first.port, second.port), upper = Math.max(first.port, second.port);
  selection.range = `${lower}-${upper}`;
  for (let port = lower + 1; port < upper; port++) {
    if (port !== backend) selection.excluded.push(port);
  }
  await assert.rejects(gateway.acquire('third', control), /No preview port is free.*PREVIEW PORTS/);

  const connection = createConnection({ host: '127.0.0.1', port: first.port });
  try {
    await once(connection, 'connect');
    gateway.release('first', first.id);
    assert.equal(gateway.renew('first', other.id), true);
    const response = await fetch(address(other.port), { headers: { cookie: cookie(other) } });
    assert.equal(response.status, 200);
    await response.text();
    const closed = once(connection, 'close', { signal: AbortSignal.timeout(5000) });
    gateway.release('first', other.id);
    await closed;
    assert.equal(gateway.renew('first', other.id), false);
  } finally {
    connection.destroy();
  }

  selection.range = `${first.port}-${first.port}`;
  selection.excluded = [first.port];
  const listenMock = t.mock.method(http.Server.prototype, 'listen', () => assert.fail('An excluded preview port must not be bound'));
  await assert.rejects(gateway.acquire('first', control), /No preview port is free/);
  listenMock.mock.restore();

  selection.range = range;
  selection.excluded = [];
  const third = await gateway.acquire('third', control);
  assert.notEqual(third.port, second.port);
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
  const expiring = new PreviewGateways({ host: '127.0.0.1', range: async () => range, lookup: () => backend, excludedPorts: () => [], ttlMs: 1 });
  try { const lease = await expiring.acquire('fixture', control); await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(expiring.renew('fixture', lease.id), false); }
  finally { expiring.close(); }
}));

test('L02: live-reload WebSockets keep application traffic and strip operator credentials', async () => fixture(async ({ gateway, seen }) => {
  const lease = await gateway.acquire('first', control);
  const socket = new WebSocket(`ws://127.0.0.1:${lease.port}/hmr`, { origin: address(lease.port), headers: { cookie: `${cookie(lease)}; arco_session_3001=secret`, authorization: 'Bearer secret' } });
  const upgrade = once(socket, 'upgrade'), message = once(socket, 'message');
  try { const [response] = await upgrade; assert.equal(response.headers['clear-site-data'], undefined); assert.equal(response.headers['strict-transport-security'], undefined); for (const name of ['alt-svc', 'report-to', 'reporting-endpoints', 'nel', 'public-key-pins', 'public-key-pins-report-only']) assert.equal(response.headers[name], undefined); assert.deepEqual(response.headers['set-cookie'], ['app_cookie=ok; Path=/']); const [data] = await message; assert.equal(data.toString(), 'hmr-fixture'); assert.equal(seen.at(-1)?.cookie, undefined); assert.equal(seen.at(-1)?.authorization, undefined); }
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
