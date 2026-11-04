// Per-user service definitions for packaged installations. All subprocesses
// use argv arrays and all mutable configuration lives under the Arco home.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./arco.mjs', import.meta.url));
const label = 'arco-workbench';
export const SERVICE_ENV_KEYS = ['ARCO_HOST', 'ARCO_PORT', 'ARCO_HOME', 'ARCO_ALLOWED_HOSTS', 'ARCO_HUB_URL', 'ARCO_NTFY_URL', 'ARCO_VOICE_HOME', 'ARCO_LOG_DIR', 'ARCO_UPDATE_CHECK', 'PATH'];
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
function systemdQuote(value) {
  if (/[\r\n\0]/.test(value)) throw new Error('A service path contains an unsupported character.');
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$')}"`;
}
// On Windows the task starts node through Windows Script Host (wscript.exe is a
// GUI-subsystem program, so no console window is created) running a small
// JScript launcher that starts node hidden and waits for it. conhost.exe
// --headless was tried first and does not start a child on hosted runners.
// JScript, not VBScript: VBScript is being retired from Windows 11.
export function windowsScriptHost(env = process.env) {
  return `${(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows').replace(/[\\/]+$/, '')}\\System32\\wscript.exe`;
}
export const WINDOWS_LAUNCHER = "var a = WScript.Arguments, c = [], i;\r\nfor (i = 0; i < a.length; i++) c.push('\"' + a(i) + '\"');\r\nWScript.Quit(new ActiveXObject('WScript.Shell').Run(c.join(' '), 0, true));\r\n";
export const WINDOWS_END_TREE = String.raw`$ErrorActionPreference='Stop'; $m=$env:ARCO_SERVICE_MARK; if (-not $m) { exit 1 }; $configPattern='(?i)(?:^|\s|")' + [Regex]::Escape($m) + '(?:"|\s|$)'; $candidates=@(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and ($_.Name -eq 'node.exe' -or $_.Name -eq 'wscript.exe') }); if (@($candidates | Where-Object { [String]::IsNullOrWhiteSpace([string]$_.CommandLine) }).Count -gt 0) { throw 'Cannot inspect process command lines.' }; $candidates | Where-Object { $_.CommandLine -match '(?i)(?:^|[\\/\s"])arco\.mjs"?\s+"?service-run"?(?:\s|$)' -and $_.CommandLine -match $configPattern } | ForEach-Object { $id=$_.ProcessId; $ErrorActionPreference='Continue'; & taskkill.exe /PID $id /T /F 2>$null | Out-Null; $ErrorActionPreference='Stop'; if ($LASTEXITCODE -ne 0) { $alive=@([System.Diagnostics.Process]::GetProcesses() | Where-Object { $_.Id -eq $id }); if ($alive.Count -gt 0) { throw 'Could not stop the service process.' } } }; exit 0`;
export const windowsLauncherPath = (config) => join(dirname(config), 'launch.js');
export function renderService(platform, { node, entry, config, home, user, env = process.env }) {
  const args = [node, entry, 'service-run', config];
  if (args.some((arg) => /[\r\n\0]/.test(arg))) throw new Error('A service path contains an unsupported character.');
  if (platform === 'linux') return `[Unit]\nDescription=Arco workbench\nAfter=network.target\n\n[Service]\nType=simple\nWorkingDirectory=${systemdQuote(home)}\nExecStart=${args.map(systemdQuote).join(' ')}\nRestart=on-failure\n\n[Install]\nWantedBy=default.target\n`;
  if (platform === 'darwin') return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join('')}</array><key>WorkingDirectory</key><string>${xml(home)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><false/><key>StandardOutPath</key><string>${xml(join(home, 'service.stdout.log'))}</string><key>StandardErrorPath</key><string>${xml(join(home, 'service.stderr.log'))}</string></dict></plist>\n`;
  if (platform === 'win32') {
    if (!user || /[\r\n\0]/.test(user)) throw new Error('Cannot determine the current Windows user.');
    const quote = (s) => `"${String(s).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
    return `<?xml version="1.0" encoding="UTF-16"?><Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(user)}</UserId></LogonTrigger></Triggers><Principals><Principal id="Author"><UserId>${xml(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Enabled>true</Enabled></Settings><Actions Context="Author"><Exec><Command>${xml(windowsScriptHost(env))}</Command><Arguments>${xml(['//B', '//Nologo', ...[windowsLauncherPath(config), ...args].map(quote)].join(' '))}</Arguments><WorkingDirectory>${xml(home)}</WorkingDirectory></Exec></Actions></Task>`;
  }
  throw new Error(`Unsupported service platform: ${platform}`);
}
export function servicePaths(platform, env = process.env) {
  const home = resolve(env.ARCO_HOME?.trim() || join(homedir(), '.arco'));
  const config = join(home, 'service', 'config.json');
  const unit = platform === 'linux' ? join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user', 'arco.service') : platform === 'darwin' ? join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`) : join(home, 'service', 'task.xml');
  return { home, config, unit };
}
export function readWindowsServicePid(home) {
  const path = join(home, 'service', 'pid.json');
  try {
    const rel = relative(realpathSync.native(home), realpathSync.native(dirname(path)));
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Service process record escapes the Arco home.');
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) throw new Error('Unsafe service process record.');
    const record = JSON.parse(readFileSync(path, 'utf8'));
    if (record.version !== 1 || !Number.isSafeInteger(record.pid) || record.pid <= 0 || record.pid > 2147483647) throw new Error('Invalid service process record.');
    return record.pid;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export function writeWindowsServicePid(home, pid = process.pid) {
  const path = join(home, 'service', 'pid.json');
  readWindowsServicePid(home);
  const temporary = `${path}.${pid}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ version: 1, pid }) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
  return () => { try { if (readWindowsServicePid(home) === pid) rmSync(path, { force: true }); } catch { /* preserve an unexpected replacement */ } };
}
// Destroy pipes on timeout so a cold or stuck PowerShell process cannot keep
// the caller waiting after the deadline.
export function runWindowsProbe(command, args, { timeout = 30_000, env = process.env } = {}) {
  return new Promise((resolveResult) => {
    let child, timer, finished = false, output = '';
    const finish = (result) => { if (finished) return; finished = true; clearTimeout(timer); resolveResult(result); };
    try { child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env }); }
    catch (error) { finish({ error }); return; }
    child.stdout.on('data', (chunk) => { output += chunk.toString(); if (output.length > 4096) { child.stdout.destroy(); child.kill(); finish({ error: new Error('Process inspection output was too large.') }); } });
    child.once('error', (error) => finish({ error }));
    child.once('close', (status) => finish({ status, stdout: output }));
    timer = setTimeout(() => { child.stdout.destroy(); try { child.kill(); } catch { /* already gone */ } child.unref(); finish({ error: Object.assign(new Error('Process inspection timed out.'), { code: 'ETIMEDOUT' }) }); }, timeout);
  });
}
export async function serviceAction(action, deps = {}) {
  const platform = deps.platform ?? process.platform, env = deps.env ?? process.env;
  const paths = deps.paths ?? servicePaths(platform, env);
  const run = deps.run ?? ((cmd, args, options = {}) => spawnSync(cmd, args, { stdio: 'inherit', windowsHide: true, ...options }));
  const call = (cmd, args) => { const r = run(cmd, args); if (r.error || r.status !== 0) throw new Error(`${cmd} ${args[0]} failed${r.error ? `: ${r.error.message}` : ''}`); };
  const uid = deps.uid ?? process.getuid?.();
  const domain = env.USERDOMAIN, username = env.USERNAME;
  const user = domain && username ? `${domain}\\${username}` : username;
  const manager = async (op) => {
    if (platform === 'linux') return call('systemctl', ['--user', op, 'arco.service']);
    if (platform === 'darwin') {
      if (typeof uid !== 'number') throw new Error('Cannot determine the current user id.');
      if (op === 'start') return call('launchctl', ['kickstart', '-k', `gui/${uid}/${label}`]);
      if (op === 'stop') return call('launchctl', ['kill', 'SIGTERM', `gui/${uid}/${label}`]);
      if (op === 'status') return call('launchctl', ['print', `gui/${uid}/${label}`]);
    }
    if (platform === 'win32') {
      if (op === 'stop') {
        // Ending the task terminates only wscript.exe; node, its child, would
        // keep running and hold the port. Whatever the task state, also end every
        // wscript.exe or node.exe whose command line names this home's service
        // configuration (the launcher and service-run both do), with its tree.
        const stopArgs = ['/End', '/TN', label];
        const stopOptions = { stdio: 'pipe', encoding: 'utf8', timeout: 30000, env };
        const stopped = await (deps.run ? run('schtasks.exe', stopArgs, stopOptions) : runWindowsProbe('schtasks.exe', stopArgs, stopOptions));
        let ended = !stopped.error && stopped.status === 0;
        if (!ended) {
          const args = ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; (Get-ScheduledTask -TaskName 'arco-workbench').State.ToString()"];
          const inspect = () => deps.run ? run('powershell.exe', args, { stdio: 'pipe', encoding: 'utf8', timeout: 30000 }) : runWindowsProbe('powershell.exe', args, { timeout: 30000, env });
          let state = await inspect();
          if (state.error?.code === 'ETIMEDOUT') state = await inspect();
          ended = !state.error && state.status === 0 && /^(Ready|Disabled)$/i.test((state.stdout || '').trim());
        }
        const args = ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_END_TREE];
        const options = { stdio: 'pipe', encoding: 'utf8', timeout: 30000, env: { ...env, ARCO_SERVICE_MARK: paths.config } };
        const inspect = () => deps.run ? run('powershell.exe', args, options) : runWindowsProbe('powershell.exe', args, options);
        let tree = await inspect();
        if (tree.error?.code === 'ETIMEDOUT') tree = await inspect();
        if (tree.error || tree.status !== 0) throw new Error('Could not end the Arco service processes.');
        if (!ended) throw new Error('Could not stop the Arco scheduled task.');
        return;
      }
      return call('schtasks.exe', [({ start: '/Run', status: '/Query' })[op], '/TN', label]);
    }
    throw new Error(`Unsupported service action: ${op}`);
  };
  const hasConfig = () => {
    try {
      const stat = lstatSync(paths.config); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('Unsafe service configuration.');
      const homeReal = realpathSync.native(paths.home), parentReal = realpathSync.native(dirname(paths.config));
      const rel = relative(homeReal, parentReal);
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Service configuration escapes the Arco home.');
      const saved = JSON.parse(readFileSync(paths.config, 'utf8'));
      if (saved.version !== 1 || !saved.env || saved.env.ARCO_HOME !== paths.home || !/^[a-f0-9]{64}$/.test(saved.unitHash || '')) throw new Error('Invalid service configuration.');
      return true;
    } catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
  };
  const verifyUnit = () => {
    const stat = lstatSync(paths.unit);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('Unsafe service definition.');
    const saved = JSON.parse(readFileSync(paths.config, 'utf8'));
    if (createHash('sha256').update(readFileSync(paths.unit)).digest('hex') !== saved.unitHash) throw new Error('The service definition changed. Review it before continuing.');
  };
  if (action === 'install') {
    const owned = hasConfig();
    if (existsSync(paths.unit) && !owned) throw new Error('An existing service has no Arco package configuration. Remove it manually before installing.');
    if (!owned && platform === 'win32') {
      const existing = run('schtasks.exe', ['/Query', '/TN', label], { stdio: 'pipe', encoding: 'utf8' });
      if (existing.error || existing.status === 0) throw new Error('A service with this name already exists or cannot be checked.');
    }
    if (!owned && platform === 'darwin') {
      if (typeof uid !== 'number') throw new Error('Cannot determine the current user id.');
      const existing = run('launchctl', ['print', `gui/${uid}/${label}`], { stdio: 'pipe', encoding: 'utf8' });
      if (existing.error || existing.status === 0) throw new Error('A service with this name already exists or cannot be checked.');
    }
    if (!owned && platform === 'linux') {
      const existing = run('systemctl', ['--user', 'show', '--property=LoadState', '--value', 'arco.service'], { stdio: 'pipe', encoding: 'utf8' });
      if (existing.error || (existing.status === 0 && (existing.stdout || '').trim() === 'loaded')) throw new Error('A service with this name already exists or cannot be checked.');
    }
    mkdirSync(paths.home, { recursive: true, mode: 0o700 });
    mkdirSync(dirname(paths.config), { recursive: true, mode: 0o700 });
    const homeReal = realpathSync.native(paths.home), parentReal = realpathSync.native(dirname(paths.config));
    const rel = relative(homeReal, parentReal);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Service configuration escapes the Arco home.');
    mkdirSync(dirname(paths.unit), { recursive: true });
    const saved = owned ? JSON.parse(readFileSync(paths.config, 'utf8')) : null;
    const config = saved || { version: 1, env: Object.fromEntries(SERVICE_ENV_KEYS.filter((key) => env[key]).map((key) => [key, env[key]])) };
    config.env.ARCO_HOME = paths.home;
    const unit = renderService(platform, { node: process.execPath, entry: cli, config: paths.config, home: paths.home, user, env });
    const unitBytes = platform === 'win32' ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(unit, 'utf16le')]) : Buffer.from(unit);
    if (!owned) { config.unitHash = createHash('sha256').update(unitBytes).digest('hex'); writeFileSync(paths.config, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); }
    if (!existsSync(paths.unit)) {
      if (owned && createHash('sha256').update(unitBytes).digest('hex') !== config.unitHash) throw new Error('The prior service definition cannot be recreated automatically.');
      writeFileSync(paths.unit, unitBytes, { mode: 0o600, flag: 'wx' });
    }
    verifyUnit();
    if (platform === 'win32') writeFileSync(windowsLauncherPath(paths.config), WINDOWS_LAUNCHER, { mode: 0o600 });
    if (platform === 'linux') { call('systemctl', ['--user', 'daemon-reload']); call('systemctl', ['--user', 'enable', 'arco.service']); }
    else if (platform === 'darwin') { if (typeof uid !== 'number') throw new Error('Cannot determine the current user id.'); if (run('launchctl', ['print', `gui/${uid}/${label}`], { stdio: 'pipe' }).status !== 0) call('launchctl', ['bootstrap', `gui/${uid}`, paths.unit]); }
    else if (platform === 'win32') { if (run('schtasks.exe', ['/Query', '/TN', label], { stdio: 'pipe' }).status !== 0) call('schtasks.exe', ['/Create', '/TN', label, '/XML', paths.unit]); }
    else throw new Error('Unsupported service platform.');
  } else if (action === 'uninstall') {
    if (!hasConfig()) throw new Error('No packaged service configuration was found.');
    verifyUnit();
    if (platform === 'linux') { call('systemctl', ['--user', 'disable', '--now', 'arco.service']); rmSync(paths.unit, { force: true }); call('systemctl', ['--user', 'daemon-reload']); }
    else if (platform === 'darwin') { if (typeof uid !== 'number') throw new Error('Cannot determine the current user id.'); call('launchctl', ['bootout', `gui/${uid}`, paths.unit]); rmSync(paths.unit, { force: true }); }
    else if (platform === 'win32') { await manager('stop'); call('schtasks.exe', ['/Delete', '/TN', label, '/F']); rmSync(paths.unit, { force: true }); rmSync(windowsLauncherPath(paths.config), { force: true }); }
    else throw new Error('Unsupported service platform.');
    rmSync(paths.config, { force: true });
  } else if (!hasConfig()) throw new Error('No packaged service configuration was found.');
  else if (action === 'restart') { verifyUnit(); await manager('stop'); await manager('start'); }
  else if (['start', 'stop', 'status'].includes(action)) { verifyUnit(); await manager(action); }
  else throw new Error('Use service install, uninstall, start, stop, restart or status.');
}

// Moves an Arco-owned Windows task from an older definition (a visible console
// window) to the current one. It only acts on an unmodified definition that
// this package wrote: the stored hash must still match the file. The task is
// re-registered first from a staged copy; the file and hash change only after
// that succeeds, so a failure leaves the previous definition in place.
export async function refreshServiceDefinition(deps = {}) {
  const platform = deps.platform ?? process.platform, env = deps.env ?? process.env;
  if (platform !== 'win32') return 'Nothing to refresh on this platform.';
  const paths = deps.paths ?? servicePaths(platform, env);
  if (!existsSync(paths.config)) return 'No packaged service is installed.';
  const release = await lockfile.lock(paths.config, { retries: { retries: 50, minTimeout: 100, maxTimeout: 100 } });
  try { return await refreshLocked(paths, env, deps); }
  finally { await release(); }
}

async function refreshLocked(paths, env, deps) {
  const run = deps.run ?? ((cmd, args, options = {}) => spawnSync(cmd, args, { stdio: 'pipe', encoding: 'utf8', windowsHide: true, ...options }));
  let saved;
  try {
    const stat = lstatSync(paths.config);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('Unsafe service configuration.');
    saved = JSON.parse(readFileSync(paths.config, 'utf8'));
  } catch (error) { if (error?.code === 'ENOENT') return 'No packaged service is installed.'; throw error; }
  if (saved.version !== 1 || !saved.env || saved.env.ARCO_HOME !== paths.home || !/^[a-f0-9]{64}$/.test(saved.unitHash || '')) throw new Error('Invalid service configuration.');
  if (!existsSync(paths.unit)) return 'No service definition file to refresh.';
  const stat = lstatSync(paths.unit);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('Unsafe service definition.');
  if (createHash('sha256').update(readFileSync(paths.unit)).digest('hex') !== saved.unitHash) throw new Error('The service definition changed. Review it before continuing.');
  const domain = env.USERDOMAIN, username = env.USERNAME;
  const user = domain && username ? `${domain}\\${username}` : username;
  const text = renderService('win32', { node: deps.node ?? process.execPath, entry: deps.entry ?? cli, config: paths.config, home: paths.home, user, env });
  const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (hash === saved.unitHash) return 'The service definition is current.';
  const staged = `${paths.unit}.new`;
  writeFileSync(staged, bytes, { mode: 0o600 });
  writeFileSync(windowsLauncherPath(paths.config), WINDOWS_LAUNCHER, { mode: 0o600 });
  try {
    const created = run('schtasks.exe', ['/Create', '/TN', label, '/XML', staged, '/F']);
    if (created.error || created.status !== 0) throw new Error('Could not register the updated service definition.');
    renameSync(staged, paths.unit);
    writeFileSync(paths.config, JSON.stringify({ ...saved, unitHash: hash }, null, 2) + '\n', { mode: 0o600 });
  } finally { rmSync(staged, { force: true }); }
  return 'The service definition was updated; it takes effect the next time the service starts.';
}
