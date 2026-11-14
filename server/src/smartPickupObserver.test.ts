import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { SmartPickupReason } from '@arco/shared';
import type { EvaluatorAdapter, EvaluatorRequest } from './smartPickupAdapters.js';

const sandbox = await fs.mkdtemp(join(tmpdir(), 'arco-smart-observer-'));
process.env.ARCO_HOME = join(sandbox, 'home');
const store = await import('./clusterStore.js');
const mailbox = await import('./clusterMailbox.js');
const ledger = await import('./smartPickupLedger.js');
const smart = await import('./smartPickup.js');
const observer = await import('./smartPickupObserver.js');
const adapters = await import('./smartPickupAdapters.js');
const { corpus, corpusSnapshotInput } = await import('./smartPickupCorpus.test-support.js');
const { scoreSmartPickup, mailFingerprint, buildSnapshot } = await import('./smartPickupEvaluator.js');
after(async () => { await fs.rm(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

// Corpus reasons, mapped onto the evaluator's reason enum.
const REASON: Record<string, SmartPickupReason> = {
  ack_or_status: 'ack_or_status', ack: 'ack_or_status', status: 'ack_or_status', progress: 'progress', injection: 'injection',
  completion_or_result: 'completion', completion: 'completion', assignment: 'assignment', explicit_assignment: 'assignment', actionable_burst: 'assignment',
  blocker: 'blocker', resolved_blocker: 'blocker', failure: 'failure', ambiguous: 'ambiguous', empty_body: 'ambiguous', invalid_output: 'ambiguous',
  clarification: 'question', question: 'question', superseded: 'superseded', stale: 'stale', duplicate: 'duplicate', busy: 'progress', stop_hold: 'progress',
  conflict: 'conflict', task_conflict: 'conflict', conflicting_facts: 'conflict', revision_changed: 'conflict', owner_changed: 'ownership', owner_confirmation: 'ownership',
};

let busy = new Set<string>();
const calls: EvaluatorRequest[] = [];
let answer: (req: EvaluatorRequest) => Promise<string> = async () => '{"action":"defer","reason":"ack_or_status"}';
const fake = (provider: 'cursor' | 'ollama'): EvaluatorAdapter => ({
  provider,
  capability: async () => ({ provider, available: true }),
  evaluate: async (req) => { calls.push(req); return answer(req); },
});
const restore = adapters.setEvaluatorAdaptersForTest({ cursor: fake('cursor'), ollama: fake('ollama') });
after(restore);
let clock = 1_800_000_000_000;
observer.configureSmartPickupObserver({ isBusy: (id) => busy.has(id), now: () => clock, debounceMs: 0, onDecision: () => {} });
beforeEach(() => { observer.resetSmartPickupObserverForTest(); calls.length = 0; busy = new Set(); observer.configureSmartPickupObserver({ readSnapshot: observer.readSnapshotInput }); });

async function armedCluster(limits = {}) {
  const c = await store.createCluster({ cwd: await fs.mkdtemp(join(sandbox, 'project-')), memberWorkflowIds: [randomUUID(), randomUUID(), randomUUID()] });
  const r = await smart.applyAutoPickup(c.clusterId, { mode: 'smart-observe', evaluator: { provider: 'cursor', model: 'auto' }, limits: { callsPerClusterHour: 120, callsPerMemberHour: 60, ...limits } }, () => true, clock);
  assert.equal(r.ok, true);
  return c;
}
async function send(to: string, from: string, content: string) {
  await mailbox.enqueue(to, { msgId: mailbox.mintMsgId(), fromWorkflowId: from, fromDisplayName: 'Sender', toWorkflowId: to, content, createdAt: new Date(clock++).toISOString(), delivered: false });
}

test('Observe-only runs the labeled corpus through the evaluator, records every decision and never delivers mail', async () => {
  const c = await armedCluster();
  const [director] = c.members;
  const results: { expected: 'wake' | 'defer' | 'ask'; actual: 'wake' | 'defer' | 'ask' | null; split: string }[] = [];
  for (const [i, k] of corpus.entries()) {
    // Alternate recipients so per-member hourly limits are not the subject here.
    const member = c.members[1 + (i % 2)];
    observer.resetSmartPickupObserverForTest();
    // Fresh mailbox per case.
    await mailbox.purgeMailboxForWorkflow(member);
    const input = corpusSnapshotInput(k);
    // Oracle evaluator: answers the label for this case.
    answer = async () => JSON.stringify({ action: k.expected.action, reason: REASON[k.expected.reason] ?? 'ambiguous' });
    observer.configureSmartPickupObserver({ readSnapshot: async () => input });
    busy = new Set(k.recipient.status === 'busy' ? [member] : []);
    for (const m of input.messages) await send(member, director, m.body.slice(0, 1000));
    const before = await mailbox.depthFor(member);
    const d = await observer.evaluateOnce(c.clusterId, member);
    assert.equal(await mailbox.depthFor(member), before, `${k.id}: Smart never delivers or removes mail`);
    if (k.recipient.status === 'busy' || input.messages.length === 0) {
      // Busy members are not evaluated (their turn reads the mail); an empty
      // mailbox has nothing to decide. Both amount to "no wake now".
      assert.equal(d, null, `${k.id}: nothing to evaluate`);
      results.push({ expected: k.expected.action, actual: 'defer', split: k.split });
      continue;
    }
    assert.ok(d, k.id);
    assert.ok(d!.outcome === 'logged', `${k.id}: Observe-only only logs (${d!.outcome})`);
    results.push({ expected: k.expected.action, actual: d!.action, split: k.split });
  }
  observer.configureSmartPickupObserver({ readSnapshot: observer.readSnapshotInput });
  const score = scoreSmartPickup(results);
  assert.equal(score.cases, 70);
  assert.equal(score.agreed, 70, 'the pipeline records exactly what the evaluator proposed, and boundaries match their labels');
  const heldOut = scoreSmartPickup(results.filter((r) => r.split === 'held_out'));
  assert.equal(heldOut.actionableRecall, 1);
  // Boundary cases (empty, oversized, corrupt) never reached the evaluator.
  assert.equal(calls.length, 70 - 5 - 1, 'five boundary cases and one busy case made no request');
  const snap = await ledger.smartPickupSnapshot(c.clusterId, (await store.readCluster(c.clusterId))!.smartPickup!.session!.id, clock);
  assert.equal(snap.counters.callsThisSession, 64);
  assert.equal(snap.counters.wakesThisSession, 0, 'Observe-only reserves no wakes');
});

test('malformed, extra-field, oversized and failing answers record fallback without waking in Observe-only', async () => {
  const c = await armedCluster();
  const [director, member] = c.members;
  const bad: (() => Promise<string>)[] = [
    async () => 'I think you should wake them.',
    async () => '{"action":"wake","reason":"assignment","recipient":"' + director + '"}',
    async () => '{"action":"wake","reason":"assignment","limits":{"wakesPerSession":1000}}',
    async () => '{"action":"run_tool","reason":"assignment"}',
    async () => { throw new adapters.EvaluatorRefused('tool_attempted'); },
    async () => { throw new adapters.EvaluatorRefused('timeout'); },
  ];
  for (const [i, fn] of bad.entries()) {
    answer = fn;
    await send(member, director, `Please review change ${i}.`);
    const d = await observer.evaluateOnce(c.clusterId, member);
    assert.equal(d?.action, null, `case ${i}`);
    assert.equal(d?.outcome, 'fallback_observed');
    assert.match(d!.reason, /^(invalid_answer|evaluator_error):/);
  }
  const last = (await ledger.smartPickupSnapshot(c.clusterId, undefined, clock)).lastDecision!;
  assert.equal(last.reason, 'evaluator_error:timeout');
});

test('a start-up failure is evaluated once more for the same mail, counted against the limits; an answer timeout is not', async () => {
  const c = await armedCluster();
  const [director, a, b] = c.members;
  // Cold start: the first request fails before the agent session is ready.
  let n = 0;
  answer = async () => { n += 1; if (n === 1) throw new adapters.EvaluatorRefused('startup_timeout'); return '{"action":"wake","reason":"assignment"}'; };
  await send(a, director, 'Implement the parser.');
  const first = await observer.evaluateOnce(c.clusterId, a);
  assert.deepEqual([first?.action, first?.reason], [null, 'evaluator_error:startup_timeout']);
  const retried = await observer.evaluateOnce(c.clusterId, a);
  assert.deepEqual([retried?.action, retried?.reason], ['wake', 'assignment'], 'the same mail is evaluated again');
  assert.equal(calls.length, 2);
  const snap = await ledger.smartPickupSnapshot(c.clusterId, (await store.readCluster(c.clusterId))!.smartPickup!.session!.id, clock);
  assert.equal(snap.counters.callsThisSession, 2, 'the retry has its own reservation');
  assert.equal(await observer.evaluateOnce(c.clusterId, a), null, 'and then the mail is settled');
  // Two start-up failures in a row: one retry only.
  calls.length = 0;
  answer = async () => { throw new adapters.EvaluatorRefused('startup_exited'); };
  await send(b, director, 'Review please.');
  assert.equal((await observer.evaluateOnce(c.clusterId, b))?.reason, 'evaluator_error:startup_exited');
  const secondFailure = await observer.evaluateOnce(c.clusterId, b);
  assert.equal(secondFailure?.reason, 'evaluator_error:startup_exited');
  assert.equal(secondFailure?.outcome, 'fallback_observed', 'only the second startup failure takes fallback');
  assert.equal(await observer.evaluateOnce(c.clusterId, b), null, 'no third attempt for unchanged mail');
  assert.equal(calls.length, 2);
  // An answer-phase timeout is about this mail: no retry until it changes.
  calls.length = 0;
  answer = async () => { throw new adapters.EvaluatorRefused('timeout'); };
  await send(b, director, 'One more thing.');
  assert.equal((await observer.evaluateOnce(c.clusterId, b))?.reason, 'evaluator_error:timeout');
  assert.equal(await observer.evaluateOnce(c.clusterId, b), null);
  assert.equal(calls.length, 1);
});

test('one evaluation per unchanged mailbox, serialized per member, limits enforced and logged once', async () => {
  const c = await armedCluster({ callsPerMemberHour: 2 });
  const [director, a, b] = c.members;
  answer = async () => '{"action":"wake","reason":"assignment"}';
  await send(a, director, 'Implement the parser.');
  await Promise.all([observer.onSmartPickupMail(c.clusterId, a), observer.onSmartPickupMail(c.clusterId, a), observer.onSmartPickupMail(c.clusterId, a)]);
  assert.equal(calls.length, 1, 'duplicate triggers coalesce into one evaluation');
  assert.equal(await observer.evaluateOnce(c.clusterId, a), null, 'unchanged fingerprint is not evaluated again');
  assert.equal(calls.length, 1);
  await send(a, director, 'Also add tests.');
  const second = await observer.evaluateOnce(c.clusterId, a);
  assert.equal(second?.action, 'wake');
  assert.equal(calls.length, 2, 'new mail is a new fingerprint');
  await send(a, director, 'And docs.');
  const limited = await observer.evaluateOnce(c.clusterId, a);
  assert.deepEqual([limited?.action, limited?.reason, limited?.outcome], [null, 'limit_calls_member_hour', 'skipped']);
  assert.equal(await observer.evaluateOnce(c.clusterId, a), null, 'a limit is logged once per fingerprint');
  assert.equal(calls.length, 2, 'no request beyond the limit');
  await send(b, director, 'Review please.');
  assert.equal((await observer.evaluateOnce(c.clusterId, b))?.action, 'wake', 'another member has its own allowance');
  busy.add(b);
  await send(b, director, 'More.');
  assert.equal(await observer.evaluateOnce(c.clusterId, b), null, 'busy members are skipped');
});

test('a result is discarded when Smart is turned off or re-armed during the request', async () => {
  const c = await armedCluster();
  const [director, member] = c.members;
  await send(member, director, 'Fix the build.');
  answer = async () => { await smart.applyAutoPickup(c.clusterId, { mode: 'off' }, () => true, clock); return '{"action":"wake","reason":"failure"}'; };
  const d = await observer.evaluateOnce(c.clusterId, member);
  assert.deepEqual([d?.action, d?.reason, d?.outcome], [null, 'session_changed', 'discarded']);
  assert.equal(store.getAutoPickupMode(c.clusterId), 'off');
  assert.equal(await observer.evaluateOnce(c.clusterId, member), null, 'nothing runs while off');
  const snap = await ledger.smartPickupSnapshot(c.clusterId, undefined, clock);
  assert.equal(snap.counters.callsLastHour, 1, 'the spent request still counts');
  assert.equal(snap.counters.inFlight, 0);
});

test('the real reader adds the recipient\'s earlier message to each sender as thread context', async () => {
  const c = await armedCluster();
  const [director, member, other] = c.members;
  // The member asked the director something, then the director answered.
  await send(director, member, 'Which fixture should I use for the retry test?');
  await send(member, director, 'Use the synthetic retry fixture.');
  await send(member, other, 'Status only, no action.');
  const input = await observer.readSnapshotInput(c.clusterId, member, false);
  assert.deepEqual(input.messages.map((m) => m.senderId).sort(), [director, other].sort());
  const snap = buildSnapshot(input, 12288);
  const data = JSON.parse(snap.payload!);
  assert.deepEqual(data.lastSentToSender, [{ to: 'Member', body: 'Which fixture should I use for the retry test?' }], 'only senders the member wrote to earlier');
  assert.equal(snap.fingerprint, mailFingerprint(input.messages.map((m) => m.id)), 'thread context does not change the mail fingerprint');
  assert.ok(!snap.payload!.includes(director), 'workflow ids are not sent');
});

test('the real mailbox reader sends roles, bodies and open tasks, and flags an unreadable mailbox', async () => {
  const c = await armedCluster();
  const [director, member] = c.members;
  await send(member, director, 'Please implement step 2.');
  const input = await observer.readSnapshotInput(c.clusterId, member, false);
  assert.equal(input.messages.length, 1);
  assert.equal(input.messages[0].body, 'Please implement step 2.');
  assert.equal(input.unreadable, undefined);
  const dir = join(process.env.ARCO_HOME!, 'clusters', c.clusterId);
  const files = await fs.readdir(join(dir, 'mailbox', member)).catch(() => [] as string[]);
  if (files.length) {
    await fs.writeFile(join(dir, 'mailbox', member, 'broken.json'), '{nope');
    const broken = await observer.readSnapshotInput(c.clusterId, member, false);
    assert.equal(broken.unreadable, true);
  }
  assert.equal(mailFingerprint(input.messages.map((m) => m.id)).length, 32);
});
