import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serviceAction, servicePaths, windowsScriptHost, WINDOWS_LAUNCHER } from './services.mjs';
import { browserHost, isArcoHome, readPortState } from './ports.mjs';

const entry = fileURLToPath(new URL('./arco.mjs', import.meta.url));
const assets = fileURLToPath(new URL('../../client/dist/', import.meta.url));
const xml = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
const desktopQuote = (value) => `"${String(value).replace(/(["\\`$])/g, '\\$1').replace(/%/g, '%%')}"`;
export function shortcutPaths(platform, env = process.env) {
  const home = env.ARCO_TEST_USER_HOME || homedir();
  const dir = env.ARCO_SHORTCUTS_DIR || (platform === 'win32' ? join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs') : platform === 'darwin' ? join(home, 'Applications') : join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'applications'));
  return { dir, target: join(dir, platform === 'win32' ? 'Arco.lnk' : platform === 'darwin' ? 'Arco.app' : 'arco.desktop') };
}
export function renderShortcut(platform, { node = process.execPath, cli = entry, icon, launcher, home }) {
  if ([node, cli, icon, launcher, home].some((s) => s && /[\r\n\0]/.test(s))) throw new Error('A shortcut path contains an unsupported character.');
  if (platform === 'linux') return `[Desktop Entry]\nType=Application\nName=Arco\nComment=Open the Arco workbench\nExec=${['env', `ARCO_HOME=${home}`, node, cli, 'open'].map(desktopQuote).join(' ')}\nIcon=${icon}\nTerminal=false\nCategories=Development;\n`;
  if (platform === 'darwin') return { plist: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>io.github.ghreprimand.arco.launcher</string><key>CFBundleName</key><string>Arco</string><key>CFBundleDisplayName</key><string>Arco</string><key>CFBundleExecutable</key><string>Arco</string><key>CFBundleIconFile</key><string>arco.icns</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>\n`, script: `#!/bin/sh\nexport ARCO_HOME=${shellQuote(home)}\nexec ${shellQuote(node)} ${shellQuote(cli)} open\n` };
  if (platform === 'win32') return { target: windowsScriptHost(), arguments: ['//B', '//Nologo', launcher, node, cli, 'shortcut-open', home].map((s) => `"${String(s).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`).join(' '), icon };
  throw new Error('Unsupported shortcut platform.');
}
function shortcutDigest(path) {
  const hash = createHash('sha256');
  const visit = (current, name) => {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error('The shortcut contains a symbolic link.');
    if (stat.isDirectory()) { hash.update(`d:${name}\n`); for (const child of readdirSync(current).sort()) visit(join(current, child), `${name}/${child}`); }
    else if (stat.isFile() && stat.size < 10 * 1024 * 1024) { hash.update(`f:${name}\n`); hash.update(readFileSync(current)); }
    else throw new Error('The shortcut contains an unexpected file.');
  };
  visit(path, ''); return hash.digest('hex');
}
export function shortcuts(action, deps = {}) {
  const platform = deps.platform || process.platform, env = deps.env || process.env, paths = shortcutPaths(platform, env);
  const home = servicePaths(platform, env).home, owned = join(home, 'shortcuts.json');
  const run = deps.run || ((cmd, args, options) => spawnSync(cmd, args, options));
  if (action === 'remove') {
    let saved; try { saved = JSON.parse(readFileSync(owned, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (saved.platform !== platform || saved.target !== paths.target) throw new Error('Shortcut location changed; remove the previous shortcut manually.');
    if (existsSync(paths.target) && shortcutDigest(paths.target) !== saved.digest) throw new Error('The shortcut changed; review and remove it manually.');
    rmSync(paths.target, { recursive: platform === 'darwin', force: true }); rmSync(owned, { force: true });
    return;
  }
  if (action !== 'add') throw new Error('Use arco shortcuts add or remove.');
  if (existsSync(paths.target)) {
    let saved; try { saved = JSON.parse(readFileSync(owned, 'utf8')); } catch { throw new Error('An Arco shortcut already exists and was not created by this installation.'); }
    if (saved.platform !== platform || saved.target !== paths.target) throw new Error('An existing shortcut is not owned by this installation.');
    if (shortcutDigest(paths.target) !== saved.digest) throw new Error('The shortcut changed; review it before replacing it.');
    rmSync(paths.target, { recursive: platform === 'darwin', force: true });
  }
  mkdirSync(paths.dir, { recursive: true }); mkdirSync(home, { recursive: true, mode: 0o700 });
  const icon = join(assets, platform === 'win32' ? 'arco.ico' : platform === 'darwin' ? 'arco.icns' : 'arco-512.png');
  const launcher = join(home, 'open-launch.js');
  const rendered = renderShortcut(platform, { icon, launcher, home });
  if (platform === 'linux') writeFileSync(paths.target, rendered, { mode: 0o644, flag: 'wx' });
  else if (platform === 'darwin') {
    const contents = join(paths.target, 'Contents'); mkdirSync(join(contents, 'MacOS'), { recursive: true }); mkdirSync(join(contents, 'Resources'), { recursive: true });
    writeFileSync(join(contents, 'Info.plist'), rendered.plist); writeFileSync(join(contents, 'MacOS', 'Arco'), rendered.script, { mode: 0o755 }); copyFileSync(icon, join(contents, 'Resources', 'arco.icns'));
  } else if (platform === 'win32') {
    writeFileSync(launcher, WINDOWS_LAUNCHER, { mode: 0o600 });
    const script = "$s=New-Object -ComObject WScript.Shell; $l=$s.CreateShortcut($env:ARCO_LINK); $l.TargetPath=$env:ARCO_TARGET; $l.Arguments=$env:ARCO_ARGS; $l.IconLocation=$env:ARCO_ICON; $l.Save()";
    const result = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: 'pipe', env: { ...env, ARCO_LINK: paths.target, ARCO_TARGET: rendered.target, ARCO_ARGS: rendered.arguments, ARCO_ICON: icon } });
    if (result.error || result.status !== 0) throw new Error('Could not create the Windows shortcut.');
  } else throw new Error('Unsupported shortcut platform.');
  writeFileSync(owned, JSON.stringify({ platform, target: paths.target, digest: shortcutDigest(paths.target) }) + '\n', { mode: 0o600 });
}
export function discoverBrowser(platform, env = process.env, deps = {}) {
  const exists = deps.exists || ((path) => { try { accessSync(path, platform === 'linux' ? constants.X_OK : constants.F_OK); return true; } catch { return false; } }), run = deps.run || ((cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', stdio: 'pipe', windowsHide: true, env }));
  if (platform === 'win32') {
    for (const [exe, suffix] of [['msedge.exe', 'Microsoft/Edge/Application/msedge.exe'], ['chrome.exe', 'Google/Chrome/Application/chrome.exe']]) {
      for (const hive of ['HKCU', 'HKLM']) {
        const result = run('reg.exe', ['query', `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`, '/ve']);
        const value = (result.stdout || '').match(/REG_(?:EXPAND_)?SZ\s+([^\r\n]+)/i)?.[1]?.trim(); if (value && exists(value)) return value;
      }
      for (const root of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean)) { const path = join(root, ...suffix.split('/')); if (exists(path)) return path; }
    }
  } else if (platform === 'darwin') {
    for (const app of ['Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Chromium']) for (const root of ['/Applications', join(env.ARCO_TEST_USER_HOME || homedir(), 'Applications')]) { const path = join(root, `${app}.app`, 'Contents', 'MacOS', app === 'Brave Browser' ? 'Brave Browser' : app); if (exists(path)) return path; }
  } else if (platform === 'linux') {
    for (const name of ['google-chrome', 'google-chrome-stable', 'microsoft-edge', 'microsoft-edge-stable', 'brave-browser', 'brave', 'chromium', 'chromium-browser']) for (const dir of (env.PATH || '').split(':').filter(Boolean)) { const path = join(dir, name); if (exists(path)) return path; }
  }
  return null;
}
export async function openArco({ tab = false, env = process.env, platform = process.platform, launch, service = serviceAction, probe, delay = (ms) => new Promise((ok) => setTimeout(ok, ms)), log = console.log } = {}) {
  const paths = servicePaths(platform, env);
  const portNow = () => {
    let saved = {}; try { saved = JSON.parse(readFileSync(paths.config, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const port = String(readPortState(paths.home)?.port || env.ARCO_PORT || saved.env?.ARCO_PORT || '3001');
    if (!/^\d+$/.test(port) || +port < 1 || +port > 65535) throw new Error('Invalid Arco port.');
    return port;
  };
  let port = portNow();
  const hostNow = () => {
    let saved = {}; try { saved = JSON.parse(readFileSync(paths.config, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return env.ARCO_HOST || saved.env?.ARCO_HOST;
  };
  const healthy = probe || ((candidate) => isArcoHome(candidate, paths.home, fetch, hostNow()));
  if (!(await healthy(port))) { await service('start', { platform, env }); let ready = false; for (let i = 0; i < 100; i++) { await delay(200); port = portNow(); if (await healthy(port)) { ready = true; break; } } if (!ready) throw new Error('Arco did not become ready. Check arco service logs.'); }
  const url = `http://${browserHost(hostNow() || 'localhost')}:${port}/`;
  const browser = tab ? null : discoverBrowser(platform, env);
  let command, args;
  if (browser) { command = browser; args = [`--user-data-dir=${join(paths.home, 'browser-profile')}`, `--app=${url}`]; }
  else { if (!tab) log('No supported Chromium browser found; opening a normal browser tab.'); [command, args] = platform === 'darwin' ? ['open', [url]] : platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]] : ['xdg-open', [url]]; }
  if (launch) return launch(command, args);
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true }); child.on('error', () => {}); child.unref();
}
