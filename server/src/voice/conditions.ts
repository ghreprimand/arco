import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { conditionActionTargets, voiceText, type ComputerConditionRule, type ConditionWorkerFacts, type VoiceOperatorTool } from '@archon/shared';
import { atomicWriteFile, withFileLock } from '../atomicFile.js';
import { workflows, workflowCwds } from '../server/state.js';
import type { WorkflowState } from '../workflows/types.js';
import * as clusters from '../clusterStore.js';
import { pendingIdsStrict } from '../clusterMailbox.js';
import { broadcastWorkflow } from '../server/broadcast.js';
import { getClaudeNativePendingInteractions } from '../providers/claude-native/index.js';
import { pendingOperatorQuestions } from '../providers/codex-appserver/operatorQuestions.js';
import { emit } from '../notifications.js';
import { readSettings } from '../settings.js';
import { subscribeActivity, subscribeComputerPolicy, computerProjectionChanged } from './activityBus.js';
import { activityReady, activityPolicy, recordComputerCondition } from './activity.js';
import { observedWorker, forgetObservedWorker } from './conditionFacts.js';
import { restoreConditionContext } from './conditionContext.js';
import { restoreConditionReply, retryConditionReply } from './conditionReply.js';
import { observeInputWithLuna } from './inputObservation.js';
import { conditionId, conditionField, parseConditionDefinition, savedConditionRule } from './conditionSchema.js';
import { ComputerConditions, conditionRefs, type ConditionCandidate } from './conditionStore.js';
import { hasActiveMailRulesForCluster } from './mailRules.js';
import { COMPUTER_TOOL_SPECS, computerToolWireArgs } from './toolDefinitions.js';
import { requestVoiceTool } from './operatorTools.js';
import { archonHome } from '../archonHome.js';

const file=process.env.ARCHON_COMPUTER_CONDITIONS_FILE??join(archonHome(), 'computer-conditions.json');
let store:ComputerConditions|undefined,loading:Promise<ComputerConditions>|undefined,stopped=false,running=false,scheduled=false,warning:string|undefined;
type Dispatch=(id:string,text:string,guard:(claim:()=>boolean)=>Promise<boolean>)=>Promise<boolean>;
let dispatch:Dispatch|undefined;
let compactDispatch:Dispatch|undefined;
const dirty=new Set<string>(),timers=new Map<string,ReturnType<typeof setTimeout>>(),published=new Set<string>(),delivered=new Set<string>();
const observing=new Map<string,AbortController>();
// Fixed observer budget belongs to the armed script, independent of the optional
// activity feed. Only changed public replies are sent, batched, never polled.
const observationRuns=new Map<string,number[]>();
const deniedTools=new Set(['archon_condition','archon_mail_rule','archon_watch','archon_activity','archon_computer']);
function toolArgs(a:{name:string;args:Record<string,string>}) {
  if(deniedTools.has(a.name))throw Error('Scripts cannot create automations or change Computer configuration.');
  const spec=COMPUTER_TOOL_SPECS.find((s)=>s.name===a.name);if(!spec)throw Error('Unknown scripted operator tool.');
  const input:Record<string,unknown>={...a.args};
  // Match normal catalog types; a script cannot bypass ordinary tool validation.
  const schema=z.toJSONSchema(z.object(spec.shape)) as {properties?:Record<string,{type?:string}>};
  for(const [k,v] of Object.entries(input)){if(schema.properties?.[k]?.type==='boolean'&&(v==='true'||v==='false'))input[k]=v==='true';}
  return computerToolWireArgs(z.object(spec.shape).strict().parse(input));
}
async function persist(){await withFileLock(file,()=>atomicWriteFile(file,JSON.stringify(store!.saved()),{mode:0o600}));}
async function ready(){
  const pending=loading??=(async()=>{
    let saved:ComputerConditionRule[]=[];
    try{
      const raw=JSON.parse(await readFile(file,'utf8'));
      if(!Array.isArray(raw)||raw.length>100)throw Error();
      saved=raw.map((value)=>{
        const r=savedConditionRule.parse(value);
        if(r.private||Object.keys(r.executions).length>128||Object.keys(r.workerTurns).length>32||Object.keys(r.mailSeen).length>32)throw Error();
        return {...r,definition:parseConditionDefinition(r.definition)};
      });
    }catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw Error('Cannot read Computer scripts; existing file kept.');}
    for(const r of saved){if(r.status!=='watching')published.add(r.id);for(const n of r.announcements)delivered.add(n.id);}
    store=new ComputerConditions(saved);if(saved.some((r)=>r.status==='watching'))await persist();return store;
  })();
  try{return await pending;}catch(e){store=undefined;loading=undefined;throw e;}
}
function invalidate(clusterId?:string){
  if(stopped||!store)return;
  if(clusterId)dirty.add(clusterId);else for(const r of store.rules)if(r.status==='watching')r.definition.cluster_ids.forEach((id)=>dirty.add(id));
  if(!scheduled){scheduled=true;setImmediate(()=>{scheduled=false;void evaluateConditions();});}
}
async function withScope<T>(ids:string[],run:()=>Promise<T>):Promise<T>{
  const sorted=ids.slice().sort();
  const lock=(i:number):Promise<T>=>i===sorted.length?run():withFileLock(clusters.clusterMailboxRoot(sorted[i]),()=>lock(i+1));
  return lock(0);
}
async function snapshot(ids:string[]):Promise<ConditionWorkerFacts[]>{
  const result:ConditionWorkerFacts[]=[];
  for(const clusterId of ids){
    const members=clusters.getMembers(clusterId);if(!members?.length)throw Error('Cluster is unavailable.');
    for(const id of members){
      const wf=workflows.get(id);if(!wf||wf.config.incognito||wf.config.voiceOperator||wf.config.kind==='chat')throw Error('Worker is unavailable or private.');
      await restoreConditionContext(id,wf);
      const pendingIds=await pendingIdsStrict(clusterId,id),f=observedWorker(id);
      const native=getClaudeNativePendingInteractions(id);
      const question=!!native?.question||!!native?.gates.length||pendingOperatorQuestions(id).some((q)=>q.status==='pending');
      const settings=await readSettings(workflowCwds.get(id)??wf.config.workingDirectory).catch(()=>null);
      const provider=wf.primary.provider;
      const can_compact=provider==='ollama'||provider==='zai'||provider==='cursor'||(provider==='claude'&&(wf.config.claudeTransport??settings?.claude?.transport??'cli')==='native')||(provider==='codex'&&(wf.config.codexTransport??settings?.codex?.transport??'exec')==='appserver');
      result.push({id,clusterId,name:voiceText(wf.config.name??id,100),busy:false,queued:0,pending_mail:pendingIds.length,pendingIds,has_work:false,needs_input:question?true:f.input,
        turns_finished:f.finished,turns_failed:f.failed,turns_interrupted:f.interrupted,mail_received:f.mail,
        context_percent:f.percent,context_tokens:f.tokens,context_window:f.window,compacting:f.compacting,compactions_finished:f.compactions,can_compact});
    }
  }
  // Read all authoritative busy/queue state after I/O; no await before claim.
  for(const f of result){const wf=workflows.get(f.id);if(!wf||wf.config.incognito||wf.config.voiceOperator||clusters.getClusterIdForWorkflow(f.id)!==f.clusterId)throw Error('Membership changed.');f.busy=wf.busy;f.queued=wf.queue.steering.length+wf.queue.followUp.length;f.has_work=f.busy||!!f.queued||!!f.pending_mail;
    const interaction=getClaudeNativePendingInteractions(f.id);
    const waiting=!!interaction?.question||!!interaction?.gates.length||pendingOperatorQuestions(f.id).some((q)=>q.status==='pending');
    f.needs_input=waiting?true:observedWorker(f.id).input;
    if(f.context_window===null&&wf.lastContextUsage){f.context_tokens=wf.lastContextUsage.tokens;f.context_window=wf.lastContextUsage.window;f.context_percent=wf.lastContextUsage.percent;}
  }
  return result;
}
function armDeadlines(){
  for(const t of timers.values())clearTimeout(t);timers.clear();
  for(const r of store?.rules??[]){const at=store!.deadline(r.id,activityPolicy(r.ownerId).enabled);if(at===undefined)continue;
    const t=setTimeout(()=>{timers.delete(r.id);r.definition.cluster_ids.forEach(invalidate);},Math.min(2147483647,Math.max(0,at-Date.now())));t.unref();timers.set(r.id,t);}
}
function audit(r:ComputerConditionRule,text:string,targetId?:string){
  if(r.private)return;
  const content=`[COMPUTER SCRIPT ${r.id}] ${text}`;
  try{
    broadcastWorkflow(r.ownerId,{type:'system_notice',workflowId:r.ownerId,content});
    if(targetId)broadcastWorkflow(targetId,{type:'system_notice',workflowId:targetId,content});
  }catch{warning='A script audit could not be saved. Review its stored state.';}
}
function publish(){
  const retained=new Set(store?.rules.map((r)=>r.id)),announcements=new Set(store?.rules.flatMap((r)=>r.announcements.map((n)=>n.id)));
  for(const id of published)if(!retained.has(id))published.delete(id);
  for(const id of delivered)if(!announcements.has(id))delivered.delete(id);
  for(const r of store?.rules??[]){
    for(const n of r.announcements)if(!delivered.has(n.id)){
      delivered.add(n.id);recordComputerCondition(r.ownerId,r.definition.label,n.text,true,!!r.private);audit(r,`Notification: ${n.text}`);
      if(!r.private)try{emit({category:'computer-watch',severity:'info',title:'Computer script',body:n.text,workflowId:r.ownerId});}catch{warning='A script notification could not be delivered. Review its stored state.';}
    }
    if(r.status!=='watching'&&!published.has(r.id)){
      published.add(r.id);audit(r,`${r.status}: ${r.reason}`);
    }
  }
}
async function saveOrStop(){try{await persist();warning=undefined;}catch{warning='Script persistence failed; automatic actions stopped.';for(const r of store!.rules)if(!r.private)store!.stop(r.id,'failed',warning);}}
async function checkInput(r:ComputerConditionRule){
  const references=r.definition.clauses.flatMap((c)=>conditionRefs(c.when)).filter((r)=>r.field==='needs_input').map((r)=>r.worker_id);
  if(!r.definition.hold_on_input&&!references.length)return;
  const targets=r.definition.clauses.flatMap((c)=>c.actions.flatMap((a)=>a.kind==='tool'&&a.args.target?[a.args.target]:conditionActionTargets(a)));
  const changed:Array<{id:string;text:string;version:number;digest:string;source:WorkflowState}>=[];
  let holdReason:string|undefined;
  for(const m of r.members){
    if(!references.includes(m.id)&&(!r.definition.hold_on_input||(r.definition.hold_worker_ids&&!r.definition.hold_worker_ids.includes(m.id)&&!targets.includes(m.id))))continue;
    const wf=workflows.get(m.id);if(!wf||wf.busy||wf.config.incognito)continue;
    const f=observedWorker(m.id);
    if(f.input!==null)continue;
    const version=f.version;
    await restoreConditionReply(m.id,wf);
    if(workflows.get(m.id)!==wf||wf.busy||wf.config.incognito||observedWorker(m.id)!==f||f.version!==version)continue;
    if(f.truncated){holdReason=`${m.name}: latest reply is incomplete, unavailable or exceeds 32000 characters; review before resuming.`;continue;}
    if(!f.text){f.input=false;continue;}
    const digest=createHash('sha256').update(f.text).digest('hex');if(f.digest===digest)continue;
    changed.push({id:m.id,text:f.text,version:f.version,digest,source:wf});
  }
  if(!changed.length)return holdReason;
  const runs=(observationRuns.get(r.ownerId)??[]).filter((at)=>at>Date.now()-3600000);observationRuns.set(r.ownerId,runs);
  if(runs.length>=24)return '24 input-observation batches/hour reached. Review and resume when ready.';
  if(observing.has(r.ownerId))return;
  const abort=new AbortController();observing.set(r.ownerId,abort);runs.push(Date.now());
  audit(r,`Checking ${changed.length} changed worker replies for operator-input requests with Luna LOW (batch ${runs.length}/24 this hour).`);
  try{
    const result=await observeInputWithLuna(changed.slice(0,16).map(({id,text})=>({id,text})),abort.signal);
    if(stopped||store?.get(r.id)!==r||r.status!=='watching')return;
    for(const v of result.workers){const source=changed.find((c)=>c.id===v.id)!;if(workflows.get(v.id)!==source.source||source.source.config.incognito)continue;const f=observedWorker(v.id);if(f.version===source.version){f.input=v.needs_input;f.digest=source.digest;}}
    audit(r,`Input observation usage: ${JSON.stringify(result.usage??{})}; ${result.workers.filter((w)=>w.needs_input!==false).length} workers held.`);
  }catch{for(const c of changed)if(observedWorker(c.id).version===c.version)observedWorker(c.id).digest=c.digest;holdReason='Input observation unavailable. No automatic retry; review the workers.';}
  finally{observing.delete(r.ownerId);if(changed.length>16)r.definition.cluster_ids.forEach(invalidate);}
  return holdReason;
}
function stillArmed(r:ComputerConditionRule,revision=r.revision??0){return !stopped&&store?.get(r.id)===r&&(r.revision??0)===revision&&r.status==='watching'&&!r.paused&&!r.definition.cluster_ids.some((id)=>clusters.isAutoTurnOnMailboxEnabled(id))&&activityPolicy(r.ownerId).enabled&&!!workflows.get(r.ownerId)?.config.voiceOperator;}
function same(a:ConditionCandidate,b:ConditionCandidate|undefined){return b&&a.key===b.key&&a.signature===b.signature;}
export async function evaluateConditions(){
  if(running||stopped||!store||!dispatch)return;running=true;
  const scopes=new Set(dirty);dirty.clear();
  try{
    for(const r of store.rules.slice().filter((r)=>r.status==='watching'&&r.definition.cluster_ids.some((id)=>scopes.has(id)))){
      const revision=r.revision??0;
      try{
        if(!workflows.has(r.ownerId)){store.stop(r.id,'interrupted','Computer owner was removed.');continue;}
        if(r.definition.cluster_ids.some((id)=>clusters.isAutoTurnOnMailboxEnabled(id))){store.stop(r.id,'interrupted','Cluster AUTO-PICKUP enabled; script stopped.');continue;}
        if(!stillArmed(r)){if(r.expiresAt!==null&&Date.now()>=r.expiresAt)store.stop(r.id,'expired','Condition time limit reached.');continue;}
        const inputHoldReason=await checkInput(r);if(!stillArmed(r,revision))continue;
        const a=await withScope(r.definition.cluster_ids,async()=>store!.next(r.id,await snapshot(r.definition.cluster_ids)));
        if(!a){if(inputHoldReason&&r.reason.startsWith('Holding for operator input/check:'))r.reason+=`. ${inputHoldReason}`;continue;}
        if(a.targetId){
          const text=a.action.kind==='send_message'?a.action.text:'Please check your peer mailbox (peer_read) and process any pending messages.';
          let checked=false;
          const run=a.action.kind==='compact'?compactDispatch:dispatch;
          if(!run)throw Error('Worker compaction is unavailable.');
          const accepted=await run(a.targetId,text,async(claim)=>withScope(r.definition.cluster_ids,async()=>{
            checked=true;if(!stillArmed(r,revision))return false;if(!r.private)await persist();
            const current=store!.next(r.id,await snapshot(r.definition.cluster_ids));
            if(!stillArmed(r,revision)||!same(a,current)||!claim())return false;
            store!.record(r.id,current!);audit(r,`${a.clause}: ${a.action.kind} → ${a.targetId}`,a.targetId);return true;
          }));
          if(!accepted&&!checked&&!workflows.get(a.targetId)?.busy)store.stop(r.id,'failed','Worker action preflight refused; no retry.');
        }else{
          const accepted=await withScope(r.definition.cluster_ids,async()=>{
            if(!stillArmed(r,revision)||!same(a,store!.next(r.id,await snapshot(r.definition.cluster_ids))))return false;
            if(!r.private)await persist();if(!stillArmed(r,revision))return false;
            store!.record(r.id,a);if(!r.private)await persist();return true;
          });
          if(accepted&&a.action.kind==='tool'){
            const args=toolArgs(a.action);
            audit(r,`${a.clause}: ${a.action.name} ${JSON.stringify(args)}`);
            const result=await requestVoiceTool(r.ownerId,a.action.name as VoiceOperatorTool,args);
            if(!result.ok||result.result?.startsWith('[error]'))store.stop(r.id,'failed',voiceText(result.error??result.result??'Scripted tool failed.',300));
          }
        }
        r.definition.cluster_ids.forEach(invalidate);
      }catch(e){store.stop(r.id,'failed',voiceText(e instanceof Error?e.message:'State check or action failed; review before re-arming.',300));}
    }
    await saveOrStop();publish();
  }finally{running=false;armDeadlines();computerProjectionChanged();if(dirty.size)invalidate();}
}
export function configureConditions(run:Dispatch,compact?:Dispatch){
  dispatch=run;
  compactDispatch=compact;
  subscribeActivity((e)=>{
    if(e.workflowId){const f=observedWorker(e.workflowId);
      if(e.kind==='worker_compaction_started'){f.compacting=true;f.compactionClaim=true;f.compactionVersion=f.version;}
      else if(e.kind==='worker_compaction_finished'){f.compacting=false;f.compactionClaim=false;f.compactions++;if(f.version===f.compactionVersion){f.tokens=null;f.percent=null;}}
      else if(e.kind==='worker_compaction_failed'){f.compacting=false;f.compactionClaim=false;}
      else if(e.kind==='worker_finished'){f.finished++;f.compacting=f.compactionClaim;}
      else if(e.kind==='worker_failed')f.failed++;else if(e.kind==='worker_interrupted'&&!f.compactionClaim)f.interrupted++;else if(e.kind==='mail_arrived')f.mail++;
      if(e.kind==='worker_removed')forgetObservedWorker(e.workflowId);
      if(e.kind==='worker_compaction_failed')f.failed++;
      for(const r of store?.rules??[])if(r.members.some((m)=>m.id===e.workflowId)){
        const failure=e.kind==='worker_failed'||e.kind==='worker_compaction_failed';
        const interruption=e.kind==='worker_interrupted'&&!f.compactionClaim;
        if(e.kind==='worker_removed'||(failure&&r.definition.stop_on_error)||(interruption&&r.definition.stop_on_interrupt))store!.stop(r.id,failure?'failed':'interrupted','A scoped worker failed, stopped, or was removed.');
      }
    }
    if(e.clusterId)invalidate(e.clusterId);
  });
  subscribeComputerPolicy((owner)=>{for(const r of store?.rules??[])if(r.ownerId===owner)r.definition.cluster_ids.forEach(invalidate);});
}
export function hasActiveConditionsForCluster(id:string){return !!store?.rules.some((r)=>r.status==='watching'&&r.definition.cluster_ids.includes(id));}
export function clearPrivateConditions(ownerId:string){for(const r of store?.rules??[])if(r.private&&r.ownerId===ownerId){published.delete(r.id);for(const n of r.announcements)delivered.delete(n.id);}store?.clearPrivate(ownerId);observing.get(ownerId)?.abort();observationRuns.delete(ownerId);armDeadlines();computerProjectionChanged();}
export async function interruptConditions(){stopped=true;for(const a of observing.values())a.abort();for(const t of timers.values())clearTimeout(t);timers.clear();if(store){for(const r of store.rules)store.stop(r.id,'interrupted','Server stopped; re-arm explicitly.');await saveOrStop();publish();}}
export function conditionCapabilities(){return {
    fields:conditionField.options,unknown:'null is unknown; NOT unknown stays unknown; only TRUE permits an action.',
    meanings:{has_work:'busy OR queued messages OR pending mail; not a verdict about project completion',needs_input:'Structured question/approval OR Luna LOW interpretation of latest reply. An idle unknown holds when hold_on_input is true; structured questions hold immediately even while busy.',context_percent:'percent 0–100 of provider-reported window; unknown if unreported',turns_finished:'complete queue drains since server boot',compactions_finished:'completed Archon-requested in-place compactions since boot; provider-internal auto-compaction and Ollama next-turn arming are not counted'},
    expressions:['{op:worker,worker_id,field,cmp,value}','{op:all|any,conditions:[expressions]}','{op:not,condition:expression}','{op:group,worker_ids,quantifier:all|any|none,field,cmp,value}','{op:count,worker_ids,field,test,value,cmp,count}'],comparisons:['eq','ne','gt','gte','lt','lte'],
    definition:'{label,cluster_ids:[exact ids],hold_on_input:true,hold_worker_ids?:[exact workers to hold for; default all scoped members],stop_on_error?:true,stop_on_interrupt?:true,clauses:[{id,when:expression,actions:[action],repeat:once|changes,watch?:[{worker_id,field}],after?:[earlier clause ids],finish?:true}],ttl_minutes?:positive integer|null,max_actions?:positive integer|null,max_worker_turns?:positive integer|null,cooldown_seconds?:nonnegative integer (default 30)}',
    actions:['{kind:nudge,worker_ids:[ids]} — standard idle-worker nudge, even without mail','{kind:nudge_mail,worker_ids:[ids]} — only idle with NEW pending message IDs','{kind:send_message,worker_id,text} — exact operator instruction, idle only','{kind:compact,worker_id} — server-side native compaction, idle only; watch compacting before continuing; Ollama compacts at next turn','{kind:notify,text}','{kind:tool,name,args:{string:string}} — existing operator tool; browser required, never invent tools or arguments'],
    tools:COMPUTER_TOOL_SPECS.filter((s)=>!deniedTools.has(s.name)).map((s)=>({name:s.name,args:Object.keys(s.shape)})),
    recurrence:'once = each action/target once. changes = once per distinct matching referenced/watched fact values; nudge_mail always deduplicates message IDs. actions run in listed order. A once clause latches after its first dispatch; its remaining actions retain input/idle/cancellation guards even if its own effects change the trigger. after waits for all action targets in an earlier clause to dispatch at least once. finish stops after all clause actions have been dispatched.',
    limits:'No default time, action or worker-turn limit: omitted or null means no limit. Set positive integer limits only when the operator requests them; no fixed 8-turn/128-action/2-hour ceiling. Cooldown defaults to 30 seconds; the operator can request any nonnegative whole seconds including 0. Runtime correctness guards still apply. Structural capacity: 4 clusters, 32 workers, 8 clauses, 128 nodes, 8000 JSON characters. No model authority to invent routing or completion.',
    editing:'Read the full definition/revision, then update the same script. Preserve existing settings unless the operator requests a change. Null removes a time/action/worker-turn limit; counters and deduplication are retained. Unchanged ttl_minutes preserves the absolute expiry; an explicitly changed numeric ttl_minutes starts that duration from the update.',
    input_observation:'hold_on_input enables up to 24 event-driven Luna LOW batches/hour (16 changed replies/batch), normal Codex usage, no tools/history. Failures/unknown hold; explicit operator review/resume retries. Worker questions are never answered automatically.',
  };
}
const request=z.object({action:z.enum(['capabilities','state','create','update','list','pause','resume','cancel','claim-announcement']),definition:z.unknown().optional(),cluster_ids:z.array(conditionId).min(1).max(4).optional(),rule_id:conditionId.optional(),expected_revision:z.number().int().nonnegative().optional(),announcement_id:z.string().max(100).optional()}).strict();
export async function computerConditionControl(ownerId:string,raw:unknown){
  const owner=workflows.get(ownerId);if(!owner?.config.voiceOperator||owner.config.kind!=='chat')throw Error('Not a Computer chat.');
  const reset=owner.config.computerContext?.lastResetAt;
  const checkOwner=()=>{if(stopped||workflows.get(ownerId)!==owner||owner.config.computerContext?.lastResetAt!==reset)throw Error('Computer context changed.');};
  const args=request.parse(raw);await activityReady();const s=await ready();checkOwner();
  if(args.action==='capabilities')return conditionCapabilities();
  if(args.action==='state'){
    if(!args.cluster_ids)throw Error('State requires exact cluster_ids.');
    const state=await withScope(args.cluster_ids,()=>snapshot(args.cluster_ids!));checkOwner();return {workers:state.map(({pendingIds,...v})=>v)};
  }
  let rule:ComputerConditionRule|undefined,announce=false;
  if(args.action==='list'&&args.rule_id){rule=s.list(ownerId).find((r)=>r.id===args.rule_id);if(!rule)throw Error('No such script.');}
  if(args.action==='create'||args.action==='update'){
    if(!args.definition||JSON.stringify(args.definition).length>8000)throw Error('Provide a script definition of at most 8000 characters.');
    const existing=args.action==='update'?s.list(ownerId).find((r)=>r.id===args.rule_id):undefined;
    if(args.action==='update'&&!existing)throw Error('No such script to update.');
    if(existing&&args.expected_revision!==(existing.revision??0))throw Error('Read the script with list and rule_id, then update with its current expected_revision.');
    // Omission means no limit on create, but cannot silently remove a saved
    // operator limit on update. Explicit null removes it without resetting spend.
    const raw=existing&&typeof args.definition==='object'&&!Array.isArray(args.definition)?{
      ttl_minutes:existing.definition.ttl_minutes,max_actions:existing.definition.max_actions,
      max_worker_turns:existing.definition.max_worker_turns,cooldown_seconds:existing.definition.cooldown_seconds,
      ...args.definition,
    }:args.definition;
    const definition=parseConditionDefinition(raw);
    for(const c of definition.clauses)for(const a of c.actions)if(a.kind==='tool')toolArgs(a);
    for(const id of definition.cluster_ids){await clusters.readCluster(id);if(clusters.isAutoTurnOnMailboxEnabled(id))throw Error('Turn off cluster AUTO-PICKUP before arming a script.');if(hasActiveMailRulesForCluster(id))throw Error('Cancel the legacy mailbox rule in this cluster before arming a script.');}
    rule=await withScope(definition.cluster_ids,async()=>{const facts=await snapshot(definition.cluster_ids);checkOwner();if(facts.length>32)throw Error('Script scope exceeds 32 workers.');for(const c of definition.clauses)for(const a of c.actions)if(a.kind==='tool'){
      if(['archon_nudge','archon_send_message'].includes(a.name))throw Error('Use typed nudge_mail/send_message actions for worker turns.');
      if(a.args.target&&!facts.some((w)=>w.id===a.args.target)&&!definition.cluster_ids.includes(a.args.target))throw Error('Script tool targets must be exact scoped ids.');
      if(a.args.control&&/^\d+$/.test(a.args.control))throw Error('Use a stable control label in scripts, not a temporary screen number.');
    }for(const c of definition.clauses)for(const a of c.actions)if(a.kind==='compact'&&facts.find((w)=>w.id===a.worker_id)?.can_compact===false)throw Error('A selected worker does not support native compaction on its current provider/transport.');if(existing&&(s.get(existing.id)?.revision??0)!==args.expected_revision)throw Error('Script changed while updating; read its current revision again.');return existing?s.update(existing.id,definition,facts):s.create(ownerId,definition,facts,!!owner.config.incognito);});
    try{if(!rule.private)await persist();}catch{s.stop(rule.id,'failed','Could not save; script was not armed.');throw Error('Could not save; script was not armed.');}
    audit(rule,`${args.action==='update'?'Updated':'Armed'}: ${JSON.stringify(rule.definition)}. Targets: ${rule.members.map((m)=>m.name+' '+m.id).join(', ')}. Input observation ${definition.hold_on_input?'enabled (24 batches/hour maximum)':'off'}.`);
  }else if(args.action!=='list'){
    rule=s.list(ownerId).find((r)=>r.id===args.rule_id);if(!rule)throw Error('No such script.');
    const current=s.get(rule.id)!;
    if(args.action==='claim-announcement'){const n=current.announcements.find((n)=>n.id===args.announcement_id);if(n&&!n.claimed){n.claimed=true;announce=true;}}
    else if(args.action==='cancel')s.stop(rule.id,'cancelled','Cancelled by operator; started actions continue.');
    else {if(current.status!=='watching')throw Error('Script has already stopped.');current.paused=args.action==='pause';if(args.action==='resume')for(const m of current.members){const f=observedWorker(m.id);if(f.input===null){f.digest=undefined;retryConditionReply(m.id);}}audit(current,current.paused?'Paused by operator.':'Resumed by operator; input holds remain until answered.');}
    if(!rule.private)await saveOrStop();
  }
  if(args.action!=='list'&&args.action!=='claim-announcement'){rule?.definition.cluster_ids.forEach(invalidate);computerProjectionChanged();}
  publish();return {rule:rule?s.list(ownerId).find((r)=>r.id===rule!.id):undefined,rules:s.list(ownerId),announce,observationTurnsThisHour:(observationRuns.get(ownerId)??[]).filter((t)=>t>Date.now()-3600000).length,warning};
}
