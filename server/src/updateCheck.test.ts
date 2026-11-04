import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareVersions, createUpdateChecker } from './updateCheck.js';
import type { AppUpdateAvailableMessage } from '@arco/shared';

const release = (tag = 'v0.2.0') => ({ tag_name: tag, html_url: `https://github.com/ghreprimand/arco/releases/tag/${tag}`, published_at: '2026-10-27T12:00:00Z', name: `Arco ${tag}` });
function fixture(response: () => Promise<Response> = async () => Response.json(release())) {
  const settings = { updateCheck: true, updateCheckDismissed: '' };
  let environment: string | undefined;
  const messages: AppUpdateAvailableMessage[] = [], logs: string[] = [], debug: string[] = [];
  let calls = 0;
  const checker = createUpdateChecker({ current: '0.1.0', settings: async () => settings, environment: () => environment,
    broadcast: (m) => messages.push(m), log: (m) => logs.push(m), debug: (m) => debug.push(m),
    fetch: async (url, init) => {
      calls++;
      assert.equal(url, 'https://api.github.com/repos/ghreprimand/arco/releases/latest');
      assert.deepEqual(init?.headers, { Accept: 'application/vnd.github+json', 'User-Agent': 'arco/0.1.0' });
      assert.ok(init?.signal); assert.equal(init?.redirect, 'error');
      return response();
    },
    now: () => new Date('2026-10-27T13:00:00Z'),
  });
  return { checker, settings, messages, logs, debug, calls: () => calls, env: (s?: string) => { environment = s; } };
}

test('semver precedence includes prerelease ordering and ignores build metadata', () => {
  const ordered = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.1.0', '2.0.0'];
  ordered.forEach((v, i) => { assert.equal(compareVersions(v, v), 0); if (i) { assert.equal(compareVersions(v, ordered[i-1]), 1); assert.equal(compareVersions(ordered[i-1], v), -1); } });
  assert.equal(compareVersions('v1.0.0+abc', '1.0.0+def'), 0);
  for (const tag of ['latest', 'v1', '01.0.0', '1.0.0-01', '1.0.0-', '1.0.0+']) assert.equal(compareVersions(tag, '1.0.0'), null);
});
test('check caches release metadata, announces and logs once per version', async () => {
  let tag = 'v0.2.0'; const f = fixture(async () => Response.json(release(tag)));
  const result = await f.checker.check();
  assert.deepEqual(result, { current: '0.1.0', latest: tag, url: release(tag).html_url, publishedAt: release(tag).published_at, checkedAt: '2026-10-27T13:00:00.000Z', enabled: true, updateAvailable: true });
  await f.checker.check(); await f.checker.status();
  assert.equal(f.calls(), 2); assert.equal(f.messages.length, 1); assert.equal(f.logs.length, 1);
  tag = 'v0.3.0'; await f.checker.check(); assert.equal(f.messages.length, 2);
});
test('up-to-date and older releases never announce', async () => {
  for (const tag of ['v0.1.0', 'v0.0.9', 'v0.1.0-rc.1']) {
    const f = fixture(async () => Response.json(release(tag)));
    assert.equal((await f.checker.check()).updateAvailable, false); assert.equal(f.messages.length, 0);
  }
});
test('settings and environment opt-outs suppress forced checks', async () => {
  const f = fixture(); f.settings.updateCheck = false;
  assert.equal((await f.checker.check()).enabled, false);
  f.settings.updateCheck = true; f.env('0'); assert.equal((await f.checker.check()).enabled, false);
  assert.equal(f.calls(), 0); f.env(); await f.checker.check(); assert.equal(f.calls(), 1);
});
test('dismissal suppresses that version while a newer one still announces', async () => {
  let tag = 'v0.2.0'; const f = fixture(async () => Response.json(release(tag)));
  f.settings.updateCheckDismissed = tag;
  assert.equal((await f.checker.check()).updateAvailable, true); assert.equal(f.messages.length, 0);
  tag = 'v0.3.0'; await f.checker.check(); assert.equal(f.messages.length, 1);
});
test('404, rate limit, network, timeout and malformed payload failures remain silent after one debug log', async () => {
  for (const reply of [async () => new Response('', { status: 404 }), async () => new Response('', { status: 403 }), async () => new Response('', { status: 429 }), async () => { throw new Error('network'); }, async () => { throw new DOMException('timeout', 'TimeoutError'); }, async () => Response.json(release('invalid')), async () => Response.json({ ...release(), html_url: 'javascript:alert(1)' }), async () => Response.json({ ...release(), published_at: 'bad' })]) {
    const f = fixture(reply); await f.checker.check(); await f.checker.check();
    assert.equal(f.calls(), 2); assert.equal(f.debug.length, 1); assert.equal(f.messages.length, 0); assert.equal((await f.checker.status()).latest, null);
  }
});
test('concurrent forced requests share one fetch and an in-flight opt-out suppresses delivery', async () => {
  let finish!: (r: Response) => void;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  const first = f.checker.check(), second = f.checker.check();
  await new Promise(resolve => setImmediate(resolve));
  f.settings.updateCheck = false; finish(Response.json(release()));
  assert.equal((await first).enabled, false); await second;
  assert.equal(f.calls(), 1); assert.equal(f.messages.length, 0);
});
test('scheduler waits 30 seconds, repeats in six hours, and stops', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); f.checker.start(); f.checker.start();
  t.mock.timers.tick(29_999); assert.equal(f.calls(), 0);
  t.mock.timers.tick(1); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.calls(), 1);
  t.mock.timers.tick(6 * 60 * 60 * 1000); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.calls(), 2);
  f.checker.stop(); t.mock.timers.tick(6 * 60 * 60 * 1000); assert.equal(f.calls(), 2);
});
test('request receives a five-second abort signal without a live network call', async (t) => {
  let deadline = 0;
  t.mock.method(AbortSignal, 'timeout', (ms: number) => { deadline = ms; return AbortSignal.abort(new DOMException('timeout', 'TimeoutError')); });
  const checker = createUpdateChecker({ current: '0.1.0', settings: async () => ({}), environment: () => undefined, broadcast: () => assert.fail('no broadcast on timeout'),
    fetch: async (_url, init) => { init?.signal?.throwIfAborted(); return Response.json(release()); },
  });
  assert.equal((await checker.check()).latest, null); assert.equal(deadline, 5000);
});
test('a failed refresh preserves the last release and a later successful cycle retries', async () => {
  let fail = false;
  const f = fixture(async () => { if (fail) throw new Error('offline'); return Response.json(release()); });
  await f.checker.check(); fail = true;
  assert.equal((await f.checker.check()).latest, 'v0.2.0');
  fail = false; await f.checker.check(); assert.equal(f.calls(), 3); assert.equal(f.messages.length, 1);
});
test('a dismissal saved during the request prevents a late toast', async () => {
  let finish!: (r: Response) => void;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.checker.check(); await new Promise(resolve => setImmediate(resolve));
  f.settings.updateCheckDismissed = 'v0.2.0'; finish(Response.json(release()));
  await pending; assert.equal(f.messages.length, 0);
});
