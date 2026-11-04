import { createHash, randomUUID } from 'node:crypto';
import { conditionActionTargets } from '@arco/shared';
import { isDeepStrictEqual } from 'node:util';
import type { ComputerConditionDefinition, ComputerConditionRule, ConditionExpression, ConditionWorkerFacts, ConditionComparison, ConditionAction, ConditionField } from '@arco/shared';
type Truth = boolean | null;
export function compareFact(a: number | boolean | null | undefined, cmp:ConditionComparison,b:number|boolean):Truth {
  if(a===null || a===undefined || typeof a!==typeof b)return null;
  switch(cmp){case'eq':return a===b;case'ne':return a!==b;case'gt':return a>b;case'gte':return a>=b;case'lt':return a<b;case'lte':return a<=b;}
}
export function testCondition(e:ConditionExpression,f:ConditionWorkerFacts[]):Truth {
  if(e.op==='not'){const v=testCondition(e.condition,f);return v===null?null:!v;}
  if('conditions' in e){
    const v=e.conditions.map((c)=>testCondition(c,f));
    return e.op==='all'?(v.includes(false)?false:v.includes(null)?null:true):(v.includes(true)?true:v.includes(null)?null:false);
  }
  if(e.op==='worker')return compareFact(f.find((w)=>w.id===e.worker_id)?.[e.field],e.cmp,e.value);
  const values=e.worker_ids.map((id)=>compareFact(f.find((w)=>w.id===id)?.[e.field],e.op==='count'?e.test:e.cmp,e.value));
  if(e.op==='count')return values.includes(null)?null:compareFact(values.filter(Boolean).length,e.cmp,e.count);
  if(e.quantifier==='all')return values.includes(false)?false:values.includes(null)?null:true;
  const any=values.includes(true)?true:values.includes(null)?null:false;
  return e.quantifier==='none'?(any===null?null:!any):any;
}
export function conditionRefs(e:ConditionExpression):Array<{worker_id:string;field:ConditionField}> {
  if('conditions' in e)return e.conditions.flatMap(conditionRefs);
  if(e.op==='not')return conditionRefs(e.condition);
  return (e.op==='worker'?[e.worker_id]:e.worker_ids).map((worker_id)=>({worker_id,field:e.field}));
}
export interface ConditionCandidate { clause:string; key:string; signature:string; action:ConditionAction; targetId?:string; messageIds?:string[] }
function expiry(minutes:number|null,now:number){
  if(minutes===null)return null;
  const at=now+minutes*60000;
  if(!Number.isSafeInteger(at)||at>8640000000000000)throw Error('Script expiry exceeds the supported date range.');
  return at;
}
export class ComputerConditions {
  rules:ComputerConditionRule[];
  constructor(saved:ComputerConditionRule[]=[]){this.rules=structuredClone(saved.filter((r)=>!r.private));for(const r of this.rules)if(r.status==='watching')this.stop(r.id,'interrupted','Server restarted; re-arm explicitly.');}
  saved(){return this.rules.filter((r)=>!r.private);}
  list(ownerId:string){return structuredClone(this.rules.filter((r)=>!r.private||r.ownerId===ownerId));}
  get(id:string){return this.rules.find((r)=>r.id===id);}
  update(id:string,definition:ComputerConditionDefinition,facts:ConditionWorkerFacts[],now=Date.now()){
    const r=this.get(id);if(!r||r.status!=='watching')throw Error('Only an active script can be updated.');
    if(r.definition.cluster_ids.slice().sort().join()!==definition.cluster_ids.slice().sort().join())throw Error('Changing cluster scope requires a separate script.');
    if(r.members.map((m)=>m.id+':'+m.clusterId).sort().join()!==facts.map((m)=>m.id+':'+m.clusterId).sort().join())throw Error('Pinned membership changed.');
    const refs=[...(definition.hold_worker_ids??[]),...definition.clauses.flatMap((c)=>[...conditionRefs(c.when),...(c.watch??[])]).map((v)=>v.worker_id),...definition.clauses.flatMap((c)=>c.actions.flatMap((a)=>conditionActionTargets(a)))];
    if(refs.some((id)=>!facts.some((w)=>w.id===id)))throw Error('Condition references a worker outside its exact scope.');
    const workerLimit=definition.max_worker_turns;
    if((definition.max_actions!==null&&r.actions>=definition.max_actions)||(workerLimit!==null&&Object.values(r.workerTurns).some((v)=>v.count>workerLimit)))throw Error('The new budget is already spent; choose a sufficient budget or remove the limit.');
    // Preserve the absolute deadline on ordinary edits. An explicit TTL change
    // starts a new duration; null removes expiry without recreating the script.
    const expiresAt=definition.ttl_minutes===r.definition.ttl_minutes?r.expiresAt:expiry(definition.ttl_minutes,now);
    const executions:Record<string,string[]>={};
    for(const c of definition.clauses){const used=new Set<number>();const old=r.definition.clauses.find((v)=>v.id===c.id);if(!old)continue;
      for(let i=0;i<c.actions.length;i++){const prior=old.actions.findIndex((a,j)=>!used.has(j)&&isDeepStrictEqual(a,c.actions[i]));if(prior<0)continue;used.add(prior);
        const prefix=`${c.id}:${prior}:`;for(const [key,value] of Object.entries(r.executions))if(key.startsWith(prefix))executions[`${c.id}:${i}:${key.slice(prefix.length)}`]=value;
      }
    }
    r.executions=executions;
    r.fired=r.fired.filter((id)=>{const c=definition.clauses.find((v)=>v.id===id);return !!c&&c.actions.every((a,i)=>{const ids=(a.kind==='notify'||a.kind==='tool')?[undefined]:conditionActionTargets(a);return ids.every((id)=>executions[`${c.id}:${i}:${id??'notify'}`]?.length);});});
    r.activated=r.activated?.filter((id)=>{const a=r.definition.clauses.find((v)=>v.id===id),b=definition.clauses.find((v)=>v.id===id);return a&&b&&isDeepStrictEqual(a.when,b.when)&&isDeepStrictEqual(a.after,b.after);});
    r.definition=structuredClone(definition);r.expiresAt=expiresAt;r.revision=(r.revision??0)+1;r.reason='Updated by operator; existing spend and mail deduplication retained.';
    return structuredClone(r);
  }
  create(ownerId:string,definition:ComputerConditionDefinition,facts:ConditionWorkerFacts[],privateRule=false,now=Date.now()){
    if(this.rules.filter((r)=>r.status==='watching').length>=16)throw Error('16 active conditions already exist.');
    const refs=[...(definition.hold_worker_ids??[]),...definition.clauses.flatMap((c)=>[...conditionRefs(c.when),...(c.watch??[])]).map((r)=>r.worker_id)];
    const targets=definition.clauses.flatMap((c)=>c.actions.flatMap((a)=>conditionActionTargets(a)));
    if([...refs,...targets].some((id)=>!facts.some((w)=>w.id===id)))throw Error('Condition references a worker outside its exact cluster scope.');
    const r:ComputerConditionRule={id:randomUUID(),ownerId,revision:0,definition:structuredClone(definition),members:facts.map(({id,clusterId,name})=>({id,clusterId,name})),status:'watching',reason:'Armed; waiting for conditions.',createdAt:now,expiresAt:expiry(definition.ttl_minutes,now),actions:0,workerTurns:{},fired:[],executions:{},mailSeen:{},announcements:[],...(privateRule?{private:true}:{})};
    this.rules.push(r);if(this.rules.length>100)this.rules=this.rules.filter((x)=>x.status==='watching'||x===r||this.rules.filter((a)=>a.status!=='watching').slice(-84).includes(x));
    return structuredClone(r);
  }
  stop(id:string,status:ComputerConditionRule['status'],reason:string){const r=this.get(id);if(r?.status==='watching'){r.status=status;r.reason=reason;if(status!=='finished'&&status!=='cancelled')r.announcements.push({id:`terminal-${r.id}`,text:`${r.definition.label}: ${reason}`,at:Date.now()});}}
  next(id:string,facts:ConditionWorkerFacts[],now=Date.now()):ConditionCandidate|undefined {
    const r=this.get(id);if(!r||r.status!=='watching')return;
    if(r.expiresAt!==null&&now>=r.expiresAt){this.stop(id,'expired','Condition time limit reached.');return;}
    if(r.members.map((m)=>m.id+':'+m.clusterId).sort().join()!==facts.map((m)=>m.id+':'+m.clusterId).sort().join()){this.stop(id,'interrupted','Cluster membership changed.');return;}
    if(r.paused)return;
    // Unknown is never negated into permission to proceed. Holding also blocks
    // completion notices, so "all idle" cannot claim an unanswered question is done.
    // Running output is not yet classifiable. Never turn it into a false fact:
    // structured questions hold immediately; an idle unknown holds before action.
    const heldWorkers=facts.filter((w)=>(!r.definition.hold_worker_ids||r.definition.hold_worker_ids.includes(w.id))&&(w.needs_input===true||(w.needs_input===null&&!w.busy)));
    const inputHeld=r.definition.hold_on_input && heldWorkers.length>0;
    r.reason=inputHeld?'Holding for operator input/check: '+heldWorkers.map((w)=>w.name).join(', ').slice(0,400):'Waiting for conditions.';
    for(const c of r.definition.clauses){
      if(inputHeld && !(c.actions.every((a)=>a.kind==='notify')&&conditionRefs(c.when).some((v)=>v.field==='needs_input')))continue;
      if(c.after?.some((id)=>!r.fired.includes(id))||(!(c.repeat==='once'&&r.activated?.includes(c.id))&&testCondition(c.when,facts)!==true))continue;
      const refs=[...conditionRefs(c.when),...(c.watch??[])];
      const signature=c.repeat==='once'?'once':createHash('sha256').update(JSON.stringify(refs.map((v)=>[v.worker_id,v.field,facts.find((w)=>w.id===v.worker_id)?.[v.field]]))).digest('hex');
      actions: for(let i=0;i<c.actions.length;i++){
        const a=c.actions[i],targets=(a.kind==='notify'||a.kind==='tool')?[undefined]:conditionActionTargets(a);
        let waiting=false;
        for(const targetId of targets){
          const key=`${c.id}:${i}:${targetId??'notify'}`,w=facts.find((w)=>w.id===targetId);
          const sig=a.kind==='nudge_mail'&&c.repeat==='changes'?createHash('sha256').update(JSON.stringify(w?.pendingIds.slice().sort())).digest('hex'):signature;
          if(r.executions[key]?.includes(sig))continue;
          if(targetId){
            if(!w||w.busy||w.queued||w.compacting|| (r.definition.hold_on_input&&w.needs_input!==false)){waiting=true;continue;}
            if(a.kind==='nudge_mail'&&(!w.pendingIds.length||!w.pendingIds.some((m)=>!r.mailSeen[targetId!]?.includes(m)))){waiting=true;continue;}
            const turns=r.workerTurns[targetId];
            if(turns&&(a.kind==='nudge_mail'||c.repeat==='changes')&&now-turns.at<r.definition.cooldown_seconds*1000){waiting=true;continue;}
            if(r.definition.max_worker_turns!==null&&(turns?.count??0)>=r.definition.max_worker_turns){this.stop(id,'limited',`${w.name} reached its worker-turn limit.`);return;}
          }
          if(r.definition.max_actions!==null&&r.actions>=r.definition.max_actions){this.stop(id,'limited','Action limit reached.');return;}
          return {clause:c.id,key,signature:sig,action:a,targetId,...(a.kind==='nudge_mail'?{messageIds:w!.pendingIds}: {})};
        }
        if(waiting)break actions;
      }
      const complete=c.actions.every((a,i)=>{
        const targets=(a.kind==='notify'||a.kind==='tool')?[undefined]:conditionActionTargets(a);
        return targets.every((id)=>r.executions[`${c.id}:${i}:${id??'notify'}`]?.includes('once'));
      });
      if(c.finish && complete) {this.stop(id,'finished','Finishing condition matched; its actions were dispatched.');return;}
    }
  }
  record(id:string,a:ConditionCandidate,now=Date.now()){
    const r=this.get(id);if(!r||r.status!=='watching')return;
    (r.executions[a.key]??=[]).push(a.signature);r.actions++;
    const clause=r.definition.clauses.find((c)=>c.id===a.clause)!;
    if(clause.repeat==='once'&&!(r.activated??=[]).includes(clause.id))r.activated.push(clause.id);
    const complete=clause.actions.every((action,i)=>{
      const ids=(action.kind==='notify'||action.kind==='tool')?[undefined]:conditionActionTargets(action);
      return ids.every((id)=>r.executions[`${clause.id}:${i}:${id??'notify'}`]?.length);
    });
    if(complete&&!r.fired.includes(a.clause))r.fired.push(a.clause);
    if(a.targetId){const v=r.workerTurns[a.targetId];r.workerTurns[a.targetId]={count:(v?.count??0)+1,at:now};if(a.messageIds)r.mailSeen[a.targetId]=a.messageIds.slice();}
    else if(a.action.kind==='notify')r.announcements.push({id:randomUUID(),text:a.action.text,at:now});
    r.reason=`Applied ${a.action.kind} in ${a.clause}.`;
  }
  deadline(id:string,enabled:boolean,now=Date.now()) {const r=this.get(id);if(!r||r.status!=='watching')return;const at=Math.min(r.expiresAt??Infinity,...(!r.paused&&enabled?Object.values(r.workerTurns).map((w)=>w.at+r.definition.cooldown_seconds*1000).filter((at)=>at>now):[]));return Number.isFinite(at)?at:undefined;}
  clearPrivate(ownerId:string){this.rules=this.rules.filter((r)=>!r.private||r.ownerId!==ownerId);}
}
