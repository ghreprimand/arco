import { lstat, mkdir, readlink, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import * as clusterStore from '../clusterStore.js';
import { startWorkerMailBridge } from '../mcp/workerMailBridge.js';
import { claudeResearcherFence } from '../providers/claude/researcherFence.js';
import { prepareCheckedLinuxWorker } from './checkedLinuxWorker.js';
import { prepareIsolatedCliHome } from './isolatedCliHome.js';
import { discoverProviderRuntime } from './providerRuntimeDiscovery.js';
import { prepareWorkerAccessPass } from './workerAccessPass.js';
import { startWorkerWebProxy } from './workerWebProxy.js';
import { workerHiddenDirectories } from './workerHiddenDirectories.js';
import { makeWorkerSocketDirectory } from './workerSocketDirectory.js';

/** Prepared components do not establish an isolation claim until their preflight passes. */
export async function prepareClaudeIsolatedLaunch(options: {
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
    throw new Error('Claude isolation requires an isolated cluster member.');
  }
  if (options.mode === 'researcher' && (!cluster.members.includes(options.directorWorkflowId) || options.directorWorkflowId === options.workflowId)) {
    throw new Error('The Research Director must be another cluster member.');
  }
  if (options.mode !== 'researcher' && options.mode !== 'isolated') throw new Error('Invalid isolated worker mode.');
  if (typeof options.webAccess !== 'boolean' || !Array.isArray(options.args)) throw new Error('Invalid isolated worker options.');
  const args = [...options.args];
  const switches = new Set(['-p', '--verbose', '--include-partial-messages', '--no-session-persistence']);
  const valued = new Set(['--output-format', '--input-format', '--model', '--effort', '--resume', '--session-id', '--system-prompt', '--append-system-prompt', '--fallback-model']);
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (typeof flag !== 'string' || seen.has(flag) || (!switches.has(flag) && !valued.has(flag))) throw new Error('Claude isolation arguments conflict with the worker fence.');
    seen.add(flag);
    if (valued.has(flag)) {
      const value = args[++index];
      if (typeof value !== 'string' || value.startsWith('-') || value.includes('\0') || Buffer.byteLength(value) > 65536) throw new Error('Invalid Claude isolation argument.');
    }
  }
  if (!seen.has('-p')) throw new Error('Claude isolation requires noninteractive mode.');
  if ((seen.has('--resume') && seen.has('--session-id')) || (seen.has('--no-session-persistence') && (seen.has('--resume') || seen.has('--session-id')))) {
    throw new Error('Conflicting Claude session arguments.');
  }
  const home = await prepareIsolatedCliHome(options.clusterId, options.workflowId);
  const config = join(home, 'config');
  try { await mkdir(config, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const configEntry = await lstat(config);
  if (!configEntry.isDirectory() || configEntry.isSymbolicLink() || (configEntry.mode & 0o077) !== 0
    || (process.getuid && configEntry.uid !== process.getuid())) throw new Error('Claude configuration home is not private.');
  const credentialLink = join(config, '.credentials.json');
  try { await symlink('/run/arco-access.json', credentialLink); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !(await lstat(credentialLink)).isSymbolicLink()
      || await readlink(credentialLink) !== '/run/arco-access.json') throw new Error('Claude configuration home contains an unexpected sign-in.');
  }
  const root = await makeWorkerSocketDirectory('arco-claude-isolation-');
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
    const runtime = await discoverProviderRuntime('claude', options.binary);
    pass = await prepareWorkerAccessPass('claude', options.credentials);
    web = await startWorkerWebProxy({ parentDir: root, webAccess: options.webAccess, providerHosts: ['api.anthropic.com'] });
    mail = await startWorkerMailBridge({ parentDir: root, clusterId: options.clusterId, workflowId: options.workflowId, arcoPort: options.arcoPort,
      ...(options.mode === 'researcher' ? { mode: 'researcher' as const, directorWorkflowId: options.directorWorkflowId } : { mode: 'isolated' as const }) });
    worker = await prepareCheckedLinuxWorker({ workspace: clusterStore.isolatedWorkspaceFor(options.clusterId, options.workflowId), privateHome: home,
      hiddenDirectories: workerHiddenDirectories(cluster),
      executable: '/usr/bin/env', runtimeMounts: runtime.mounts, accessPass: pass, webSocket: web.socketPath, mailSocket: mail.socketPath,
      mailToken: mail.token, webAccess: options.webAccess, providerProbeHost: 'api.anthropic.com', arcoPort: options.arcoPort,
      args: (url, bridge) => [`CLAUDE_CONFIG_DIR=${['', 'home', 'worker', 'config'].join('/')}`, runtime.executable, ...runtime.argsPrefix, ...args,
        ...claudeResearcherFence({ webAccess: options.webAccess, webProxyPort: bridge.webProxyPort }).args,
        '--mcp-config', JSON.stringify({ mcpServers: { 'arco-cluster': { type: 'http', url } } })] });
    return { command: worker.command, close };
  } catch (error) { await close(); throw error; }
}
