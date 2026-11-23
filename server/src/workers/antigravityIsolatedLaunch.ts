import { chmod, lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as clusterStore from '../clusterStore.js';
import { startWorkerMailBridge } from '../mcp/workerMailBridge.js';
import { GEMINI_RESEARCH_SCOPE, GEMINI_RESEARCH_TOKEN, type GeminiResearchCredentials } from '../providers/antigravity/researchSignIn.js';
import { prepareCheckedLinuxWorker } from './checkedLinuxWorker.js';
import { prepareIsolatedCliHome } from './isolatedCliHome.js';
import { discoverProviderRuntime } from './providerRuntimeDiscovery.js';
import { startWorkerWebProxy } from './workerWebProxy.js';
import { workerHiddenDirectories } from './workerHiddenDirectories.js';
import { makeWorkerSocketDirectory } from './workerSocketDirectory.js';

// The Antigravity CLI's model, sign-in and account hosts. With web access off
// only these stay reachable; its telemetry, avatar and updater hosts are refused.
export const ANTIGRAVITY_PROVIDER_HOSTS = ['daily-cloudcode-pa.googleapis.com', 'cloudcode-pa.googleapis.com', 'oauth2.googleapis.com', 'www.googleapis.com'];
const PROBE_HOST = 'daily-cloudcode-pa.googleapis.com';
const WORKER_HOME = ['', 'home', 'worker'].join('/');

async function privateDirectory(path: string): Promise<void> {
  try { await mkdir(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink() || (process.getuid && entry.uid !== process.getuid())) throw new Error('Gemini researcher home is not private.');
  await chmod(path, 0o700);
}

/** Remove the per-turn copy of the research sign-in from a researcher's home. */
export async function removeAntigravityCredentialCopy(home: string): Promise<void> {
  await Promise.all([rm(join(home, GEMINI_RESEARCH_TOKEN), { force: true }), rm(join(home, GEMINI_RESEARCH_SCOPE), { force: true })]);
}

/**
 * A fenced Antigravity ACP server for one Gemini researcher. The research
 * sign-in is copied into the researcher's private home for this turn only and
 * removed by close(). The CLI runs with no D-Bus session and a runtime folder
 * inside its home, so it uses that copy and never the system keyring.
 */
export async function prepareAntigravityIsolatedLaunch(options: {
  clusterId: string;
  workflowId: string;
  directorWorkflowId: string;
  arcoPort: number;
  binary: string;
  credentials: GeminiResearchCredentials;
  webAccess: boolean;
}) {
  const cluster = await clusterStore.readCluster(options.clusterId);
  if (!cluster?.members.includes(options.workflowId) || clusterStore.getMemberAccessMode(options.clusterId, options.workflowId) !== 'researcher') {
    throw new Error('Gemini isolation requires a researcher.');
  }
  if (!cluster.members.includes(options.directorWorkflowId) || options.directorWorkflowId === options.workflowId) throw new Error('The Research Director must be another cluster member.');
  if (typeof options.webAccess !== 'boolean') throw new Error('Invalid isolated worker options.');
  const home = await prepareIsolatedCliHome(options.clusterId, options.workflowId);
  for (const part of ['.gemini', join('.gemini', 'antigravity-cli'), '.config', join('.config', 'antigravity'), '.run']) await privateDirectory(join(home, part));
  const root = await makeWorkerSocketDirectory('arco-antigravity-isolation-');
  let web: Awaited<ReturnType<typeof startWorkerWebProxy>> | undefined;
  let mail: Awaited<ReturnType<typeof startWorkerMailBridge>> | undefined;
  let worker: Awaited<ReturnType<typeof prepareCheckedLinuxWorker>> | undefined;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    const results = await Promise.allSettled([worker?.close(), mail?.close(), web?.close(), removeAntigravityCredentialCopy(home)]);
    await rm(root, { recursive: true, force: true });
    if (results.some(result => result.status === 'rejected')) throw new Error('Could not remove all worker isolation resources.');
  };
  try {
    const runtime = await discoverProviderRuntime('antigravity', options.binary);
    await removeAntigravityCredentialCopy(home);
    await writeFile(join(home, GEMINI_RESEARCH_TOKEN), JSON.stringify(options.credentials.token), { mode: 0o600, flag: 'wx' });
    if (options.credentials.scope) await writeFile(join(home, GEMINI_RESEARCH_SCOPE), options.credentials.scope, { mode: 0o600, flag: 'wx' });
    web = await startWorkerWebProxy({ parentDir: root, webAccess: options.webAccess, providerHosts: ANTIGRAVITY_PROVIDER_HOSTS });
    mail = await startWorkerMailBridge({ parentDir: root, clusterId: options.clusterId, workflowId: options.workflowId, arcoPort: options.arcoPort,
      mode: 'researcher' as const, directorWorkflowId: options.directorWorkflowId });
    worker = await prepareCheckedLinuxWorker({ workspace: clusterStore.isolatedWorkspaceFor(options.clusterId, options.workflowId), privateHome: home,
      hiddenDirectories: workerHiddenDirectories(cluster),
      executable: '/usr/bin/env', runtimeMounts: runtime.mounts, webSocket: web.socketPath, mailSocket: mail.socketPath,
      mailToken: mail.token, webAccess: options.webAccess, providerProbeHost: PROBE_HOST, arcoPort: options.arcoPort,
      args: () => [`XDG_RUNTIME_DIR=${WORKER_HOME}/.run`, `XDG_CONFIG_HOME=${WORKER_HOME}/.config`, 'BROWSER=true', 'NO_BROWSER=true',
        runtime.executable, ...runtime.argsPrefix, 'acp'] });
    return { command: worker.command, mailUrl: worker.mailUrl, workspace: '/work', withdrawCredentials: () => removeAntigravityCredentialCopy(home), close };
  } catch (error) { await close(); throw error; }
}
