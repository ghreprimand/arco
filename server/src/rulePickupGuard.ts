import type { RulePickupLimits } from '@arco/shared';

interface Wake { sender: string; recipient: string }
interface State { wakes: number; members: Map<string, number[]>; chain: Wake[]; pausedPair?: [string, string]; budgetPaused: boolean }

/** Admission state, persisted before dispatch. All methods run on the server event loop. */
export class RulePickupGuard {
  private clusters = new Map<string, State>();
  constructor(private readonly load?: (cluster: string) => string | undefined, private readonly save?: (cluster: string, text: string) => void) {}
  private persist(cluster: string, s: State): void {
    this.save?.(cluster, JSON.stringify({ version: 1, wakes: s.wakes, members: [...s.members], chain: s.chain, pausedPair: s.pausedPair, budgetPaused: s.budgetPaused }));
  }
  private state(cluster: string): State {
    let s = this.clusters.get(cluster);
    if (!s) {
      const raw = this.load?.(cluster);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.version !== 1 || !Number.isSafeInteger(parsed.wakes) || parsed.wakes < 0 || !Array.isArray(parsed.members) || !Array.isArray(parsed.chain) || typeof parsed.budgetPaused !== 'boolean') throw new Error('Invalid Rule-based pickup ledger');
        s = { wakes: parsed.wakes, members: new Map(parsed.members), chain: parsed.chain, pausedPair: parsed.pausedPair, budgetPaused: parsed.budgetPaused };
        for (const [id, times] of s.members) if (typeof id !== 'string' || !Array.isArray(times) || times.some((t) => !Number.isFinite(t))) throw new Error('Invalid Rule-based pickup ledger');
        if (s.chain.some((w) => typeof w.sender !== 'string' || typeof w.recipient !== 'string') || (s.pausedPair && (!Array.isArray(s.pausedPair) || s.pausedPair.length !== 2 || s.pausedPair.some((id) => typeof id !== 'string')))) throw new Error('Invalid Rule-based pickup ledger');
      } else s = { wakes: 0, members: new Map(), chain: [], budgetPaused: false };
      this.clusters.set(cluster, s);
    }
    return s;
  }
  reset(cluster: string): void { this.resume(cluster); }
  drop(cluster: string): void { this.clusters.delete(cluster); }
  changed(cluster: string): void { const s = this.state(cluster); if (!s.pausedPair && s.chain.length) { s.chain = []; this.persist(cluster, s); } }
  resume(cluster: string): void { const s = this.state(cluster); s.wakes = 0; s.budgetPaused = false; s.chain = []; s.pausedPair = undefined; this.persist(cluster, s); }
  interrupt(cluster: string, member?: string): void {
    const s = this.state(cluster);
    if ((!member || !s.pausedPair || s.pausedPair.includes(member)) && (s.pausedPair || s.chain.length)) { s.pausedPair = undefined; s.chain = []; this.persist(cluster, s); }
  }
  mail(cluster: string, sender: string, recipient: string): void {
    const s = this.state(cluster);
    if (s.pausedPair && s.pausedPair.includes(recipient) && !s.pausedPair.includes(sender)) this.interrupt(cluster, recipient);
    const last = s.chain.at(-1);
    if (last && !(last.sender === recipient && last.recipient === sender)) { s.chain = []; this.persist(cluster, s); }
  }
  admit(cluster: string, sender: string, recipient: string, limits: RulePickupLimits, now = Date.now()): 'budget_paused' | 'member_capped' | 'pair_paused' | null {
    const s = this.state(cluster);
    if (s.budgetPaused) return 'budget_paused';
    if (s.wakes >= limits.wakesPerArming) { s.budgetPaused = true; this.persist(cluster, s); return 'budget_paused'; }
    if (s.pausedPair && s.pausedPair.includes(sender) && s.pausedPair.includes(recipient)) return 'pair_paused';
    const times = (s.members.get(recipient) ?? []).filter((t) => t > now - 3_600_000);
    s.members.set(recipient, times);
    if (times.length >= limits.wakesPerMemberHour) return 'member_capped';
    return null;
  }
  stamp(cluster: string, sender: string, recipient: string, limits: RulePickupLimits, now = Date.now()): { budgetPaused: boolean; pairPaused: boolean } {
    const s = this.state(cluster); s.wakes++; (s.members.get(recipient) ?? (s.members.set(recipient, []), s.members.get(recipient)!)).push(now);
    const last = s.chain.at(-1);
    if (!last || (last.sender === recipient && last.recipient === sender)) s.chain.push({ sender, recipient });
    else s.chain = [{ sender, recipient }];
    const pairPaused = s.chain.length >= limits.pingPongWakes;
    if (pairPaused) s.pausedPair = [sender, recipient];
    const budgetPaused = s.wakes >= limits.wakesPerArming;
    if (budgetPaused) s.budgetPaused = true;
    this.persist(cluster, s);
    return { budgetPaused, pairPaused };
  }
  snapshot(cluster: string) { const s = this.state(cluster); return { wakes: s.wakes, budgetPaused: s.budgetPaused, pausedPair: s.pausedPair }; }
}
