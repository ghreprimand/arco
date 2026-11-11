import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { markThrottled, markAvailable, getState, isAvailable, setChangeListener } from './quota.js';
afterEach(()=>{setChangeListener(null);for(const p of ['codex','claude','ollama'] as const)markAvailable(p);});
test('known reset broadcasts recovery without a read or a browser refresh',t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:100_000});
 const events:boolean[]=[];setChangeListener((p,s)=>{if(p==='codex')events.push(s.throttled);});
 markThrottled('codex','fixture limit',101_000);t.mock.timers.tick(999);assert.deepEqual(events,[true]);
 t.mock.timers.tick(1);assert.deepEqual(events,[true,false]);assert.equal(isAvailable('codex'),true);
});
test('updated reset replaces the timer and manual clear cancels recovery',t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:100_000});
 const events:boolean[]=[];setChangeListener((p,s)=>{if(p==='codex')events.push(s.throttled);});
 markThrottled('codex','fixture limit',101_000);markThrottled('codex','extended limit',103_000);
 t.mock.timers.tick(1_000);assert.deepEqual(events,[true,true]);
 markAvailable('codex');t.mock.timers.tick(4_000);assert.deepEqual(events,[true,true,false]);assert.equal(getState('codex').resetsAt,undefined);
});
test('past resets and resets beyond the platform timer limit expire safely',t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:100_000});
 const events:boolean[]=[];setChangeListener((p,s)=>{if(p==='codex')events.push(s.throttled);});
 markThrottled('codex','past',99_000);t.mock.timers.tick(0);assert.deepEqual(events,[true,false]);
 events.length=0;const max=2_147_483_647;markThrottled('codex','far away',Date.now()+max+10_000);
 t.mock.timers.tick(max);assert.deepEqual(events,[true]);t.mock.timers.tick(9_999);assert.deepEqual(events,[true]);
 t.mock.timers.tick(1);assert.deepEqual(events,[true,false]);
});
