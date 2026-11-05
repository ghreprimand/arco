// Chromium-family browsers that can open Arco as an app window (`--app=`).
// Used by `arco open`, the application shortcut (through `arco open`) and the
// server's explorer window. Node built-ins only: the server loads this file at
// run time from the package or the source checkout.
import { accessSync, constants, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, join, posix, win32 } from 'node:path';

export const BROWSER_FAMILIES = [
  { id: 'chrome', name: 'Google Chrome', aliases: ['google chrome', 'google-chrome', 'google-chrome-stable', 'chrome.exe'] },
  { id: 'edge', name: 'Microsoft Edge', aliases: ['microsoft edge', 'msedge', 'msedge.exe', 'microsoft-edge', 'microsoft-edge-stable'] },
  { id: 'brave', name: 'Brave', aliases: ['brave browser', 'brave-browser', 'brave.exe'] },
  { id: 'vivaldi', name: 'Vivaldi', aliases: ['vivaldi-stable', 'vivaldi.exe'] },
  { id: 'chromium', name: 'Chromium', aliases: ['chromium-browser'] },
];
const family = (id) => BROWSER_FAMILIES.find((f) => f.id === id);

// Search order per system. Earlier entries win under Automatic.
const WINDOWS = [
  { id: 'edge', exe: 'msedge.exe', suffix: 'Microsoft/Edge/Application/msedge.exe' },
  { id: 'chrome', exe: 'chrome.exe', suffix: 'Google/Chrome/Application/chrome.exe' },
  { id: 'brave', exe: 'brave.exe', suffix: 'BraveSoftware/Brave-Browser/Application/brave.exe' },
  { id: 'vivaldi', exe: 'vivaldi.exe', suffix: 'Vivaldi/Application/vivaldi.exe' },
  { id: 'chromium', suffix: 'Chromium/Application/chrome.exe' },
];
const MACOS = [
  { id: 'chrome', app: 'Google Chrome' },
  { id: 'edge', app: 'Microsoft Edge' },
  { id: 'brave', app: 'Brave Browser' },
  { id: 'chromium', app: 'Chromium' },
  { id: 'vivaldi', app: 'Vivaldi' },
];
const LINUX = [
  { id: 'chrome', names: ['google-chrome', 'google-chrome-stable'] },
  { id: 'edge', names: ['microsoft-edge', 'microsoft-edge-stable'] },
  { id: 'brave', names: ['brave-browser', 'brave'] },
  { id: 'chromium', names: ['chromium', 'chromium-browser'] },
  { id: 'vivaldi', names: ['vivaldi', 'vivaldi-stable'] },
];
export const FLATPAK_APPS = [
  { id: 'chrome', app: 'com.google.Chrome' },
  { id: 'edge', app: 'com.microsoft.Edge' },
  { id: 'brave', app: 'com.brave.Browser' },
  { id: 'chromium', app: 'org.chromium.Chromium' },
  { id: 'vivaldi', app: 'com.vivaldi.Vivaldi' },
];

function tools(platform, env, deps) {
  const exists = deps.exists || ((path) => { try { accessSync(path, platform === 'win32' ? constants.F_OK : constants.X_OK); return true; } catch { return false; } });
  const run = deps.run || ((cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', stdio: 'pipe', windowsHide: true, env, timeout: 5000 }));
  return { exists, run, home: env.ARCO_TEST_USER_HOME || deps.home || homedir() };
}
const pathDirs = (platform, env) => (env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
const isAbsoluteFor = (platform, value) => (platform === 'win32' ? win32.isAbsolute(value) : posix.isAbsolute(value));

// Every installed browser in search order, at most one entry per id.
// Entry: { id, family, name, path, command, flatpak? }. `command` is the program
// to run; for a Flatpak it is `flatpak` and `flatpak` holds the app id.
export function findBrowsers(platform, env = process.env, deps = {}) {
  const { exists, run, home } = tools(platform, env, deps);
  const found = [];
  const add = (id, path, extra = {}) => {
    const key = extra.flatpak ? `${id}-flatpak` : id;
    if (found.some((b) => b.id === key)) return;
    const name = family(id).name;
    found.push({ id: key, family: id, name: extra.flatpak ? `${name} (Flatpak)` : name, path, command: extra.command || path, ...extra });
  };
  if (platform === 'win32') {
    for (const { id, exe, suffix } of WINDOWS) {
      let hit = null;
      if (exe) for (const hive of ['HKCU', 'HKLM']) {
        const result = run('reg.exe', ['query', `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`, '/ve']);
        const value = (result?.stdout || '').match(/REG_(?:EXPAND_)?SZ\s+([^\r\n]+)/i)?.[1]?.trim().replace(/^"(.*)"$/, '$1');
        if (value && exists(value)) { hit = value; break; }
      }
      if (!hit) for (const root of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean)) {
        const path = join(root, ...suffix.split('/'));
        if (exists(path)) { hit = path; break; }
      }
      if (hit) add(id, hit);
    }
  } else if (platform === 'darwin') {
    for (const { id, app } of MACOS) for (const root of ['/Applications', join(home, 'Applications')]) {
      const path = join(root, `${app}.app`, 'Contents', 'MacOS', app);
      if (exists(path)) { add(id, path); break; }
    }
  } else if (platform === 'linux') {
    const dirs = pathDirs(platform, env);
    for (const { id, names } of LINUX) {
      const hit = names.flatMap((name) => dirs.map((dir) => join(dir, name))).find((path) => exists(path));
      if (hit) add(id, hit);
    }
    // Flatpak installs export a wrapper per app; the window runs through
    // `flatpak run` so the Arco profile folder can be shared with the sandbox.
    const flatpak = [...dirs.map((dir) => join(dir, 'flatpak')), '/usr/bin/flatpak'].find((path) => exists(path));
    if (flatpak) {
      const exportDirs = [join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'flatpak', 'exports', 'bin'), '/var/lib/flatpak/exports/bin'];
      for (const { id, app } of FLATPAK_APPS) {
        const wrapper = exportDirs.map((dir) => join(dir, app)).find((path) => exists(path));
        if (wrapper) add(id, wrapper, { command: flatpak, flatpak: app });
      }
    }
  }
  return found;
}

// The first installed browser in search order, or null.
export function discoverBrowser(platform, env = process.env, deps = {}) {
  return findBrowsers(platform, env, deps)[0] || null;
}

const NOT_CHROMIUM = /^(?:firefox|firefox-esr|librewolf|waterfox|floorp|safari|epiphany|org\.mozilla\.firefox)(?:\.exe|\.app)?$/i;

// A choice is empty or "automatic" (search order), a browser id or name
// ("brave", "Microsoft Edge", "brave-flatpak", "com.brave.Browser"), a program
// name on PATH, or an absolute path. Returns { browser, missing }: `missing` is
// true when a choice was given but not found (with `unsupported` when it names
// a browser outside the Chromium family), and `browser` is then the automatic
// choice (or null).
export function resolveBrowser(choice, platform, env = process.env, deps = {}) {
  const installed = findBrowsers(platform, env, deps);
  const automatic = installed[0] || null;
  const wanted = typeof choice === 'string' ? choice.trim() : '';
  if (!wanted || wanted.toLowerCase() === 'automatic') return { browser: automatic, missing: false };
  const { exists } = tools(platform, env, deps);
  const program = (path, name = basename(path)) => ({ id: 'path', family: null, name, path, command: path });
  // Browsers outside the Chromium family have no app-window mode.
  if (NOT_CHROMIUM.test(basename(wanted.replace(/\\/g, '/')))) return { browser: automatic, missing: true, unsupported: true };
  if (isAbsoluteFor(platform, wanted)) {
    if (!exists(wanted)) return { browser: automatic, missing: true };
    return { browser: installed.find((b) => b.path === wanted && !b.flatpak) || program(wanted), missing: false };
  }
  const key = wanted.toLowerCase();
  const exact = installed.find((b) => b.id === key || b.flatpak?.toLowerCase() === key);
  if (exact) return { browser: exact, missing: false };
  const fam = BROWSER_FAMILIES.find((f) => f.id === key || f.name.toLowerCase() === key || f.aliases.includes(key));
  if (fam) {
    const hit = installed.find((b) => b.family === fam.id);
    return hit ? { browser: hit, missing: false } : { browser: automatic, missing: true };
  }
  if (!/[\\/]/.test(wanted)) {
    const names = platform === 'win32' && !/\.exe$/i.test(wanted) ? [wanted, `${wanted}.exe`] : [wanted];
    const hit = pathDirs(platform, env).flatMap((dir) => names.map((name) => join(dir, name))).find((path) => exists(path));
    if (hit) return { browser: program(hit, wanted), missing: false };
  }
  return { browser: automatic, missing: true };
}

// Command and arguments that open `url` as an app window. With `profile` the
// window uses that profile folder, and a Flatpak is given access to it.
export function launchCommand(browser, url, profile) {
  const own = [...(profile ? [`--user-data-dir=${profile}`] : []), `--app=${url}`];
  if (browser.flatpak) return [browser.command, ['run', ...(profile ? [`--filesystem=${profile}`] : []), browser.flatpak, ...own]];
  return [browser.command, own];
}

// The Settings choice "App window browser" saved in <home>/settings.json.
export function savedBrowserChoice(home) {
  try {
    const value = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'))?.appWindowBrowser;
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  } catch { return undefined; }
}
