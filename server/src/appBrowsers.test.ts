import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Settings live in a temporary Arco home; imports that capture it happen below.
const fixture = mkdtempSync(path.join(os.tmpdir(), 'arco-app-browser-'));
process.env.ARCO_HOME = path.join(fixture, 'arco');
mkdirSync(process.env.ARCO_HOME, { recursive: true });
after(() => rmSync(fixture, { recursive: true, force: true }));
const { patchSettings, readSettings } = await import('./settings.js');
const { appBrowserReport, chosenAppBrowser } = await import('./appBrowsers.js');

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
  assert.equal(await tryHandleAppBrowserRoutes({ url: '/api/app-browsers', method: 'GET' } as never, res as never), true);
  assert.equal(captured.status, 200);
  assert.equal(captured.cache, 'no-store');
  const report = JSON.parse(captured.body ?? '{}') as { browsers: unknown; choice: unknown; missing: unknown };
  assert.equal(Array.isArray(report.browsers), true);
  assert.equal('choice' in report && 'missing' in report, true);
  assert.equal(await tryHandleAppBrowserRoutes({ url: '/api/app-browsers', method: 'POST' } as never, res as never), false);
  assert.equal(await tryHandleAppBrowserRoutes({ url: '/api/settings', method: 'GET' } as never, res as never), false);
});

test('the report and the server window follow the shared browser rules', async () => {
  const bin = path.join(fixture, 'bin');
  mkdirSync(bin, { recursive: true });
  const env = { PATH: bin, ARCO_TEST_USER_HOME: path.join(fixture, 'user'), XDG_DATA_HOME: path.join(fixture, 'xdg') };
  if (process.platform === 'linux') {
    for (const name of ['chromium', 'vivaldi']) writeFileSync(path.join(bin, name), '#!/bin/sh\n', { mode: 0o755 });
    await patchSettings({ appWindowBrowser: '' });
    const automatic = await appBrowserReport('linux', env);
    assert.deepEqual(automatic.browsers.map((b) => b.id).slice(0, 2), ['chromium', 'vivaldi']);
    assert.equal(automatic.choice, null); assert.equal(automatic.using?.id, 'chromium'); assert.equal(automatic.missing, false);
    assert.equal(await chosenAppBrowser(env), null, 'Automatic keeps the explorer search');
    await patchSettings({ appWindowBrowser: 'vivaldi' });
    assert.equal((await appBrowserReport('linux', env)).using?.id, 'vivaldi');
    const chosen = await chosenAppBrowser(env);
    assert.equal(chosen?.command, path.join(bin, 'vivaldi'));
    assert.deepEqual(chosen?.args('http://localhost:3001/?app=explorer'), ['--app=http://localhost:3001/?app=explorer']);
    await patchSettings({ appWindowBrowser: 'edge' });
    const missing = await appBrowserReport('linux', env);
    assert.equal(missing.missing, true); assert.equal(missing.using?.id, 'chromium'); assert.equal(missing.choice, 'edge');
    assert.equal(await chosenAppBrowser(env), null);
    await patchSettings({ appWindowBrowser: 'firefox' });
    const firefox = await appBrowserReport('linux', env);
    assert.equal(firefox.missing, true); assert.equal(firefox.unsupported, true); assert.equal(firefox.using?.id, 'chromium');
  } else {
    // The module loads from server/src (and server/dist) on every system.
    const report = await appBrowserReport(process.platform, env);
    assert.equal(Array.isArray(report.browsers), true);
  }
});
