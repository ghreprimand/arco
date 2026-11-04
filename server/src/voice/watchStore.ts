import { randomUUID } from 'node:crypto';
import type { ComputerWatch } from '@arco/shared';

type Outcome = 'finished' | 'interrupted' | 'failed';
export interface WatchCandidate { id: string; name: string; token?: number }
// Deterministic one-shot state machine. Generation bindings are memory-only:
// a process restart cannot truthfully infer that the killed work succeeded.
export class ComputerWatches {
  private watches: ComputerWatch[];
  private bindings = new Map<string, Map<string, number>>();
  constructor(saved: ComputerWatch[] = [], private changed: (watch: ComputerWatch) => void = () => {}) {
    this.watches = saved.filter((w) => !w.private).slice(-100).map((w) => w.status === 'watching'
      ? { ...w, status: 'interrupted', endedAt: Date.now(), targets: w.targets.map((t) => t.status === 'working' ? { ...t, status: 'interrupted' } : t) } : w);
  }
  list(ownerId?: string) { return structuredClone(this.watches.filter((w) => !w.private || w.ownerId === ownerId)); }
  saved() { return this.list().filter((w) => !w.private); }
  create(ownerId: string, label: string, candidates: WatchCandidate[], privateWatch = false): ComputerWatch {
    const working = candidates.filter((c) => c.token !== undefined);
    if (!working.length) throw Error('Those workers are already idle. No watch was created.');
    if (this.watches.filter((w) => w.status === 'watching').length >= 32) throw Error('32 watches are already active. Cancel one first.');
    const watch: ComputerWatch = { id: randomUUID(), ownerId, label, createdAt: Date.now(), status: 'watching',
      targets: working.map((c) => ({ id: c.id, name: c.name, status: 'working' })), ...(privateWatch ? { private: true } : {}) };
    this.bindings.set(watch.id, new Map(working.map((c) => [c.id, c.token!])));
    this.watches.push(watch);
    // Never evict an armed watch to make room for history.
    const old = this.watches.filter((w) => w.status !== 'watching').slice(0, Math.max(0, this.watches.length - 100));
    this.watches = this.watches.filter((w) => !old.includes(w));
    return structuredClone(watch);
  }
  settle(id: string, token: number, outcome: Outcome) {
    for (const w of this.watches) {
      if (w.status !== 'watching' || this.bindings.get(w.id)?.get(id) !== token) continue;
      this.bindings.get(w.id)!.delete(id);
      const target = w.targets.find((t) => t.id === id)!;
      target.status = outcome;
      if (w.targets.some((t) => t.status === 'working')) continue;
      w.status = w.targets.some((t) => t.status === 'failed') ? 'failed'
        : w.targets.some((t) => t.status === 'interrupted') ? 'interrupted' : 'finished';
      w.endedAt = Date.now(); this.bindings.delete(w.id); this.changed(structuredClone(w));
    }
  }
  cancel(id: string, ownerId: string) {
    const w = this.watches.find((w) => w.id === id && (!w.private || w.ownerId === ownerId));
    if (!w) throw Error('No such watch.');
    if (w.status === 'watching') { w.status = 'cancelled'; w.endedAt = Date.now(); this.bindings.delete(id); }
    return structuredClone(w);
  }
  claimAnnouncement(id: string, ownerId: string) {
    const w = this.watches.find((w) => w.id === id && (!w.private || w.ownerId === ownerId));
    if (!w || !['finished', 'failed', 'interrupted'].includes(w.status) || w.announcedAt) return false;
    w.announcedAt = Date.now(); return true;
  }
  clearPrivate(ownerId: string) {
    for (const w of this.watches) if (w.private && w.ownerId === ownerId) this.bindings.delete(w.id);
    this.watches = this.watches.filter((w) => !w.private || w.ownerId !== ownerId);
  }
}
