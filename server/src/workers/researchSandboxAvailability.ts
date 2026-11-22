import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { findDiagnosticExecutable } from '../diagnostics/executableLookup.js';
import { PORT } from '../server/constants.js';
import { prepareCheckedLinuxWorker } from './checkedLinuxWorker.js';
import { discoverProviderRuntime } from './providerRuntimeDiscovery.js';
import { startWorkerWebProxy } from './workerWebProxy.js';
import { makeWorkerSocketDirectory } from './workerSocketDirectory.js';
import { codexResearchVersionReason, installedCodexVersion } from '../providers/codexVersion.js';

// A short-lived, shared availability probe does not read a sign-in or launch a model.
// Every actual worker still runs its own same-namespace preflight before a turn.
type CliResearchProvider = 'claude' | 'codex';
const current = new Map<CliResearchProvider, Promise<boolean>>();
const last = new Map<CliResearchProvider, { result: boolean; at: number }>();
export async function researchSandboxAvailable(provider: CliResearchProvider): Promise<boolean> {
  const cached = last.get(provider);
  if (cached && Date.now() - cached.at < 60_000) return cached.result;
  const pending = current.get(provider);
  if (pending) return pending;
  const checkPromise = check(provider).catch(() => false).then(result => { last.set(provider, { result, at: Date.now() }); return result; });
  current.set(provider, checkPromise);
  try { return await checkPromise; } finally { current.delete(provider); }
}
async function check(provider: CliResearchProvider): Promise<boolean> {
  if (process.platform !== 'linux') return false;
  const binary = findDiagnosticExecutable(provider);
  if (!binary) return false;
  if (provider === 'codex' && codexResearchVersionReason(installedCodexVersion())) return false;
  await discoverProviderRuntime(provider, resolve(binary));
  const root = await makeWorkerSocketDirectory('arco-research-availability-');
  const workspace = join(root, 'work'), privateHome = join(root, 'home'), mailPath = join(root, 'mail.sock');
  const mail = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ result: { tools: [{ name: 'peer_send' }, { name: 'peer_read' }] } }));
  });
  let web: Awaited<ReturnType<typeof startWorkerWebProxy>> | undefined;
  let prepared: Awaited<ReturnType<typeof prepareCheckedLinuxWorker>> | undefined;
  try {
    await Promise.all([mkdir(workspace, { mode: 0o700 }), mkdir(privateHome, { mode: 0o700 })]);
    await new Promise<void>((resolve, reject) => { mail.once('error', reject); mail.listen(mailPath, resolve); });
    await chmod(mailPath, 0o600);
    web = await startWorkerWebProxy({ parentDir: root, webAccess: true, providerHosts: provider === 'claude' ? ['api.anthropic.com'] : ['chatgpt.com', 'api.openai.com'] });
    prepared = await prepareCheckedLinuxWorker({ workspace, privateHome, executable: '/usr/bin/true', args: () => [],
      webSocket: web.socketPath, mailSocket: mailPath, mailToken: randomBytes(32).toString('hex'), webAccess: true, arcoPort: PORT });
    return await new Promise<boolean>(resolve => {
      execFile(prepared!.command.file, prepared!.command.args, { timeout: 25_000, env: { PATH: '/usr/bin:/bin' } }, error => resolve(!error));
    });
  } finally {
    const cleanup = await Promise.allSettled([
      prepared?.close(),
      web?.close(),
      mail.listening ? new Promise<void>(resolve => mail.close(() => resolve())) : undefined,
    ]);
    await rm(root, { recursive: true, force: true });
    if (cleanup.some(result => result.status === 'rejected')) throw new Error('Sandbox availability cleanup failed.');
  }
}
