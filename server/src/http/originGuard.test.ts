import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'http';
import { hostname } from 'os';
import { checkRequestOrigin, isAllowedHostname, isAllowedOrigin } from './originGuard.js';

function req(headers: Record<string, string>, method = 'GET', url = '/api/x'): IncomingMessage {
  return { headers, method, url } as unknown as IncomingMessage;
}

test('hostnames: loopback, IP literals, self, tailnet allowed; foreign DNS names refused', () => {
  for (const h of ['localhost', '127.0.0.1', '::1', '100.64.0.20', '192.168.1.5', hostname(), 'box.tail1234.ts.net']) {
    assert.equal(isAllowedHostname(h), true, h);
  }
  for (const h of ['evil.example', 'localhost.evil.example', '']) {
    assert.equal(isAllowedHostname(h), false, h);
  }
});

test('ARCO_ALLOWED_HOSTS adds exact names and *.suffix wildcards', () => {
  process.env.ARCO_ALLOWED_HOSTS = 'arco.example.com, *.corp.example';
  try {
    assert.equal(isAllowedHostname('arco.example.com'), true);
    assert.equal(isAllowedHostname('a.corp.example'), true);
    assert.equal(isAllowedHostname('corp.example.evil'), false);
  } finally {
    delete process.env.ARCO_ALLOWED_HOSTS;
  }
});

test('origins: same-host dev proxy passes, foreign and "null" refused', () => {
  assert.equal(isAllowedOrigin('http://localhost:5173'), true);
  assert.equal(isAllowedOrigin('http://[::1]:3001'), true);
  assert.equal(isAllowedOrigin('https://evil.example'), false);
  assert.equal(isAllowedOrigin('null'), false);
  assert.equal(isAllowedOrigin(undefined), true);
});

test('requests: DNS rebinding (foreign Host) refused even with no Origin', () => {
  assert.equal(checkRequestOrigin(req({ host: 'evil.example:3001' })).ok, false);
  assert.equal(checkRequestOrigin(req({ host: '127.0.0.1:3001' })).ok, true);
});

test('requests: cross-site page fetch refused; allowed origin echoed', () => {
  assert.equal(checkRequestOrigin(req({ host: '127.0.0.1:3001', origin: 'https://evil.example' }, 'POST')).ok, false);
  const ok = checkRequestOrigin(req({ host: 'localhost:3001', origin: 'http://localhost:5173' }, 'POST'));
  assert.deepEqual(ok, { ok: true, origin: 'http://localhost:5173' });
});

test('requests: cross-site no-cors subresource refused; cross-site navigation to the app shell allowed', () => {
  assert.equal(checkRequestOrigin(req({ host: '127.0.0.1:3001', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' }, 'GET', '/api/file-content?path=x')).ok, false);
  assert.equal(checkRequestOrigin(req({ host: '127.0.0.1:3001', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' }, 'GET', '/')).ok, true);
  assert.equal(checkRequestOrigin(req({ host: '127.0.0.1:3001', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' }, 'GET', '/api/files')).ok, false);
});
