import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, win32 } from 'node:path';
import { findBrowsers, launchCommand, resolveBrowser, browserVersionTarget } from './browsers.mjs';

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
  assert.equal(pick('thorium-browser').browser.family, 'thorium');
  assert.equal(pick('thorium-browser').browser.command, join('/extra', 'thorium-browser'));
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

test('a url or profile that looks like extra flags stays one argument', () => {
  const url = 'http://127.0.0.1:3001/?app=explorer --no-sandbox';
  const profile = '/tmp/profile --disable-gpu';
  const [command, args] = launchCommand({ command: '/bin/chromium' }, url, profile);
  assert.equal(command, '/bin/chromium');
  assert.deepEqual(args, [`--user-data-dir=${profile}`, `--app=${url}`]);
});

test('launch arguments use the profile only when one is given', () => {
  assert.deepEqual(launchCommand({ command: '/b/chrome' }, 'http://h/', '/p'), ['/b/chrome', ['--user-data-dir=/p', '--app=http://h/']]);
  assert.deepEqual(launchCommand({ command: '/b/chrome' }, 'http://h/'), ['/b/chrome', ['--app=http://h/']]);
  assert.deepEqual(launchCommand({ command: '/usr/bin/flatpak', flatpak: 'org.chromium.Chromium' }, 'http://h/'), ['/usr/bin/flatpak', ['run', 'org.chromium.Chromium', '--app=http://h/']]);
});


test('Linux lists Brave Origin Beta separately while preserving the old Automatic winner', () => {
  const env = { PATH: '/b', ARCO_TEST_USER_HOME: '/empty', XDG_DATA_DIRS: '/empty', XDG_DATA_HOME: '/empty' };
  const found = findBrowsers('linux', env, fs(['/b/brave', '/b/brave-origin-beta', '/b/google-chrome-beta', '/b/ungoogled-chromium']));
  assert.equal(found[0].path, '/b/brave');
  assert.ok(found.some(b => b.name === 'Brave Origin Beta'));
  assert.ok(found.some(b => b.name === 'Google Chrome Beta'));
  assert.ok(found.some(b => b.name === 'Ungoogled Chromium'));
  assert.equal(resolveBrowser(found.find(b => b.name === 'Brave Origin Beta').id, 'linux', env, fs(['/b/brave', '/b/brave-origin-beta'])).browser.path, '/b/brave-origin-beta');
});


test('proven wrapper chains deduplicate their native target and only that target may be version-probed', () => {
  const native = Buffer.from([127, 69, 76, 70, 2, 1, 1, 0, 0, 0]);
  const contents = {
    '/bin/brave-origin-beta': '#!/bin/sh\nexec "/opt/origin/brave-origin-beta" "$@"\n',
    '/opt/origin/brave-origin-beta': '#!/bin/bash\nexport CHROME_WRAPPER="`readlink -f "$0"`"\nHERE="`dirname "$CHROME_WRAPPER"`"\n"$HERE/brave" "$@" || true\n',
    '/opt/origin/brave': native,
    '/bin/brave': '#!/bin/sh\nexec /opt/old/Brave.AppImage "$@"\n',
    '/opt/old/Brave.AppImage': Buffer.from([127, 69, 76, 70, 2, 1, 1, 0, 65, 73]),
  };
  const deps = fs(Object.keys(contents), { read: p => contents[p] || '' });
  const env = { PATH: '/bin:/opt/origin', ARCO_TEST_USER_HOME: '/empty', XDG_DATA_DIRS: '/empty', XDG_DATA_HOME: '/empty' };
  const found = findBrowsers('linux', env, deps);
  assert.equal(found.length, 2, 'wrapper and native target are one installation');
  const origin = found.find(b => b.name === 'Brave Origin Beta');
  assert.equal(browserVersionTarget(origin, 'linux', deps), '/opt/origin/brave');
  assert.equal(browserVersionTarget(found.find(b => b.name === 'Brave'), 'linux', deps), null, 'AppImages are never probed');
  const unsafe = { ...deps, read: p => p === '/bin/brave' ? '#!/bin/sh\nexec "$ARBITRARY/brave" "$@"' : contents[p] || '' };
  assert.equal(browserVersionTarget({ family: 'brave', path: '/bin/brave' }, 'linux', unsafe), null);
  assert.equal(browserVersionTarget({ family: 'brave', path: '/opt/origin/brave', flatpak: 'app' }, 'linux', deps), null);
});

test('Linux desktop and Snap discovery is bounded, excludes unsupported commands and never executes desktop contents', () => {
  const folder = '/xdg/applications'; const commands = [];
  const files = ['/opt/browser-fixture/brave-origin-beta', '/snap/bin/chromium', '/opt/firefox', '/usr/bin/flatpak', '/opt/beta/chrome'];
  const deps = fs(files, {
    list: p => p === folder ? ['origin.desktop', 'evil.desktop', 'firefox.desktop', 'unknown.desktop', 'beta.desktop'] : [],
    read: p => ({ [folder+'/beta.desktop']: '[Desktop Entry]\nName=Google Chrome Beta\nExec=/opt/beta/chrome %U\n', [folder+'/origin.desktop']: '[Desktop Entry]\nExec="/opt/browser-fixture/brave-origin-beta" %U\n', [folder+'/evil.desktop']: '[Desktop Entry]\nExec=sh -c "brave; touch ignored"', [folder+'/firefox.desktop']: '[Desktop Entry]\nExec=/opt/firefox %U', [folder+'/unknown.desktop']: '[Desktop Entry]\nExec=/opt/unregistered %U' })[p] || '',
    run: (command, args) => { commands.push([command, args]); return { stdout: '' }; },
  });
  const found = findBrowsers('linux', { PATH: '/nothing', XDG_DATA_HOME: '/xdg', XDG_DATA_DIRS: '/empty', ARCO_TEST_USER_HOME: '/empty' }, deps);
  assert.deepEqual(found.map(b => b.name), ['Chromium (Snap)', 'Brave Origin Beta', 'Google Chrome Beta']);
  assert.equal(commands.length, 0, 'no discovered program or desktop command is run');
});

test('macOS uses bundle identity and its actual executable, retaining separate channels and user installs', () => {
  const root = '/Applications/Renamed.app/Contents'; const user = '/user/Applications/Origin.app/Contents';
  const files = [root+'/MacOS/browser-core', user+'/MacOS/brave'];
  const plist = (id, exe) => `<plist><dict><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleExecutable</key><string>${exe}</string></dict></plist>`;
  const deps = fs(files, { list: p => p === '/Applications' ? ['Renamed.app', 'Unsupported.app'] : p === '/user/Applications' ? ['Origin.app'] : [], read: p => p === root+'/Info.plist' ? plist('com.google.Chrome.beta', 'browser-core') : p === user+'/Info.plist' ? plist('com.brave.Browser.origin.beta', 'brave') : '' });
  assert.deepEqual(findBrowsers('darwin', { ARCO_TEST_USER_HOME: '/user' }, deps).map(b => [b.name, b.path]), [['Google Chrome Beta', files[0]], ['Brave Origin Beta', files[1]]]);
});

test('Windows lists channel builds, both roots and registered clients from both registry views without launching them', () => {
  const files = [win32.join('C:\\Programs', 'Google/Chrome Beta/Application/chrome.exe'), win32.join('D:\\User', 'Google/Chrome Beta/Application/chrome.exe'), 'E:\\Browsers\\brave-origin-beta\\brave.exe'];
  const commands = [];
  const deps = fs(files, { run: (command, args) => { commands.push([command, args]); return { stdout: args.includes('/reg:32') && args[1].includes('StartMenuInternet') ? '  (Default) REG_SZ "'+files[2]+'" --registered\r\n' : '' }; } });
  const found = findBrowsers('win32', { ProgramFiles: 'C:\\Programs', LOCALAPPDATA: 'D:\\User' }, deps);
  assert.equal(found.length, 3); assert.equal(new Set(found.map(b => b.installationId)).size, 3);
  assert.equal(found.filter(b => b.name.startsWith('Google Chrome Beta')).length, 2);
  assert.ok(found.find(b => b.name === 'Brave Origin Beta'));
  assert.ok(commands.some(([, args]) => args.includes('/reg:64')));
  assert.ok(commands.every(([command]) => command === 'reg.exe'));
});

test('stable installation ids survive a PATH reorder while legacy family ids retain their preference', () => {
  const files = ['/a/brave', '/b/brave']; const deps = fs(files);
  const one = findBrowsers('linux', { PATH: '/a:/b', ARCO_TEST_USER_HOME: '/empty' }, deps);
  const selected = one.find(b => b.path === '/a/brave').installationId;
  const next = resolveBrowser(selected, 'linux', { PATH: '/b:/a', ARCO_TEST_USER_HOME: '/empty' }, deps);
  assert.equal(next.browser.path, '/a/brave');
  assert.equal(resolveBrowser('brave', 'linux', { PATH: '/b:/a', ARCO_TEST_USER_HOME: '/empty' }, deps).browser.path, '/b/brave');
  assert.equal(new Set(one.map(b => b.name)).size, 2, 'duplicate display names include the installation path');
});

test('Flatpak branches/installations are separate, stable exported duplicates are removed and launch preserves branch', () => {
  const deps = fs(['/bin/flatpak', exported('com.brave.Browser')], { run: (_cmd, args) => ({ stdout: args[0] === 'list' ? 'com.brave.Browser stable system\ncom.brave.Browser beta user\norg.mozilla.firefox stable system\n' : '' }) });
  const found = findBrowsers('linux', { PATH: '/bin', ARCO_TEST_USER_HOME: '/empty' }, deps);
  assert.equal(found.length, 2);
  const beta = found.find(b => b.flatpakBranch === 'beta');
  assert.ok(beta);
  assert.deepEqual(launchCommand(beta, 'http://h/')[1], ['run', '--branch=beta', '--user', 'com.brave.Browser', '--app=http://h/']);
});

test('XML and binary macOS bundle metadata use bounded readers, and unsupported identities are ignored', () => {
  const info = '/Applications/Chrome.app/Contents/Info.plist';
  let calls = 0;
  const deps = fs(['/Applications/Chrome.app/Contents/MacOS/Chrome'], { list: p => p === '/Applications' ? ['Chrome.app'] : [], read: p => p === info ? 'bplist00' : '', run: (cmd, args) => { calls++; assert.equal(cmd, '/usr/bin/plutil'); assert.equal(args.at(-1), info); return { stdout: JSON.stringify({ CFBundleIdentifier: 'com.google.Chrome', CFBundleExecutable: 'Chrome' }) }; } });
  assert.equal(findBrowsers('darwin', { ARCO_TEST_USER_HOME: '/empty' }, deps)[0].name, 'Google Chrome');
  assert.equal(calls, 1);
});


test('registry probing stops at the discovery deadline even when every registration times out', () => {
  const original = Date.now; let now = 0; let calls = 0;
  Date.now = () => now;
  try {
    const found = findBrowsers('win32', {}, fs([], { run: () => { now += 1000; calls++; return { stdout: '' }; } }));
    assert.deepEqual(found, []); assert.equal(calls, 4);
  } finally { Date.now = original; }
});

test('Snap parallel instances remain separate and are never version-probed', () => {
  const deps = fs(['/snap/bin/chromium', '/snap/bin/chromium_beta'], { list: p => p === '/snap/bin' ? ['chromium', 'chromium_beta', 'firefox'] : [] });
  const found = findBrowsers('linux', { PATH: '/empty', ARCO_TEST_USER_HOME: '/empty' }, deps);
  assert.deepEqual(found.map(b => b.name), ['Chromium (Snap)', 'Chromium (Snap beta)']);
  assert.ok(found.every(b => browserVersionTarget(b, 'linux', deps) === null));
});


test('Snap launchers sharing the snap executable never merge different browser apps', () => {
  const paths = ['/snap/bin/chromium', '/snap/bin/brave'];
  const deps = fs(paths, { real: () => '/usr/bin/snap' });
  const found = findBrowsers('linux', { PATH: '/snap/bin', ARCO_TEST_USER_HOME: '/empty' }, deps);
  assert.equal(found.length, 2); assert.ok(found.every(b => b.snap));
  assert.equal(new Set(found.map(b => b.family)).size, 2);
});
