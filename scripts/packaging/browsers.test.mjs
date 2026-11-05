import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { findBrowsers, launchCommand, resolveBrowser } from './browsers.mjs';

// Simulated file systems: `files` is the set of paths that exist.
const fs = (files, extra = {}) => ({ exists: (p) => files.includes(p), run: () => ({ stdout: '' }), ...extra });
const ids = (list) => list.map((b) => b.id);
const exported = (app) => join('/var/lib/flatpak/exports/bin', app);

test('Windows finds Edge, Chrome, Brave, Vivaldi and Chromium, per machine and per user', () => {
  const env = { ProgramFiles: '/pf', 'ProgramFiles(x86)': '/pf86', LOCALAPPDATA: '/local' };
  const files = [
    join('/pf86', 'Microsoft/Edge/Application/msedge.exe'),
    join('/pf', 'Google/Chrome/Application/chrome.exe'),
    join('/local', 'BraveSoftware/Brave-Browser/Application/brave.exe'),
    join('/local', 'Vivaldi/Application/vivaldi.exe'),
    join('/local', 'Chromium/Application/chrome.exe'),
  ];
  const found = findBrowsers('win32', env, fs(files));
  assert.deepEqual(ids(found), ['edge', 'chrome', 'brave', 'vivaldi', 'chromium']);
  assert.equal(found[2].path, files[2]);
  // Brave and Vivaldi installed for all users.
  const machine = [join('/pf', 'BraveSoftware/Brave-Browser/Application/brave.exe'), join('/pf', 'Vivaldi/Application/vivaldi.exe')];
  assert.deepEqual(findBrowsers('win32', env, fs(machine)).map((b) => b.path), machine);
});

test('Windows reads App Paths registrations, quoted or not, before the folder search', () => {
  const run = (_cmd, args) => ({ stdout: args[1].includes('HKCU') && args[1].endsWith('brave.exe') ? '    (Default)    REG_SZ    "/custom/brave.exe"\r\n' : args[1].endsWith('vivaldi.exe') && args[1].startsWith('HKLM') ? '    (Default)    REG_EXPAND_SZ    /v/vivaldi.exe\r\n' : '' });
  const found = findBrowsers('win32', {}, { exists: (p) => ['/custom/brave.exe', '/v/vivaldi.exe'].includes(p), run });
  assert.deepEqual(found.map((b) => [b.id, b.path]), [['brave', '/custom/brave.exe'], ['vivaldi', '/v/vivaldi.exe']]);
});

test('macOS finds Vivaldi in /Applications or ~/Applications after the other browsers', () => {
  const env = { ARCO_TEST_USER_HOME: '/user' };
  const vivaldi = join('/user', 'Applications/Vivaldi.app/Contents/MacOS/Vivaldi');
  const brave = join('/Applications', 'Brave Browser.app/Contents/MacOS/Brave Browser');
  assert.deepEqual(findBrowsers('darwin', env, fs([vivaldi, brave])).map((b) => [b.id, b.path]), [['brave', brave], ['vivaldi', vivaldi]]);
});

test('Linux finds Vivaldi on PATH and Flatpak installs through their exported wrappers', () => {
  const env = { PATH: '/usr/bin:/opt/bin', ARCO_TEST_USER_HOME: '/user' };
  const files = [
    join('/opt/bin', 'vivaldi-stable'), join('/usr/bin', 'flatpak'),
    exported('com.brave.Browser'),
    join('/user', '.local/share/flatpak/exports/bin/org.chromium.Chromium'),
    exported('com.google.Chrome'), exported('com.microsoft.Edge'), exported('com.vivaldi.Vivaldi'),
  ];
  const found = findBrowsers('linux', env, fs(files));
  assert.deepEqual(ids(found), ['vivaldi', 'chrome-flatpak', 'edge-flatpak', 'brave-flatpak', 'chromium-flatpak', 'vivaldi-flatpak']);
  const brave = found.find((b) => b.id === 'brave-flatpak');
  assert.equal(brave.name, 'Brave (Flatpak)'); assert.equal(brave.command, join('/usr/bin', 'flatpak')); assert.equal(brave.flatpak, 'com.brave.Browser');
  assert.deepEqual(launchCommand(brave, 'http://localhost:3001/', '/h/browser-profile'), [join('/usr/bin', 'flatpak'), ['run', '--filesystem=/h/browser-profile', 'com.brave.Browser', '--user-data-dir=/h/browser-profile', '--app=http://localhost:3001/']]);
  // A user XDG_DATA_HOME is searched; without the flatpak program, wrappers are ignored.
  assert.deepEqual(ids(findBrowsers('linux', { PATH: '/usr/bin', XDG_DATA_HOME: '/xdg' }, fs([join('/usr/bin', 'flatpak'), join('/xdg', 'flatpak/exports/bin/com.vivaldi.Vivaldi')]))), ['vivaldi-flatpak']);
  assert.deepEqual(ids(findBrowsers('linux', { PATH: '/nothing', ARCO_TEST_USER_HOME: '/user' }, fs([exported('com.brave.Browser')]))), []);
});

test('Linux keeps the earlier search order and prefers a native install over a Flatpak', () => {
  const env = { PATH: '/a:/b', ARCO_TEST_USER_HOME: '/user' };
  const files = [join('/b', 'google-chrome'), join('/a', 'chromium'), '/usr/bin/flatpak', exported('com.microsoft.Edge')];
  assert.deepEqual(ids(findBrowsers('linux', env, fs(files))), ['chrome', 'chromium', 'edge-flatpak']);
  assert.equal(resolveBrowser('edge', 'linux', env, fs(files)).browser.id, 'edge-flatpak');
  assert.equal(resolveBrowser(undefined, 'linux', env, fs(files)).browser.path, join('/b', 'google-chrome'));
});

test('a chosen browser is matched by id, name, Flatpak id, program name or path, and falls back when missing', () => {
  const env = { PATH: '/bin:/extra', ARCO_TEST_USER_HOME: '/user' };
  const files = [join('/bin', 'google-chrome'), join('/bin', 'brave-browser'), '/usr/bin/flatpak', exported('com.vivaldi.Vivaldi'), join('/extra', 'thorium-browser'), '/opt/custom/chrome'];
  const pick = (choice) => resolveBrowser(choice, 'linux', env, fs(files));
  assert.deepEqual(pick('automatic'), { browser: pick('').browser, missing: false });
  assert.equal(pick('').browser.id, 'chrome');
  assert.equal(pick('Brave').browser.id, 'brave');
  assert.equal(pick('brave-browser').browser.id, 'brave');
  assert.equal(pick('Google Chrome').browser.id, 'chrome');
  assert.equal(pick('vivaldi').browser.id, 'vivaldi-flatpak');
  assert.equal(pick('com.vivaldi.Vivaldi').browser.id, 'vivaldi-flatpak');
  assert.deepEqual(pick('thorium-browser'), { browser: { id: 'path', family: null, name: 'thorium-browser', path: join('/extra', 'thorium-browser'), command: join('/extra', 'thorium-browser') }, missing: false });
  assert.equal(pick('/opt/custom/chrome').browser.command, '/opt/custom/chrome');
  // An absolute path to a detected browser is that browser (POSIX paths on a POSIX host).
  if (process.platform !== 'win32') assert.equal(pick('/bin/brave-browser').browser.id, 'brave');
  for (const missing of ['edge', 'Microsoft Edge', '/opt/gone/chrome', 'nonexistent', 'some/relative']) assert.deepEqual(pick(missing), { browser: pick('').browser, missing: true }, missing);
  assert.deepEqual(resolveBrowser('edge', 'linux', { PATH: '' }, fs([])), { browser: null, missing: true });
  // Firefox and Safari have no app window, even when installed.
  const withFirefox = [...files, join('/bin', 'firefox'), '/Applications/Firefox.app'];
  for (const name of ['firefox', 'Firefox', '/Applications/Firefox.app', 'C:\\Program Files\\Mozilla Firefox\\firefox.exe', 'org.mozilla.firefox', 'safari']) assert.deepEqual(resolveBrowser(name, 'linux', env, fs(withFirefox)), { browser: pick('').browser, missing: true, unsupported: true }, name);
});

test('a Windows choice accepts drive paths and program names without .exe', () => {
  const env = { PATH: 'C:\\Tools;D:\\Apps', LOCALAPPDATA: '/local' };
  const files = ['C:\\Browsers\\thorium.exe', join('D:\\Apps', 'thorium.exe'), join('/local', 'Vivaldi/Application/vivaldi.exe')];
  assert.equal(resolveBrowser('C:\\Browsers\\thorium.exe', 'win32', env, fs(files)).browser.command, 'C:\\Browsers\\thorium.exe');
  assert.equal(resolveBrowser('thorium', 'win32', env, fs(files)).browser.command, join('D:\\Apps', 'thorium.exe'));
  assert.equal(resolveBrowser('Vivaldi', 'win32', env, fs(files)).browser.id, 'vivaldi');
  assert.equal(resolveBrowser('C:\\Missing\\x.exe', 'win32', env, fs(files)).missing, true);
});

test('launch arguments use the profile only when one is given', () => {
  assert.deepEqual(launchCommand({ command: '/b/chrome' }, 'http://h/', '/p'), ['/b/chrome', ['--user-data-dir=/p', '--app=http://h/']]);
  assert.deepEqual(launchCommand({ command: '/b/chrome' }, 'http://h/'), ['/b/chrome', ['--app=http://h/']]);
  assert.deepEqual(launchCommand({ command: '/usr/bin/flatpak', flatpak: 'org.chromium.Chromium' }, 'http://h/'), ['/usr/bin/flatpak', ['run', 'org.chromium.Chromium', '--app=http://h/']]);
});
