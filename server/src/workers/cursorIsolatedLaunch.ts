import { writeFileSync } from 'node:fs';
import { lstat, mkdir, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import * as clusterStore from '../clusterStore.js';
import { startWorkerMailBridge } from '../mcp/workerMailBridge.js';
import { prepareCheckedLinuxWorker } from './checkedLinuxWorker.js';
import { prepareIsolatedCliHome } from './isolatedCliHome.js';
import { discoverProviderRuntime, type ProviderRuntime } from './providerRuntimeDiscovery.js';
import { prepareWorkerAccessPass } from './workerAccessPass.js';
import { startWorkerWebProxy } from './workerWebProxy.js';
import { workerHiddenDirectories } from './workerHiddenDirectories.js';
import { makeWorkerSocketDirectory } from './workerSocketDirectory.js';

// Cursor's agent streams from regional hosts under cursor.sh; with web access
// off only Cursor's own hosts stay reachable. A leading dot allows subdomains.
export const CURSOR_PROVIDER_HOSTS = ['api2.cursor.sh', '.cursor.sh'];
const PROBE_HOST = 'api2.cursor.sh';
const HELPER = '/opt/arco-runtime/cursor/cursorsandbox';
const WORKER_HOME = ['', 'home', 'worker'].join('/');
const PASS_PATH = ['', 'run', 'arco-pass', 'access.json'].join('/');

export function cursorSandboxHelper(runtime: ProviderRuntime): string {
  if (!runtime.mounts.some(mount => mount.target === HELPER)) throw new Error('Cursor sandbox helper is missing.');
  return HELPER;
}

/**
 * Cursor's own settings for a fenced member, written to its private
 * CURSOR_CONFIG_DIR before every turn. The sandbox keeps the shell's writes
 * inside the workspace. Cursor honours the workspace read boundary only when
 * a server-side feature flag is on, so the sign-in is withdrawn after start
 * instead of relying on it. Print mode cannot ask for approval: anything not
 * allowed here is rejected. Cursor's web search runs on Cursor's servers and
 * would bypass Arco's web filter, so it is accepted only while web access is
 * on. Cursor's web fetch stays denied; pages are fetched with the shell,
 * through the filter.
 */
export function cursorIsolatedCliConfig(webAccess: boolean): string {
  return JSON.stringify({
    version: 1,
    approvalMode: 'allowlist',
    autoAcceptWebSearch: webAccess === true,
    sandbox: { mode: 'enabled', readBoundary: 'workspace', networkAccess: 'enabled' },
    permissions: { allow: ['Mcp(arco-cluster:peer_read)', 'Mcp(arco-cluster:peer_send)'], deny: ['WebFetch(*)'] },
  });
}

async function privateDirectory(path: string): Promise<void> {
  try { await mkdir(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0
    || (process.getuid && entry.uid !== process.getuid())) throw new Error('Cursor configuration home is not private.');
}

async function replaceFile(path: string, content: string): Promise<void> {
  try { if ((await lstat(path)).isSymbolicLink()) throw new Error('Cursor configuration home contains an unexpected link.'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const temporary = `${path}.${randomUUID()}`;
  try { await writeFile(temporary, content, { mode: 0o600, flag: 'wx' }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}

/** Only these Cursor arguments may reach the fenced agent; the launcher adds the rest. */
export function checkedCursorIsolationArgs(args: readonly unknown[]): string[] {
  const switches = new Set(['--stream-partial-output']);
  const valued = new Set(['--model', '--resume']);
  const seen = new Set<string>();
  const checked: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (typeof flag !== 'string' || seen.has(flag) || (!switches.has(flag) && !valued.has(flag))) throw new Error('Cursor isolation arguments conflict with the worker fence.');
    seen.add(flag);
    checked.push(flag);
    if (valued.has(flag)) {
      const value = args[++index];
      if (typeof value !== 'string' || !value || value.startsWith('-') || value.includes('\0') || Buffer.byteLength(value) > 1024) throw new Error('Invalid Cursor isolation argument.');
      checked.push(value);
    }
  }
  return checked;
}

/** Prepared components do not establish an isolation claim until their preflight passes. */
export async function prepareCursorIsolatedLaunch(options: {
  clusterId: string;
  workflowId: string;
  arcoPort: number;
  binary: string;
  credentials: unknown;
  webAccess: boolean;
  args: readonly string[];
} & ({ mode: 'researcher'; directorWorkflowId: string } | { mode: 'isolated'; directorWorkflowId?: never })) {
  options = { ...options, args: Array.isArray(options.args) ? [...options.args] : options.args };
  const cluster = await clusterStore.readCluster(options.clusterId);
  if (!cluster?.members.includes(options.workflowId) || clusterStore.getMemberAccessMode(options.clusterId, options.workflowId) !== options.mode) {
    throw new Error('Cursor isolation requires an isolated cluster member.');
  }
  if (options.mode === 'researcher' && (!cluster.members.includes(options.directorWorkflowId) || options.directorWorkflowId === options.workflowId)) {
    throw new Error('The Research Director must be another cluster member.');
  }
  if (options.mode !== 'researcher' && options.mode !== 'isolated') throw new Error('Invalid isolated worker mode.');
  if (typeof options.webAccess !== 'boolean' || !Array.isArray(options.args)) throw new Error('Invalid isolated worker options.');
  const args = checkedCursorIsolationArgs(options.args);
  const home = await prepareIsolatedCliHome(options.clusterId, options.workflowId);
  const configDir = join(home, '.cursor');
  const xdg = join(home, '.config');
  await privateDirectory(configDir);
  await privateDirectory(xdg);
  await privateDirectory(join(xdg, 'cursor'));
  await replaceFile(join(configDir, 'cli-config.json'), cursorIsolatedCliConfig(options.webAccess));
  const credentialLink = join(xdg, 'cursor', 'auth.json');
  try { await symlink(PASS_PATH, credentialLink); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !(await lstat(credentialLink)).isSymbolicLink()
      || await readlink(credentialLink) !== PASS_PATH) throw new Error('Cursor configuration home contains an unexpected sign-in.');
  }
  // Cursor reads user-level MCP servers from ~/.cursor/mcp.json; it never asks
  // to approve them, and the sandboxed agent cannot read or change this file.
  const mcpPath = join(configDir, 'mcp.json');
  await replaceFile(mcpPath, '{}');
  const root = await makeWorkerSocketDirectory('arco-cursor-isolation-');
  let pass: Awaited<ReturnType<typeof prepareWorkerAccessPass>> | undefined;
  let web: Awaited<ReturnType<typeof startWorkerWebProxy>> | undefined;
  let mail: Awaited<ReturnType<typeof startWorkerMailBridge>> | undefined;
  let worker: Awaited<ReturnType<typeof prepareCheckedLinuxWorker>> | undefined;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    const results = await Promise.allSettled([worker?.close(), mail?.close(), web?.close(), pass?.close()]);
    await rm(root, { recursive: true, force: true });
    if (results.some(result => result.status === 'rejected')) throw new Error('Could not remove all worker isolation resources.');
  };
  try {
    const runtime = await discoverProviderRuntime('cursor', options.binary);
    const helper = cursorSandboxHelper(runtime);
    pass = await prepareWorkerAccessPass('cursor', options.credentials);
    web = await startWorkerWebProxy({ parentDir: root, webAccess: options.webAccess, providerHosts: CURSOR_PROVIDER_HOSTS });
    mail = await startWorkerMailBridge({ parentDir: root, clusterId: options.clusterId, workflowId: options.workflowId, arcoPort: options.arcoPort,
      ...(options.mode === 'researcher' ? { mode: 'researcher' as const, directorWorkflowId: options.directorWorkflowId } : { mode: 'isolated' as const }) });
    worker = await prepareCheckedLinuxWorker({ workspace: clusterStore.isolatedWorkspaceFor(options.clusterId, options.workflowId), privateHome: home,
      hiddenDirectories: workerHiddenDirectories(cluster),
      executable: '/usr/bin/env', runtimeMounts: runtime.mounts, accessPass: pass, webSocket: web.socketPath, mailSocket: mail.socketPath,
      mailToken: mail.token, webAccess: options.webAccess, providerProbeHost: PROBE_HOST, arcoPort: options.arcoPort, nestedSandboxHelper: helper,
      args: (url) => {
        writeFileSync(mcpPath, JSON.stringify({ mcpServers: { 'arco-cluster': { url } } }), { mode: 0o600 });
        return [`XDG_CONFIG_HOME=${WORKER_HOME}/.config`, `CURSOR_CONFIG_DIR=${WORKER_HOME}/.cursor`, 'AGENT_CLI_CREDENTIAL_STORE=file',
          runtime.executable, ...runtime.argsPrefix, '--print', '--output-format', 'stream-json', '--trust', '--sandbox', 'enabled', ...args];
      } });
    const accessPass = pass;
    // Call when the agent reports that it started: it has read the sign-in by then.
    const withdrawPass = async () => {
      if (!accessPass.withdraw) throw new Error('Cursor access pass cannot be withdrawn.');
      await accessPass.withdraw();
    };
    return { command: worker.command, withdrawPass, close };
  } catch (error) { await close(); throw error; }
}
