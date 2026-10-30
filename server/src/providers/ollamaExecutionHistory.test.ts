import assert from 'node:assert/strict';
import test from 'node:test';
import { projectOllamaHistory, type OllamaHistoryEvent } from './ollamaExecutionHistory.js';
const wf = 'fixture';
const echo = (content: string, clientMessageId = content) => ({ type: 'user_message_echo', workflowId: wf, content, clientMessageId, ollamaReplayInput: true });
const start = (id: string, ...inputs: number[]) => ({ type: 'primary_turn_started', workflowId: wf, ollamaExecutionId: id, ollamaInputSeqs: inputs });
const text = (id: string, value: string) => ({ type: 'primary_text', workflowId: wf, ollamaExecutionId: id, text: value, phase: 'passthrough' });
const complete = (id: string) => ({ type: 'primary_complete', workflowId: wf, ollamaExecutionId: id });
const rows = (values: object[]) => values.map((e, i) => ({ seq: i + 1, ...e })) as OllamaHistoryEvent[];
const users = (events: OllamaHistoryEvent[]) => events.flatMap(e => e.type === 'user_message_echo' ? [e.content] : []);
const replies = (events: OllamaHistoryEvent[]) => events.flatMap(e => e.type === 'primary_text' ? [e.text] : []);

test('earlier completion cannot consume a queued instruction that executed later', () => {
 const events = rows([echo('A'), start('a', 1), echo('Q'), text('a', 'answer A'), complete('a'), start('q', 3), text('q', 'answer Q'), complete('q'), echo('R')]);
 const raw = JSON.stringify(events), p = projectOllamaHistory(events, wf, [9]);
 assert.equal(p.valid, true); assert.deepEqual(p.cuts.map(c => c.throughSeq), [8]);
 assert.deepEqual(users(p.events), ['A', 'Q']); assert.deepEqual(replies(p.events), ['answer A', 'answer Q']);
 assert.equal(JSON.stringify(events), raw);
});
test('STOP or restart after a drain cannot manufacture an execution', () => {
 for (const marker of [{type:'turn_cancelled'}, {type:'system_notice'}]) {
  const events = rows([echo('Q'), {type:'queued_messages_drained', clientMessageIds:['Q']}, marker, echo('R'), start('r', 4), text('r', 'answer R'), complete('r'), echo('next')]);
  const p = projectOllamaHistory(events, wf, [8]);
  assert.equal(p.valid, true); assert.deepEqual(users(p.events), ['R']); assert.deepEqual(p.cuts, []);
 }
});
test('partial cancelled work stays readable and prevents crossing its prefix', () => {
 const events = rows([echo('A'), start('a',1), text('a','partial'), {type:'primary_turn_ended',workflowId:wf,ollamaExecutionId:'a'}, echo('R'),start('r',5),text('r','answer R'),complete('r'),echo('next')]);
 const p = projectOllamaHistory(events,wf,[9]);
 assert.equal(p.valid,true); assert.deepEqual(users(p.events),['A','R']); assert.deepEqual(replies(p.events),['partial','answer R']); assert.deepEqual(p.cuts,[]);
});
test('waiting cancellation is durable before a scalar cut can pass it', () => {
 const events=rows([echo('A'),start('a',1),echo('Q'),text('a','answer A'),complete('a'),{type:'queued_message_cancelled',workflowId:wf,clientMessageId:'Q'},echo('R'),start('r',7),text('r','answer R'),complete('r'),echo('next')]);
 const p=projectOllamaHistory(events,wf,[11]);
 assert.equal(p.valid,true);assert.deepEqual(users(p.events),['A','R']);assert.deepEqual(p.cuts.map(c=>c.throughSeq),[10]);
});
test('merged execution replays steering before follow-up in actual drain order',()=>{
 const events=rows([echo('A'),start('a',1),echo('follow'),echo('steer'),text('a','answer A'),complete('a'),start('merged',4,3),text('merged','merged answer'),complete('merged'),echo('next')]);
 const p=projectOllamaHistory(events,wf,[10]);
 assert.equal(p.valid,true);assert.deepEqual(users(p.events),['A','steer\n\nfollow']);assert.deepEqual(p.cuts.map(c=>c.throughSeq),[9]);
});
test('identical text, idless clients and current merged input remain distinct',()=>{
 const events=rows([echo('same',''),start('old',1),text('old','old answer'),complete('old'),echo('same',''),echo('second','')]);
 const p=projectOllamaHistory(events,wf,[5,6]);
 assert.equal(p.valid,true);assert.deepEqual(users(p.events),['same']);assert.deepEqual(users([...p.events,echo('same\n\nsecond') as OllamaHistoryEvent]),['same','same\n\nsecond']);
});
test('legacy, conflicting, foreign, rotated and late identities defer without guessing',()=>{
 const good=rows([echo('A'),start('a',1),text('a','answer'),complete('a'),echo('next')]);
 const old=structuredClone(good);delete old[0].ollamaReplayInput;
 const duplicate=rows([echo('A'),start('a',1),start('again',1),echo('next')]);
 const late=rows([echo('A'),start('a',1),{type:'primary_turn_ended',workflowId:wf,ollamaExecutionId:'a'},complete('a'),echo('next')]);
 const foreign=structuredClone(good);Object.assign(foreign[2],{workflowId:'other'});
 for(const source of [old, duplicate,late,foreign,good.slice(1)]) {
  const p=projectOllamaHistory(source,wf,[source.at(-1)!.seq!]); assert.equal(p.valid,false);assert.deepEqual(p.cuts,[]);
 }
 const p=projectOllamaHistory(good,wf,[5]);const changed=structuredClone(good);Object.assign(changed[2],{text:'changed'});
 assert.notEqual(p.cuts[0].digest,projectOllamaHistory(changed,wf,[5]).cuts[0].digest);
});
test('restart projection and source hashes are stable across ten queued arrival placements',()=>{
 let checked=0;
 const base=[echo('A'),start('a',1),text('a','part1'),text('a','part2'),complete('a')];
 for(let f=2;f<=5;f++)for(let s=f+1;s<=6;s++) {
  const values=[...base];values.splice(f,0,echo('follow'));values.splice(s,0,echo('steer'));
  const events=rows(values);const follow=events.find(e=>e.type==='user_message_echo'&&e.content==='follow')!.seq!;
  const steer=events.find(e=>e.type==='user_message_echo'&&e.content==='steer')!.seq!;
  events.push(...rows([start('q',steer,follow),text('q','merged'),complete('q'),echo('next')]).map(e=>({...e,seq:e.seq!+7})));
  const raw=JSON.stringify(events),p=projectOllamaHistory(events,wf,[11]);
  assert.equal(p.valid,true);assert.deepEqual(users(p.events),['A','steer\n\nfollow']);assert.deepEqual(replies(p.events),['part1','part2','merged']);
  assert.equal(p.cuts.at(-1)?.throughSeq,10);assert.deepEqual(projectOllamaHistory(JSON.parse(raw),wf,[11]),p);assert.equal(JSON.stringify(events),raw);checked++;
 }
 assert.equal(checked,10);
});

test('unrelated checkpoint guard positions do not alter execution identity or its digest',()=>{
 const source=rows([echo('A'),start('a',1),text('a','answer'),complete('a'),echo('next')]);
 const expected=projectOllamaHistory(source,wf,[5]);
 const extra=[...source,{type:'checkpoint_created',workflowId:wf,seq:2},{type:'system_notice',workflowId:wf,seq:1}] as OllamaHistoryEvent[];
 assert.deepEqual(projectOllamaHistory(extra,wf,[5]),expected);
});

test('unverifiable legacy replay excludes known waiting and current new inputs',()=>{
 const old={type:'user_message_echo',workflowId:wf,content:'legacy'};
 const source=rows([old,{type:'primary_text',workflowId:wf,phase:'passthrough',text:'old answer'},echo('waiting'),echo('current')]);
 const p=projectOllamaHistory(source,wf,[4]);assert.equal(p.valid,false);assert.deepEqual(users(p.events),['legacy']);assert.deepEqual(replies(p.events),['old answer']);
});
