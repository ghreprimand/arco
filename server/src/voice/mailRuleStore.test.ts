import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ComputerMailRules, MAIL_RULE_COOLDOWN_MS as cooldown, MAIL_RULE_DURATION_MS as duration } from './mailRuleStore.js';
import type { MailSnapshot } from './mailRuleStore.js';
import { computerToolWireArgs } from './toolDefinitions.js';

const snapshot = (): MailSnapshot => ({ autoPickup: false, members: [
  { id: 'b1', name: 'Builder 1', busy: false, pending: ['m1'] },
  { id: 'b2', name: 'Builder 2', busy: false, pending: [] },
  { id: 'd', name: 'Director', busy: false, pending: ['report'] },
] });
const arm = (s: ComputerMailRules, snap = snapshot(), privateRule = false) => s.create('owner', 'cluster', 'SignalQueue', ['b1'], 'd', snap, privateRule, 0);
test('only selected workers, only new mail; busy/cooldown/unchanged batches cannot loop', () => {
  const s = new ComputerMailRules(), snap = snapshot(), r = arm(s);
  snap.members[1].pending = ['other-builder-mail'];
  const first = s.next(r.id, snap, 1)!; assert.equal(first.targetId, 'b1'); s.record(r.id, first, 1);
  assert.equal(s.next(r.id, snap, cooldown + 2), undefined);
  snap.members[0].pending.push('m2');
  assert.equal(s.next(r.id, snap, 2), undefined);
  snap.members[0].busy = true; assert.equal(s.next(r.id, snap, cooldown + 2), undefined);
  snap.members[0].busy = false;
  assert.equal(s.next(r.id, snap, cooldown + 2)!.targetId, 'b1');
});
test('final nudge waits for ALL other mailboxes AND full idle boundary, and fires once', () => {
  const s = new ComputerMailRules(), snap = snapshot(), r = arm(s);
  snap.members[0].pending = []; snap.members[1].busy = true;
  assert.equal(s.next(r.id, snap, 1), undefined);
  snap.members[1].busy = false; snap.members[1].pending = ['outside-selected-set'];
  assert.equal(s.next(r.id, snap, 2), undefined);
  snap.members[1].pending = []; snap.members[2].busy = true;
  assert.equal(s.next(r.id, snap, 3), undefined);
  snap.members[2].busy = false;
  const action = s.next(r.id, snap, 4)!; assert.equal(action.final, true); assert.equal(action.targetId, 'd');
  s.record(r.id, action, 4); assert.equal(s.get(r.id)!.status, 'finished');
  assert.equal(s.next(r.id, snap, 5), undefined);
});
test('limits, expiry, membership changes, AUTO-PICKUP, cancellation and restart stop the rule', () => {
  const s = new ComputerMailRules(), snap = snapshot(), r = arm(s);
  for (let i = 0; i < 8; i++) { snap.members[0].pending = [`m${i}`]; const a = s.next(r.id, snap, i * cooldown)!; assert(a); s.record(r.id, a, i * cooldown); }
  snap.members[0].pending = ['ninth']; assert.equal(s.next(r.id, snap, 8 * cooldown), undefined); assert.equal(s.get(r.id)!.status, 'limited');
  const exp = arm(s); assert.equal(s.next(exp.id, snap, duration), undefined); assert.equal(s.get(exp.id)!.status, 'expired');
  const changed = arm(s); s.next(changed.id, { ...snap, members: snap.members.slice(1) }, 1); assert.equal(s.get(changed.id)!.status, 'interrupted');
  const auto = arm(s); s.next(auto.id, { ...snap, autoPickup: true }, 1); assert.equal(s.get(auto.id)!.status, 'interrupted');
  assert.throws(() => arm(s, { ...snap, autoPickup: true }), /AUTO-PICKUP/);
  const cancelled = arm(s); s.stop(cancelled.id, 'cancelled', 'operator cancelled'); assert.equal(s.next(cancelled.id, snap, 1), undefined);
  const restart = arm(s); const recovered = new ComputerMailRules(s.saved()); assert.equal(recovered.get(restart.id)!.status, 'interrupted');
});
test('exact ids, duplicates, privacy isolation and array wire encoding', () => {
  const s = new ComputerMailRules(), snap = snapshot();
  assert.throws(() => s.create('o', 'c', 'x', ['b1','b1'], 'd', snap), /distinct/);
  assert.throws(() => s.create('o', 'c', 'x', ['unknown'], 'd', snap), /distinct/);
  assert.throws(() => s.create('o', 'c', 'x', ['d'], 'd', snap), /distinct/);
  const r = arm(s, snap, true); assert.deepEqual(s.saved(), []); assert.deepEqual(s.list('other'), []); assert.equal(s.all().length, 1);
  assert(s.next(r.id, snap, 1)); assert.throws(() => arm(s), /already has/);
  s.clearPrivate('owner'); assert.deepEqual(s.all(), []);
  assert.deepEqual(computerToolWireArgs({worker_ids:['b1','b2'],confirm:true,empty:undefined}), {worker_ids:'["b1","b2"]',confirm:'true'});
});

test('pause/resume and the actual next deadline never require a recurring scan',()=>{
  const s=new ComputerMailRules(),snap=snapshot(),r=arm(s);
  s.get(r.id)!.paused=true;assert.equal(s.next(r.id,snap,1),undefined);assert.equal(s.nextDeadline(r.id,true,1),duration);
  s.get(r.id)!.paused=false;const a=s.next(r.id,snap,1)!;s.record(r.id,a,1);
  assert.equal(s.nextDeadline(r.id,true,2),1+cooldown);assert.equal(s.nextDeadline(r.id,false,2),duration);
  assert.equal(s.nextDeadline(r.id,true,cooldown+2),duration);
});
