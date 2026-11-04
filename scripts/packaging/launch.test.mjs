import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverBrowser, openArco, renderShortcut, shortcutPaths, shortcuts } from './launch.mjs';
import { writePortState } from './ports.mjs';

test('renders platform shortcuts with explicit executable and escaped paths', () => {
  const values = { node: '/test/node binary', cli: '/test/arco.mjs', icon: '/test/arco.png', launcher: '/test/launch.js', home: '/test/home' };
  assert.match(renderShortcut('linux', values), /Exec="env" "ARCO_HOME=\/test\/home" "\/test\/node binary" "\/test\/arco.mjs" "open"/);
  const mac = renderShortcut('darwin', values); assert.match(mac.plist, /CFBundleIconFile/); assert.match(mac.script, /'\/test\/node binary' '\/test\/arco.mjs' open/);
  const win = renderShortcut('win32', values); assert.match(win.target, /wscript\.exe$/i); assert.match(win.arguments, /"\/test\/launch.js" "\/test\/node binary" "\/test\/arco.mjs" "shortcut-open" "\/test\/home"/);
});
test('browser discovery prefers Windows Edge and ordered Unix candidates', () => {
  const win = discoverBrowser('win32', { ProgramFiles: '/program' }, { run: (_cmd, args) => ({ stdout: args[1].includes('msedge') ? '    (Default)    REG_SZ    /edge.exe\n' : '' }), exists: (p) => p === '/edge.exe' });
  assert.equal(win, '/edge.exe');
  assert.equal(discoverBrowser('linux', { PATH: '/bin-test' }, { exists: (p) => [join('/bin-test', 'chromium'), join('/bin-test', 'google-chrome')].includes(p) }), join('/bin-test', 'google-chrome'));
  assert.equal(discoverBrowser('darwin', { ARCO_TEST_USER_HOME: '/user' }, { exists: (p) => p === join('/user', 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome') }), join('/user', 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'));
  assert.equal(discoverBrowser('linux', { PATH: '' }, { exists: () => false }), null);
});
test('open starts a stopped service, uses configured port, and falls back to a tab', async () => {
  const home = mkdtempSync(join(tmpdir(), 'arco-open-')); const env = { ARCO_HOME: home, PATH: '' }; let count = 0, serviceCount = 0, launched, message;
  try {
    await openArco({ env, platform: 'linux', probe: async () => ++count > 1, delay: async () => {}, service: async (action) => { assert.equal(action, 'start'); serviceCount++; }, launch: (cmd, args) => { launched = [cmd, args]; }, log: (value) => { message = value; } });
    assert.equal(serviceCount, 1); assert.deepEqual(launched, ['xdg-open', ['http://localhost:3001/']]); assert.match(message, /normal browser tab/);
    await openArco({ tab: true, env: { ...env, ARCO_PORT: '4040' }, platform: 'linux', probe: async () => true, launch: (cmd, args) => { launched = [cmd, args]; } });
    assert.deepEqual(launched, ['xdg-open', ['http://localhost:4040/']]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
test('open follows a port chosen while the service starts', async () => {
  const home = mkdtempSync(join(tmpdir(), 'arco-open-port-')); let launched;
  try {
    await openArco({ tab: true, env: { ARCO_HOME: home }, platform: 'linux', probe: async (port) => port === '3012', delay: async () => {}, service: async () => writePortState(home, { version: 1, port: 3012, workspacePort: 3001 }), launch: (_cmd, args) => { launched = args; } });
    assert.deepEqual(launched, ['http://localhost:3012/']);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
test('Linux shortcut is removable only while unmodified', () => {
  const root = mkdtempSync(join(tmpdir(), 'arco-shortcut-')); const env = { ARCO_HOME: join(root, 'state'), ARCO_SHORTCUTS_DIR: join(root, 'applications') };
  try { shortcuts('add', { platform: 'linux', env }); const path = shortcutPaths('linux', env).target; assert.match(readFileSync(path, 'utf8'), /Name=Arco/); writeFileSync(path, 'user edits'); assert.throws(() => shortcuts('remove', { platform: 'linux', env }), /changed/); assert.equal(readFileSync(path, 'utf8'), 'user edits'); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

test('open launches a Chromium app window with an isolated profile', async () => {
  const home = mkdtempSync(join(tmpdir(), 'arco-open-app-'));
  const platform = process.platform === 'win32' ? 'win32' : 'linux';
  const bin = platform === 'win32' ? join(home, 'Microsoft', 'Edge', 'Application') : join(home, 'bin');
  const browser = join(bin, platform === 'win32' ? 'msedge.exe' : 'chromium');
  mkdirSync(bin, { recursive: true }); writeFileSync(browser, 'fixture', { mode: 0o755 }); let result;
  const env = { ARCO_HOME: home, PATH: platform === 'win32' ? '' : bin, ProgramFiles: home, ARCO_PORT: '4123' };
  try { await openArco({ env, platform, probe: async () => true, launch: (cmd, args) => { result = [cmd, args]; } });
    assert.deepEqual(result, [browser, [`--user-data-dir=${join(home, 'browser-profile')}`, '--app=http://localhost:4123/']]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
