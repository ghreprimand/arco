import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';

// Settings live in a temporary Arco home; imports that capture it happen below.
const fixture = mkdtempSync(path.join(os.tmpdir(), 'arco-app-browser-'));
process.env.ARCO_HOME = path.join(fixture, 'arco');
mkdirSync(process.env.ARCO_HOME, { recursive: true });
after(() => rmSync(fixture, { recursive: true, force: true }));
const { patchSettings, readSettings } = await import('./settings.js');
const { appBrowserReport, chosenAppBrowser, BrowserVersionCache } = await import('./appBrowsers.js');

test('the App window browser setting is saved, cleared by Automatic and refuses control characters', async () => {
  assert.equal((await readSettings()).appWindowBrowser, undefined);
  assert.equal((await patchSettings({ appWindowBrowser: '  brave  ' })).appWindowBrowser, 'brave');
  assert.equal(JSON.parse(readFileSync(path.join(process.env.ARCO_HOME!, 'settings.json'), 'utf8')).appWindowBrowser, 'brave');
  assert.equal((await patchSettings({ operatorName: 'Tester' })).appWindowBrowser, 'brave', 'other patches keep it');
  await assert.rejects(patchSettings({ appWindowBrowser: 'bad\nvalue' }), /invalid appWindowBrowser/);
  await assert.rejects(patchSettings({ appWindowBrowser: 42 as unknown as string }), /invalid appWindowBrowser/);
  assert.equal((await readSettings()).appWindowBrowser, 'brave');
  assert.equal((await patchSettings({ appWindowBrowser: 'Automatic' })).appWindowBrowser, undefined);
  await patchSettings({ appWindowBrowser: '/opt/browser/chrome' });
  assert.equal((await patchSettings({ appWindowBrowser: '' })).appWindowBrowser, undefined);
});

test('GET /api/app-browsers returns the report and other requests pass through', async () => {
  const { tryHandleAppBrowserRoutes } = await import('./http/appBrowserRoutes.js');
  const captured: { status?: number; body?: string; cache?: string } = {};
  const res = { writeHead(status: number, headers: Record<string, string>) { captured.status = status; captured.cache = headers['Cache-Control']; }, end(body: string) { captured.body = body; } };
  assert.equal(await tryHandleAppBrowserRoutes({ url: '/api/app-browsers', method: 'GET' } as never, res as never, async () => ({ platform: 'linux', choice: null, browsers: [], using: null, missing: false, unsupported: false })), true);
  assert.equal(captured.status, 200);
  assert.equal(captured.cache, 'no-store');
  const report = JSON.parse(captured.body ?? '{}') as { browsers: unknown; choice: unknown; missing: unknown };
  assert.equal(Array.isArray(report.browsers), true);
  assert.equal('choice' in report && 'missing' in report, true);
  assert.equal(await tryHandleAppBrowserRoutes({ url: '/api/app-browsers', method: 'POST' } as never, res as never), false);
  assert.equal(await tryHandleAppBrowserRoutes({ url: '/api/settings', method: 'GET' } as never, res as never), false);
});

test('the report and the server window follow the shared browser rules', async t => {
  // Discovery also searches fixed install roots. Limit its filesystem view,
  // not just PATH, so a browser installed on the runner cannot enter the fixture.
  const onlyFixture = <T extends (...args: any[]) => any>(read: T) => ((...args: Parameters<T>) => {
    const relative = path.relative(fixture, String(args[0]));
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw Object.assign(new Error('Outside the browser fixture'), { code: 'ENOENT' });
    }
    return read(...args);
  }) as T;
  t.mock.method(fs, 'accessSync', onlyFixture(fs.accessSync));
  t.mock.method(fs, 'opendirSync', onlyFixture(fs.opendirSync));
  // A Windows report must not query the runner's real browser registry either.
  t.mock.method(childProcess, 'spawnSync', (() => ({ status: 0, stdout: '', stderr: '' })) as any);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const bin = path.join(fixture, 'bin');
  mkdirSync(bin, { recursive: true });
  const env = { PATH: bin, ARCO_TEST_USER_HOME: path.join(fixture, 'user'), XDG_DATA_HOME: path.join(fixture, 'xdg') };
  if (process.platform === 'linux') {
    for (const name of ['chromium', 'vivaldi']) writeFileSync(path.join(bin, name), '#!/bin/sh\n', { mode: 0o755 });
    await patchSettings({ appWindowBrowser: '' });
    const automatic = await appBrowserReport('linux', env);
    assert.deepEqual(automatic.browsers.map(b => b.name).slice(0, 2), ['Chromium', 'Vivaldi']);
    assert.ok(automatic.browsers.every(b => /-[a-f0-9]{12}$/.test(b.id)), 'the UI receives stable installation identifiers');
    assert.equal(automatic.choice, null); assert.equal(automatic.using?.name, 'Chromium'); assert.equal(automatic.missing, false);
    assert.equal(await chosenAppBrowser(env), null, 'Automatic keeps the explorer search');
    await patchSettings({ appWindowBrowser: 'vivaldi' });
    assert.equal((await appBrowserReport('linux', env)).using?.name, 'Vivaldi');
    const chosen = await chosenAppBrowser(env);
    assert.equal(chosen?.command, path.join(bin, 'vivaldi'));
    assert.deepEqual(chosen?.args('http://localhost:3001/?app=explorer'), ['--app=http://localhost:3001/?app=explorer']);
    await patchSettings({ appWindowBrowser: 'edge' });
    const missing = await appBrowserReport('linux', env);
    assert.equal(missing.missing, true); assert.equal(missing.using?.name, 'Chromium'); assert.equal(missing.choice, 'edge');
    assert.equal(await chosenAppBrowser(env), null);
    await patchSettings({ appWindowBrowser: 'firefox' });
    const firefox = await appBrowserReport('linux', env);
    assert.equal(firefox.missing, true); assert.equal(firefox.unsupported, true); assert.equal(firefox.using?.name, 'Chromium');
  } else {
    // The module loads from server/src (and server/dist) on every system.
    const report = await appBrowserReport(process.platform, env);
    assert.equal(Array.isArray(report.browsers), true);
  }
});


test('selected-version failures and concurrent reads are cached, never retried per report', async () => {
  const target = path.join(fixture, 'native'); writeFileSync(target, 'fixture');
  let calls = 0;
  const cache = new BrowserVersionCache(async () => { calls++; throw new Error('timed out'); });
  assert.deepEqual(await Promise.all([cache.get(target, 'linux', {}), cache.get(target, 'linux', {})]), [undefined, undefined]);
  await cache.get(target, 'linux', {}); assert.equal(calls, 1);
});
