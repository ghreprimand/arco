import { z } from 'zod';
import type { ConditionExpression, ComputerConditionDefinition } from '@arco/shared';
import { conditionActionTargets } from '@arco/shared';
export const conditionId = z.string().regex(/^[a-zA-Z0-9-]{8,80}$/);
export const conditionField = z.enum(['busy','queued','pending_mail','has_work','needs_input','turns_finished','turns_failed','turns_interrupted','mail_received','context_percent','context_tokens','context_window','compacting','can_compact','compactions_finished']);
const cmp = z.enum(['eq','ne','gt','gte','lt','lte']);
const value = z.union([z.boolean(),z.number().min(0).max(10000000)]);
const ids = z.array(conditionId).min(1).max(32).refine((ids)=>new Set(ids).size===ids.length,'Duplicate worker ids.');
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const optionalLimit = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().default(null);
export const savedConditionRule=z.object({
  id:conditionId,ownerId:conditionId,definition:z.unknown(),revision:z.number().int().nonnegative().optional(),
  members:z.array(z.object({id:conditionId,clusterId:conditionId,name:z.string().max(100)}).strict()).min(1).max(32),
  status:z.enum(['watching','finished','cancelled','failed','interrupted','expired','limited']),reason:z.string().max(1024),
  createdAt:z.number().int().nonnegative(),expiresAt:z.number().int().nonnegative().nullable(),paused:z.boolean().optional(),private:z.boolean().optional(),
  actions:counter,workerTurns:z.record(conditionId,z.object({count:counter,at:z.number().int().nonnegative()}).strict()),
  fired:z.array(z.string().max(32)).max(8),activated:z.array(z.string().max(32)).max(8).optional(),
  executions:z.record(z.string().max(160),z.array(z.string().max(64))),mailSeen:z.record(conditionId,z.array(z.string().max(256)).max(4096)),
  announcements:z.array(z.object({id:z.string().max(100),text:z.string().max(1024),at:z.number().int().nonnegative(),claimed:z.boolean().optional()}).strict()),
}).strict();
// A finite schema tree makes the complexity budget visible and avoids recursive
// JSON-schema references that some local tool transports cannot accept.
function expression(depth: number): z.ZodType<ConditionExpression> {
  const leaves = [
    z.object({op:z.literal('worker'),worker_id:conditionId,field:conditionField,cmp,value}).strict(),
    z.object({op:z.literal('group'),worker_ids:ids,quantifier:z.enum(['all','any','none']),field:conditionField,cmp,value}).strict(),
    z.object({op:z.literal('count'),worker_ids:ids,field:conditionField,test:cmp,value,cmp,count:z.number().int().min(0).max(32)}).strict(),
  ] as const;
  if (!depth) return z.union(leaves);
  const child = expression(depth-1);
  return z.union([...leaves,z.object({op:z.enum(['all','any']),conditions:z.array(child).min(1).max(8)}).strict(),z.object({op:z.literal('not'),condition:child}).strict()]);
}
export const conditionDefinition = z.object({
  label:z.string().min(1).max(160),cluster_ids:z.array(conditionId).min(1).max(4),hold_on_input:z.boolean().default(true),
  hold_worker_ids:ids.optional(),
  stop_on_error:z.boolean().default(true),stop_on_interrupt:z.boolean().default(true),
  clauses:z.array(z.object({id:z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),when:expression(4),
    actions:z.array(z.union([
      z.object({kind:z.literal('nudge_mail'),worker_ids:ids}).strict(),
      z.object({kind:z.literal('nudge'),worker_ids:ids}).strict(),
      z.object({kind:z.literal('send_message'),worker_id:conditionId,text:z.string().min(1).max(2000)}).strict(),
      z.object({kind:z.literal('compact'),worker_id:conditionId}).strict(),
      z.object({kind:z.literal('notify'),text:z.string().min(1).max(600)}).strict(),
      z.object({kind:z.literal('tool'),name:z.string().max(60),args:z.record(z.string().max(32),z.string().max(2000))}).strict(),
    ])).min(1).max(4),repeat:z.enum(['once','changes']).default('once'),
    watch:z.array(z.object({worker_id:conditionId,field:conditionField}).strict()).max(32).optional(),
    after:z.array(z.string().max(32)).max(8).optional(),finish:z.boolean().optional(),
  }).strict()).min(1).max(8),
  ttl_minutes:optionalLimit,max_actions:optionalLimit,
  max_worker_turns:optionalLimit,cooldown_seconds:z.number().int().min(0).max(Math.floor(Number.MAX_SAFE_INTEGER/1000)).default(30),
}).strict() satisfies z.ZodType<ComputerConditionDefinition>;
export function parseConditionDefinition(raw: unknown) {
  const d = conditionDefinition.parse(raw);
  if (new Set(d.cluster_ids).size !== d.cluster_ids.length) throw Error('Duplicate cluster ids.');
  const previous = new Set<string>();let nodes=0;
  const check = (e:ConditionExpression) => {
    if(++nodes>128)throw Error('Condition exceeds 128 expression nodes.');
    if('conditions' in e)e.conditions.forEach(check);
    else if(e.op==='not')check(e.condition);
    else {
      const bool = ['busy','has_work','needs_input','compacting','can_compact'].includes(e.field);
      if(bool !== (typeof e.value==='boolean') || (bool && !['eq','ne'].includes(e.op==='count'?e.test:e.cmp)))throw Error('Boolean facts require eq/ne and a boolean; counters require a number.');
    }
  };
  for(const c of d.clauses){
    // Catalog alias, not utterance matching. Compaction is the same requested
    // operation, but server execution need not borrow a microphone/browser.
    c.actions=c.actions.map((a)=>{
      if(a.kind!=='tool')return a;
      if(a.name==='arco_compact')return {kind:'compact' as const,worker_id:conditionId.parse(a.args.target)};
      if(a.name==='arco_nudge')return {kind:'nudge' as const,worker_ids:[conditionId.parse(a.args.target)]};
      if(a.name==='arco_send_message'){
        if(a.args.mode&&a.args.mode!=='follow-up')throw Error('Scripted worker messages wait for idle; use a separate explicit cancel action if interruption was requested.');
        return {kind:'send_message' as const,worker_id:conditionId.parse(a.args.target),text:z.string().min(1).max(2000).parse(a.args.text)};
      }
      return a;
    });
    if(previous.has(c.id) || c.after?.some((id)=>!previous.has(id)))throw Error('Clause ids must be unique; after references only earlier clauses.');
    previous.add(c.id);check(c.when);
    if(c.finish && c.repeat!=='once')throw Error('A finishing clause must run once.');
  }
  for(const c of d.clauses){
    const chain=new Set<string>();
    const collect=(id:string)=>{if(chain.has(id))return;chain.add(id);d.clauses.find((v)=>v.id===id)!.after?.forEach(collect);};
    collect(c.id);let actions=0;const turns=new Map<string,number>();
    for(const v of d.clauses.filter((v)=>chain.has(v.id)))for(const a of v.actions){
      const targets=conditionActionTargets(a);
      actions+=targets.length||1;for(const id of targets)turns.set(id,(turns.get(id)??0)+1);
    }
    if(d.max_actions!==null&&actions>d.max_actions)throw Error(`Clause ${c.id} and its dependencies need at least ${actions} actions; max_actions is ${d.max_actions}.`);
    for(const [id,count] of turns)if(d.max_worker_turns!==null&&count>d.max_worker_turns)throw Error(`This sequence needs at least ${count} worker turns for ${id} (compaction counts); max_worker_turns is ${d.max_worker_turns}.`);
  }
  return d;
}
