import { recordComputerCondition, clearPrivateActivity } from './activity.js';
import { clearPrivateConditions, interruptConditions } from './conditions.js';
import { computerProjectionChanged } from './activityBus.js';
import { clearPrivateMailRules, interruptMailRules, mailRuleSettled } from './mailRules.js';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ComputerWatch } from '@arco/shared';
import { atomicWriteFile, withFileLock } from '../atomicFile.js';
import { workflows } from '../server/state.js';
import { broadcastWorkflow } from '../server/broadcast.js';
import { emit } from '../notifications.js';
import { readCluster } from '../clusterStore.js';
import { ComputerWatches } from './watchStore.js';
import type { WorkflowState } from '../workflows/types.js';
import { arcoHome } from '../arcoHome.js';

const claims = new WeakMap<WorkflowState, number>();
const file = process.env.ARCO_COMPUTER_WATCH_FILE ?? join(arcoHome(), 'computer-watches.json');
let store: ComputerWatches | undefined;
let loading: Promise<ComputerWatches> | undefined;
let persistenceError: string | undefined;
async function persist() {
  await withFileLock(file, async () => { await atomicWriteFile(file, JSON.stringify(store!.saved()), { mode: 0o600 }); persistenceError = undefined; });
}
function changed(w: ComputerWatch) {
  const body = `${w.label}: ${w.status === 'finished' ? 'the watched workers finished their current turns and queued messages.' : `current work ended ${w.status}; this is not a completion confirmation.`}`;
  recordComputerCondition(w.ownerId,w.label,body,w.status === 'finished',!!w.private);
  computerProjectionChanged();
  // A private watch never enters notification transports, operational logs,
  // or saved transcripts. The authenticated owner reads its memory state.
  if (!w.private) {
    broadcastWorkflow(w.ownerId, { type: 'system_notice', workflowId: w.ownerId, content: `[COMPUTER WATCH] ${body}` });
    emit({ category: 'computer-watch', severity: w.status === 'finished' ? 'success' : 'warning', title: 'Computer watch', body, workflowId: w.ownerId });
    void persist().catch(() => { persistenceError = 'Watch persistence failed; current state is memory-only.'; });
  }
}
async function ready() {
  const pending = loading ??= (async () => {
    let saved: ComputerWatch[] = [];
    try { saved = JSON.parse(await readFile(file, 'utf8')); if (!Array.isArray(saved)) throw Error('Invalid watch file.'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw Error('Cannot read Computer watches. The existing file was kept.'); }
    store = new ComputerWatches(saved, changed);
    if (saved.some((w) => w.status === 'watching')) await persist();
    return store;
  })();
  try { return await pending; } catch (error) { loading = undefined; throw error; }
}
export function watchClaimed(wf: WorkflowState, token: number) { claims.set(wf, token); }
export function watchSettled(wf: WorkflowState, token: number | undefined, outcome: 'finished' | 'interrupted' | 'failed') {
  if (token === undefined || claims.get(wf) !== token) return;
  claims.delete(wf);
  for (const [id, state] of workflows) if (state === wf) { mailRuleSettled(id, outcome); break; }
  if (!store) return;
  for (const [id, state] of workflows) if (state === wf) { try { store.settle(id, token, outcome); } catch { persistenceError = 'Watch notification could not be published; review its state in Computer.'; } break; }
}
export function clearPrivateWatches(ownerId: string) { store?.clearPrivate(ownerId); clearPrivateMailRules(ownerId);clearPrivateConditions(ownerId);clearPrivateActivity(ownerId);computerProjectionChanged(); }
export async function computerWatchControl(ownerId: string, action: string, target?: string, watchId?: string) {
  const owner = workflows.get(ownerId);
  if (!owner?.config.voiceOperator || owner.config.kind !== 'chat') throw Error('Not a Computer chat.');
  const s = await ready();
  // Removed private contexts leave no watch metadata behind.
  for (const w of s.list(ownerId)) if (w.private && !workflows.has(w.ownerId)) s.clearPrivate(w.ownerId);
  if (action === 'create') {
    if (!target || target === ownerId) throw Error('Choose an exact worker or cluster id from arco_targets.');
    if (!workflows.has(target) && !/^[a-zA-Z0-9-]{8,80}$/.test(target)) throw Error('Choose an exact id from arco_targets.');
    const cluster = workflows.has(target) ? null : await readCluster(target);
    const ids = cluster ? cluster.members.map((id) => ({ id, name: workflows.get(id)?.config.name ?? id })) : [{ id: target, name: workflows.get(target)?.config.name ?? target }];
    if (!ids.every((t) => workflows.has(t.id))) throw Error('One or more workers are unavailable; no watch was created.');
    if (ids.some((t) => workflows.get(t.id)!.config.incognito || workflows.get(t.id)!.config.voiceOperator)) throw Error('Watches cannot inspect private chats or Computer itself.');
    const w = s.create(ownerId, cluster?.name ?? ids[0].name, ids.map((t) => ({ ...t, token: claims.get(workflows.get(t.id)!) })), !!owner.config.incognito);
    if (!w.private) {
      try { await persist(); } catch { s.cancel(w.id, ownerId); throw Error('Watch could not be saved; it was not armed.'); }
      broadcastWorkflow(ownerId, { type: 'system_notice', workflowId: ownerId, content: `[COMPUTER WATCH] Created watch ${w.id} for ${w.targets.map((t) => t.name).join(', ')}: current turns and queued messages only.` });
    }
    computerProjectionChanged();
    return { watch: s.list(ownerId).find((current) => current.id === w.id), watches: s.list(ownerId), warning: persistenceError };
  }
  if (action === 'claim-announcement') {
    const announce = s.claimAnnouncement(watchId ?? '', ownerId);
    if (announce && !s.list(ownerId).find((w) => w.id === watchId)?.private) await persist();
    return { announce, watches: s.list(ownerId), warning: persistenceError };
  }
  if (action === 'cancel') {
    const previous = s.list(ownerId).find((w) => w.id === watchId)?.status;
    const w = s.cancel(watchId ?? '', ownerId);
    if (!w.private) {
      await persist();
      if (previous === 'watching') broadcastWorkflow(w.ownerId, { type: 'system_notice', workflowId: w.ownerId,
        content: `[COMPUTER WATCH] Cancelled watch ${w.id} for ${w.label}.` });
    }
    computerProjectionChanged();
    return { watch: s.list(ownerId).find((current) => current.id === w.id), watches: s.list(ownerId), warning: persistenceError };
  }
  if (action !== 'list') throw Error('Watch action must be create, list or cancel.');
  return { watches: s.list(ownerId), warning: persistenceError };
}

// Mark shutdown before killing subprocesses: their resulting provider errors
// describe an interrupted run, not a worker failure.
export async function interruptComputerWatches() {
  const ruleFlush = interruptMailRules();
  const scriptFlush = interruptConditions();
  if (!store) { await Promise.all([ruleFlush,scriptFlush]); return; }
  const hadSaved = store.saved().some((w) => w.status === 'watching');
  for (const wf of workflows.values()) watchSettled(wf, claims.get(wf), 'interrupted');
  await Promise.all([ruleFlush, scriptFlush, ...(hadSaved ? [persist()] : [])]);
}
