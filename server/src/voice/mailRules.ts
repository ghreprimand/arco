import { subscribeActivity, subscribeComputerPolicy, computerProjectionChanged } from './activityBus.js';
import { activityReady, activityPolicy, recordComputerCondition } from './activity.js';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { ComputerMailRule } from '@archon/shared';
import { atomicWriteFile, withFileLock } from '../atomicFile.js';
import * as clusters from '../clusterStore.js';
import { pendingIdsStrict } from '../clusterMailbox.js';
import { workflows } from '../server/state.js';
import { broadcastWorkflow } from '../server/broadcast.js';
import { emit } from '../notifications.js';
import { ComputerMailRules, type MailSnapshot } from './mailRuleStore.js';
import { hasActiveConditionsForCluster } from './conditions.js';

const file = process.env.ARCHON_COMPUTER_MAIL_RULE_FILE ?? join(homedir(), '.archon', 'computer-mail-rules.json');
let store: ComputerMailRules | undefined, loading: Promise<ComputerMailRules> | undefined;
let warning: string | undefined;
let stopped = false, ticking = false;
let dispatch: ((id: string, content: string, guard: (claim: () => boolean) => Promise<boolean>) => Promise<boolean>) | undefined;
const published = new Set<string>();
const dirtyClusters = new Set<string>();
const deadlines = new Map<string, ReturnType<typeof setTimeout>>();
let scheduled = false;
function invalidate(clusterId?: string) {
  if (stopped || !store) return;
  if (clusterId) dirtyClusters.add(clusterId);
  else for (const r of store.all()) if (r.status === 'watching') dirtyClusters.add(r.clusterId);
  if (!scheduled) {scheduled = true;setImmediate(() => {scheduled = false;void evaluateMailRules();});}
}
function armDeadlines() {
  for (const timer of deadlines.values()) clearTimeout(timer);deadlines.clear();
  for (const r of store?.all() ?? []) {
    const at = store!.nextDeadline(r.id,activityPolicy(r.ownerId).enabled);
    if (at === undefined) continue;
    const timer = setTimeout(() => {deadlines.delete(r.id);invalidate(r.clusterId);},Math.max(0,at-Date.now()));timer.unref();deadlines.set(r.id,timer);
  }
}
async function persist() {
  await withFileLock(file, () => atomicWriteFile(file, JSON.stringify(store!.saved()), { mode: 0o600 }));
}
async function ready() {
  const pending = loading ??= (async () => {
    let saved: ComputerMailRule[] = [];
    try { saved = z.array(savedRule).max(100).parse(JSON.parse(await readFile(file, 'utf8'))); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw Error('Cannot read Computer mailbox rules; existing file kept.'); }
    for (const r of saved) if (r.status !== 'watching') published.add(r.id);
    store = new ComputerMailRules(saved);
    if (saved.some((r) => r.status === 'watching')) await persist();
    return store;
  })();
  try { return await pending; } catch (e) { store = undefined; loading = undefined; throw e; }
}
function audit(r: ComputerMailRule, text: string, targetId?: string) {
  // Private ownership/labels/IDs never leave memory. A requested standard
  // nudge still lives in its NORMAL destination worker transcript.
  if (r.private) return;
  const content = `[COMPUTER MAIL RULE ${r.id}] ${text}`;
  try {
    broadcastWorkflow(r.ownerId, { type: 'system_notice', workflowId: r.ownerId, content });
    if (targetId) broadcastWorkflow(targetId, { type: 'system_notice', workflowId: targetId, content });
  } catch { warning = 'A mailbox rule audit notice could not be saved. Review its state in Computer.'; }
}
function publishTerminals() {
  const retained = new Set(store?.all().map((r) => r.id));
  for (const id of published) if (!retained.has(id)) published.delete(id);
  for (const r of store?.all() ?? []) {
    if (r.status === 'watching' || published.has(r.id)) continue;
    published.add(r.id); recordComputerCondition(r.ownerId,r.label,r.reason,r.status === 'finished',!!r.private); audit(r, `${r.label}: ${r.status}. ${r.reason}`);
    if (!r.private) { try { emit({ category: 'computer-watch', severity: r.status === 'finished' ? 'success' : 'warning',
      title: 'Computer mailbox rule', body: `${r.label}: ${r.reason}`, workflowId: r.ownerId }); } catch { warning = 'Mailbox rule notification failed; review its state in Computer.'; } }
  }
}
async function snapshot(clusterId: string): Promise<MailSnapshot> {
  const ids = clusters.getMembers(clusterId);
  if (!ids?.length) throw Error('Cluster is unavailable.');
  const members = await Promise.all(ids.map(async (id) => {
    const wf = workflows.get(id);
    if (!wf || wf.config.incognito || wf.config.kind === 'chat' || wf.config.voiceOperator) throw Error('Cluster workers are unavailable or private.');
    return { id, name: wf.config.name ?? id, busy: wf.busy || !!wf.queue.steering.length || !!wf.queue.followUp.length,
      pending: await pendingIdsStrict(clusterId, id) };
  }));
  // Busy state must be sampled AFTER I/O, with no subsequent await before
  // claim. Membership is checked again by the state machine under the lock.
  for (const m of members) {
    const wf = workflows.get(m.id);
    if (!wf || clusters.getClusterIdForWorkflow(m.id) !== clusterId) throw Error('Cluster membership changed.');
    m.busy = wf.busy || !!wf.queue.steering.length || !!wf.queue.followUp.length;
  }
  return { members, autoPickup: clusters.isAutoTurnOnMailboxEnabled(clusterId) };
}
async function saveOrStop() {
  try { await persist(); warning = undefined; }
  catch {
    warning = 'Mailbox rule persistence failed; active saved rules were stopped. Review Computer before re-arming.';
    for (const r of store!.all()) if (!r.private) store!.stop(r.id, 'failed', warning);
  }
}
export function configureMailRules(run: NonNullable<typeof dispatch>) {
  dispatch = run;
  subscribeActivity((event) => { if(event.clusterId) invalidate(event.clusterId); });
  subscribeComputerPolicy((ownerId) => { for(const r of store?.all() ?? []) if(r.ownerId === ownerId)invalidate(r.clusterId); });
}
export function hasActiveMailRulesForCluster(id:string){return !!store?.all().some((r)=>r.clusterId===id&&r.status==='watching');}
export async function evaluateMailRules() {
  if (stopped || ticking || !store || !dispatch) return;
  ticking = true;
  const before = JSON.stringify(store.saved());
  const clustersToCheck = new Set(dirtyClusters);dirtyClusters.clear();
  try {
    for (const r of store.all().filter((r) => clustersToCheck.has(r.clusterId) && r.status === 'watching')) {
      try {
        const action = await withFileLock(clusters.clusterMailboxRoot(r.clusterId), async () => store!.next(r.id, await snapshot(r.clusterId)));
        if (!action || !activityPolicy(r.ownerId).enabled) continue;
        const text = 'Please check your peer mailbox (peer_read) and process any pending messages.';
        let checked = false;
        const accepted = await dispatch(action.targetId, text, async (claim) => withFileLock(clusters.clusterMailboxRoot(r.clusterId), async () => {
          checked = true;
          if (stopped || !activityPolicy(r.ownerId).enabled || store!.get(r.id)?.status !== 'watching') return false;
          // Check writability BEFORE any paid turn. A crash after claim cannot
          // replay: every saved watching record becomes interrupted on load.
          if (!r.private) { await persist(); }
          const current = store!.next(r.id, await snapshot(r.clusterId));
          if (!current || current.targetId !== action.targetId || current.final !== action.final || stopped || !activityPolicy(r.ownerId).enabled || store!.get(r.id)?.status !== 'watching') return false;
          if (!claim()) return false;
          store!.record(r.id, current);
          audit(store!.get(r.id)!, `${current.final ? 'Final recipient' : 'Worker'} nudged: ${current.targetId}; pending message IDs: ${current.messageIds.join(", ")}.`, current.targetId);
          return true;
        }));
        const target = workflows.get(action.targetId);
        if (!accepted && !checked && !target?.busy) store.stop(r.id, 'failed', 'Worker turn preflight refused the nudge; no further nudges will be sent.');
      } catch { store.stop(r.id, 'failed', 'Mailbox check or nudge dispatch failed; no further nudges will be sent.'); }
    }
    if (JSON.stringify(store.saved()) !== before || store.saved().some((r) => r.status !== 'watching' && !published.has(r.id))) await saveOrStop();
    publishTerminals();
  } finally { ticking = false;armDeadlines();computerProjectionChanged();if(dirtyClusters.size)invalidate(); }
}
export function mailRuleSettled(id: string, outcome: string) {
  if (outcome === 'finished' || !store) return;
  for (const r of store.all()) if (r.memberIds.includes(id)) {store.stop(r.id, outcome === 'failed' ? 'failed' : 'interrupted', 'A cluster member’s turn failed or was stopped.');invalidate(r.clusterId);}
}
export function clearPrivateMailRules(ownerId: string) {
  for (const r of store?.list(ownerId) ?? []) if (r.private) published.delete(r.id);
  store?.clearPrivate(ownerId);armDeadlines();computerProjectionChanged();
}
export async function interruptMailRules() {
  stopped = true;for(const timer of deadlines.values())clearTimeout(timer);deadlines.clear();
  if (!store) return;
  for (const r of store.all()) store.stop(r.id, 'interrupted', 'Server stopped; rule must be armed again.');
  if (store.saved().length) await saveOrStop();
  publishTerminals();
}
const id = z.string().regex(/^[a-zA-Z0-9-]{8,80}$/);
const savedRule = z.object({ id, ownerId: id, clusterId: id, label: z.string(), memberIds: z.array(id),
  finalId: id, finalName: z.string(), workers: z.array(z.object({ id, name: z.string(), nudges: z.number().int().nonnegative(), lastNudgedAt: z.number().optional() })),
  status: z.enum(['watching', 'finished', 'cancelled', 'interrupted', 'failed', 'expired', 'limited']), reason: z.string(),
  createdAt: z.number(), expiresAt: z.number(), cooldownMs: z.number(), maxNudgesPerWorker: z.number(),
  endedAt: z.number().optional(), announcedAt: z.number().optional(), private: z.boolean().optional(), paused: z.boolean().optional(),
});
const request = z.object({ action: z.enum(['create', 'list', 'cancel', 'pause', 'resume', 'claim-announcement']).default('list'),
  cluster_id: id.optional(), worker_ids: z.array(id).min(1).max(16).optional(), final_id: id.optional(), rule_id: id.optional() }).strict();
export async function computerMailRuleControl(ownerId: string, raw: unknown) {
  const owner = workflows.get(ownerId);
  if (!owner?.config.voiceOperator || owner.config.kind !== 'chat') throw Error('Not a Computer chat.');
  const privateRule = !!owner.config.incognito, resetAt = owner.config.computerContext?.lastResetAt;
  const checkOwner = () => {
    if (workflows.get(ownerId) !== owner || !!owner.config.incognito !== privateRule || owner.config.computerContext?.lastResetAt !== resetAt)
      throw Error('Computer context changed; mailbox rule was not armed.');
  };
  await activityReady();
  const args = request.parse(raw), s = await ready();
  checkOwner();
  if (stopped) throw Error('Server is stopping.');
  let rule: ComputerMailRule | undefined, announce: boolean | undefined;
  if (args.action === 'create') {
    if (!args.cluster_id || !args.worker_ids || !args.final_id) throw Error('Resolve exact cluster, worker and final recipient ids with archon_targets.');
    if(hasActiveConditionsForCluster(args.cluster_id))throw Error('Cancel active conditional scripts in this cluster before arming a legacy mailbox rule.');
    const cluster = await clusters.readCluster(args.cluster_id);
    if (!cluster) throw Error('Cluster is unavailable.');
    rule = await withFileLock(clusters.clusterMailboxRoot(cluster.clusterId), async () => {
      const state = await snapshot(cluster.clusterId); checkOwner();
      return s.create(ownerId, cluster.clusterId, cluster.name ?? 'Cluster', args.worker_ids!, args.final_id!, state, privateRule);
    });
    if (!rule.private) {
      try { await persist(); } catch { s.stop(rule.id, 'failed', 'Could not save; rule was not armed.'); throw Error('Mailbox rule could not be saved; it was not armed.'); }
    }
    audit(rule, `Armed for ${rule.workers.map((w) => `${w.name} (${w.id})`).join(', ')}; final recipient ${rule.finalName} (${rule.finalId}). All other members must be idle with empty mailboxes. Max ${rule.maxNudgesPerWorker} nudges per worker, ${rule.cooldownMs / 1000}s cooldown, expires ${new Date(rule.expiresAt).toISOString()}.`);
  } else if (['cancel','pause','resume','claim-announcement'].includes(args.action)) {
    rule = s.list(ownerId).find((r) => r.id === args.rule_id);
    if (!rule) throw Error('No such mailbox rule.');
    if (args.action === 'pause' || args.action === 'resume') {
      const current=s.get(rule.id)!;if(current.status !== 'watching')throw Error('This rule has already stopped.');current.paused=args.action === 'pause';
      audit(current, current.paused?'Paused by the operator.':'Resumed by the operator.');
    } else if (args.action === 'cancel') s.stop(rule.id, 'cancelled', 'Cancelled by the operator. Already started turns continue.');
    else { const current = s.get(rule.id)!; announce = current.status !== 'watching' && current.status !== 'cancelled' && !current.announcedAt;
      if (announce) current.announcedAt = Date.now(); }
    if (!rule.private) await saveOrStop();
    publishTerminals();
  }
  if(args.action !== 'list' && args.action !== 'claim-announcement') {invalidate(rule?.clusterId);computerProjectionChanged();}
  return { rule: rule ? s.list(ownerId).find((r) => r.id === rule!.id) : undefined, rules: s.list(ownerId), announce, warning };
}
