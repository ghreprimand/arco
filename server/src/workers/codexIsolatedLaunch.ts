import { lstat, mkdir, readlink, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import * as clusterStore from '../clusterStore.js';
import { startWorkerMailBridge } from '../mcp/workerMailBridge.js';
import { prepareCheckedLinuxWorker } from './checkedLinuxWorker.js';
import { codexIsolatedProfileArgs } from './codexIsolatedPolicy.js';
import { prepareIsolatedCliHome } from './isolatedCliHome.js';
import { discoverProviderRuntime } from './providerRuntimeDiscovery.js';
import { prepareWorkerAccessPass } from './workerAccessPass.js';
import { startWorkerWebProxy } from './workerWebProxy.js';
import { workerHiddenDirectories } from './workerHiddenDirectories.js';
import { makeWorkerSocketDirectory } from './workerSocketDirectory.js';

/** Prepare the outer fence and the named Codex profile; preflight must pass before app-server starts. */
export async function prepareCodexIsolatedLaunch(options: {
  clusterId: string; workflowId: string; arcoPort: number; binary: string; credentials: unknown; webAccess: boolean; sourceHome?: string;
} & ({ mode: 'researcher'; directorWorkflowId: string } | { mode: 'isolated'; directorWorkflowId?: never })) {
  options = { ...options };
  const cluster = await clusterStore.readCluster(options.clusterId);
  if (!cluster?.members.includes(options.workflowId) || clusterStore.getMemberAccessMode(options.clusterId, options.workflowId) !== options.mode) {
    throw new Error('Codex isolation requires an isolated cluster member.');
  }
  if (options.mode !== 'researcher' && options.mode !== 'isolated') throw new Error('Invalid isolated worker mode.');
  if (typeof options.webAccess !== 'boolean') throw new Error('Invalid isolated worker options.');
  if (options.mode === 'researcher' && (!cluster.members.includes(options.directorWorkflowId) || options.directorWorkflowId === options.workflowId)) {
    throw new Error('The Research Director must be another cluster member.');
  }
  const home = await prepareIsolatedCliHome(options.clusterId, options.workflowId);
  const config = join(home, 'config');
  try { await mkdir(config, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const configEntry = await lstat(config);
  if (!configEntry.isDirectory() || configEntry.isSymbolicLink() || (configEntry.mode & 0o077) !== 0
    || (process.getuid && configEntry.uid !== process.getuid())) throw new Error('Codex configuration home is not private.');
  try { await lstat(join(config, 'config.toml')); throw new Error('Codex isolated home contains an unexpected configuration.'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const credentialLink = join(config, 'auth.json');
  try { await symlink('/run/arco-pass/access.json', credentialLink); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !(await lstat(credentialLink)).isSymbolicLink()
      || await readlink(credentialLink) !== '/run/arco-pass/access.json') throw new Error('Codex configuration home contains an unexpected sign-in.');
  }
  const root = await makeWorkerSocketDirectory('arco-codex-isolation-');
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
    const runtime = await discoverProviderRuntime('codex', options.binary);
    pass = await prepareWorkerAccessPass('codex', options.credentials);
    web = await startWorkerWebProxy({ parentDir: root, webAccess: options.webAccess, providerHosts: ['chatgpt.com', 'api.openai.com'] });
    mail = await startWorkerMailBridge({ parentDir: root, clusterId: options.clusterId, workflowId: options.workflowId, arcoPort: options.arcoPort,
      ...(options.mode === 'researcher' ? { mode: 'researcher' as const, directorWorkflowId: options.directorWorkflowId } : { mode: 'isolated' as const }) });
    worker = await prepareCheckedLinuxWorker({ workspace: clusterStore.isolatedWorkspaceFor(options.clusterId, options.workflowId), privateHome: home,
      hiddenDirectories: workerHiddenDirectories(cluster, options.sourceHome ? [options.sourceHome] : []),
      executable: '/usr/bin/env', runtimeMounts: runtime.mounts, accessPass: pass, webSocket: web.socketPath, mailSocket: mail.socketPath,
      mailToken: mail.token, webAccess: options.webAccess, providerProbeHost: 'chatgpt.com', arcoPort: options.arcoPort,
      args: url => [`CODEX_HOME=${['', 'home', 'worker', 'config'].join('/')}`, runtime.executable, ...runtime.argsPrefix, ...codexIsolatedProfileArgs(url), 'app-server'] });
    const accessPass = pass;
    return { command: worker.command, mailUrl: worker.mailUrl, replacePass: async (credentials: unknown) => {
      if (!accessPass.replace) throw new Error('Codex access pass cannot be replaced.');
      await accessPass.replace(credentials);
    }, close };
  } catch (error) { await close(); throw error; }
}
