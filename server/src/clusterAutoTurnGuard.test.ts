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
