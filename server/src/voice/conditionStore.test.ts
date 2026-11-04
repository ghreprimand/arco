import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConditionExpression, ConditionWorkerFacts } from '@arco/shared';
import { ComputerConditions, testCondition } from './conditionStore.js';
import { parseConditionDefinition, savedConditionRule } from './conditionSchema.js';
const b='builder-0001',c='builder-0002',d='director-001',cluster='cluster-0001';
const worker=(id:string,pendingIds:string[]=[]):ConditionWorkerFacts=>({id,name:id,clusterId:cluster,busy:false,queued:0,pending_mail:pendingIds.length,pendingIds,has_work:!!pendingIds.length,needs_input:false,turns_finished:0,turns_failed:0,turns_interrupted:0,mail_received:0,context_percent:0,context_tokens:0,context_window:100000,compacting:false,can_compact:true,compactions_finished:0});
const fact=(worker_id:string,field='busy',value:number|boolean=false,cmp='eq')=>({op:'worker',worker_id,field,cmp,value});
const group=(field:string,value:number|boolean)=>({op:'group',worker_ids:[b,c],quantifier:'all',field,cmp:'eq',value});
const definition=()=>parseConditionDefinition({label:'Exact operator policy',cluster_ids:[cluster],hold_worker_ids:[b,c],clauses:[
  {id:'mail',when:{op:'group',worker_ids:[b,c],quantifier:'any',field:'pending_mail',cmp:'gt',value:0},actions:[{kind:'nudge_mail',worker_ids:[b,c]}],repeat:'changes'},
  {id:'settled',when:{op:'all',conditions:[group('busy',false),group('queued',0),group('pending_mail',0)]},actions:[{kind:'notify',text:'Workers finished exchanging mail; Director was left alone.'}],finish:true},
]});

test('composition, group quantifiers, counts and NOT preserve unknown facts',()=>{
  const f=[worker(b),worker(c)];f[0].needs_input=null;
  const check=(e:unknown)=>testCondition(e as ConditionExpression,f);
  assert.equal(check({op:'not',condition:fact(b,'needs_input',true)}),null);
  assert.equal(check({op:'all',conditions:[fact(b),fact(c)]}),true);
  assert.equal(check({op:'any',conditions:[fact(b,'busy',true),fact(b,'needs_input',true)]}),null);
  assert.equal(check({op:'group',worker_ids:[b,c],quantifier:'none',field:'busy',cmp:'eq',value:true}),true);
  assert.equal(check({op:'count',worker_ids:[b,c],field:'busy',test:'eq',value:false,cmp:'eq',count:2}),true);
  assert.equal(check(fact('missing-worker')),null);
});
test('arbitrary worker combinations and notification do not imply a Director action',()=>{
  const f=[worker(b,['one']),worker(c),worker(d,['report'])],s=new ComputerConditions(),r=s.create('owner-0001',definition(),f,false,0);
  let a=s.next(r.id,f,1)!;assert.equal(a.targetId,b);s.record(r.id,a,1);
  assert.equal(s.next(r.id,f,2),undefined,'unchanged pending mail cannot re-nudge');
  f[0].pendingIds=[];f[0].pending_mail=0;f[1].busy=true;
  assert.equal(s.next(r.id,f,3),undefined,'empty mail while busy is not settled');
  f[1].busy=false;f[1].queued=1;assert.equal(s.next(r.id,f,4),undefined);
  f[1].queued=0;f[2].busy=true;f[2].needs_input=true;
  a=s.next(r.id,f,5)!;assert.equal(a.action.kind,'notify');assert.equal(a.targetId,undefined);s.record(r.id,a,5);
  assert.equal(s.next(r.id,f,6),undefined);assert.equal(s.get(r.id)!.status,'finished');
  assert.equal(s.get(r.id)!.workerTurns[d],undefined,'Director is untouched even while it has mail or is busy');
});
test('input holds block actions and completion; explicit question notifications still work',()=>{
  const f=[worker(b,['one']),worker(c)],def=definition();def.clauses.unshift({id:'question',when:fact(b,'needs_input',true) as ConditionExpression,actions:[{kind:'notify',text:'Please answer Builder.'}],repeat:'once'});
  const s=new ComputerConditions(),r=s.create('owner-0001',def,f,false,0);
  f[0].needs_input=null;assert.equal(s.next(r.id,f,1),undefined);
  f[0].needs_input=true;const a=s.next(r.id,f,2)!;assert.equal(a.action.kind,'notify');s.record(r.id,a,2);assert.equal(s.next(r.id,f,3),undefined);
  f[0].needs_input=false;assert.equal(s.next(r.id,f,4)!.action.kind,'nudge_mail');
});
test('operator-requested per-worker limits and cooldowns still stop further nudges',()=>{
  const f=[worker(b,['one']),worker(c)],def=definition();def.max_worker_turns=1;
  const s=new ComputerConditions(),r=s.create('owner-0001',def,f,false,0);
  s.record(r.id,s.next(r.id,f,1)!,1);f[0].pendingIds.push('two');f[0].pending_mail++;
  assert.equal(s.next(r.id,f,2),undefined);assert.equal(s.deadline(r.id,true,2),30001);
  assert.equal(s.next(r.id,f,30002),undefined);assert.equal(s.get(r.id)!.status,'limited');
});
test('sequences wait for their own observations, compaction and every finishing action',()=>{
  const f=[worker(b),worker(c)],def=parseConditionDefinition({label:'Compact then continue',cluster_ids:[cluster],hold_on_input:false,clauses:[
    {id:'compact',when:fact(b,'context_percent',40,'gte'),actions:[{kind:'tool',name:'arco_compact',args:{target:b}}]},
    {id:'continue',after:['compact'],when:fact(b,'busy',false),actions:[{kind:'send_message',worker_id:b,text:'Continue the task.'},{kind:'send_message',worker_id:c,text:'Review the result.'}],finish:true},
  ]});
  const s=new ComputerConditions(),r=s.create('owner-0001',def,f,false,0);
  assert.equal(s.next(r.id,f,1),undefined);f[0].context_percent=41;
  let a=s.next(r.id,f,2)!;assert.equal(a.action.kind,'compact');s.record(r.id,a,2);f[0].compacting=true;
  assert.equal(s.next(r.id,f,3),undefined);f[0].compacting=false;f[0].context_percent=10;
  a=s.next(r.id,f,4)!;assert.equal(a.targetId,b);s.record(r.id,a,4);f[1].busy=true;
  assert.equal(s.next(r.id,f,5),undefined);assert.equal(s.get(r.id)!.status,'watching','a busy second action must not be silently skipped');
  f[1].busy=false;a=s.next(r.id,f,6)!;assert.equal(a.targetId,c);s.record(r.id,a,6);s.next(r.id,f,7);assert.equal(s.get(r.id)!.status,'finished');
});
test('scope, privacy, restart, pause, expiry and malformed declarations fail closed',()=>{
  const f=[worker(b),worker(c)],s=new ComputerConditions();
  assert.throws(()=>parseConditionDefinition({label:'x',cluster_ids:[cluster],clauses:[{id:'bad',when:fact(b,'busy',1),actions:[{kind:'notify',text:'x'}]}]}),/Boolean/);
  const def=definition();def.clauses[0].after=['settled'];assert.throws(()=>parseConditionDefinition(def),/earlier/);
  const outside=definition();outside.clauses[0].actions=[{kind:'nudge_mail',worker_ids:['outside-worker']}];assert.throws(()=>s.create('owner-0001',outside,f),/outside/);
  const timed=definition();timed.ttl_minutes=120;
  const r=s.create('owner-0001',timed,f,true,0);assert.equal(s.saved().length,0);assert.equal(s.list('another-owner').length,0);
  s.get(r.id)!.paused=true;assert.equal(s.next(r.id,f,1),undefined);s.next(r.id,f,7200000);assert.equal(s.get(r.id)!.status,'expired');s.clearPrivate('owner-0001');assert.equal(s.rules.length,0);
  const saved=s.create('owner-0001',definition(),f);assert.equal(new ComputerConditions(s.saved()).get(saved.id)!.status,'interrupted');
  const membership=s.create('owner-0001',definition(),f);s.next(membership.id,[worker(b)],1);assert.equal(s.get(membership.id)!.status,'interrupted');
});
test('actions execute in order, cannot notify before a nudge, and a started once clause survives its own effects',()=>{
  const f=[worker(b)],def=parseConditionDefinition({label:'Notify after actual nudge',cluster_ids:[cluster],hold_on_input:false,clauses:[{id:'do_it',when:fact(b),actions:[{kind:'nudge_mail',worker_ids:[b]},{kind:'notify',text:'Nudge dispatched.'}],finish:true}]});
  const s=new ComputerConditions(),r=s.create('owner-0001',def,f,false,0);
  assert.equal(s.next(r.id,f,1),undefined,'no mail means no nudge and no later notification');
  f[0].pendingIds=['mail'];f[0].pending_mail=1;let a=s.next(r.id,f,2)!;assert.equal(a.action.kind,'nudge_mail');s.record(r.id,a,2);
  f[0].busy=true;a=s.next(r.id,f,3)!;assert.equal(a.action.kind,'notify','the first action changing busy cannot strand its subsequent notification');s.record(r.id,a,3);s.next(r.id,f,4);assert.equal(s.get(r.id)!.status,'finished');
});
test('the compiler refuses budgets that cannot possibly execute a dependent sequence',()=>{
  assert.throws(()=>parseConditionDefinition({label:'Impossible one-turn sequence',cluster_ids:[cluster],max_worker_turns:1,clauses:[
    {id:'compact',when:fact(b),actions:[{kind:'compact',worker_id:b}]},
    {id:'continue',when:fact(b),after:['compact'],actions:[{kind:'send_message',worker_id:b,text:'Continue.'}]},
  ]}),/at least 2 worker turns/);
});
test('editing an active script retains spend/mail IDs and completed actions while fencing its old revision',()=>{
  const f=[worker(b,['one']),worker(c)],s=new ComputerConditions(),def=definition();def.clauses=def.clauses.slice(0,1);
  const r=s.create('owner-0001',def,f,false,0);s.record(r.id,s.next(r.id,f,1)!,1);
  const revised=structuredClone(def);revised.label='Also hold for input';revised.clauses[0].when={op:'all',conditions:[revised.clauses[0].when,{op:'not',condition:fact(b,'needs_input',true) as ConditionExpression}]};
  s.update(r.id,revised,f,2);assert.equal(s.get(r.id)!.revision,1);assert.equal(s.get(r.id)!.actions,1);assert.equal(s.get(r.id)!.expiresAt,null);assert.equal(s.next(r.id,f,30002),undefined,'editing a predicate must not re-nudge unchanged mail');
  const one=parseConditionDefinition({label:'Once message',cluster_ids:[cluster],hold_on_input:false,clauses:[{id:'message',when:fact(b),actions:[{kind:'send_message',worker_id:b,text:'Do this once.'}]}]});
  const second=s.create('owner-0001',one,f,false,0);s.record(second.id,s.next(second.id,f,1)!,1);
  const guarded=structuredClone(one);guarded.clauses[0].when={op:'all',conditions:[fact(b) as ConditionExpression,fact(c) as ConditionExpression]};s.update(second.id,guarded,f,2);
  assert.equal(s.next(second.id,f,30002),undefined,'adding a guard preserves an already sent one-time message');
});

test('no-limit scripts pass the old turn/action/time ceilings and retain deduplication across saved-state loading',()=>{
  const f=[worker(b,['mail-0']),worker(c)],def=definition();def.clauses=[{id:'mail',when:fact(b,'pending_mail',0,'gt') as ConditionExpression,actions:[{kind:'nudge_mail',worker_ids:[b]}],repeat:'changes'}];
  assert.equal(def.ttl_minutes,null);assert.equal(def.max_actions,null);assert.equal(def.max_worker_turns,null);
  const s=new ComputerConditions(),r=s.create('owner-0001',def,f,false,0);
  assert.equal(s.deadline(r.id,true,0),undefined,'no expiry or pending cooldown means no timer');
  for(let i=0;i<160;i++){
    const at=3*3600000+i*31000;f[0].pendingIds=[`mail-${i}`];f[0].pending_mail=1;
    const a=s.next(r.id,f,at);assert(a,`new mail ${i} should still dispatch`);s.record(r.id,a,at);
    assert.equal(s.next(r.id,f,at+30001),undefined,'same unread mail never repeats even without budgets');
  }
  const live=s.get(r.id)!;assert.equal(live.workerTurns[b].count,160);assert.equal(live.actions,160);assert.equal(live.status,'watching');
  const saved=savedConditionRule.parse(JSON.parse(JSON.stringify(s.saved()[0])));
  const restored=new ComputerConditions([{...saved,definition:parseConditionDefinition(saved.definition)}]);
  assert.equal(restored.get(r.id)!.actions,160);assert.equal(restored.get(r.id)!.status,'interrupted','restart never resumes an unbounded script');
});

test('optional explicit action/time budgets and long notification histories round-trip beyond old maxima',()=>{
  const f=[worker(b)],def=parseConditionDefinition({label:'Operator budgets',cluster_ids:[cluster],ttl_minutes:360,max_actions:150,max_worker_turns:100,cooldown_seconds:0,clauses:[
    {id:'notice',when:fact(b),watch:[{worker_id:b,field:'turns_finished'}],repeat:'changes',actions:[{kind:'notify',text:'Another completed run.'}]},
  ]});
  const s=new ComputerConditions(),r=s.create('owner-0001',def,f,false,0);assert.equal(r.expiresAt,21600000);
  for(let i=0;i<150;i++){f[0].turns_finished=i;s.record(r.id,s.next(r.id,f,i)!,i);}
  f[0].turns_finished++;assert.equal(s.next(r.id,f,151),undefined);assert.equal(s.get(r.id)!.status,'limited');
  const saved=savedConditionRule.parse(JSON.parse(JSON.stringify(s.saved()[0])));assert.equal(saved.announcements.length,151);
  const expiring=s.create('owner-0001',def,f,false,0);s.get(expiring.id)!.paused=true;s.next(expiring.id,f,21600000);assert.equal(s.get(expiring.id)!.status,'expired','explicit expiry applies while paused');
});

test('removing limits updates the original script without resetting spend, replaying mail or losing its deadline on unrelated edits',()=>{
  const f=[worker(b,['first']),worker(c)],s=new ComputerConditions(),def=definition();def.clauses=def.clauses.slice(0,1);def.ttl_minutes=120;def.max_actions=32;def.max_worker_turns=8;
  const r=s.create('owner-0001',def,f,false,0);s.record(r.id,s.next(r.id,f,1)!,1);
  const ordinary=structuredClone(def);ordinary.label='Same script';s.update(r.id,ordinary,f,60000);assert.equal(s.get(r.id)!.expiresAt,7200000);
  const extended=structuredClone(ordinary);extended.ttl_minutes=360;s.update(r.id,extended,f,60001);assert.equal(s.get(r.id)!.expiresAt,21660001);
  const unlimited=structuredClone(extended);unlimited.ttl_minutes=null;unlimited.max_actions=null;unlimited.max_worker_turns=null;s.update(r.id,unlimited,f,60002);
  assert.equal(s.get(r.id)!.expiresAt,null);assert.equal(s.get(r.id)!.actions,1);assert.equal(s.get(r.id)!.workerTurns[b].count,1);
  assert.equal(s.next(r.id,f,60003),undefined,'removing limits cannot re-send the first nudge');
  f[0].pendingIds=['new'];f[0].pending_mail=1;assert.equal(s.next(r.id,f,10*3600000)!.targetId,b);
});

test('old saved numeric limits remain in force and invalid budgets cannot mutate an active script',()=>{
  const f=[worker(b,['one']),worker(c)],s=new ComputerConditions(),legacy=definition();legacy.ttl_minutes=120;legacy.max_actions=32;legacy.max_worker_turns=8;
  const r=s.create('owner-0001',legacy,f,false,0);s.record(r.id,s.next(r.id,f,1)!,1);
  const saved=savedConditionRule.parse(JSON.parse(JSON.stringify(s.saved()[0]))),parsed=parseConditionDefinition(saved.definition);
  assert.equal(parsed.max_worker_turns,8);assert.equal(saved.expiresAt,7200000);
  const invalid=structuredClone(legacy);invalid.ttl_minutes=Number.MAX_SAFE_INTEGER;
  assert.throws(()=>s.update(r.id,invalid,f,2),/date range/);assert.deepEqual(s.get(r.id)!.definition,legacy);
  invalid.ttl_minutes=120;invalid.max_actions=1;assert.throws(()=>s.update(r.id,invalid,f,2),/already spent/);
  for(const values of [{max_actions:0},{max_worker_turns:-1},{ttl_minutes:1.5},{cooldown_seconds:-1},{max_actions:Number.MAX_SAFE_INTEGER+1}])assert.throws(()=>parseConditionDefinition({...legacy,...values}));
});

test('no limits and zero cooldown still respect busy workers, queued work, questions and cancellation',()=>{
  const f=[worker(b,['one']),worker(c)],def=definition();def.cooldown_seconds=0;def.clauses=def.clauses.slice(0,1);
  const s=new ComputerConditions(),r=s.create('owner-0001',def,f,false,0);
  f[0].busy=true;assert.equal(s.next(r.id,f,1),undefined);f[0].busy=false;f[0].queued=1;assert.equal(s.next(r.id,f,2),undefined);
  f[0].queued=0;f[0].needs_input=true;assert.equal(s.next(r.id,f,3),undefined);f[0].needs_input=false;s.record(r.id,s.next(r.id,f,4)!,4);
  f[0].pendingIds=['two'];f[0].pending_mail=1;assert(s.next(r.id,f,4),'new mail may act immediately when cooldown explicitly disabled');
  s.stop(r.id,'cancelled','Operator cancelled.');assert.equal(s.next(r.id,f,5),undefined);assert.equal(s.deadline(r.id,true,5),undefined);
});
