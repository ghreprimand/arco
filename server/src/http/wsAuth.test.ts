import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'http';
import { checkHttpAuth, checkMintRequest, checkUpgradeAuth, mintToken, SESSION_COOKIE, sessionCookieHeader, verifyToken } from './wsAuth.js';

function req(headers: Record<string, string>, method = 'GET', url = '/'): IncomingMessage {
  return { headers, method, url, socket: {} } as unknown as IncomingMessage;
}

const BROWSER_FETCH = {
  origin: 'http://localhost:5173',
  'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'cors',
  'sec-fetch-dest': 'empty',
};

test('tokens: fresh verifies; tampered, expired, future-dated, junk refused', () => {
  const now = 1_800_000_000_000;
  const t = mintToken(now);
  assert.equal(verifyToken(t, now + 1000), true);
  assert.equal(verifyToken(t.slice(0, -2) + 'xx', now), false);
  assert.equal(verifyToken(t, now + 61 * 60 * 1000), false);
  assert.equal(verifyToken(mintToken(now + 5 * 60 * 1000), now), false);
  for (const junk of [undefined, '', 'v1.1.2', 'v2.1.2.3', 'a.b.c.d']) assert.equal(verifyToken(junk, now), false, String(junk));
});

test('mint: only a same-origin browser POST fetch', () => {
  assert.equal(checkMintRequest(req(BROWSER_FETCH, 'POST')).ok, true);
  assert.equal(checkMintRequest(req({ ...BROWSER_FETCH, 'sec-fetch-mode': 'same-origin' }, 'POST')).ok, true);
  // GET, Node/curl (no fetch metadata), no Origin, cross-site, navigation.
  assert.equal(checkMintRequest(req(BROWSER_FETCH, 'GET')).ok, false);
  assert.equal(checkMintRequest(req({ origin: 'http://localhost:3001' }, 'POST')).ok, false);
  assert.equal(checkMintRequest(req({}, 'POST')).ok, false);
  const { origin: _o, ...noOrigin } = BROWSER_FETCH;
  assert.equal(checkMintRequest(req(noOrigin, 'POST')).ok, false);
  assert.equal(checkMintRequest(req({ ...BROWSER_FETCH, 'sec-fetch-site': 'cross-site' }, 'POST')).ok, false);
  assert.equal(checkMintRequest(req({ ...BROWSER_FETCH, 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }, 'POST')).ok, false);
});

test('upgrade: needs Origin AND a valid cookie; ARCO_WS_AUTH=off bypasses', () => {
  const cookie = `other=1; ${SESSION_COOKIE}=${mintToken()}`;
  assert.equal(checkUpgradeAuth(req({ origin: 'http://localhost:5173', cookie })).ok, true);
  assert.equal(checkUpgradeAuth(req({ cookie })).ok, false);
  assert.equal(checkUpgradeAuth(req({ origin: 'http://localhost:5173' })).ok, false);
  assert.equal(checkUpgradeAuth(req({ origin: 'http://localhost:5173', cookie: `${SESSION_COOKIE}=forged` })).ok, false);
  const prev = process.env.ARCO_WS_AUTH;
  process.env.ARCO_WS_AUTH = 'off';
  try {
    assert.equal(checkUpgradeAuth(req({})).ok, true);
  } finally {
    if (prev === undefined) delete process.env.ARCO_WS_AUTH; else process.env.ARCO_WS_AUTH = prev;
  }
});

test('cookie is session-only (never written to the on-disk store) and HttpOnly/Strict', () => {
  const h = sessionCookieHeader('tok');
  assert.match(h, /HttpOnly/);
  assert.match(h, /SameSite=Strict/);
  assert.doesNotMatch(h, /Max-Age|Expires/i);
});

test('http: operator routes need the cookie; agent tool routes, mint, and non-api paths do not', () => {
  const cookie = `${SESSION_COOKIE}=${mintToken()}`;
  for (const url of ['/api/shutdown', '/api/file-content?path=/x', '/api/clusters/abc/members', '/api/plans/xyz', '/upload', '/api']) {
    assert.equal(checkHttpAuth(req({}, 'POST', url)).ok, false, url);
    assert.equal(checkHttpAuth(req({ cookie }, 'POST', url)).ok, true, url);
  }
  for (const url of ['/api/clusters/abc/peer/send', '/api/clusters/abc/peer/list?workflowId=w', '/api/plans?cwd=/x', '/api/plans/attach?planId=p', '/api/session', '/', '/assets/index.js', '/healthz']) {
    assert.equal(checkHttpAuth(req({}, 'POST', url)).ok, true, url);
  }
  // Peer exemption is one path segment deep — no smuggling extra segments.
  assert.equal(checkHttpAuth(req({}, 'POST', '/api/clusters/abc/peer/send/../../members')).ok, false);
});
