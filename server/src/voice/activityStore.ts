import { randomUUID } from 'node:crypto';
import type { ComputerActivityEvent, ComputerActivityPolicy, ComputerActivityDelivery, ComputerActivitySnapshot } from '@archon/shared';
export const COMPUTER_UPDATES_PER_HOUR = 12;
export const COMPUTER_PENDING_UPDATES = 50;
export interface ActivitySaved {
  ledger: ComputerActivityEvent[];
  policies: Array<ComputerActivityPolicy & { ownerId: string; private?: boolean }>;
  deliveries: ComputerActivityDelivery[];
  runs?: Array<{ownerId:string;at:number;private?:boolean}>;
}
export class ComputerActivity {
  private ledger: ComputerActivityEvent[];
  private policies: ActivitySaved['policies'];
  private deliveries: ComputerActivityDelivery[];
  private runs: NonNullable<ActivitySaved['runs']>;
  constructor(saved: ActivitySaved = {ledger:[],policies:[],deliveries:[]}) {
    this.runs = (saved.runs ?? []).filter((r)=>!r.private && r.at>Date.now()-3_600_000);
    this.ledger = saved.ledger.filter((e) => !e.private).slice(-200);
    this.policies = saved.policies.filter((p) => !p.private);
    this.deliveries = saved.deliveries.filter((d) => !d.private).map((d) => ['queued','delivering'].includes(d.status)
      ? {...d,status:'interrupted',endedAt:Date.now(),reason:'Server restarted; update was not replayed.'} : d);
  }
  policy(ownerId: string): ComputerActivityPolicy { const p = this.policies.find((p) => p.ownerId === ownerId); return {enabled:p?.enabled ?? true,agentUpdates:p?.agentUpdates ?? 'off'}; }
  configure(ownerId: string, change: Partial<ComputerActivityPolicy>, privatePolicy = false) {
    const previous = this.policies.find((p) => p.ownerId === ownerId);
    if (!previous && this.policies.length >= 100) throw Error('Computer activity configuration limit reached.');
    const policy = {...this.policy(ownerId),...change,ownerId,...(privatePolicy ? {private:true} : {})};
    this.policies = this.policies.filter((p) => p.ownerId !== ownerId); this.policies.push(policy);
    if (!policy.enabled || policy.agentUpdates === 'off') this.cancelQueued(ownerId,'Agent updates disabled.');
    return this.policy(ownerId);
  }
  add(event: ComputerActivityEvent) {
    if (this.ledger.some((e) => e.id === event.id)) return;
    this.ledger.push(event);
    // Public traffic cannot evict private state into the saved projection.
    const publicRows = this.ledger.filter((e) => !e.private).slice(-200);
    const privateOwners = new Set(this.ledger.filter((e) => e.private).map((e) => e.ownerId));
    this.ledger = [...publicRows,...[...privateOwners].flatMap((owner) => this.ledger.filter((e) => e.private && e.ownerId === owner).slice(-50))].sort((a,b) => a.at-b.at);
    for (const p of this.policies) {
      if (!p.enabled || p.agentUpdates === 'off') continue;
      const match = event.ownerId === p.ownerId && ['condition_matched','condition_stopped'].includes(event.kind);
      const worker = p.agentUpdates === 'workers' && ['worker_finished','worker_failed','worker_interrupted','worker_compaction_finished','worker_compaction_failed'].includes(event.kind);
      if ((!match && !worker) || (event.private && event.ownerId !== p.ownerId)) continue;
      // A private Computer receives public worker facts in a PRIVATE inbox.
      this.enqueue(p.ownerId,event,!!p.private || !!event.private);
    }
  }
  private enqueue(ownerId: string, event: ComputerActivityEvent, privateDelivery: boolean) {
    if (this.deliveries.some((d) => d.ownerId === ownerId && d.event.id === event.id)) return;
    const pending = this.deliveries.filter((d) => d.ownerId === ownerId && d.status === 'queued');
    if (pending.length >= COMPUTER_PENDING_UPDATES) {
      // Explicit overflow rather than a silent drop or unbounded prompt queue.
      pending[0].status = 'cancelled'; pending[0].reason = '50-update queue limit reached; review the activity ledger.'; pending[0].endedAt = Date.now();
    }
    this.deliveries.push({id:randomUUID(),ownerId,event,status:'queued',createdAt:Date.now(),...(privateDelivery ? {private:true} : {})});
    const owners = new Set(this.deliveries.map((d) => d.ownerId));
    const terminal = new Set([...owners].flatMap((id) => this.deliveries.filter((d)=>d.ownerId===id && !['queued','delivering'].includes(d.status)).slice(-40).map((d)=>d.id)));
    this.deliveries = this.deliveries.filter((d)=>['queued','delivering'].includes(d.status) || terminal.has(d.id));
  }
  owners() { return this.policies.map((p) => p.ownerId); }
  queued(ownerId: string) { return this.deliveries.filter((d) => d.ownerId === ownerId && d.status === 'queued').slice(0,10); }
  nextAllowedAt(ownerId: string, now = Date.now()) {
    const batches = this.runs.filter((r)=>r.ownerId===ownerId && r.at>now-3_600_000).map((r)=>r.at).sort((a,b)=>a-b);
    return batches.length >= COMPUTER_UPDATES_PER_HOUR ? batches[batches.length-COMPUTER_UPDATES_PER_HOUR]+3_600_000 : now;
  }
  start(ids: string[], now = Date.now()) {
    const first=this.deliveries.find((d)=>ids.includes(d.id) && d.status==='queued');if(!first)return;
    this.runs=this.runs.filter((r)=>r.at>now-3_600_000);
    this.runs.push({ownerId:first.ownerId,at:now,...(first.private?{private:true}:{})});
    for (const d of this.deliveries) if (ids.includes(d.id) && d.status === 'queued') {d.status='delivering';d.startedAt=now;}
  }
  settle(ids: string[], error?: string) { for (const d of this.deliveries) if (ids.includes(d.id) && d.status === 'delivering') {d.status=error?'failed':'delivered';d.reason=error;d.endedAt=Date.now();} }
  failQueued(ids: string[],reason:string) { for(const d of this.deliveries)if(ids.includes(d.id)&&d.status==='queued'){d.status='failed';d.reason=reason;d.endedAt=Date.now();} }
  cancelQueued(ownerId: string, reason = 'Cancelled by the operator.') { for (const d of this.deliveries) if (d.ownerId === ownerId && d.status === 'queued') {d.status='cancelled';d.reason=reason;d.endedAt=Date.now();} }
  snapshot(ownerId: string): ComputerActivitySnapshot {
    const own=this.deliveries.filter((d)=>d.ownerId===ownerId);
    const recentTerminal=new Set(own.filter((d)=>!['queued','delivering'].includes(d.status)).slice(-30).map((d)=>d.id));
    const next=this.nextAllowedAt(ownerId);
    return structuredClone({policy:this.policy(ownerId),updatesThisHour:this.runs.filter((r)=>r.ownerId===ownerId&&r.at>Date.now()-3_600_000).length,nextUpdateAt:next>Date.now()?next:undefined,ledger:this.ledger.filter((e) => !e.private || e.ownerId === ownerId).slice(-100),
      deliveries:own.filter((d)=>['queued','delivering'].includes(d.status) || recentTerminal.has(d.id)),pending:this.deliveries.filter((d) => d.ownerId === ownerId && d.status === 'queued').length,updatesPerHour:COMPUTER_UPDATES_PER_HOUR});
  }
  saved(): ActivitySaved { return structuredClone({ledger:this.ledger.filter((e) => !e.private),policies:this.policies.filter((p) => !p.private),deliveries:this.deliveries.filter((d) => !d.private),runs:this.runs.filter((r)=>!r.private)}); }
  clearPrivate(ownerId: string) { this.ledger=this.ledger.filter((e) => !e.private || e.ownerId !== ownerId);this.policies=this.policies.filter((p) => !p.private || p.ownerId !== ownerId);this.deliveries=this.deliveries.filter((d) => !d.private || d.ownerId !== ownerId);this.runs=this.runs.filter((r)=>!r.private || r.ownerId!==ownerId); }
  interrupt() { for(const d of this.deliveries)if(['queued','delivering'].includes(d.status)){d.status='interrupted';d.reason='Server stopped; update was not replayed.';d.endedAt=Date.now();} }
}
