import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ServerMessage, WorkflowConfig } from '@arco/shared';
import { handleServerMessage, type WsDeps } from './handleServerMessage.js';
import { useAppStore } from '../stores/appStore.js';
import { streamingMsgs } from './streamState.js';

const deps: WsDeps = { wsRef: { current: null }, scheduleReconnect: () => {} };
const config = { name: 'ordering fixture', primaryModel: 'fixture', primaryEffort: 'low', primaryProvider: 'claude' } as unknown as WorkflowConfig;
const send = (message: Record<string, unknown>) => handleServerMessage(message as unknown as ServerMessage, deps);

test('peer reads split assistant text without losing earlier or later chunks', () => {
  const id = 'ordering-fixture';
  streamingMsgs.delete(id);
  useAppStore.getState().createJob(id, config, undefined, undefined);
  send({ type: 'primary_turn_started', workflowId: id, startedAt: 1000, seq: 1 });
  send({ type: 'primary_text', workflowId: id, phase: 'passthrough', text: 'Before', seq: 2 });
  send({ type: 'peer_message_received', workflowId: id, msgId: 'p1', from: 'worker', fromName: 'Worker', content: 'Peer one', ts: 500, seq: 3 });
  send({ type: 'peer_message_received', workflowId: id, msgId: 'p2', from: 'worker', fromName: 'Worker', content: 'Peer two', ts: 400, seq: 4 });
  send({ type: 'primary_text', workflowId: id, phase: 'passthrough', text: 'After', seq: 5 });
  send({ type: 'primary_complete', workflowId: id, phase: 'passthrough', seq: 6 });
  const rows = useAppStore.getState().jobs[id].messages.filter(m => m.role === 'assistant' || m.role === 'peer-received');
  assert.deepEqual(rows.map(m => [m.role, m.content]), [['assistant', 'Before'], ['peer-received', 'Peer one'], ['peer-received', 'Peer two'], ['assistant', 'After']]);
});

import { projectChatMessages } from '../utils/displayMessages.js';
useAppStore.persist.setOptions({ storage: { getItem: () => null, setItem() {}, removeItem() {} } });
let count = 0;
function fixture(kind?: 'chat') {
  const id = `ordering-${++count}`;
  useAppStore.getState().createJob(id, { ...config, kind }, undefined, undefined);
  const emit = (type: string, seq: number, fields: object = {}) => send({ type, workflowId: id, phase: 'passthrough', seq, ...fields });
  const text = (seq: number, value: string) => emit('primary_text', seq, { text: value });
  const peer = (seq: number, value: string) => emit('peer_message_received', seq, { msgId: `p${seq}`, from: 'worker', fromName: 'Worker', content: value, ts: 200 - seq });
  const display = () => projectChatMessages(useAppStore.getState().jobs[id]).filter(m => m.role === 'assistant' || m.role.startsWith('peer-'));
  emit('primary_turn_started', 1, { startedAt: 1000 });
  return { id, emit, text, peer, display };
}

test('event sequence wins over sender timestamps in both workflow and cluster projections', () => {
  const f = fixture(); f.text(2,'Before'); f.peer(3,'Peer one'); f.peer(4,'Peer two'); f.text(5,'After'); f.emit('primary_complete',6);
  assert.deepEqual(f.display().map(m => m.content),['Before','Peer one','Peer two','After']);
  assert.deepEqual(projectChatMessages(useAppStore.getState().jobs[f.id],'chat').filter(m=>m.role!=='system').map(m=>m.content),['Before','Peer one','Peer two','After']);
  const before = f.display().map(m=>[m.id,m.content]);
  f.peer(3,'Peer one'); f.text(5,'After');
  assert.deepEqual(f.display().map(m=>[m.id,m.content]),before,'duplicate replay must neither split nor append again');
});

test('session overlay retains peers and consumes only matching assistant text, including partial JSONL catch-up', () => {
  for (const body of ['Before','BeforeAf','BeforeAfter','BeforeAfter extra session text']) {
    const f=fixture(); f.text(2,'Before'); f.peer(3,'Peer'); f.text(4,'After');
    useAppStore.getState().upsertSessionChat(f.id,{kind:'message',role:'assistant',content:body,timestamp:1500,uuid:'session'});
    assert.deepEqual(f.display().map(m=>m.content),body.endsWith(' extra session text')?['Before','Peer','After',' extra session text']:['Before','Peer','After']);
  }
});

test('tool and thinking events keep their content and placement across peer boundaries and session catch-up', () => {
  const f=fixture(); f.text(2,'Before');
  f.emit('primary_tool_use',3,{tool:'Read',toolUseId:'read-id',input:'{}'});
  f.peer(4,'Peer'); f.emit('primary_thinking',5,{text:'Preserved reasoning'}); f.text(6,'After'); f.emit('primary_complete',7);
  const store=useAppStore.getState();
  store.upsertSessionChat(f.id,{kind:'message',role:'assistant',content:'Before',timestamp:1200,uuid:'s1'});
  store.upsertSessionChat(f.id,{kind:'tool_use',tool:'Read',toolUseId:'read-id',input:{file_path:'fixture.txt'},timestamp:1300});
  store.upsertSessionChat(f.id,{kind:'message',role:'assistant',content:'After',timestamp:1400,uuid:'s2'});
  assert.deepEqual(f.display().map(m=>m.toolUse?.tool ?? m.content),['Before','Read','Peer','After']);
  assert.ok(useAppStore.getState().jobs[f.id].activity.some(a=>a.kind==='thinking'&&a.text==='Preserved reasoning'));
  assert.deepEqual(f.display().find(m=>m.toolUse)?.toolUse?.input,{file_path:'fixture.txt'});
});

test('plan capture includes every text segment from the same turn after peers and tools', () => {
  const f=fixture();useAppStore.getState().setPendingPlanCapture(f.id,'review');
  const first='# Ordered plan\n\n- [ ] First\n',last='- [ ] Second\n- [ ] Third';
  f.text(2,first);f.peer(3,'Advice');f.emit('primary_tool_use',4,{tool:'Read',toolUseId:'plan-tool',input:'{}'});f.text(5,last);f.emit('primary_complete',6);
  assert.equal(useAppStore.getState().jobs[f.id].planCandidate?.body,first+last);
  assert.equal(useAppStore.getState().jobs[f.id].pendingPlanCapture,null);
});

test('reconnect continues the persisted segment and cold replay yields identical row identities and contents', () => {
  const f=fixture();f.text(2,'Before');f.peer(3,'Peer');f.text(4,'Af');
  const cached=structuredClone(useAppStore.getState().jobs[f.id]);
  streamingMsgs.delete(f.id);
  useAppStore.setState(s=>({jobs:{...s.jobs,[f.id]:{...cached,messages:cached.messages.map(m=>({...m,isStreaming:false}))}}}));
  f.text(5,'ter');f.emit('primary_complete',6);f.emit('primary_turn_ended',7,{endedAt:2000});
  const warm=f.display().map(m=>[m.id,m.role,m.content]);
  useAppStore.getState().removeJob(f.id);streamingMsgs.delete(f.id);useAppStore.getState().createJob(f.id,config,undefined,undefined);
  f.emit('primary_turn_started',1,{startedAt:1000});f.text(2,'Before');f.peer(3,'Peer');f.text(4,'Af');f.text(5,'ter');f.emit('primary_complete',6);f.emit('primary_turn_ended',7,{endedAt:2000});
  assert.deepEqual(f.display().map(m=>[m.id,m.role,m.content]),warm);
  assert.ok(useAppStore.getState().jobs[f.id].messages.every(m=>!m.isStreaming));
});

test('frame-batched chat deltas flush to the before segment and cancellation retains it', () => {
  const original=Object.getOwnPropertyDescriptors(globalThis);
  const callbacks=new Map<number,FrameRequestCallback>();let frame=0;
  Object.assign(globalThis,{requestAnimationFrame:(cb:FrameRequestCallback)=>{callbacks.set(++frame,cb);return frame;},cancelAnimationFrame:(id:number)=>callbacks.delete(id)});
  try {
    const f=fixture('chat');f.text(2,'Before');f.peer(3,'Peer');f.text(4,'After');f.emit('primary_complete',5);f.emit('turn_cancelled',6);
    assert.deepEqual(f.display().map(m=>m.content),['Before','Peer','After']);
    assert.equal(callbacks.size,0);
    assert.ok(useAppStore.getState().jobs[f.id].messages.every(m=>!m.isStreaming));
  } finally {
    for(const key of ['requestAnimationFrame','cancelAnimationFrame']) {
      if(original[key])Object.defineProperty(globalThis,key,original[key]);else Reflect.deleteProperty(globalThis,key);
    }
  }
});

test('outgoing peers, repeated text in separate turns and historical session rows remain distinct', () => {
  const f=fixture();f.text(2,'Same');f.emit('peer_message_sent',3,{msgId:'out',from:f.id,to:'worker',contentPreview:'Sent advice',ts:50});f.text(4,' reply');f.emit('primary_complete',5);f.emit('primary_turn_ended',6,{endedAt:2000});
  f.emit('primary_turn_started',7,{startedAt:10000});f.text(8,'Same');f.peer(9,'New advice');f.text(10,' reply');f.emit('primary_complete',11);
  const store=useAppStore.getState();
  store.upsertSessionChat(f.id,{kind:'message',role:'assistant',content:'Historical text',timestamp:100,uuid:'old'});
  store.upsertSessionChat(f.id,{kind:'message',role:'assistant',content:'Same reply',timestamp:1500,uuid:'one'});
  store.upsertSessionChat(f.id,{kind:'message',role:'assistant',content:'Same reply',timestamp:10500,uuid:'two'});
  assert.deepEqual(f.display().map(m=>m.content),['Historical text','Same','Sent advice',' reply','Same','New advice',' reply']);
});

test('identical replies in rapid adjacent turns do not consume each other or historical text', () => {
  const f=fixture();f.text(2,'Repeat');f.peer(3,'First advice');f.text(4,' body');f.emit('primary_complete',5);f.emit('primary_turn_ended',6,{endedAt:1700});
  f.emit('primary_turn_started',7,{startedAt:2000});f.text(8,'Repeat');f.peer(9,'Second advice');f.text(10,' body');f.emit('primary_complete',11);
  const store=useAppStore.getState();
  store.upsertSessionChat(f.id,{kind:'message',role:'assistant',content:'Repeat body',timestamp:500,uuid:'historical-repeat'});
  store.upsertSessionChat(f.id,{kind:'message',role:'assistant',content:'Repeat body',timestamp:1500,uuid:'first-repeat'});
  store.upsertSessionChat(f.id,{kind:'message',role:'assistant',content:'Repeat body',timestamp:2500,uuid:'second-repeat'});
  assert.deepEqual(f.display().map(m=>m.content),['Repeat body','Repeat','First advice',' body','Repeat','Second advice',' body']);
});

test('session whitespace at text-block boundaries does not duplicate segmented replies or move older tools', () => {
  const f=fixture();f.text(2,'Before');f.peer(3,'Peer');f.text(4,'After');f.emit('primary_complete',5);
  const store=useAppStore.getState();
  store.upsertSessionChat(f.id,{kind:'tool_use',tool:'Old tool',toolUseId:'old-tool',input:{},timestamp:100});
  store.upsertSessionChat(f.id,{kind:'message',role:'assistant',content:'Before\n',timestamp:1500,uuid:'whitespace-one'});
  store.upsertSessionChat(f.id,{kind:'message',role:'assistant',content:'After',timestamp:1700,uuid:'whitespace-two'});
  assert.deepEqual(f.display().map(m=>m.toolUse?.tool??m.content),['Old tool','Before','Peer','After']);
});

test('completion history keeps the full reply when a peer follows its final text', () => {
  const f=fixture();f.text(2,'Earlier ');f.peer(3,'First peer');f.text(4,'answer');f.peer(5,'Last peer');f.emit('primary_complete',6);
  const history=useAppStore.getState().jobs[f.id].historyEvents ?? [];
  const last=history.at(-1)!;
  assert.equal(last.summary,'Earlier answer');
  assert.equal(last.chatMessageId,f.display().find(m=>m.content==='answer')?.id);
});


test('a long turn with fifty peer boundaries preserves every reply chunk exactly once', () => {
  const f=fixture();let seq=2;const expected:string[]=[];
  for(let i=0;i<50;i++) {
    const text=`Chunk ${i}`;f.text(seq++,text);expected.push(text);
    const peer=`Advice ${i}`;f.peer(seq++,peer);expected.push(peer);
  }
  f.text(seq++,'Final answer');expected.push('Final answer');f.emit('primary_complete',seq++);
  const before=structuredClone(useAppStore.getState().jobs[f.id].messages);
  useAppStore.getState().upsertSessionChat(f.id,{kind:'message',role:'assistant',content:expected.filter(t=>!t.startsWith('Advice')).join(''),timestamp:1500,uuid:'long-turn'});
  assert.deepEqual(f.display().map(m=>m.content),expected);
  assert.deepEqual(useAppStore.getState().jobs[f.id].messages,before,'projection must not rewrite saved event rows');
});
