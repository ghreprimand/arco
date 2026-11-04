import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ComputerActivity} from './activityStore.js';
import type {ComputerActivityEvent} from '@arco/shared';
const event=(id:string,kind:ComputerActivityEvent['kind']='worker_finished',ownerId?:string):ComputerActivityEvent=>({id,kind,at:Date.now(),workflowId:'builder-1',ownerId,name:'Builder 1'});
test('default collects facts without model calls; opt-in selects completion or matched events',()=>{
  const s=new ComputerActivity();s.add(event('a'));assert.equal(s.snapshot('c').ledger.length,1);assert.equal(s.queued('c').length,0);
  s.configure('c',{agentUpdates:'matches'});s.add(event('b'));s.add(event('c','condition_matched','other'));assert.equal(s.queued('c').length,0);
  s.add(event('d','condition_matched','c'));s.add(event('d','condition_matched','c'));assert.equal(s.queued('c').length,1);
  s.configure('c',{agentUpdates:'workers'});s.add(event('e','worker_started'));s.add(event('f','mail_arrived'));s.add(event('g','worker_failed'));
  assert.deepEqual(s.queued('c').map((d)=>d.event.id),['d','g']);
  s.configure('c',{enabled:false});assert.equal(s.queued('c').length,0);s.add(event('h'));assert.equal(s.queued('c').length,0);
});
test('private settings, ledger, inbox and usage counters never persist or cross owners',()=>{
  const s=new ComputerActivity();s.configure('private-owner',{agentUpdates:'workers'},true);
  s.add(event('public'));s.add({...event('secret','condition_matched','private-owner'),private:true});
  assert.equal(s.snapshot('other').ledger.some((e)=>e.id==='secret'),false);
  const ids=s.queued('private-owner').map((d)=>d.id);s.start(ids);s.settle(ids);
  assert(!JSON.stringify(s.saved()).includes('private-owner'));assert(!JSON.stringify(s.saved()).includes('secret'));
  s.clearPrivate('private-owner');assert.equal(s.snapshot('private-owner').deliveries.length,0);assert.equal(s.policy('private-owner').agentUpdates,'off');
});
test('queue bounds remain visible, retain in-flight batches, and restart never replays updates',()=>{
  const s=new ComputerActivity();s.configure('c',{agentUpdates:'workers'});
  s.add(event('first'));const first=s.queued('c')[0];s.start([first.id]);
  for(let i=0;i<250;i++)s.add(event('event-'+i));
  assert.equal(s.snapshot('c').pending,50);assert(s.saved().deliveries.some((d)=>d.id===first.id && d.status==='delivering'));
  assert(s.snapshot('c').deliveries.some((d)=>d.reason?.includes('queue limit')));
  const restored=new ComputerActivity(s.saved());assert.equal(restored.queued('c').length,0);assert(restored.saved().deliveries.every((d)=>d.status!=='delivering'));
});
test('rolling model budget survives history eviction and restart, and counts batches rather than events',()=>{
  const s=new ComputerActivity();s.configure('c',{agentUpdates:'workers'});const now=Date.now();
  for(let batch=0;batch<12;batch++){
    for(let i=0;i<10;i++)s.add(event(`${batch}-${i}`));
    const ids=s.queued('c').map((d)=>d.id);s.start(ids,now+batch);s.settle(ids);
  }
  assert.equal(s.nextAllowedAt('c',now+20),now+3_600_000);
  const restored=new ComputerActivity(s.saved());assert.equal(restored.nextAllowedAt('c',now+20),now+3_600_000);
});
