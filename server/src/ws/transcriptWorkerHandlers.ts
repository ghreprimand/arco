import * as clusterStore from '../clusterStore.js';
import { buildReplacementHistory } from '../replacementHistory.js';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type WebSocket from 'ws';
import type { TranscriptWorkerCreateMessage, TranscriptWorkerPreviewMessage, WorkflowConfig } from '@arco/shared';
import type { Session } from '../workflows/types.js';
import { send } from '../server/broadcast.js';
import { workflows } from '../server/state.js';
import { safeDirectory } from '../fileAccessPolicy.js';
import { readSettings } from '../settings.js';
import { isKnownProvider } from '../providers/index.js';
import { configuredAccounts } from '../providerAccounts.js';
import { buildTranscriptWorkerSlice, type TranscriptSliceOptions } from '../transcriptWorker.js';
import { TERMINAL_CODEX_ACCOUNT } from '@arco/shared';

interface Dependencies {
  create(ws: WebSocket, session: Session, config: WorkflowConfig): Promise<string>;
  seed(ws: WebSocket, session: Session, workflowId: string, content: string): void;
}
let deps: Dependencies;
export function initTranscriptWorkerHandlers(value: Dependencies): void { deps = value; }
type Slice = Awaited<ReturnType<typeof buildTranscriptWorkerSlice>> | Awaited<ReturnType<typeof buildReplacementHistory>>;
interface Snapshot { replacement?: { clusterId: string; mode: 'recent' | 'full' }; claimed?: boolean; owner: WebSocket; source: string; cwd: string; options: TranscriptSliceOptions; slice: Slice; expires: number; created?: string; creating?: Promise<string> }
const snapshots = new Map<string, Snapshot>();
function prune(): void {
  for (const [token, entry] of snapshots) if (entry.expires < Date.now() && !entry.creating) snapshots.delete(token);
  while (snapshots.size >= 32) {
    const oldest = [...snapshots].find(([, entry]) => !entry.creating);
    if (!oldest) throw new Error('Transcript previews are busy. Try again when a request finishes.');
    snapshots.delete(oldest[0]);
  }
}
function sourceFor(workflowId: string) {
  const source = workflows.get(workflowId);
  if (!source || source.config.kind === 'chat' || source.config.kind === 'cluster' || source.config.incognito || !source.config.workingDirectory) throw new Error('Choose an available Agent conversation as the source.');
  return source;
}

export async function handleTranscriptWorkerPreview(ws: WebSocket, message: TranscriptWorkerPreviewMessage): Promise<void> {
  try {
    prune();
    const source = sourceFor(message.workflowId);
    const options: TranscriptSliceOptions = { turns: message.turns, includePartial: message.includePartial, preface: message.preface, wasBusy: source.busy };
    let cwd = source.config.workingDirectory;
    if (message.replacement) {
      const cluster = await clusterStore.readCluster(message.replacement.clusterId);
      if (!cluster?.members.includes(message.workflowId)) throw new Error('Choose an available cluster member.');
      if (source.busy) throw new Error('Wait for the member to finish before replacing it.');
      if (!['recent', 'full'].includes(message.replacement.mode)) throw new Error('Choose a valid history mode.');
      cwd = cluster.cwd;
      options.includePartial = false; options.preface = ''; options.wasBusy = false;
    }
    const slice = message.replacement
      ? await buildReplacementHistory(cwd, message.workflowId, message.replacement.mode, options)
      : await buildTranscriptWorkerSlice(cwd, message.workflowId, options);
    const token = randomUUID();
    snapshots.set(token, { replacement: message.replacement, owner: ws, source: message.workflowId, cwd, options: { ...options, cutoffSeq: slice.cutoffSeq }, slice, expires: Date.now() + 10 * 60_000 });
    const { digest: _digest, branchKey: _branch, ...preview } = slice;
    send(ws, { type: 'transcript_worker_result', requestId: message.requestId, preview: { ...preview, token } });
  } catch (error) {
    send(ws, { type: 'transcript_worker_result', requestId: message.requestId, error: error instanceof Error ? error.message : String(error) });
  }
}

async function destinationConfig(message: TranscriptWorkerCreateMessage): Promise<WorkflowConfig> {
  const target = message.destination;
  if (!target || typeof target.workingDirectory !== 'string' || !isAbsolute(target.workingDirectory)) throw new Error('Choose an existing absolute working directory for the new worker.');
  let workingDirectory: string;
  try { workingDirectory = safeDirectory(target.workingDirectory); }
  catch { throw new Error('The destination folder is unavailable or protected. Choose another existing folder.'); }
  if (!isKnownProvider(target.provider) || typeof target.model !== 'string' || !target.model.trim()) throw new Error('Choose a supported provider and model.');
  if (!['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(target.effort)) throw new Error('Choose a valid effort.');
  if (target.skipPermissions !== undefined && typeof target.skipPermissions !== 'boolean') throw new Error('Choose the new worker permission setting.');
  const settings = await readSettings(workingDirectory);
  if (settings.enabledProviders?.[target.provider] === false) throw new Error('That provider is turned off. Enable it or choose another provider.');
  if (target.providerAccountRef && !(target.provider === 'codex' && target.providerAccountRef === TERMINAL_CODEX_ACCOUNT)) {
    if (target.provider !== 'codex' || !(await configuredAccounts('codex', workingDirectory)).some(account => account.id === target.providerAccountRef)) throw new Error('Choose an available account for the new worker.');
  }
  return { kind: 'workflow', name: typeof target.name === 'string' && target.name.trim() ? target.name.trim().slice(0, 120) : 'Transcript worker', workingDirectory,
    primaryProvider: target.provider, primaryModel: target.model.trim(), primaryEffort: target.effort,
    ...(target.provider === 'codex' && target.providerAccountRef ? { providerAccountRef: target.providerAccountRef } : {}), skipPermissions: target.skipPermissions === true };
}

export async function handleTranscriptWorkerCreate(ws: WebSocket, session: Session, message: TranscriptWorkerCreateMessage): Promise<void> {
  try {
    const entry = snapshots.get(message.token);
    if (!entry || entry.owner !== ws || entry.replacement || entry.expires < Date.now()) throw new Error('The preview expired or disconnected. Refresh the preview before sending.');
    if (!entry.created && !entry.creating) {
      entry.creating = (async () => {
        const source = sourceFor(entry.source);
        if (source.config.workingDirectory !== entry.cwd) throw new Error('The source folder changed. Refresh the preview.');
        const current = await buildTranscriptWorkerSlice(entry.cwd, entry.source, entry.options);
        if (current.digest !== entry.slice.digest) throw new Error('The source history changed or was rewound. Refresh the preview.');
        const config = await destinationConfig(message);
        const id = await deps.create(ws, session, config);
        entry.created = id;
        deps.seed(ws, session, id, entry.slice.seed);
        return id;
      })();
    }
    const id = entry.created ?? await entry.creating!;
    entry.creating = undefined;
    send(ws, { type: 'transcript_worker_result', requestId: message.requestId, newWorkflowId: id });
  } catch (error) {
    const entry = snapshots.get(message.token);
    if (entry && !entry.created) entry.creating = undefined;
    send(ws, { type: 'transcript_worker_result', requestId: message.requestId, error: error instanceof Error ? error.message : String(error) });
  }
}


// REPLACE consumes the same socket-bound, fixed-cutoff preview as NEW WORKER.
// Claim after checking again so a repeated submit cannot allocate two members.
export async function takeReplacementHistoryPreview(ws: WebSocket, clusterId: string, workflowId: string, mode: 'recent' | 'full', turns: number, token: string) {
  const entry = snapshots.get(token);
  if (!entry || entry.owner !== ws || entry.expires < Date.now() || entry.source !== workflowId
    || entry.replacement?.clusterId !== clusterId || entry.replacement.mode !== mode || entry.options.turns !== turns) {
    throw new Error('The history preview expired or changed. Refresh it before replacing.');
  }
  const current = await buildReplacementHistory(entry.cwd, workflowId, mode, entry.options);
  if (current.digest !== entry.slice.digest) throw new Error('The source history changed or was rewound. Refresh the preview.');
  if (entry.claimed) throw new Error('This history preview was already used. Refresh it before replacing again.');
  entry.claimed = true;
  return current;
}
