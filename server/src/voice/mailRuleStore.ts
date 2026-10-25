import { randomUUID } from 'node:crypto';
import type { ComputerMailRule } from '@archon/shared';

export interface MailMember { id: string; name: string; busy: boolean; pending: string[] }
export interface MailSnapshot { members: MailMember[]; autoPickup: boolean }
export interface MailAction { targetId: string; messageIds: string[]; final: boolean }
export const MAIL_RULE_COOLDOWN_MS = 30_000;
export const MAIL_RULE_MAX_NUDGES = 8;
export const MAIL_RULE_DURATION_MS = 2 * 60 * 60_000;

// The model selects exact identities once. This machine interprets no names,
// prose, worker answers or completion judgments. A nudge starts a paid turn.
export class ComputerMailRules {
  private rules: ComputerMailRule[];
  private seen = new Map<string, Map<string, Set<string>>>();
  constructor(saved: ComputerMailRule[] = []) {
    this.rules = saved.filter((r) => !r.private).slice(-100).map((r) => r.status === 'watching'
      ? { ...r, status: 'interrupted', reason: 'Server restarted; rule must be armed again.', endedAt: Date.now() } : r);
  }
  list(ownerId?: string) { return structuredClone(this.rules.filter((r) => !r.private || r.ownerId === ownerId)); }
  all() { return structuredClone(this.rules); }
  saved() { return this.list().filter((r) => !r.private); }
  get(id: string) { return this.rules.find((r) => r.id === id); }
  create(ownerId: string, clusterId: string, label: string, workerIds: string[], finalId: string, snapshot: MailSnapshot, privateRule = false, now = Date.now()) {
    if (snapshot.autoPickup) throw Error('Turn off this cluster’s AUTO-PICKUP before arming a mailbox rule.');
    const ids = snapshot.members.map((m) => m.id);
    if (!workerIds.length || workerIds.length > 16 || new Set(workerIds).size !== workerIds.length || workerIds.includes(finalId)
      || ![...workerIds, finalId].every((id) => ids.includes(id))) throw Error('Choose distinct exact worker ids and a different final recipient in one cluster.');
    if (this.rules.some((r) => r.status === 'watching' && r.clusterId === clusterId)) throw Error('This cluster already has an active mailbox rule. Cancel it first.');
    if (this.rules.filter((r) => r.status === 'watching').length >= 16) throw Error('16 mailbox rules are already active.');
    const r: ComputerMailRule = { id: randomUUID(), ownerId, clusterId, label, memberIds: ids.slice().sort(), finalId,
      finalName: snapshot.members.find((m) => m.id === finalId)!.name,
      workers: workerIds.map((id) => ({ id, name: snapshot.members.find((m) => m.id === id)!.name, nudges: 0 })),
      status: 'watching', reason: 'Waiting for pending worker mail or the final condition.', createdAt: now, expiresAt: now + MAIL_RULE_DURATION_MS,
      cooldownMs: MAIL_RULE_COOLDOWN_MS, maxNudgesPerWorker: MAIL_RULE_MAX_NUDGES, ...(privateRule ? { private: true } : {}) };
    this.rules.push(r); this.seen.set(r.id, new Map());
    const old = this.rules.filter((r) => r.status !== 'watching').slice(0, Math.max(0, this.rules.length - 100));
    this.rules = this.rules.filter((r) => !old.includes(r));
    return structuredClone(r);
  }
  stop(id: string, status: ComputerMailRule['status'], reason: string) {
    const r = this.get(id);
    if (r?.status === 'watching') { r.status = status; r.reason = reason; r.endedAt = Date.now(); this.seen.delete(id); }
  }
  next(id: string, snapshot: MailSnapshot, now = Date.now()): MailAction | undefined {
    const r = this.get(id); if (!r || r.status !== 'watching') return;
    if (now >= r.expiresAt) { this.stop(id, 'expired', 'Two-hour limit reached.'); return; }
    if (snapshot.autoPickup || snapshot.members.map((m) => m.id).sort().join(',') !== r.memberIds.join(',')) {
      this.stop(id, 'interrupted', snapshot.autoPickup ? 'AUTO-PICKUP was enabled.' : 'Cluster membership changed.'); return;
    }
    if (r.paused) return;
    const final = snapshot.members.find((m) => m.id === r.finalId)!;
    // ALL other cluster members count, including ones not selected for nudges.
    // An empty mailbox alone does not imply an in-flight worker is finished.
    if (!final.busy && final.pending.length && snapshot.members.every((m) => m.id === r.finalId || (!m.busy && !m.pending.length))) {
      return { targetId: r.finalId, messageIds: final.pending, final: true };
    }
    for (const w of r.workers) {
      const m = snapshot.members.find((m) => m.id === w.id)!;
      const seen = this.seen.get(id)?.get(w.id) ?? new Set<string>();
      if (m.busy || !m.pending.some((msg) => !seen.has(msg)) || now - (w.lastNudgedAt ?? -Infinity) < r.cooldownMs) continue;
      if (w.nudges >= r.maxNudgesPerWorker) { this.stop(id, 'limited', `${w.name} reached the ${r.maxNudgesPerWorker}-nudge limit.`); return; }
      return { targetId: w.id, messageIds: m.pending, final: false };
    }
  }
  record(id: string, action: MailAction, now = Date.now()) {
    const r = this.get(id); if (!r || r.status !== 'watching') return;
    if (action.final) { this.stop(id, 'finished', `${r.finalName} was nudged after all other members were idle with empty mailboxes. Rule stopped.`); return; }
    const w = r.workers.find((w) => w.id === action.targetId)!;
    w.nudges++; w.lastNudgedAt = now;
    const bindings = this.seen.get(id)!;
    // A mailbox is capped by the cluster substrate. Only the most recent
    // pending batch is needed: message IDs never recur after removal.
    bindings.set(w.id, new Set(action.messageIds));
    r.reason = `Nudged ${w.name}; waiting for new mail or the final condition.`;
  }
  nextDeadline(id: string, enabled: boolean, now = Date.now()) {
    const r = this.get(id); if (!r || r.status !== 'watching') return;
    return Math.min(r.expiresAt, ...(!r.paused && enabled ? r.workers.map((w) => (w.lastNudgedAt ?? -Infinity) + r.cooldownMs).filter((at) => at > now) : []));
  }
  clearPrivate(ownerId: string) {
    for (const r of this.rules) if (r.private && r.ownerId === ownerId) this.seen.delete(r.id);
    this.rules = this.rules.filter((r) => !r.private || r.ownerId !== ownerId);
  }
}
