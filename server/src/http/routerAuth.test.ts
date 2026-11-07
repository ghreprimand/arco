import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';

// Every non-public API route sits behind the session cookie, whatever module
// handles it, and a request path is judged in the same form the handlers
// route it. Synthetic requests through the real router; no listener, no
// provider call; the notification sender is a recording stub.

const root = mkdtempSync(path.join(tmpdir(), 'arco-router-auth-'));
installIsolatedTestHome(root);
delete process.env.ARCO_WS_AUTH;

interface Reply { status: number; body: string }
function request(method: string, url: string, body = '', headers: Record<string, string> = {}): IncomingMessage {
  const req = Readable.from(body ? [Buffer.from(body)] : []) as unknown as IncomingMessage;
  Object.assign(req, { method, url, headers: { host: '127.0.0.1:3001', ...headers }, socket: { remoteAddress: '127.0.0.1', remotePort: 1 } });
  return req;
}
async function send(method: string, url: string, body = '', headers: Record<string, string> = {}): Promise<Reply> {
  const { handleHttpRequest } = await import('./router.js');
  let status = 200, out = '';
  const res: Record<string, unknown> = {
    headersSent: false,
    setHeader() { return res; }, getHeader() { return undefined; }, removeHeader() {},
    writeHead(code: number) { status = code; res.headersSent = true; return res; },
    write(chunk: unknown) { out += String(chunk); return true; },
    end(chunk?: unknown) { if (chunk !== undefined) out += String(chunk); return res; },
    on() { return res; }, once() { return res; },
  };
  await handleHttpRequest(request(method, url, body, headers), res as unknown as ServerResponse, {} as never);
  return { status, body: out };
}

test('utility-agent, tidy, smart-pickup and notification routes need the session cookie', async () => {
  const attention = await import('../attention.js');
  attention._setChannelsPathForTest(path.join(root, 'channels.json'));
  await attention.saveChannels({ ntfy: { server: 'https://example.com', topic: 'synthetic', token: 'synthetic-fixture-token' } });
  const calls: Array<{ url: string; auth?: string }> = [];
  attention._setFetchForTest((async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
    return new Response('', { status: 200 });
  }) as typeof fetch);
  const protectedRoutes: Array<[string, string, string?]> = [
    ['GET', '/api/notification-channels'],
    ['PUT', '/api/notification-channels', JSON.stringify({ ntfy: { server: 'https://example.org', topic: 'capture' } })],
    ['POST', '/api/notification-channels/test', JSON.stringify({ ntfy: { server: 'https://example.org', topic: 'capture' } })],
    ['GET', '/api/utility-agent/providers'],
    ['POST', '/api/utility-agent/tidy', '{}'],
    ['GET', '/api/smart-pickup/evaluators'],
  ];
  for (const [method, url, body] of protectedRoutes) {
    const reply = await send(method, url, body ?? '');
    assert.equal(reply.status, 401, `${method} ${url}: ${reply.body}`);
  }
  assert.deepEqual(calls, [], 'no notification was sent');
  assert.equal(attention.getChannels().ntfy.server, 'https://example.com', 'the saved address is unchanged');
  // Public probes stay reachable without a cookie.
  assert.equal((await send('GET', '/healthz')).status, 200);
  assert.equal((await send('GET', '/api/app/version')).status, 200);
});

test('a notification test to another server does not carry the saved token', async () => {
  const attention = await import('../attention.js');
  attention._setChannelsPathForTest(path.join(root, 'channels-2.json'));
  await attention.saveChannels({ ntfy: { server: 'https://example.com', topic: 'synthetic', token: 'synthetic-fixture-token' } });
  const calls: Array<{ url: string; auth?: string }> = [];
  attention._setFetchForTest((async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
    return new Response('', { status: 200 });
  }) as typeof fetch);
  await attention.sendTest({ ntfy: { server: 'https://example.org', topic: 'capture' } });
  await attention.sendTest({ ntfy: { server: 'https://example.com', topic: 'other' } });
  assert.deepEqual(calls, [
    { url: 'https://example.org/capture', auth: undefined },
    { url: 'https://example.com/other', auth: 'Bearer synthetic-fixture-token' },
  ]);
  // Saving another server without a new token drops the saved one.
  await attention.saveChannels({ ntfy: { server: 'https://example.org', topic: 'capture' } });
  assert.equal(attention.getChannels().ntfy.token, undefined);
  await attention.saveChannels({ ntfy: { server: 'https://example.org', topic: 'capture', token: 'second' } });
  await attention.saveChannels({ ntfy: { server: 'https://example.org/', topic: 'renamed' } });
  assert.equal(attention.getChannels().ntfy.token, 'second', 'the same server keeps its token');
});

test('a path with dot segments or another non-canonical form cannot reach a protected route without the cookie', async () => {
  assert.equal((await send('GET', '/api/storage/policy')).status, 401);
  for (const url of [
    '/x/../api/storage/policy',
    '/x/%2e%2e/api/storage/policy',
    '/x/%2E%2E/api/storage/policy',
    '/./api/storage/policy',
    '/x\\..\\api/storage/policy',
    '//host/api/storage/policy',
    'http://127.0.0.1:3001/api/storage/policy',
    '/x/../api/notification-channels',
  ]) {
    const reply = await send('GET', url);
    assert.ok(reply.status === 400 || reply.status === 401, `${url}: ${reply.status} ${reply.body}`);
  }
  // An ordinary page path and a probe still work.
  assert.equal((await send('GET', '/healthz')).status, 200);
});

test.after(() => { setImmediate(() => process.exit(process.exitCode ?? 0)); });
