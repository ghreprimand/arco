import { randomBytes, randomInt } from 'node:crypto';
import { access, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join, normalize, relative, sep } from 'node:path';
import { linuxWorkerSandboxCommand, type LinuxWorkerSandboxCommand } from './linuxWorkerSandbox.js';
import type { WorkerAccessPass } from './workerAccessPass.js';

// Runs inside the very same namespace that subsequently execs the provider.
// It must not write to stdout, which may be the provider's protocol stream.
const PROBE = String.raw`
const fs = require('node:fs'), net = require('node:net'), http = require('node:http'), crypto = require('node:crypto');
const dns = require('node:dns').promises;
const c = JSON.parse(fs.readFileSync('/run/arco-check.json', 'utf8'));
const loopback = [127, 0, 0, 1].join('.');
const deadline = setTimeout(() => { console.error('Worker isolation check timed out.'); process.exit(1); }, 15000);
async function blocked(port) {
  return await new Promise(resolve => {
    const s = net.connect({host:loopback, port});
    s.setTimeout(1000, () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(true));
    s.once('connect', () => { s.destroy(); resolve(false); });
  });
}
async function request(port, options, body) {
  let last;
  for (let i = 0; i < 40; i++) {
    try {
      return await new Promise((resolve, reject) => {
        const r = http.request({host:loopback, port, ...options, timeout:3000}, response => {
          let data = '';
          response.setEncoding('utf8');
          response.on('data', chunk => { data += chunk; if (data.length > 16384) r.destroy(new Error('oversize')); });
          response.on('end', () => resolve({status:response.statusCode, data}));
        });
        r.once('timeout', () => r.destroy(new Error('timeout')));
        r.once('error', reject); r.end(body);
      });
    } catch (error) { last = error; await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  throw last;
}
async function tunnel(port, host) {
  return await new Promise((resolve, reject) => {
    const r = http.request({host:loopback, port, method:'CONNECT', path:host+':443', timeout:3000});
    r.once('connect', (response, socket) => { socket.destroy(); resolve(response.statusCode); });
    r.once('timeout', () => r.destroy(new Error('timeout'))); r.once('error', reject); r.end();
  });
}
async function main() {
  const homeEntries = fs.readdirSync('/home');
  if (homeEntries.length !== 1 || homeEntries[0] !== 'worker') throw new Error('home scope did not match');
  for (const path of ['/root', '/srv', '/mnt', '/media', '/var']) if (fs.existsSync(path)) throw new Error('unexpected host root');
  const local = await dns.lookup('localhost', {all:true});
  if (!local.length || local.some(entry => entry.address !== loopback && entry.address !== ['', '', '1'].join(':'))) throw new Error('localhost did not resolve locally');
  for (const path of c.hiddenCanaries) {
    try { fs.readFileSync(path); throw new Error('foreign file was readable'); }
    catch (error) { if (!['ENOENT','EACCES','EPERM','ENOTDIR'].includes(error.code)) throw error; }
  }
  for (const path of c.hiddenDirectories) {
    try { fs.readdirSync(path); throw new Error('foreign directory was readable'); }
    catch (error) { if (!['ENOENT','EACCES','EPERM','ENOTDIR'].includes(error.code)) throw error; }
  }
  if ((await Promise.all(c.hostPorts.map(blocked))).some(value => !value)) throw new Error('host service was reachable');
  const path = '/work/.arco-check-' + crypto.randomBytes(12).toString('hex');
  const fd = fs.openSync(path, 'wx', 0o600); fs.closeSync(fd); fs.unlinkSync(path);
  const web = await request(c.webPort, {method:'GET', path:'http://example.com/', headers:{Host:'example.com', Connection:'close'}});
  if (c.webAccess ? web.status !== 200 : web.status !== 403) throw new Error('web policy did not match');
  if (!c.webAccess && await tunnel(c.webPort, c.providerProbeHost) !== 200) throw new Error('provider route unavailable');
  const rpc = JSON.stringify({jsonrpc:'2.0', id:1, method:'tools/list', params:{}});
  const mail = await request(c.mailPort, {method:'POST', path:'/mcp/'+c.mailToken, headers:{'Content-Type':'application/json', Accept:'application/json, text/event-stream', Connection:'close'}}, rpc);
  if (mail.status !== 200) throw new Error('mail bridge unavailable');
  const names = JSON.parse(mail.data).result.tools.map(tool => tool.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(['peer_read','peer_send'])) throw new Error('mail scope did not match');
  if (c.nestedHelper) nested(c.nestedHelper);
}
// The provider's own sandbox must start inside this fence and must deny a read
// outside the workspace that this fence still allows. The helper deletes its
// policy file after reading it, so each run gets a fresh copy.
function nested(helper) {
  const { spawnSync } = require('node:child_process');
  const policy = JSON.stringify({sandbox:{type:'workspace_readwrite', cwd:'/work', readBoundary:'workspace',
    hardcodedReadPaths:['/usr','/bin','/lib','/lib64','/etc','/opt/arco-runtime'], networkAccess:false, ignoreMapping:{},
    additionalReadwritePaths:[], disableTmpWrite:false}});
  const run = (command) => {
    const file = '/tmp/.arco-nested-' + crypto.randomBytes(12).toString('hex');
    fs.writeFileSync(file, policy, {mode:0o600, flag:'wx'});
    try { return spawnSync(helper, ['--policy', file, ...command], {stdio:'ignore', timeout:10000, env:{PATH:'/usr/bin:/bin'}}).status; }
    finally { fs.rmSync(file, {force:true}); }
  };
  if (run(['--preflight-only', '--', '/bin/true']) !== 0) throw new Error('nested sandbox unavailable');
  if (run(['--', '/usr/bin/ls', '/work']) !== 0) throw new Error('nested sandbox did not run');
  if (run(['--', '/usr/bin/cat', '/run/arco-check.json']) === 0 || run(['--', '/usr/bin/ls', '/home/worker']) === 0) throw new Error('nested sandbox did not deny a read');
}
main().then(() => { clearTimeout(deadline); }, () => { clearTimeout(deadline); console.error('Worker isolation self-check failed.'); process.exitCode = 1; });
`;

const WRAPPER = String.raw`
set -eu
web="$1"; mail="$2"; node="$3"; probe="$4"; loopback="$5"; socat="$6"; shift 6
"$socat" "TCP-LISTEN:$web,bind=$loopback,reuseaddr,fork,max-children=32" UNIX-CONNECT:/run/arco-web.sock </dev/null >/dev/null 2>&1 &
"$socat" "TCP-LISTEN:$mail,bind=$loopback,reuseaddr,fork,max-children=16" UNIX-CONNECT:/run/arco-mail.sock </dev/null >/dev/null 2>&1 &
"$node" -e "$probe"
exec "$@"
`;

export interface CheckedLinuxWorker {
  command: LinuxWorkerSandboxCommand;
  /** HTTP endpoint reachable only inside this worker's network namespace. */
  mailUrl: string;
  /** Call only after the provider process has exited. */
  close(): Promise<void>;
}

/** Prepare a fail-closed same-namespace probe and provider command. */
export async function prepareCheckedLinuxWorker(options: {
  workspace: string;
  privateHome: string;
  executable: string;
  args: (mailUrl: string, bridge: { webProxyPort: number }) => readonly string[];
  runtimeMounts?: readonly { source: string; target: string }[];
  accessPass?: WorkerAccessPass;
  /** Host directories that must not be readable through their real paths. */
  hiddenDirectories?: readonly string[];
  webSocket: string;
  mailSocket: string;
  mailToken: string;
  webAccess: boolean;
  /** Required when web is off, to check that the provider route still works. */
  providerProbeHost?: string;
  arcoPort: number;
  /**
   * The provider's own sandbox helper inside a mounted runtime. When set, the
   * fence hides the ID-map helpers and the self-check proves that the nested
   * sandbox starts and denies a read outside the workspace.
   */
  nestedSandboxHelper?: string;
}): Promise<CheckedLinuxWorker> {
  options = { ...options, runtimeMounts: options.runtimeMounts?.map((mount) => ({ ...mount })), hiddenDirectories: options.hiddenDirectories ? [...options.hiddenDirectories] : [] };
  if (!/^[a-f0-9]{64}$/.test(options.mailToken) || !Number.isInteger(options.arcoPort) || options.arcoPort < 1 || options.arcoPort > 65535) {
    throw new Error('Invalid worker self-check configuration.');
  }
  if (options.hiddenDirectories!.some(path => typeof path !== 'string' || !isAbsolute(path) || path.includes('\0'))) throw new Error('Invalid hidden directory.');
  if (!options.webAccess && (typeof options.providerProbeHost !== 'string' || !/^[a-zA-Z0-9.-]{1,253}$/.test(options.providerProbeHost))) {
    throw new Error('A provider host is required when web access is off.');
  }
  const inRuntime = options.runtimeMounts?.some(({ target }) => {
    const suffix = relative(target, options.executable);
    return suffix === '' || (suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
  });
  if ((!options.executable.startsWith('/usr/') && !inRuntime) || normalize(options.executable) !== options.executable) {
    throw new Error('The provider executable must be in a mounted runtime.');
  }
  if (options.nestedSandboxHelper !== undefined && (normalize(options.nestedSandboxHelper) !== options.nestedSandboxHelper
    || !options.runtimeMounts?.some(({ target }) => target === options.nestedSandboxHelper))) {
    throw new Error('The nested sandbox helper must be in a mounted runtime.');
  }
  const node = await realpath(process.execPath);
  if (!node.startsWith('/usr/')) throw new Error('Worker isolation requires a mounted Node runtime.');
  let socat: string | undefined;
  for (const candidate of ['/usr/bin/socat', '/usr/local/bin/socat']) {
    try {
      const resolved = await realpath(candidate);
      if (!resolved.startsWith('/usr/')) continue;
      await access(resolved, constants.X_OK); socat = resolved; break;
    } catch { /* Try the next system runtime path. */ }
  }
  if (!socat) throw new Error('Worker isolation requires socat.');
  const root = await mkdtemp(join(tmpdir(), 'arco-worker-check-'));
  const canary = join(root, 'foreign-canary');
  const config = join(root, 'check.json');
  const hosts = join(root, 'hosts');
  const listener = createServer(socket => socket.destroy());
  const loopback = [127, 0, 0, 1].join('.');
  try {
    await writeFile(canary, randomBytes(32), { mode: 0o600, flag: 'wx' });
    await writeFile(hosts, `${loopback} localhost\n${['', '', '1'].join(':')} localhost\n`, { mode: 0o600, flag: 'wx' });
    await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, loopback, resolve); });
    const fixture = listener.address();
    if (!fixture || typeof fixture === 'string') throw new Error('Cannot start a worker isolation fixture.');
    let webPort = randomInt(20000, 60000), mailPort = randomInt(20000, 60000);
    while ([options.arcoPort, fixture.port, webPort].includes(mailPort)) mailPort = randomInt(20000, 60000);
    while ([options.arcoPort, fixture.port, mailPort].includes(webPort)) webPort = randomInt(20000, 60000);
    const mailUrl = `http://${loopback}:${mailPort}/mcp/${options.mailToken}`;
    await writeFile(config, JSON.stringify({ hiddenCanaries: [canary], hiddenDirectories: options.hiddenDirectories, hostPorts: [options.arcoPort, fixture.port], webPort, mailPort, webAccess: options.webAccess === true, providerProbeHost: options.providerProbeHost, mailToken: options.mailToken, nestedHelper: options.nestedSandboxHelper }), { mode: 0o600, flag: 'wx' });
    const proxy = `http://${loopback}:${webPort}`;
    const command = await linuxWorkerSandboxCommand({
      workspace: options.workspace,
      privateHome: options.privateHome,
      executable: '/usr/bin/sh',
      runtimeMounts: options.runtimeMounts,
      accessPass: options.accessPass,
      hideIdMapHelpers: options.nestedSandboxHelper !== undefined,
      controlMounts: { webSocket: options.webSocket, mailSocket: options.mailSocket, configFile: config, hostsFile: hosts },
      proxyUrl: proxy,
      args: ['-c', WRAPPER, 'arco-worker', String(webPort), String(mailPort), node, PROBE, loopback, socat, options.executable, ...options.args(mailUrl, { webProxyPort: webPort })],
    });
    return {
      command,
      mailUrl,
      close: async () => {
        if (listener.listening) await new Promise<void>((resolve) => listener.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (listener.listening) await new Promise<void>((resolve) => listener.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
