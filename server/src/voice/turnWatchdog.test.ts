import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ComputerTurnWatchdog} from './turnWatchdog.js';

test('silent startup and an answered read followed by a hung code runner both time out', (t)=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const expired:string[]=[];
  const startup=new ComputerTurnWatchdog((reason)=>expired.push(reason));
  t.mock.timers.tick(89_999);assert.equal(expired.length,0);
  t.mock.timers.tick(1);assert.match(expired[0],/No action tools were dispatched/);
  startup.progress();t.mock.timers.tick(300_000);assert.equal(expired.length,1);
  const read=new ComputerTurnWatchdog((reason)=>expired.push(reason));
  read.tool({tool:'archon_screen',phase:'requested'});read.tool({tool:'archon_screen',phase:'answered'});
  t.mock.timers.tick(59_999);assert.equal(expired.length,1);
  t.mock.timers.tick(1);assert.equal(expired.length,2);assert.match(expired[1],/no progress/);
});

test('healthy progress renews the idle clock, but a repeated-tool loop cannot exceed five minutes', (t)=>{
  t.mock.timers.enable({apis:['setTimeout']});const expired:string[]=[];
  const guard=new ComputerTurnWatchdog((reason)=>expired.push(reason));
  guard.tool({tool:'archon_nudge',phase:'requested'});
  for(let i=0;i<5;i++){t.mock.timers.tick(50_000);guard.progress();}
  assert.equal(expired.length,0);t.mock.timers.tick(50_000);
  assert.equal(expired.length,1);assert.match(expired[0],/time limit/);assert.match(expired[0],/Some actions may already have happened/);
});

test('settling or cancelling a turn removes both clocks', (t)=>{
  t.mock.timers.enable({apis:['setTimeout']});let expired=0;
  const guard=new ComputerTurnWatchdog(()=>expired++);guard.progress();guard.stop();
  t.mock.timers.tick(600_000);assert.equal(expired,0);
});
