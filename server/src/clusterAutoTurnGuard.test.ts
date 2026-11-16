import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const root = await fs.mkdtemp(join(tmpdir(), 'arco-rule-pickup-'));
process.env.ARCO_HOME = join(root, 'home');
process.env.ARCO_CLUSTER_AUTO_TURN_COOLDOWN_MS = '0';
const store = await import('./clusterStore.js');
const mailbox = await import('./clusterMailbox.js');
const detector = await import('./clusterAutoTurn.js');
after(async () => { detector.stop(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

test('ack-only mail remains pending and later actionable mail wakes the recipient', async () => {
  const sender = randomUUID(), recipient = randomUUID();
  const cluster = await store.createCluster({ cwd: await fs.mkdtemp(join(root, 'project-')), memberWorkflowIds: [sender, recipient] });
  await store.setAutoTurnOnMailbox(cluster.clusterId, true);
  const events: Array<{ type: string; reason?: string }> = []; let wakes = 0;
  detector.configure({ broadcastWorkflow: (_id, msg) => { events.push(msg as { type: string; reason?: string }); }, dispatchAutoTurn: () => { wakes++; }, isBusy: () => false });
  const send = async (content: string) => {
    await mailbox.enqueue(recipient, { msgId: randomUUID(), fromWorkflowId: sender, fromDisplayName: 'Builder', toWorkflowId: recipient, content, createdAt: new Date().toISOString(), delivered: false });
    detector.onPeerMessageSent({ clusterId: cluster.clusterId, senderWfid: sender, recipientWfid: recipient, incomingChainDepth: 0 });
    await new Promise((resolve) => setTimeout(resolve, 80));
  };
  await send('Thanks!'); assert.equal(wakes, 0); assert.equal((await mailbox.peek(recipient)).length, 1); assert.ok(events.some((e) => e.reason === 'ack_only'));
  await send('Thanks, please check the failed test.'); assert.equal(wakes, 1); assert.equal((await mailbox.peek(recipient)).length, 2);
});

test('a recipient that becomes busy before deferred dispatch is not woken', async () => {
  const sender = randomUUID(), recipient = randomUUID();
  const cluster = await store.createCluster({ cwd: await fs.mkdtemp(join(root, 'project-')), memberWorkflowIds: [sender, recipient] });
  await store.setAutoTurnOnMailbox(cluster.clusterId, true);
  let busy = false, wakes = 0;
  detector.configure({ broadcastWorkflow: (_id, msg) => { if (msg.type === 'cluster_auto_turn_fired' && msg.fired) busy = true; }, dispatchAutoTurn: () => { wakes++; }, isBusy: () => busy });
  await mailbox.enqueue(recipient, { msgId: randomUUID(), fromWorkflowId: sender, fromDisplayName: 'Builder', toWorkflowId: recipient, content: 'Please check the failing test.', createdAt: new Date().toISOString(), delivered: false });
  detector.onPeerMessageSent({ clusterId: cluster.clusterId, senderWfid: sender, recipientWfid: recipient, incomingChainDepth: 0 });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(wakes, 0); assert.equal((await mailbox.peek(recipient)).length, 1);
});

test('operator pause holds Rule-based mail and resume keeps the budget while waking each idle member once', { timeout: 5000 }, async () => {
  const smart = await import('./smartPickup.js');
  const members = [randomUUID(), randomUUID(), randomUUID()];
  const cluster = await store.createCluster({ cwd: await fs.mkdtemp(join(root, 'project-')), memberWorkflowIds: members });
  await smart.applyAutoPickup(cluster.clusterId, { mode: 'rule' }, () => true);
  const busy = new Set<string>();
  const wakes: string[] = [];
  let finished!: () => void;
  const resumed = new Promise<void>((resolve) => { finished = resolve; });
  detector.configure({ broadcastWorkflow: () => {}, isBusy: (id) => busy.has(id),
    resolveMembers: () => new Map([[cluster.clusterId, members.map((workflowId) => ({ workflowId, busy: busy.has(workflowId) }))]]),
    dispatchAutoTurn: (id) => { busy.add(id); wakes.push(id); if (wakes.length === 2) finished(); },
  });
  const send = async (recipient: string) => mailbox.enqueue(recipient, { msgId: randomUUID(), fromWorkflowId: members[0], fromDisplayName: 'Builder', toWorkflowId: recipient, content: 'Please check this task.', createdAt: new Date().toISOString(), delivered: false });
  await smart.applyAutoPickup(cluster.clusterId, { mode: 'rule', paused: true }, () => true);
  await send(members[1]); await send(members[2]);
  detector.onPeerMessageSent({ clusterId: cluster.clusterId, senderWfid: members[0], recipientWfid: members[1], incomingChainDepth: 0 });
  await detector.pickupWaitingMail(cluster.clusterId);
  assert.equal(wakes.length, 0);
  assert.equal(detector.rulePickupStatus(cluster.clusterId).wakes, 0);
  assert.equal((await mailbox.peek(members[1])).length, 1);
  await smart.applyAutoPickup(cluster.clusterId, { mode: 'rule', paused: false }, () => true);
  await resumed;
  assert.deepEqual(wakes.sort(), members.slice(1).sort());
  assert.equal(detector.rulePickupStatus(cluster.clusterId).wakes, 2);
  await smart.applyAutoPickup(cluster.clusterId, { mode: 'rule', paused: true }, () => true);
  assert.equal(detector.rulePickupStatus(cluster.clusterId).wakes, 2, 'another pause keeps the existing count');
  assert.deepEqual(await smart.applyAutoPickup(cluster.clusterId, { mode: 'rule', resumeRule: true }, () => true), { ok: false, problem: 'invalid_pause' }, 'a budget reset cannot silently clear an operator pause');
  await smart.applyAutoPickup(cluster.clusterId, { mode: 'off' }, () => true);
  assert.equal(store.isAutoPickupPaused(cluster.clusterId), false);
});
