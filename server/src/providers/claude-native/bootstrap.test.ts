import { after, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { installIsolatedTestHome } from '../../testSupport/isolatedHome.js';

const home = mkdtempSync(join(tmpdir(), 'arco-bootstrap-'));
installIsolatedTestHome(home);
const oauth = await import('./oauth.js');
const { saveTokens, loadTokens, nativeCredentialBinding } = await import('./auth.js');
const { getClaudeNativeAuthStatus } = await import('./authStatus.js');
const originalFetch = globalThis.fetch, originalNow = Date.now;
let tokenCalls = 0;
let grant = async () => new Response(JSON.stringify({ access_token: 'fixture-new-access', refresh_token: 'fixture-new-refresh', expires_in: 3600 }));
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  if (String(url) === 'https://platform.claude.com/v1/oauth/token') { tokenCalls++; return grant(); }
  assert.match(String(url), /^http:\/\/(127\.0\.0\.1|localhost):53692\/callback\?/);
  return originalFetch(url, init);
}) as typeof fetch;
afterEach(async () => { Date.now = originalNow; await oauth.cancelActiveBootstrap(); oauth.clearClaudeAuthProblem(); });
after(() => { globalThis.fetch = originalFetch; rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
const seed = () => ({ accessToken: 'fixture-rejected', refreshToken: 'fixture-refresh', expiresAt: Date.now() + 3600_000, obtainedAt: 1, tokenType: 'Bearer', scope: 'fixture' });
const callback = (state: string, code = 'fixture-code') => `http://localhost:53692/callback?code=${code}&state=${state}`;
async function begin() { await saveTokens(seed()); tokenCalls = 0; grant = async () => new Response(JSON.stringify({ access_token: 'fixture-new-access', refresh_token: 'fixture-new-refresh', expires_in: 3600 })); return oauth.startBootstrap(nativeCredentialBinding(await loadTokens()), 'origin'); }

test('manual completion proves flow and binding replacement despite existing rejected credentials', async () => {
  const start = await begin(); oauth.markClaudeAuthProblem('fixture rejection');
  assert.notEqual(start.flow.id, start.state, 'public flow id must not be the PKCE verifier');
  assert.equal((await getClaudeNativeAuthStatus()).credentialsPresent, true);
  assert.equal((await oauth.getBootstrapFlow(start.flow.id))?.status, 'pending');
  const result = await oauth.completeBootstrap(callback(start.state), start.flow.id);
  assert.equal(result.flow.status, 'complete'); assert.equal(result.flow.workflowId, 'origin');
  assert.notEqual(result.flow.binding?.revision, start.flow.bindingBefore.revision);
  assert.deepEqual(result.flow.binding, nativeCredentialBinding(await loadTokens()));
  assert.equal(oauth.getClaudeAuthProblem(), null); assert.equal(tokenCalls, 1);
  await assert.rejects(oauth.completeBootstrap(callback(start.state), start.flow.id), /no longer pending/);
  assert.equal(tokenCalls, 1);
});

test('local callback reaches the same completion lifecycle and reports success only after commit', async () => {
  const start = await begin(); assert.equal(start.manualFallback, false);
  const response = await fetch(callback(start.state)); assert.equal(response.status, 200);
  assert.match(await response.text(), /No work was replayed/);
  const flow = await oauth.getBootstrapFlow(start.flow.id); assert.equal(flow?.status, 'complete'); assert.equal(tokenCalls, 1);
});

test('malformed callback request targets leave the process and pending flow usable', () => {
  const childHome = mkdtempSync(join(home, 'callback-child-'));
  const script = `
    import assert from 'node:assert/strict';
    import { connect } from 'node:net';
    const { installIsolatedTestHome } = await import(${JSON.stringify(new URL('../../testSupport/isolatedHome.ts', import.meta.url).href)});
    installIsolatedTestHome(process.argv[1]);
    const oauth = await import(${JSON.stringify(new URL('./oauth.ts', import.meta.url).href)});
    const auth = await import(${JSON.stringify(new URL('./auth.ts', import.meta.url).href)});
    let tokenCalls = 0;
    globalThis.fetch = async url => {
      assert.equal(String(url), 'https://platform.claude.com/v1/oauth/token');
      tokenCalls++;
      return new Response(JSON.stringify({ access_token: 'fixture-callback-access', refresh_token: 'fixture-callback-refresh', expires_in: 3600 }));
    };
    const rawRequest = target => new Promise((resolve, reject) => {
      const socket = connect(53692, '127.0.0.1');
      let response = '';
      socket.setTimeout(3000, () => socket.destroy(new Error('Callback response timed out')));
      socket.on('connect', () => socket.write('GET ' + target + ' HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n'));
      socket.on('data', chunk => { response += chunk.toString(); });
      socket.on('end', () => resolve(response));
      socket.on('error', reject);
    });
    try {
      const start = await oauth.startBootstrap(undefined, 'origin');
      assert.equal(start.manualFallback, false);
      const before = await auth.loadTokens();
      for (const target of ['//%', 'http://[invalid']) {
        assert.ok((await rawRequest(target)).startsWith('HTTP/1.1 400 '));
        assert.equal((await oauth.getBootstrapFlow(start.flow.id)).status, 'pending');
        assert.deepEqual(await auth.loadTokens(), before);
        assert.equal(tokenCalls, 0);
      }
      assert.ok((await rawRequest('/unrelated')).startsWith('HTTP/1.1 404 '));
      assert.equal((await oauth.getBootstrapFlow(start.flow.id)).status, 'pending');
      assert.ok((await rawRequest('/callback?code=fixture-code&state=' + start.state)).startsWith('HTTP/1.1 200 '));
      assert.equal((await oauth.getBootstrapFlow(start.flow.id)).status, 'complete');
      assert.equal((await auth.loadTokens()).accessToken, 'fixture-callback-access');
      assert.equal(tokenCalls, 1);
      console.log('PASS callback process and flow survived malformed targets');
    } finally { await oauth.cancelActiveBootstrap(); }
  `;
  try {
    const result = spawnSync(process.execPath, ['--conditions', 'development', '--import', 'tsx', '--input-type=module', '-e', script, childHome], {
      encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PASS callback process and flow survived malformed targets/);
  } finally { rmSync(childHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('superseded exchanging flow cannot overwrite credentials or cancel the new flow', async () => {
  const first = await begin(); let release!: (res: Response) => void;
  grant = () => new Promise(resolve => { release = resolve; });
  const pending = oauth.completeBootstrap(callback(first.state), first.flow.id);
  const failed = assert.rejects(pending, /no longer pending/);
  await new Promise(resolve => setImmediate(resolve));
  const next = await oauth.startBootstrap(undefined, 'other');
  release(new Response(JSON.stringify({ access_token: 'fixture-obsolete', refresh_token: 'fixture-obsolete-refresh', expires_in: 3600 })));
  await failed;
  assert.equal((await loadTokens())?.accessToken, 'fixture-rejected');
  assert.equal((await oauth.getBootstrapFlow(first.flow.id))?.status, 'superseded');
  assert.equal((await oauth.getBootstrapFlow(next.flow.id))?.status, 'pending');
});

test('duplicate concurrent callbacks exchange once and cancellation fences the exchange', async () => {
  const start = await begin(); let release!: (res: Response) => void;
  grant = () => new Promise(resolve => { release = resolve; });
  const a = oauth.completeBootstrap(callback(start.state), start.flow.id), b = oauth.completeBootstrap(callback(start.state), start.flow.id);
  const rejected = Promise.all([assert.rejects(a, /no longer pending/), assert.rejects(b, /no longer pending/)]);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(tokenCalls, 1);
  await oauth.cancelBootstrap(start.flow.id);
  release(new Response(JSON.stringify({ access_token: 'fixture-cancelled', refresh_token: 'fixture-cancelled-refresh', expires_in: 3600 })));
  await rejected; assert.equal((await loadTokens())?.accessToken, 'fixture-rejected');
  assert.equal((await oauth.getBootstrapFlow(start.flow.id))?.status, 'cancelled');
});

test('expiry and wrong flow/state never complete or cancel another login', async () => {
  const first = await begin();
  await assert.rejects(oauth.completeBootstrap(callback('wrong-state'), first.flow.id), /state mismatch/);
  assert.equal((await oauth.getBootstrapFlow(first.flow.id))?.status, 'pending');
  Date.now = () => first.flow.expiresAt + 1;
  assert.equal((await oauth.getBootstrapFlow(first.flow.id))?.status, 'expired');
  Date.now = originalNow;
  const next = await oauth.startBootstrap(undefined, 'other');
  await assert.rejects(oauth.completeBootstrap(callback(first.state), first.flow.id), /no longer pending/);
  assert.equal((await oauth.getBootstrapFlow(next.flow.id))?.status, 'pending'); assert.equal(tokenCalls, 0);
});

test('changed credential binding refuses stale start and late bootstrap persistence', async () => {
  const first = await begin(), changed = { ...seed(), accessToken: 'fixture-concurrent-grant', obtainedAt: 2 };
  await saveTokens(changed);
  await assert.rejects(oauth.startBootstrap(first.flow.bindingBefore), /credentials changed/);
  await assert.rejects(oauth.completeBootstrap(callback(first.state), first.flow.id), /credentials changed during sign-in/);
  assert.deepEqual(await loadTokens(), changed);
  assert.equal((await oauth.getBootstrapFlow(first.flow.id))?.status, 'superseded');
});

test('exchange failure remains separate from credential presence and can be retried with a new flow', async () => {
  const first = await begin(); oauth.markClaudeAuthProblem('fixture rejected');
  grant = async () => new Response(JSON.stringify({ error: 'fixture-invalid-grant' }), { status: 400 });
  await assert.rejects(oauth.completeBootstrap(callback(first.state), first.flow.id), /token exchange failed/);
  assert.equal((await oauth.getBootstrapFlow(first.flow.id))?.status, 'failed');
  assert.equal((await getClaudeNativeAuthStatus()).credentialsPresent, true); assert.ok(oauth.getClaudeAuthProblem());
  const next = await oauth.startBootstrap(); assert.equal(next.flow.status, 'pending');
});

test('unavailable local listener retains manual callback completion', async () => {
  const blocker = createServer(); await new Promise<void>(resolve => blocker.listen(53692, '127.0.0.1', resolve));
  try {
    const start = await begin(); assert.equal(start.manualFallback, true); assert.match(start.manualReason!, /Local callback unavailable/);
    const result = await oauth.completeBootstrap(callback(start.state), start.flow.id); assert.equal(result.flow.status, 'complete');
  } finally { await new Promise<void>(resolve => blocker.close(() => resolve())); }
});


test('Native failure notice carries the actual credential binding before tab changes or rotation', async () => {
  await saveTokens(seed()); tokenCalls = 0;
  const { ClaudeNativeWorker } = await import('./worker.js');
  const worker = new ClaudeNativeWorker({ workflowId: 'origin', config: { model: 'claude-opus-4-8', effort: 'low' } } as never);
  (worker as unknown as { ensureStarted: () => Promise<void> }).ensureStarted = async () => { throw new oauth.ClaudeNativeNoAuthError(); };
  let context: unknown;
  worker.on('system_notice', (notice, recovery) => { assert.match(notice, /AUTH:claude/); context = recovery; });
  worker.on('error', () => {});
  const binding = nativeCredentialBinding(await loadTokens());
  await worker.runTurn('fixture');
  await saveTokens({ ...seed(), accessToken: 'fixture-later-grant' });
  assert.deepEqual(context, { transport: 'native', binding }); assert.equal(tokenCalls, 0);
});


test('a malformed successful exchange does not complete recovery or replace credentials', async () => {
  const start = await begin(), before = await loadTokens();
  grant = async () => new Response(JSON.stringify({ access_token: 'fixture-incomplete' }));
  await assert.rejects(oauth.completeBootstrap(callback(start.state), start.flow.id), /Invalid Native token exchange response/);
  assert.deepEqual(await loadTokens(), before); assert.equal((await oauth.getBootstrapFlow(start.flow.id))?.status, 'failed');
});
