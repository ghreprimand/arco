import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { EvaluatorAdapter, EvaluatorRequest } from './smartPickupAdapters.js';
import type { ObservedDecision } from './smartPickupObserver.js';

// Race and budget scenarios for Smart: Automatic (Tester's
// smart-pickup-race-scenarios). Synthetic members and mail; the evaluator and
// the turn dispatcher are fakes. Every scenario checks that no wake happens
// without admission, mail is never removed by Smart, and caps hold.
const sandbox = await fs.mkdtemp(join(tmpdir(), 'arco-smart-auto-'));
process.env.ARCO_HOME = join(sandbox, 'home');
const store = await import('./clusterStore.js');
const mailbox = await import('./clusterMailbox.js');
const ledger = await import('./smartPickupLedger.js');
const smart = await import('./smartPickup.js');
const observer = await import('./smartPickupObserver.js');
const adapters = await import('./smartPickupAdapters.js');
after(async () => { await fs.rm(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

let clock = 1_800_000_000_000;
let busy = new Set<string>();
const calls: EvaluatorRequest[] = [];
const woke: { wfid: string; content: string }[] = [];
const asks: ObservedDecision[] = [];
let answer: (req: EvaluatorRequest) => Promise<string> = async () => '{"action":"wake","reason":"assignment"}';
const fake: EvaluatorAdapter = { provider: 'cursor', capability: async () => ({ provider: 'cursor', available: true }), evaluate: async (req) => { calls.push(req); return answer(req); } };
after(adapters.setEvaluatorAdaptersForTest({ cursor: fake }));
observer.configureSmartPickupObserver({
  isBusy: (id) => busy.has(id),
  now: () => clock,
  debounceMs: 0,
  deferMs: 60_000,
  onDecision: () => {},
  readSnapshot: observer.readSnapshotInput,
  notifyAsk: (d) => asks.push(d),
  // Mirrors handleUserMessage's conditional admission: the turn starts only
  // if the guard's claim succeeds, and the claim fails while busy.
  dispatchGuarded: async (wfid, content, guard) => guard(() => {
    if (busy.has(wfid)) return false;
    woke.push({ wfid, content });
    return true;
  }),
});
beforeEach(() => { observer.resetSmartPickupObserverForTest(); calls.length = 0; woke.length = 0; asks.length = 0; busy = new Set(); clock += 3_600_000; answer = async () => '{"action":"wake","reason":"assignment"}'; });

async function automatic(limits = {}) {
  const c = await store.createCluster({ cwd: await fs.mkdtemp(join(sandbox, 'project-')), memberWorkflowIds: [randomUUID(), randomUUID(), randomUUID()] });
  const r = await smart.applyAutoPickup(c.clusterId, { mode: 'smart-auto', evaluator: { provider: 'cursor', model: 'auto' }, limits: { callsPerClusterHour: 120, callsPerMemberHour: 60, wakesPerMemberHour: 60, wakesPerSession: 200, ...limits } }, () => true, clock);
  assert.equal(r.ok, true);
  return c;
}
async function send(to: string, from: string, content: string) {
  await mailbox.enqueue(to, { msgId: mailbox.mintMsgId(), fromWorkflowId: from, fromDisplayName: 'Sender', toWorkflowId: to, content, createdAt: new Date(clock++).toISOString(), delivered: false });
}
const sessionOf = async (id: string) => (await store.readCluster(id))!.smartPickup!.session!.id;
const counters = async (id: string) => (await ledger.smartPickupSnapshot(id, await sessionOf(id), clock)).counters;

test('a wake proposal starts one admitted turn with the auto-pickup prompt and leaves the mail for that turn', async () => {
  const c = await automatic();
  const [d, m] = c.members;
  await send(m, d, 'Implement step 2.');
  const decision = await observer.evaluateOnce(c.clusterId, m);
  assert.deepEqual([decision?.action, decision?.outcome], ['wake', 'woke']);
  assert.equal(woke.length, 1);
  assert.equal(woke[0].wfid, m);
  assert.match(woke[0].content, /auto-pickup/i);
  assert.equal(await mailbox.depthFor(m), 1, 'Smart never drains mail');
  assert.equal((await counters(c.clusterId)).wakesThisSession, 1);
  assert.equal((await counters(c.clusterId)).inFlight, 0);
});

test('Observe-only never wakes, even on a wake proposal', async () => {
  const c = await automatic();
  await smart.applyAutoPickup(c.clusterId, { mode: 'smart-observe', evaluator: { provider: 'cursor', model: 'auto' } }, () => true, clock);
  const [d, m] = c.members;
  await send(m, d, 'Implement step 2.');
  const decision = await observer.evaluateOnce(c.clusterId, m);
  assert.deepEqual([decision?.action, decision?.outcome], ['wake', 'logged']);
  assert.equal(woke.length, 0);
});

test('duplicate events and unchanged polls produce one evaluation and one wake', async () => {
  const c = await automatic();
  const [d, m] = c.members;
  await send(m, d, 'Review the diff.');
  await Promise.all([1, 2, 3, 4].map(() => observer.onSmartPickupMail(c.clusterId, m)));
  for (let i = 0; i < 3; i++) await observer.evaluateOnce(c.clusterId, m);
  assert.equal(calls.length, 1);
  assert.equal(woke.length, 1);
});

test('new mail during evaluation discards the stale result; the new mailbox is evaluated next', async () => {
  const c = await automatic();
  const [d, m] = c.members;
  await send(m, d, 'First.');
  answer = async () => { await send(m, d, 'Second, arrived during evaluation.'); return '{"action":"wake","reason":"assignment"}'; };
  const stale = await observer.evaluateOnce(c.clusterId, m);
  assert.deepEqual([stale?.outcome, stale?.reason], ['skipped', 'assignment:mail_changed']);
  assert.equal(woke.length, 0);
  answer = async () => '{"action":"wake","reason":"assignment"}';
  const fresh = await observer.evaluateOnce(c.clusterId, m);
  assert.equal(fresh?.outcome, 'woke');
  assert.equal(calls.length, 2);
  assert.equal(await mailbox.depthFor(m), 2);
});

test('member removal and disarm during evaluation never wake', async () => {
  const c = await automatic();
  const [d, m, other] = c.members;
  await send(m, d, 'Do the thing.');
  answer = async () => { await store.removeMember(c.clusterId, m); return '{"action":"wake","reason":"assignment"}'; };
  const removed = await observer.evaluateOnce(c.clusterId, m);
  assert.equal(removed?.outcome, 'skipped');
  assert.match(removed!.reason, /member_changed|unverifiable/);
  await send(other, d, 'Your turn.');
  answer = async () => { await smart.applyAutoPickup(c.clusterId, { mode: 'off' }, () => true, clock); return '{"action":"wake","reason":"assignment"}'; };
  const off = await observer.evaluateOnce(c.clusterId, other);
  assert.equal(off?.outcome, 'discarded');
  assert.equal(woke.length, 0);
});

test('STOP holds the mail a member had; new mail releases it; STOP during evaluation blocks the wake', async () => {
  const c = await automatic();
  const [d, m, other] = c.members;
  await send(m, d, 'Mail before STOP.');
  await observer.noteSmartPickupStop(m);
  const held = await observer.evaluateOnce(c.clusterId, m);
  assert.deepEqual([held?.reason, held?.outcome], ['stop_hold', 'skipped']);
  assert.equal(calls.length, 0, 'no evaluation while held');
  await send(m, d, 'New mail after STOP.');
  const released = await observer.evaluateOnce(c.clusterId, m);
  assert.equal(released?.outcome, 'woke');
  await send(other, d, 'Mail for the other member.');
  answer = async () => { await observer.noteSmartPickupStop(other); return '{"action":"wake","reason":"assignment"}'; };
  const during = await observer.evaluateOnce(c.clusterId, other);
  assert.deepEqual([during?.outcome, during?.reason], ['skipped', 'assignment:stop_hold']);
  assert.equal(woke.length, 1);
});

test('exhausted caps deny before dispatch; passing conditions keep the wake owed without a new evaluation', async () => {
  const c = await automatic({ wakesPerSession: 1 });
  const [d, a, b] = c.members;
  await send(a, d, 'Task for A.');
  assert.equal((await observer.evaluateOnce(c.clusterId, a))?.outcome, 'woke');
  await send(b, d, 'Task for B.');
  const capped = await observer.evaluateOnce(c.clusterId, b);
  assert.deepEqual([capped?.outcome, capped?.reason], ['skipped', 'assignment:limit_wakes_session']);
  assert.equal(woke.length, 1);
  assert.equal((await counters(c.clusterId)).wakesThisSession, 1, 'the session cap is never exceeded');

  const c2 = await automatic();
  const [d2, x] = c2.members;
  busy.add(x);
  await send(x, d2, 'Fix it.');
  observer.configureSmartPickupObserver({ isBusy: () => false });
  const blocked = await observer.evaluateOnce(c2.clusterId, x);
  observer.configureSmartPickupObserver({ isBusy: (id) => busy.has(id) });
  assert.deepEqual([blocked?.outcome, blocked?.reason], ['skipped', 'assignment:busy'], 'claim refused while the turn path sees the member busy');
  assert.equal((await counters(c2.clusterId)).wakesThisSession, 1, 'a refused claim still counts');
  busy.delete(x);
  const retried = await observer.evaluateOnce(c2.clusterId, x);
  assert.equal(retried?.outcome, 'woke', 'the owed wake is retried');
  assert.equal(calls.length, 3, 'without asking the evaluator again');

  await send(x, d2, 'Again soon after.');
  const cooled = await observer.evaluateOnce(c2.clusterId, x);
  assert.deepEqual([cooled?.outcome, cooled?.reason], ['skipped', 'assignment:cooldown'], 'the Rule-based cooldown also applies');
  clock += 60_000;
  assert.equal((await observer.evaluateOnce(c2.clusterId, x))?.outcome, 'woke');
  assert.equal(woke.length, 3);

  const c3 = await automatic();
  const [d3, y] = c3.members;
  await send(y, d3, 'Deep chain.');
  await observer.onSmartPickupMail(c3.clusterId, y, 8);
  assert.equal(woke.filter((w) => w.wfid === y).length, 0, 'the chain-depth guard also applies');
});

test('ask raises one alert per mailbox; defer stands until it lapses or mail changes', async () => {
  const c = await automatic();
  const [d, m] = c.members;
  answer = async () => '{"action":"ask","reason":"ambiguous"}';
  await send(m, d, 'Who owns this?');
  await observer.evaluateOnce(c.clusterId, m);
  await observer.evaluateOnce(c.clusterId, m);
  assert.equal(asks.length, 1);
  await send(m, d, 'Also this.');
  await observer.evaluateOnce(c.clusterId, m);
  assert.equal(asks.length, 2, 'changed mail can alert again');
  assert.equal(woke.length, 0);

  const [, , n] = c.members;
  answer = async () => '{"action":"defer","reason":"ack_or_status"}';
  await send(n, d, 'Thanks.');
  await observer.evaluateOnce(c.clusterId, n);
  assert.equal(await observer.evaluateOnce(c.clusterId, n), null, 'defer stands');
  clock += 60_001;
  answer = async () => '{"action":"wake","reason":"question"}';
  assert.equal((await observer.evaluateOnce(c.clusterId, n))?.outcome, 'woke', 'a lapsed defer is evaluated again');
});

test('the sweep visits every idle member with mail in a stable order', async () => {
  const c = await automatic();
  const [d, a, b] = c.members;
  await send(a, d, 'For A.');
  await send(b, d, 'For B.');
  await observer.sweepSmartPickupMail();
  for (let i = 0; i < 50 && woke.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(woke.map((w) => w.wfid).sort(), [a, b].sort());
});
