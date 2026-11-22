import { existsSync, lstatSync, readdirSync, readlinkSync } from 'node:fs';
import { lstat, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { arcoHome } from '../arcoHome.js';
import { isPreparedWorkerAccessPass, type WorkerAccessPass } from './workerAccessPass.js';

/** A command line for bubblewrap; it is not a successful isolation check. */
export interface LinuxWorkerSandboxCommand {
  file: 'bwrap';
  args: string[];
}

function contains(parent: string, child: string): boolean {
  const remainder = relative(parent, child);
  return remainder === '' || (!remainder.startsWith(`..${sep}`) && remainder !== '..' && !isAbsolute(remainder));
}

async function directory(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error('Sandbox folders must be absolute.');
  const resolved = await realpath(path);
  if (!(await stat(resolved)).isDirectory()) throw new Error('Sandbox folders must be directories.');
  return resolved;
}

async function privateControlPath(path: string, kind: 'socket' | 'file'): Promise<string> {
  if (!isAbsolute(path)) throw new Error('Sandbox control paths must be absolute.');
  const entry = await lstat(path);
  const parent = await lstat(dirname(path));
  if (entry.isSymbolicLink() || parent.isSymbolicLink() || !parent.isDirectory()
    || (kind === 'socket' ? !entry.isSocket() : !entry.isFile() || entry.nlink !== 1 || entry.size > 16 * 1024)
    || (entry.mode & 0o077) !== 0 || (parent.mode & 0o077) !== 0
    || (process.getuid && (entry.uid !== process.getuid() || parent.uid !== process.getuid()))) {
    throw new Error('Sandbox control paths must be private and owned by this account.');
  }
  return realpath(path);
}

const ID_MAP_HELPERS = new Set(['newuidmap', 'newgidmap']);

/**
 * Mount one system path for a fence without the ID-map helpers. A top-level
 * link such as /bin -> usr/bin stays a link, so the helpers cannot reappear
 * through it. A binary folder that holds a helper becomes a tmpfs with one
 * read-only bind per remaining entry: links into the folder would resolve
 * outside the system paths some providers accept. Dangling links are skipped
 * because bubblewrap cannot bind them.
 */
export function hiddenHelperMount(path: string): string[] {
  const entry = lstatSync(path);
  if (entry.isSymbolicLink()) {
    const target = readlinkSync(path);
    if (!/^[a-zA-Z0-9._/-]+$/.test(target)) throw new Error('Unsupported system path link.');
    return ['--symlink', target, path];
  }
  const args = ['--ro-bind', path, path];
  for (const folder of [`${path}/bin`, `${path}/sbin`]) {
    if (!existsSync(folder) || lstatSync(folder).isSymbolicLink()) continue;
    const names = readdirSync(folder);
    if (!names.some((name) => ID_MAP_HELPERS.has(name))) continue;
    args.push('--tmpfs', folder);
    for (const name of names.sort()) {
      const source = `${folder}/${name}`;
      if (ID_MAP_HELPERS.has(name) || !existsSync(source)) continue;
      args.push('--ro-bind', source, source);
    }
  }
  return args;
}

/**
 * Build the minimal Linux process fence. This does not start a worker and
 * must not be used as an isolation claim: the network and tool bridges and
 * the fail-closed self-check must be installed before it is used for a turn.
 */
export async function linuxWorkerSandboxCommand(options: {
  workspace: string;
  privateHome: string;
  executable: string;
  args: readonly string[];
  /** Exact provider runtime paths selected by trusted provider discovery. */
  runtimeMounts?: readonly { source: string; target: string }[];
  /** Private paths created by the sandbox's own proxy, mail bridge and preflight. */
  controlMounts?: { webSocket: string; mailSocket: string; configFile: string; hostsFile: string };
  proxyUrl?: string;
  /** Private access-only pass prepared by the server, never the real sign-in. */
  accessPass?: WorkerAccessPass;
  /**
   * Present system binary folders without the setuid ID-map helpers. A
   * provider's own nested sandbox then maps its namespace directly; the
   * helpers cannot work inside this fence and their failure path is fatal.
   */
  hideIdMapHelpers?: boolean;
}): Promise<LinuxWorkerSandboxCommand> {
  options = { ...options, args: [...options.args], runtimeMounts: options.runtimeMounts?.map((mount) => ({ ...mount })), controlMounts: options.controlMounts ? { ...options.controlMounts } : undefined };
  if (process.platform !== 'linux') throw new Error('Linux worker sandbox is unavailable on this platform.');
  const [workspace, home] = await Promise.all([directory(options.workspace), directory(options.privateHome)]);
  if (contains(workspace, home) || contains(home, workspace)) throw new Error('The sandbox home and workspace must be separate.');
  if (contains(workspace, homedir()) || contains(home, homedir())) throw new Error('A sandbox folder cannot include the operator home.');
  if (workspace === '/' || home === '/' || workspace === '/tmp' || home === '/tmp') throw new Error('A system directory cannot be a sandbox workspace or home.');
  for (const reserved of ['/usr', '/etc', '/proc', '/dev', '/sys', '/run']) {
    if (contains(reserved, workspace) || contains(reserved, home)) throw new Error('A system directory cannot be a sandbox workspace or home.');
  }
  const protectedPaths = await Promise.all([arcoHome(), process.env.CODEX_HOME ?? join(homedir(), '.codex'), process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'cursor'), join(homedir(), '.cursor')].map(async (path) => {
    try { return await realpath(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return resolve(path); throw error; }
  }));
  const mounts: Array<{ source: string; target: string }> = [];
  for (const mount of options.runtimeMounts ?? []) {
    if (!isAbsolute(mount.source) || !mount.target.startsWith('/opt/arco-runtime/') || normalize(mount.target) !== mount.target
      || mount.target.split('/').some((part) => part === '.' || part === '..') || !/^\/[a-zA-Z0-9._@/-]+$/.test(mount.target)) throw new Error('Invalid provider runtime mount.');
    const source = await realpath(mount.source);
    const entry = await stat(source);
    if ((!entry.isFile() && !entry.isDirectory()) || contains(source, homedir())
      || ['/etc', '/proc', '/dev', '/sys', '/run', '/var'].some((path) => contains(path, source) || contains(source, path))
      || [workspace, home].some((path) => contains(path, source) || contains(source, path))
      || protectedPaths.some((path) => contains(path, source) || contains(source, path))
      || mounts.some((existing) => contains(existing.target, mount.target) || contains(mount.target, existing.target))) {
      throw new Error('Provider runtime mount is not isolated.');
    }
    mounts.push({ source, target: mount.target });
  }
  const systemExecutable = options.executable.startsWith('/usr/');
  const runtimeExecutable = mounts.some((mount) => contains(mount.target, options.executable));
  if ((!systemExecutable && !runtimeExecutable) || normalize(options.executable) !== options.executable || options.executable.includes('\0') || options.args.some((arg) => arg.includes('\0'))) {
    throw new Error('The sandbox command must use a mounted absolute executable.');
  }
  const runtimeDirectories = new Set<string>(['/opt', '/opt/arco-runtime']);
  for (const mount of mounts) {
    for (let parent = dirname(mount.target); parent.startsWith('/opt/arco-runtime/'); parent = dirname(parent)) runtimeDirectories.add(parent);
  }
  const systemMounts = ['/usr', '/bin', '/lib', '/lib64'].filter(existsSync).flatMap((path) => options.hideIdMapHelpers ? hiddenHelperMount(path) : ['--ro-bind', path, path]);
  if (!existsSync('/usr') || !existsSync('/bin')) throw new Error('Required sandbox runtime is unavailable.');
  systemMounts.push('--dir', '/etc');
  if (existsSync('/etc/ssl/certs')) systemMounts.push('--dir', '/etc/ssl', '--ro-bind', '/etc/ssl/certs', '/etc/ssl/certs');
  // Some Linux distributions link the standard CA bundle into /etc/pki.
  // Mount the bundle file only, so certificate verification can follow that link.
  if (existsSync('/etc/pki/tls/certs/ca-bundle.crt')) {
    systemMounts.push('--dir', '/etc/pki', '--dir', '/etc/pki/tls', '--dir', '/etc/pki/tls/certs',
      '--ro-bind', '/etc/pki/tls/certs/ca-bundle.crt', '/etc/pki/tls/certs/ca-bundle.crt');
  }
  const controls: string[] = [];
  if (options.controlMounts || options.accessPass) controls.push('--dir', '/run');
  if (options.accessPass) {
    if (!isPreparedWorkerAccessPass(options.accessPass)) throw new Error('Worker access pass was not prepared by the server.');
    const pass = await privateControlPath(options.accessPass.path, 'file');
    if (options.accessPass.directory) {
      const entry = await lstat(options.accessPass.directory);
      const directory = await realpath(options.accessPass.directory);
      if (!entry.isDirectory() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0
        || (process.getuid && entry.uid !== process.getuid()) || pass !== join(directory, 'access.json')) throw new Error('Worker access pass directory is not private.');
      controls.push('--ro-bind', directory, '/run/arco-pass');
    } else controls.push('--ro-bind', pass, '/run/arco-access.json');
  }
  if (options.controlMounts) {
    const [web, mail, config, hosts] = await Promise.all([
      privateControlPath(options.controlMounts.webSocket, 'socket'),
      privateControlPath(options.controlMounts.mailSocket, 'socket'),
      privateControlPath(options.controlMounts.configFile, 'file'),
      privateControlPath(options.controlMounts.hostsFile, 'file'),
    ]);
    if (web === mail) throw new Error('Sandbox web and mail sockets must be separate.');
    controls.push('--ro-bind', web, '/run/arco-web.sock', '--ro-bind', mail, '/run/arco-mail.sock', '--ro-bind', config, '/run/arco-check.json', '--ro-bind', hosts, '/etc/hosts');
  }
  if (options.proxyUrl) {
    const proxy = new URL(options.proxyUrl);
    const loopback = [127, 0, 0, 1].join('.');
    if (!options.controlMounts || proxy.protocol !== 'http:' || proxy.hostname !== loopback || !proxy.port || proxy.username || proxy.password || proxy.pathname !== '/' || proxy.search || proxy.hash) {
      throw new Error('Invalid worker proxy endpoint.');
    }
    for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) controls.push('--setenv', name, options.proxyUrl);
    for (const name of ['NO_PROXY', 'no_proxy']) controls.push('--setenv', name, `localhost,${loopback}`);
  }
  return {
    file: 'bwrap',
    args: [
      '--unshare-user', '--unshare-pid', '--unshare-net', '--unshare-ipc', '--unshare-uts',
      '--die-with-parent', '--new-session', '--clearenv',
      ...systemMounts,
      '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
      '--dir', '/work', '--bind', workspace, '/work',
      '--dir', '/home', '--bind', home, '/home/worker',
      ...controls,
      ...[...runtimeDirectories].sort((a, b) => a.length - b.length).flatMap((path) => ['--dir', path]),
      ...mounts.flatMap(({ source, target }) => ['--ro-bind', source, target]),
      '--setenv', 'HOME', '/home/worker', '--setenv', 'PATH', '/usr/local/bin:/usr/bin:/bin',
      '--chdir', '/work', '--', options.executable, ...options.args,
    ],
  };
}
