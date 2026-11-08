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

 test('L01: browser origins are exact scheme/host/port tuples, not hostname classes', () => {
  const previous = process.env.ARCO_SERVE_CLIENT;
  process.env.ARCO_SERVE_CLIENT = '1';
  try {
    for (const origin of ['http://localhost:45678', 'https://localhost:3001', 'http://192.0.2.40:3001', 'https://unrelated.tail-example.ts.net', 'http://localhost:5173']) {
      for (const [method, url] of [['OPTIONS', '/api/fixture-only'], ['POST', '/api/fixture-only'], ['GET', '/ws'], ['GET', '/terminal']]) {
        assert.equal(checkRequestOrigin(req({ host: 'localhost:3001', origin }, method, url)).ok, false, `${method} ${url} ${origin}`);
      }
    }
    assert.equal(checkRequestOrigin(req({ host: 'localhost:3001', origin: 'http://localhost:3001' })).ok, true);
  } finally { if (previous === undefined) delete process.env.ARCO_SERVE_CLIENT; else process.env.ARCO_SERVE_CLIENT = previous; }
});

 test('L01: development and explicitly configured remote origins keep their exact authority', () => {
  const names = ['ARCO_SERVE_CLIENT', 'ARCO_ALLOWED_HOSTS', 'ARCO_ALLOWED_ORIGINS', 'ARCO_CLIENT_PORT'];
  const previous = new Map(names.map(name => [name, process.env[name]]));
  delete process.env.ARCO_SERVE_CLIENT; process.env.ARCO_CLIENT_PORT = '5173';
  process.env.ARCO_ALLOWED_HOSTS = 'workbench.tail-example.ts.net';
  process.env.ARCO_ALLOWED_ORIGINS = 'https://workbench.example:8443';
  try {
    for (const [host, origin] of [['localhost:3001', 'http://localhost:5173'], ['workbench.tail-example.ts.net', 'https://workbench.tail-example.ts.net'], ['workbench.example:8443', 'https://workbench.example:8443']]) {
      assert.equal(checkRequestOrigin(req({ host, origin }, 'POST')).ok, true, origin);
    }
    for (const origin of ['http://workbench.example:8443', 'https://workbench.example:8444', 'https://other.tail-example.ts.net', 'http://user:pass@localhost:3001', 'http://localhost:3001/path']) {
      assert.equal(checkRequestOrigin(req({ host: 'localhost:3001', origin }, 'POST')).ok, false, origin);
    }
    assert.equal(checkRequestOrigin(req({ host: 'localhost:3001', 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'no-cors' }, 'GET', '/api/fixture-only')).ok, false);
  } finally { for (const [name, value] of previous) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } }
});

 test('L01: same-origin remote upgrades need no new configuration', () => {
  const saved = process.env.ARCO_ALLOWED_HOSTS; delete process.env.ARCO_ALLOWED_HOSTS;
  try {
    for (const [host, origin, forwarded] of [['existing.tail-example.ts.net:8088', 'http://existing.tail-example.ts.net:8088', ''], ['existing.tail-example.ts.net', 'https://existing.tail-example.ts.net', 'https']]) {
      assert.equal(checkRequestOrigin(req({ host, origin, ...(forwarded ? { 'x-forwarded-proto': forwarded } : {}) }, 'POST')).ok, true, origin);
    }
  } finally { if (saved === undefined) delete process.env.ARCO_ALLOWED_HOSTS; else process.env.ARCO_ALLOWED_HOSTS = saved; }
});
