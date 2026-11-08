import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IncomingMessage } from 'node:http';
import { sessionCookieHeader } from './wsAuth.js';

function request(headers: Record<string, string>, socket: { encrypted?: boolean; remoteAddress?: string } = {}): IncomingMessage {
  return { headers, socket } as unknown as IncomingMessage;
}
const proxy = { host: 'workbench.tail-example.ts.net', origin: 'https://workbench.tail-example.ts.net', 'x-forwarded-proto': 'https' };

test('L04: direct TLS adds Secure and keeps the existing session-cookie restrictions', () => {
  const header = sessionCookieHeader('synthetic-fixture-token', request({ host: 'localhost:3001', origin: 'https://localhost:3001' }, { encrypted: true }));
  assert.match(header, /; Secure(?:;|$)/);
  for (const flag of ['HttpOnly', 'SameSite=Strict', 'Path=/']) assert.ok(header.includes(flag));
  assert.doesNotMatch(header, /Domain=|Max-Age=|Expires=/i);
});

test('L04: loopback HTTPS proxies are accepted, forwarding headers alone are not TLS proof', () => {
  assert.match(sessionCookieHeader('synthetic-fixture-token', request(proxy, { remoteAddress: '::ffff:127.0.0.1' })), /; Secure(?:;|$)/);
  for (const req of [
    request(proxy, { remoteAddress: '192.0.2.20' }),
    request({ ...proxy, origin: 'http://workbench.tail-example.ts.net' }, { remoteAddress: '127.0.0.1' }),
    request({ host: proxy.host, 'x-forwarded-proto': 'https' }, { remoteAddress: '127.0.0.1' }),
    request({ ...proxy, origin: 'https://unrelated.tail-example.ts.net' }, { remoteAddress: '127.0.0.1' }),
    request({ ...proxy, 'x-forwarded-proto': 'https,http' }, { remoteAddress: '127.0.0.1' }),
    request({ host: 'localhost:3001', origin: 'http://localhost:3001' }, { remoteAddress: '127.0.0.1' }),
  ]) assert.doesNotMatch(sessionCookieHeader('synthetic-fixture-token', req), /; Secure(?:;|$)/);
});

test('L04: additional reverse-proxy peers require an exact configured address', () => {
  const before = process.env.ARCO_TRUSTED_PROXIES;
  process.env.ARCO_TRUSTED_PROXIES = '192.0.2.20, 2001:db8::20';
  try {
    for (const remoteAddress of ['192.0.2.20', '2001:db8::20']) assert.match(sessionCookieHeader('synthetic-fixture-token', request(proxy, { remoteAddress })), /; Secure(?:;|$)/);
    assert.doesNotMatch(sessionCookieHeader('synthetic-fixture-token', request(proxy, { remoteAddress: '192.0.2.21' })), /; Secure(?:;|$)/);
  } finally { if (before === undefined) delete process.env.ARCO_TRUSTED_PROXIES; else process.env.ARCO_TRUSTED_PROXIES = before; }
});
