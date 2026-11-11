// Chromium-family browsers that can open Arco as an app window (`--app=`).
// Used by `arco open`, the application shortcut (through `arco open`) and the
// server's explorer window. Node built-ins only: the server loads this file at
// run time from the package or the source checkout.
import { accessSync, constants, readFileSync, opendirSync, realpathSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, join, posix, win32 } from 'node:path';

export const BROWSER_FAMILIES = [
  { id: 'chrome', name: 'Google Chrome', aliases: ['google chrome', 'google-chrome', 'google-chrome-stable', 'chrome.exe'] },
  { id: 'edge', name: 'Microsoft Edge', aliases: ['microsoft edge', 'msedge', 'msedge.exe', 'microsoft-edge', 'microsoft-edge-stable'] },
  { id: 'brave', name: 'Brave', aliases: ['brave browser', 'brave-browser', 'brave.exe'] },
  { id: 'vivaldi', name: 'Vivaldi', aliases: ['vivaldi-stable', 'vivaldi.exe'] },
  { id: 'chromium', name: 'Chromium', aliases: ['chromium-browser'] },
  { id: 'ungoogled', name: 'Ungoogled Chromium', aliases: ['ungoogled-chromium'] },
  { id: 'thorium', name: 'Thorium', aliases: ['thorium-browser', 'thorium.exe'] },
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

// Tests inject filesystem readers; injected existence never falls through to host files.
function tools(platform, env, deps) {
  const exists = deps.exists || ((path) => { try { accessSync(path, platform === 'win32' ? constants.F_OK : constants.X_OK); return true; } catch { return false; } });
  const deadline = Date.now() + 4000;
  const rawRun = deps.run || ((cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', stdio: 'pipe', windowsHide: true, env, timeout: Math.max(1, Math.min(750, deadline - Date.now())), maxBuffer: 256 * 1024 }));
  const run = (cmd, args) => Date.now() >= deadline ? { stdout: '' } : rawRun(cmd, args);
  const read = deps.read || (deps.exists ? () => '' : (path) => {
    let fd;
    try { if (!statSync(path).isFile()) return ''; fd = openSync(path, 'r'); const bytes = Buffer.alloc(256 * 1024); return bytes.subarray(0, readSync(fd, bytes, 0, bytes.length, 0)); }
    catch { return ''; } finally { if (fd !== undefined) closeSync(fd); }
  });
  const list = deps.list || (deps.exists ? () => [] : (path) => { try { const dir = opendirSync(path); const entries = []; try { for (let i = 0; i < 512; i++) { const entry = dir.readSync(); if (!entry) break; entries.push(entry.name); } } finally { dir.closeSync(); } return entries; } catch { return []; } });
  const real = deps.real || (deps.exists ? (p) => p : (p) => { try { return realpathSync(p); } catch { return p; } });
  return { exists, run, read, list, real, expired: () => Date.now() >= deadline, home: env.ARCO_TEST_USER_HOME || deps.home || homedir() };
}
const pathDirs = (platform, env) => (env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':').filter(Boolean).slice(0, 64);
const isAbsoluteFor = (platform, value) => (platform === 'win32' ? win32.isAbsolute(value) : posix.isAbsolute(value));

// Installed browsers in compatibility-first search order, one per installation.
// Entry: { id, family, name, path, command, flatpak? }. `command` is the program
// to run; for a Flatpak it is `flatpak` and `flatpak` holds the app id.
export function findBrowsers(platform, env = process.env, deps = {}) {
  const io = tools(platform, env, deps);
  const { exists, run, home } = io;
  const found = [];
  const identities = new Map();
  const add = (id, path, extra = {}) => {
    if (io.expired() || !exists(path)) return;
    if (platform === 'linux' && !extra.flatpak && (path.startsWith('/snap/bin/') || io.real(path) !== path && io.real(path).endsWith('/snap'))) {
      extra = { ...extra, snap: true, name: extra.name || `${family(id).name} (Snap)` };
    }
    if (extra.flatpakBranch) {
      const exported = found.find(b => b.flatpak === extra.flatpak && b.flatpakInstallation === extra.flatpakInstallation && !b.flatpakBranch);
      if (exported) {
        for (const [key, value] of identities) if (value === exported) identities.delete(key);
        const identity = `${extra.flatpak}:${extra.flatpakBranch}:${extra.flatpakInstallation}`;
        Object.assign(exported, extra, { installationId: `${id}-flatpak-${createHash('sha256').update(identity).digest('hex').slice(0, 12)}` });
        identities.set(identity, exported); return;
      }
    }
    const identityPath = extra.flatpak ? `${extra.flatpak}:${extra.flatpakBranch || "stable"}:${extra.flatpakInstallation || "system"}` : extra.snap ? posix.join('/snap/bin', basename(path)) : browserTarget(path, platform, io);
    const identity = platform === 'win32' ? identityPath.toLowerCase() : identityPath;
    if (identities.has(identity)) {
      const previous = identities.get(identity);
      if (extra.name && /Origin|Beta|Nightly|Canary|Snapshot|Dev/.test(extra.name) && !/Origin|Beta|Nightly|Canary|Snapshot|Dev/.test(previous.name)) previous.name = extra.name;
      return;
    }
    const baseKey = extra.flatpak ? `${id}-flatpak` : id;
    const key = found.some(b => b.id === baseKey) ? `${baseKey}-${createHash('sha256').update(identity).digest('hex').slice(0, 12)}` : baseKey;
    const name = extra.name || family(id).name + (extra.flatpak ? ' (Flatpak)' : '');
    const item = { id: key, family: id, name, path, command: extra.command || path, ...extra, installationId: `${baseKey}-${createHash('sha256').update(identity).digest('hex').slice(0, 12)}`, probePath: extra.flatpak || extra.snap ? undefined : identityPath };
    found.push(item); identities.set(identity, item);
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
        if (wrapper) add(id, wrapper, { command: flatpak, flatpak: app, flatpakInstallation: wrapper.startsWith('/var/lib/') ? 'system' : 'user' });
      }
    }
  }
  const legacyCount = found.length;
  discoverAdditional(platform, env, io, add);
  const rank = b => /Nightly|Canary/i.test(b.name) ? 3 : /Dev|Snapshot/i.test(b.name) ? 2 : /Beta/i.test(b.name) ? 1 : 0;
  const user = b => [home, env.LOCALAPPDATA].filter(Boolean).some(root => b.path.startsWith(root)) || b.flatpakInstallation === 'user' ? 1 : 0;
  found.splice(legacyCount, found.length - legacyCount, ...found.slice(legacyCount).sort((a, b) => rank(a) - rank(b) || user(a) - user(b) || a.name.localeCompare(b.name) || a.path.localeCompare(b.path)));

  const names = new Map();
  for (const browser of found) names.set(browser.name, (names.get(browser.name) || 0) + 1);
  for (const browser of found) if (names.get(browser.name) > 1) browser.name += ` (${browser.path})`;
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
  const installed = deps.browsers || findBrowsers(platform, env, deps);
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
  const exact = installed.find((b) => b.id === key || b.installationId === key || b.flatpak?.toLowerCase() === key || b.name.toLowerCase() === key || basename(b.path).toLowerCase() === key);
  if (exact) return { browser: exact, missing: false };
  const fam = BROWSER_FAMILIES.find((f) => f.id === key || f.name.toLowerCase() === key || f.aliases.includes(key));
  if (fam) {
    const hit = installed.find((b) => b.family === fam.id);
    if (hit) return { browser: hit, missing: false };
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
  if (browser.flatpak) return [browser.command, ['run', ...(browser.flatpakBranch ? [`--branch=${browser.flatpakBranch}`, `--${browser.flatpakInstallation}`] : []), ...(profile ? [`--filesystem=${profile}`] : []), browser.flatpak, ...own]];
  return [browser.command, own];
}

// The Settings choice "App window browser" saved in <home>/settings.json.
export function savedBrowserChoice(home) {
  try {
    const value = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'))?.appWindowBrowser;
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  } catch { return undefined; }
}

// Known Chromium app-window builds. A browser family alone is not evidence
// that a different vendor implements --app=; unsupported families stay out.
const BUILDS = [
  ['chrome', '', ['google-chrome', 'google-chrome-stable'], 'Google Chrome', 'com.google.Chrome', 'Google/Chrome'],
  ['chrome', 'Beta', ['google-chrome-beta'], 'Google Chrome Beta', 'com.google.Chrome.beta', 'Google/Chrome Beta'],
  ['chrome', 'Dev', ['google-chrome-unstable', 'google-chrome-dev'], 'Google Chrome Dev', 'com.google.Chrome.dev', 'Google/Chrome Dev'],
  ['chrome', 'Canary', ['google-chrome-canary'], 'Google Chrome Canary', 'com.google.Chrome.canary', 'Google/Chrome SxS'],
  ['edge', '', ['microsoft-edge', 'microsoft-edge-stable'], 'Microsoft Edge', 'com.microsoft.edgemac', 'Microsoft/Edge'],
  ['edge', 'Beta', ['microsoft-edge-beta'], 'Microsoft Edge Beta', 'com.microsoft.edgemac.Beta', 'Microsoft/Edge Beta'],
  ['edge', 'Dev', ['microsoft-edge-dev'], 'Microsoft Edge Dev', 'com.microsoft.edgemac.Dev', 'Microsoft/Edge Dev'],
  ['edge', 'Canary', [], 'Microsoft Edge Canary', 'com.microsoft.edgemac.Canary', 'Microsoft/Edge SxS'],
  ['brave', '', ['brave-browser', 'brave', 'brave-browser-stable'], 'Brave Browser', 'com.brave.Browser', 'BraveSoftware/Brave-Browser'],
  ['brave', 'Beta', ['brave-browser-beta', 'brave-beta'], 'Brave Browser Beta', 'com.brave.Browser.beta', 'BraveSoftware/Brave-Browser-Beta'],
  ['brave', 'Nightly', ['brave-browser-nightly', 'brave-nightly'], 'Brave Browser Nightly', 'com.brave.Browser.nightly', 'BraveSoftware/Brave-Browser-Nightly'],
  ['brave', 'Origin', ['brave-origin', 'brave-origin-stable'], 'Brave Origin', 'com.brave.Browser.origin', 'BraveSoftware/Brave-Origin'],
  ['brave', 'Origin Beta', ['brave-origin-beta'], 'Brave Origin Beta', 'com.brave.Browser.origin.beta', 'BraveSoftware/Brave-Origin-Beta'],
  ['brave', 'Origin Nightly', ['brave-origin-nightly'], 'Brave Origin Nightly', 'com.brave.Browser.origin.nightly', 'BraveSoftware/Brave-Origin-Nightly'],
  ['chromium', '', ['chromium', 'chromium-browser'], 'Chromium', 'org.chromium.Chromium', 'Chromium'],
  ['ungoogled', '', ['ungoogled-chromium', 'ungoogled-chromium-browser'], 'Ungoogled Chromium', 'com.github.Eloston.UngoogledChromium', 'Ungoogled Chromium'],
  ['vivaldi', '', ['vivaldi', 'vivaldi-stable'], 'Vivaldi', 'com.vivaldi.Vivaldi', 'Vivaldi'],
  ['vivaldi', 'Snapshot', ['vivaldi-snapshot'], 'Vivaldi Snapshot', 'com.vivaldi.Vivaldi.snapshot', 'Vivaldi Snapshot'],
  ['thorium', '', ['thorium-browser', 'thorium'], 'Thorium', 'org.chromium.Thorium', 'Thorium'],
];
const buildName = b => family(b[0]).name + (b[1] ? ` ${b[1]}` : '');
const buildRank = b => /Nightly|Canary/i.test(b[1]) ? 3 : /Dev|Snapshot/i.test(b[1]) ? 2 : /Beta/i.test(b[1]) ? 1 : 0;
const orderedBuilds = [...BUILDS].sort((a, b) => buildRank(a) - buildRank(b));
const text = value => Buffer.isBuffer(value) ? value.toString('utf8') : String(value || '');

// Only literal exec targets and the conventional HERE/CHROME_WRAPPER dirname
// forms are resolved. No sourcing, expansion, command substitution or execution.
export function browserTarget(path, platform, io, depth = 0) {
  const canonical = io.real(path);
  if (platform === 'win32' || depth >= 3) return canonical;
  const script = text(io.read(canonical));
  if (!script.startsWith('#!') || /\.appimage$/i.test(path)) return canonical;
  for (const line of script.split('\n').slice(0, 256)) {
    const direct = line.match(/^\s*("\$(?:HERE|{HERE})\/[^"\n]+")\s+"\$@"(?:\s*\|\|\s*true)?\s*$/);
    const match = direct || line.match(/^\s*exec\s+(?:-a\s+['"]?\$0['"]?\s+)?("[^"\n]+"|'[^'\n]+'|[^\s;]+)(?:\s|$)/);
    if (!match) continue;
    let target = match[1].replace(/^(['"])(.*)\1$/, '$2');
    const here = script.split('\n').filter(l => /^\s*(?:export\s+)?HERE=/.test(l));
    const wrapper = script.split('\n').filter(l => /^\s*(?:export\s+)?CHROME_WRAPPER=/.test(l));
    const hereValue = here[0]?.replace(/^\s*(?:export\s+)?HERE=/, '').trim();
    const wrapperValue = wrapper[0]?.replace(/^\s*(?:export\s+)?CHROME_WRAPPER=/, '').trim();
    const directHere = ['"`dirname "$0"`"', '"$(dirname "$0")"'].includes(hereValue);
    const wrappedHere = ['"`dirname "$CHROME_WRAPPER"`"', '"$(dirname "$CHROME_WRAPPER")"'].includes(hereValue);
    const wrappedSelf = ['"`readlink -f "$0"`"', '"$(readlink -f "$0")"'].includes(wrapperValue);
    const knownHere = here.length === 1 && (directHere || wrappedHere && wrapper.length === 1 && wrappedSelf);
    if (/^\$(?:HERE|{HERE})\//.test(target) && knownHere) target = posix.join(posix.dirname(directHere ? path : canonical), target.replace(/^\$(?:HERE|{HERE})\//, ''));
    if (/[\$`;&|<>\n]/.test(target) || !posix.isAbsolute(target) || !io.exists(target)) continue;
    return browserTarget(target, platform, io, depth + 1);
  }
  return canonical;
}
function classifyExecutable(path) {
  const name = path.replace(/\\/g, '/').split('/').pop().toLowerCase();
  return BUILDS.find(b => b[2].includes(name)) || (name === 'chrome' ? BUILDS[0] : name === 'msedge' ? BUILDS[4] : name === 'vivaldi-bin' ? BUILDS[16] : name === 'chrome.exe' ? BUILDS[0] : name === 'msedge.exe' ? BUILDS[4] : name === 'brave.exe' ? BUILDS[8] : name === 'vivaldi.exe' ? BUILDS[16] : name === 'thorium.exe' ? BUILDS[18] : undefined);
}
function windowsExecutable(value, env) {
  const expanded = value.replace(/%([^%]+)%/g, (_, key) => Object.entries(env).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1] || '');
  return expanded.match(/^\s*"([^"\r\n]+\.exe)"/i)?.[1] || expanded.match(/^\s*(.+?\.exe)(?:\s|$)/i)?.[1];
}
function plistValue(xml, key) {
  return xml.match(new RegExp(`<key>\\s*${key}\\s*</key>\\s*<string>([^<]+)</string>`))?.[1]?.replace(/&amp;/g, '&').replace(/&quot;/g, '"');
}
function discoverAdditional(platform, env, io, add) {
  const { exists, list, read, home, run } = io;
  if (platform === 'linux') {
    const dirs = [...new Set([...pathDirs(platform, env), '/snap/bin'])];
    for (const build of orderedBuilds) for (const name of build[2]) for (const dir of dirs) {
      const path = posix.join(dir, name);
      if (exists(path)) add(build[0], path, { name: buildName(build) + (dir === '/snap/bin' ? ' (Snap)' : ''), ...(dir === '/snap/bin' ? { snap: true } : {}) });
    }
    for (const name of list('/snap/bin').slice(0, 512)) {
      const [base, instance] = name.split('_');
      const build = BUILDS.find(b => b[2].includes(base));
      if (build && instance && /^[\w-]+$/.test(instance)) add(build[0], posix.join('/snap/bin', name), { snap: true, name: `${buildName(build)} (Snap ${instance})` });
    }
    const appDirs = [...new Set([posix.join(env.XDG_DATA_HOME || posix.join(home, '.local/share'), 'applications'), ...(env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter(p => posix.isAbsolute(p)).slice(0, 16).map(p => posix.join(p, 'applications')), '/var/lib/snapd/desktop/applications', '/var/lib/flatpak/exports/share/applications', posix.join(home, '.local/share/flatpak/exports/share/applications')])];
    const locate = command => posix.isAbsolute(command) ? command : dirs.map(dir => posix.join(dir, command)).find(exists);
    for (const dir of appDirs) for (const file of list(dir).slice(0, 512)) {
      if (io.expired()) return;
      if (!file.endsWith('.desktop')) continue;
      const desktop = text(read(posix.join(dir, file))).split(/\n\s*\[/)[0];
      const command = desktop.match(/^Exec=(.+)$/m)?.[1];
      if (!command || /[`$\n;&|<>]/.test(command)) continue;
      const tokens = command.match(/"(?:[^"\\]|\\.)*"|'[^']*'|[^\s]+/g)?.map(t => t.replace(/^(['"])(.*)\1$/, '$2')) || [];
      const program = locate(tokens[0] || '');
      if (!program || /\.appimage$/i.test(program)) continue;
      const recognized = classifyExecutable(program);
      const title = desktop.match(/^Name=(.+)$/m)?.[1]?.trim();
      const build = BUILDS.find(b => b[0] === recognized?.[0] && (buildName(b) === title || b[3] === title)) || recognized;
      if (build) add(build[0], program, { name: buildName(build) + (program.startsWith('/snap/bin/') ? ' (Snap)' : ''), ...(program.startsWith('/snap/bin/') ? { snap: true } : {}) });
    }
    const flatpak = locate('flatpak');
    if (flatpak) {
      const known = [...FLATPAK_APPS, { id: 'ungoogled', app: 'io.github.ungoogled_software.ungoogled_chromium' }, { id: 'thorium', app: 'io.github.Alex313031.thorium' }];
      const result = run(flatpak, ['list', '--app', '--columns=application,branch,installation']);
      for (const line of text(result?.stdout).split('\n').slice(0, 128)) {
        const [app, branch, installation] = line.trim().split(/\s+/);
        const knownApp = known.find(k => k.app === app);
        if (!knownApp || !branch || !/^[\w.-]+$/.test(branch) || !['user', 'system'].includes(installation)) continue;
        add(knownApp.id, flatpak, { name: `${family(knownApp.id).name} (Flatpak ${branch}, ${installation})`, command: flatpak, flatpak: app, flatpakBranch: branch, flatpakInstallation: installation });
      }
    }
  } else if (platform === 'darwin') {
    for (const build of orderedBuilds) for (const root of ['/Applications', posix.join(home, 'Applications')]) {
      const app = posix.join(root, `${build[3]}.app`), path = posix.join(app, 'Contents/MacOS', build[3]);
      if (exists(path)) add(build[0], path, { name: buildName(build) });
    }
    for (const root of ['/Applications', posix.join(home, 'Applications')]) for (const file of list(root).slice(0, 512)) {
      if (io.expired()) return;
      if (!file.endsWith('.app')) continue;
      const app = posix.join(root, file), info = posix.join(app, 'Contents/Info.plist');
      const raw = read(info); let id, executable;
      if (text(raw).startsWith('bplist')) {
        try { const data = JSON.parse(text(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', info])?.stdout)); id = data.CFBundleIdentifier; executable = data.CFBundleExecutable; } catch { continue; }
      } else { id = plistValue(text(raw), 'CFBundleIdentifier'); executable = plistValue(text(raw), 'CFBundleExecutable'); }
      const build = BUILDS.find(b => b[4].toLowerCase() === String(id).toLowerCase());
      if (!build || typeof executable !== 'string' || /[\/\\\0]/.test(executable)) continue;
      add(build[0], posix.join(app, 'Contents/MacOS', executable), { name: buildName(build) });
    }
  } else if (platform === 'win32') {
    const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean);
    for (const build of orderedBuilds) for (const root of roots) {
      const exe = build[0] === 'edge' ? 'msedge.exe' : build[0] === 'brave' ? 'brave.exe' : build[0] === 'vivaldi' ? 'vivaldi.exe' : build[0] === 'thorium' ? 'thorium.exe' : 'chrome.exe';
      add(build[0], win32.join(root, build[5], 'Application', exe), { name: buildName(build) });
    }
    for (const hive of ['HKCU', 'HKLM']) for (const view of ['64', '32']) for (const key of ['Software\\Microsoft\\Windows\\CurrentVersion\\App Paths', 'Software\\Clients\\StartMenuInternet']) {
      const output = text(run('reg.exe', ['query', `${hive}\\${key}`, '/s', `/reg:${view}`])?.stdout);
      for (const line of output.split('\n').slice(0, 1024)) {
        const value = line.match(/REG_(?:EXPAND_)?SZ\s+([^\r\n]+)/i)?.[1];
        if (!value) continue;
        const path = windowsExecutable(value, env), build = path && classifyExecutable(path);
        if (!build) continue;
        const matching = [...BUILDS].sort((a, b) => b[5].length - a[5].length).find(b => path.toLowerCase().replace(/\\/g, '/').includes(b[5].toLowerCase() + '/') && b[0] === build[0]) || [...BUILDS].sort((a, b) => b[1].length - a[1].length).find(b => b[0] === build[0] && b[1] && b[2].some(name => path.toLowerCase().replace(/\\/g, '/').split('/').includes(name))) || build;
        add(build[0], path, { name: buildName(matching) });
      }
    }
  }
}

// A version probe is allowed only for a proven native executable with a known
// browser basename. AppImages (ELF with AI magic) and scripts are never executed.
export function browserVersionTarget(browser, platform = process.platform, deps = {}) {
  if (!browser || browser.flatpak || browser.snap || !browser.family) return null;
  const io = tools(platform, process.env, deps), path = browserTarget(browser.path, platform, io);
  if (/\.appimage$/i.test(path) || !io.exists(path)) return null;
  const name = path.replace(/\\/g, '/').split('/').pop();
  if (!classifyExecutable(path) && !/^(?:chrome|brave|chromium|vivaldi-bin|Google Chrome(?: Beta| Dev| Canary)?|Brave (?:Browser|Origin)(?: Beta| Nightly)?|Microsoft Edge(?: Beta| Dev| Canary)?|Vivaldi(?: Snapshot)?|Thorium)$/i.test(name)) return null;
  const bytes = Buffer.from(io.read(path));
  const elf = bytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70]));
  if (elf && bytes[8] === 65 && bytes[9] === 73) return null;
  const native = platform === 'win32' ? bytes[0] === 77 && bytes[1] === 90 : platform === 'darwin' ? ['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca'].includes(bytes.subarray(0, 4).toString('hex')) : elf;
  return native ? path : null;
}
