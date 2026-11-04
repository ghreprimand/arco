import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { arcoHome } from './arcoHome.js';
import { updateChecker } from './server/updateCheck.js';
import { APP_VERSION } from './appVersion.js';

export type UpdateMode = 'service' | 'foreground' | 'docker';
export function updateMode(platform = process.platform, env: NodeJS.ProcessEnv = process.env): UpdateMode {
  if (env.ARCO_DEPLOYMENT === 'docker') return 'docker';
  if (env.ARCO_PACKAGED === '1' && env.ARCO_PACKAGE_SERVICE === '1') return 'service';
  return platform === 'linux' && !!(env.INVOCATION_ID || env.SYSTEMD_EXEC_PID) ? 'service' : 'foreground';
}
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
type Status = { outcome: string; message?: string; startedAt?: number; finishedAt?: number; attemptId?: string; fromVersion?: string; target?: string; reportedAt?: number };
export function createUpdateManager(deps: {
  mode?: () => UpdateMode; home?: () => string; root?: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform;
  check?: () => Promise<{ latest: string | null; updateAvailable: boolean }>;
  launch?: (command: string, args: string[]) => { status: number | null; error?: Error; stderr?: string | null };
  now?: () => number; version?: string;
} = {}) {
  const mode = deps.mode ?? (() => updateMode());
  const home = deps.home ?? arcoHome;
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const packaged = env.ARCO_PACKAGED === '1';
  const check = deps.check ?? (() => updateChecker.check());
  const launch = deps.launch ?? ((command, args) => spawnSync(command, args, { encoding: 'utf8', timeout: 15_000 }));
  const now = deps.now ?? Date.now;
  const version = deps.version ?? APP_VERSION;
  const resultPath = () => join(home(), 'update-result.json');
  function read(): Status | null { try { const x = JSON.parse(readFileSync(resultPath(), 'utf8')); return x && typeof x.outcome === 'string' ? x : null; } catch { return null; } }
  function status() {
    const result = read();
    if (!result?.attemptId || !Number.isFinite(result.startedAt) || !result.fromVersion || !/^v\d+\.\d+\.\d+$/.test(result.target ?? '')) return { mode: mode(), platform, packaged, result: null };
    if (result.outcome === 'running') return { mode: mode(), platform, packaged, result: now() - result.startedAt! < 30 * 60_000 && now() >= result.startedAt! ? result : null };
    if (!['updated', 'failed', 'unchanged'].includes(result.outcome) || !Number.isFinite(result.finishedAt) || result.finishedAt! < result.startedAt! || result.finishedAt! > now()) return { mode: mode(), platform, packaged, result: null };
    const successOnTarget = result.outcome === 'updated' && result.target === `v${version.replace(/^v/, '')}`;
    const recent = now() - result.finishedAt! <= 15 * 60_000;
    if (successOnTarget) {
      if (result.reportedAt && result.reportedAt <= now() && now() - result.reportedAt <= 15 * 60_000) return { mode: mode(), platform, packaged, result };
      if (!result.reportedAt) {
        try { writeFileSync(resultPath(), JSON.stringify({ ...result, reportedAt: now() }), { mode: 0o600 }); return { mode: mode(), platform, packaged, result }; } catch { /* do not repeat a result that cannot be marked */ }
      }
      return { mode: mode(), platform, packaged, result: null };
    }
    if (recent && result.fromVersion === version) return { mode: mode(), platform, packaged, result };
    return { mode: mode(), platform, packaged, result: null };
  }
  let starting = false;
  async function start(body: unknown) {
    if (mode() !== 'service') return { ok: false, status: 409, error: 'Use the update command for this run mode.' };
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => key !== 'expectedLatest') || typeof (body as { expectedLatest?: unknown }).expectedLatest !== 'string') return { ok: false, status: 400, error: 'Confirm the displayed release; update accepts no target.' };
    if (starting) return { ok: false, status: 409, error: 'An update is already starting.' };
    starting = true;
    try {
    const previous = read();
    if (previous?.outcome === 'running' && now() - (previous.startedAt ?? 0) < 30 * 60_000) return { ok: false, status: 409, error: 'An update is already running.' };
    let latest;
    try { latest = await check(); } catch { return { ok: false, status: 503, error: 'Release check unavailable. Try again or use npm run arco:update.' }; }
    if (!latest.updateAvailable || !latest.latest || !/^v\d+\.\d+\.\d+$/.test(latest.latest)) return { ok: false, status: 409, error: 'No newer stable release is available.' };
    if ((body as { expectedLatest: string }).expectedLatest !== latest.latest) return { ok: false, status: 409, error: 'The latest release changed. Review the new release before updating.' };
    const attempt = { attemptId: randomUUID(), startedAt: now(), fromVersion: version, target: latest.latest };
    if (packaged) {
      const resultFile = resultPath(); mkdirSync(home(), { recursive: true, mode: 0o700 });
      writeFileSync(resultFile, JSON.stringify({ ...attempt, outcome: 'running' }), { mode: 0o600 });
      const repo = deps.root ?? repoRoot;
      const task = `arco-updater-${randomUUID()}`;
      const cli = join(repo, 'scripts', 'packaging', 'arco.mjs');
      const updateArgs = [cli, 'package-update', latest.latest, resultFile, task, attempt.attemptId];
      let result: { status: number | null; error?: Error; stderr?: string | null };
      if (platform === 'linux') {
        if ([repo, resultFile, home(), process.execPath].some((value) => value.includes('$'))) {
          const message = 'Run arco update from a terminal.';
          writeFileSync(resultFile, JSON.stringify({ ...attempt, outcome: 'failed', message, finishedAt: now() }), { mode: 0o600 });
          return { ok: false, status: 503, error: message };
        }
        result = launch('systemd-run', ['--user', '--collect', '--no-ask-password', '--service-type=exec', '--quiet', `--unit=${task}`, `--working-directory=${home()}`, `--setenv=ARCO_HOME=${home()}`, ...(env.PATH ? [`--setenv=PATH=${env.PATH}`] : []), process.execPath, ...updateArgs]);
      } else if (platform === 'darwin') {
        result = launch('launchctl', ['submit', '-l', task, '--', process.execPath, ...updateArgs]);
      } else if (platform === 'win32') {
        const user = env.USERDOMAIN && env.USERNAME ? `${env.USERDOMAIN}\\${env.USERNAME}` : env.USERNAME;
        if (!user || [user, repo, resultFile, process.execPath].some((value) => /[\r\n\0]/.test(value))) {
          const message = 'Run arco update from a terminal.';
          writeFileSync(resultFile, JSON.stringify({ ...attempt, outcome: 'failed', message, finishedAt: now() }), { mode: 0o600 });
          return { ok: false, status: 503, error: message };
        }
        const escape = (x: string) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
        const quote = (x: string) => `"${x.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
        const xml = `<?xml version="1.0" encoding="UTF-16"?><Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Triggers/><Principals><Principal id="Author"><UserId>${escape(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Enabled>true</Enabled></Settings><Actions Context="Author"><Exec><Command>${escape(process.execPath)}</Command><Arguments>${escape(updateArgs.map(quote).join(' '))}</Arguments><WorkingDirectory>${escape(home())}</WorkingDirectory></Exec></Actions></Task>`;
        const xmlPath = join(home(), `${task}.xml`);
        writeFileSync(xmlPath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]), { mode: 0o600 });
        result = launch('schtasks.exe', ['/Create', '/TN', task, '/XML', xmlPath]);
        if (!result.error && result.status === 0) {
          result = launch('schtasks.exe', ['/Run', '/TN', task]);
          if (result.error || result.status !== 0) { launch('schtasks.exe', ['/Delete', '/TN', task, '/F']); rmSync(xmlPath, { force: true }); }
        } else rmSync(xmlPath, { force: true });
      } else result = { status: 1 };
      if (result.error || result.status !== 0) {
        const message = 'Could not start a separate updater. Run arco update from a terminal.';
        writeFileSync(resultFile, JSON.stringify({ ...attempt, outcome: 'failed', message, finishedAt: now() }), { mode: 0o600 });
        return { ok: false, status: 503, error: message };
      }
      return { ok: true, status: 202, latest: latest.latest, attemptId: attempt.attemptId };
    }
    const unit = env.ARCO_SYSTEMD_UNIT || 'arco.service';
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.@-]*\.service$/.test(unit)) return { ok: false, status: 409, error: 'The service unit name is invalid.' };
    const resultFile = resultPath(); mkdirSync(home(), { recursive: true, mode: 0o700 });
    writeFileSync(resultFile, JSON.stringify({ ...attempt, outcome: 'running' }), { mode: 0o600 });
    const repo = deps.root ?? repoRoot;
    if ([repo, resultFile, home(), process.execPath].some((value) => value.includes('$'))) {
      const message = 'The checkout or home path cannot be passed safely to the service. Run npm run arco:update from a terminal.';
      writeFileSync(resultFile, JSON.stringify({ ...attempt, outcome: 'failed', message, finishedAt: now() }), { mode: 0o600 });
      return { ok: false, status: 503, error: message };
    }
    const args = ['--user', '--collect', '--no-ask-password', '--service-type=exec', '--quiet', `--unit=arco-updater-${randomUUID()}`, `--working-directory=${repo}`,
      `--setenv=ARCO_HOME=${home()}`, `--setenv=ARCO_SYSTEMD_UNIT=${unit}`, ...(env.PATH ? [`--setenv=PATH=${env.PATH}`] : []), ...(env.ARCO_PORT ? [`--setenv=ARCO_PORT=${env.ARCO_PORT}`] : []),
      process.execPath, join(repo, 'scripts', 'arco-update.mjs'), '--yes', '--require-service', '--expected-release', latest.latest, '--result-file', resultFile, '--attempt-id', attempt.attemptId];
    const result = launch('systemd-run', args);
    if (result.error || result.status !== 0) {
      const message = 'Could not start a separate updater. Run npm run arco:update from a terminal.';
      writeFileSync(resultFile, JSON.stringify({ ...attempt, outcome: 'failed', message, finishedAt: now() }), { mode: 0o600 });
      return { ok: false, status: 503, error: message };
    }
    return { ok: true, status: 202, latest: latest.latest, attemptId: attempt.attemptId };
    } finally { starting = false; }
  }
  function restart() {
    if (!packaged || mode() !== 'service' || !['darwin', 'win32'].includes(platform)) return { ok: false, status: 409, error: 'Use the service restart command.' };
    const repo = deps.root ?? repoRoot, task = `arco-updater-${randomUUID()}`;
    const cli = join(repo, 'scripts', 'packaging', 'arco.mjs');
    const args = [cli, 'package-restart', home(), task];
    let result: { status: number | null; error?: Error; stderr?: string | null };
    if (platform === 'darwin') result = launch('launchctl', ['submit', '-l', task, '--', process.execPath, ...args]);
    else {
      const user = env.USERDOMAIN && env.USERNAME ? `${env.USERDOMAIN}\\${env.USERNAME}` : env.USERNAME;
      if (!user || [user, repo, home(), process.execPath].some((value) => /[\r\n\0]/.test(value))) return { ok: false, status: 503, error: 'Run arco service restart from a terminal.' };
      const escape = (x: string) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
      const quote = (x: string) => `"${x.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
      const xml = `<?xml version="1.0" encoding="UTF-16"?><Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Triggers/><Principals><Principal id="Author"><UserId>${escape(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Enabled>true</Enabled></Settings><Actions Context="Author"><Exec><Command>${escape(process.execPath)}</Command><Arguments>${escape(args.map(quote).join(' '))}</Arguments><WorkingDirectory>${escape(home())}</WorkingDirectory></Exec></Actions></Task>`;
      mkdirSync(home(), { recursive: true, mode: 0o700 });
      const xmlPath = join(home(), `${task}.xml`);
      writeFileSync(xmlPath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]), { mode: 0o600 });
      result = launch('schtasks.exe', ['/Create', '/TN', task, '/XML', xmlPath]);
      if (!result.error && result.status === 0) {
        result = launch('schtasks.exe', ['/Run', '/TN', task]);
        if (result.error || result.status !== 0) { launch('schtasks.exe', ['/Delete', '/TN', task, '/F']); rmSync(xmlPath, { force: true }); }
      } else rmSync(xmlPath, { force: true });
    }
    return result.error || result.status !== 0 ? { ok: false, status: 503, error: 'Run arco service restart from a terminal.' } : { ok: true, status: 202 };
  }
  return { status, start, restart };
}
export const updateManager = createUpdateManager();
