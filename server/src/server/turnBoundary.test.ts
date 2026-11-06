import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type WebSocket from 'ws';
import type { ServerMessage } from '@arco/shared';

// Turn-boundary hooks for real turns. The turn engine reports a turn's start
// and end through send(); other producers use broadcastWorkflow. Both paths
// run the same hooks: the idle nudger's busy/idle baseline, the end-of-turn
// artifact size check, the auto-turn chain-depth clear and the auto-pickup
// idle-resume sweep. A start or end carried twice runs them once.
const root = mkdtempSync(path.join(tmpdir(), 'arco-turn-boundary-'));
installIsolatedTestHome(root);
process.env.ARCO_ARTIFACT_WARN_FILE_BYTES = '1000';
process.env.ARCO_CLUSTER_AUTO_TURN_COOLDOWN_MS = '0';
process.env.ARCO_CLUSTER_AUTO_TURN_RATE_CAP_PER_MINUTE = '4';
process.env.ARCO_CLUSTER_AUTO_TURN_SWEEP_INTERVAL_MS = '500';
const { send, broadcastWorkflow } = await import('./broadcast.js');
const { workflows, workflowCwds } = await import('./state.js');
const { initWorkflowStore } = await import('../workflowStore.js');
const { settleProjectWrites } = await import('../testSupport/projectWrites.js');
const nudger = await import('../clusterIdleNudger.js');
const autoTurn = await import('../clusterAutoTurn.js');
const clusterStore = await import('../clusterStore.js');
const mailbox = await import('../clusterMailbox.js');
const members: string[] = [];
after(async () => {
  autoTurn.stop();
  for (const id of members) { workflows.delete(id); workflowCwds.delete(id); }
  await settleProjectWrites();
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

type Path = 'send' | 'broadcastWorkflow';
interface Member { id: string; cwd: string; ws: WebSocket; received: ServerMessage[]; wf: { busy: boolean } }

function member(withCwd = false): Member {
  const id = randomUUID();
  const cwd = path.join(root, id);
  const received: ServerMessage[] = [];
  const ws = { readyState: 1, bufferedAmount: 0, send: (data: string) => { received.push(JSON.parse(data)); } } as unknown as WebSocket;
  const wf = { config: { name: 'fixture', workingDirectory: cwd, primaryProvider: 'claude' }, primary: { provider: 'claude', model: 'fixture' }, busy: false, observers: new Set([ws]), queue: { steering: [], followUp: [] } };
  workflows.set(id, wf as never);
  if (withCwd) workflowCwds.set(id, cwd);
  members.push(id);
  return { id, cwd, ws, received, wf };
}

function boundary(m: Member, via: Path, type: 'primary_turn_started' | 'primary_turn_ended'): void {
  const message = (type === 'primary_turn_started'
    ? { type, workflowId: m.id, startedAt: Date.now() }
    : { type, workflowId: m.id, endedAt: Date.now() }) as ServerMessage;
  if (via === 'send') send(m.ws, message); else broadcastWorkflow(m.id, message);
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await tick(10);
  assert.ok(check(), label);
}

for (const via of ['send', 'broadcastWorkflow'] as const) {
  test(`${via}: the idle nudger sees the member busy, then idle, with the per-turn count reset`, () => {
    const m = member();
    boundary(m, via, 'primary_turn_ended');
    assert.equal(nudger._peekMember(m.id).busy, false);
    boundary(m, via, 'primary_turn_started');
    assert.deepEqual(nudger._peekMember(m.id), { busy: true, idleSince: undefined, nudgesThisTurn: 0 });
    boundary(m, via, 'primary_turn_ended');
    const idle = nudger._peekMember(m.id);
    assert.equal(idle.busy, false);
    assert.equal(typeof idle.idleSince, 'number');
  });

  test(`${via}: a turn shorter than the in-turn interval still gets the end-of-turn size check`, async () => {
    const m = member(true);
    const artifacts = path.join(m.cwd, '.arco', 'workflows', m.id, 'artifacts');
    mkdirSync(artifacts, { recursive: true });
    await initWorkflowStore(m.cwd, m.id);
    boundary(m, via, 'primary_turn_started');
    writeFileSync(path.join(artifacts, 'render.bin'), Buffer.alloc(4000));
    boundary(m, via, 'primary_turn_ended');
    const warned = () => m.received.filter((msg) => msg.type === 'storage_warning');
    await until(() => warned().length > 0, 'storage_warning after the turn ended');
    assert.deepEqual((warned()[0] as ServerMessage & { items: Array<{ path: string }> }).items.map((i) => i.path), ['artifacts/render.bin']);
  });

  test(`${via}: the auto-turn chain depth clears when the turn ends`, () => {
    const m = member();
    boundary(m, via, 'primary_turn_started');
    autoTurn.stampSharedGuards('depth-fixture', m.id, 2);
    assert.equal(autoTurn.currentAutoTurnDepth(m.id), 3);
    boundary(m, via, 'primary_turn_ended');
    assert.equal(autoTurn.currentAutoTurnDepth(m.id), 0);
  });
}

test('a start or end carried twice runs the hooks once', () => {
  const m = member();
  boundary(m, 'send', 'primary_turn_started');
  boundary(m, 'send', 'primary_turn_ended');
  const firstIdle = nudger._peekMember(m.id).idleSince;
  // A STOP sends its own end and the killed worker sends another; the second
  // must not re-stamp the idle baseline or clear a marker set since.
  autoTurn.stampSharedGuards('dup-fixture', m.id, 0);
  const realNow = Date.now; Date.now = () => realNow() + 60_000;
  try {
    boundary(m, 'broadcastWorkflow', 'primary_turn_ended');
    boundary(m, 'send', 'primary_turn_ended');
  } finally { Date.now = realNow; }
  assert.equal(nudger._peekMember(m.id).idleSince, firstIdle);
  assert.equal(autoTurn.currentAutoTurnDepth(m.id), 1);
  // A repeated start does not reset the nudge state a second time either.
  boundary(m, 'send', 'primary_turn_started');
  assert.equal(nudger._peekMember(m.id).busy, true);
  boundary(m, 'broadcastWorkflow', 'primary_turn_started');
  boundary(m, 'send', 'primary_turn_ended');
  assert.equal(nudger._peekMember(m.id).busy, false);
  assert.equal(autoTurn.currentAutoTurnDepth(m.id), 0);
});

// A member that is busy when mail arrives is woken when its turn ends, once,
// even when both paths carry the end.
test('idle-resume sweep: mail that arrived mid-turn wakes the member once its turn ends', async () => {
  const sender = member(); const recipient = member();
  const cluster = await clusterStore.createCluster({ cwd: path.join(root, 'sweep'), memberWorkflowIds: [sender.id, recipient.id] });
  await clusterStore.setAutoPickup(cluster.clusterId, { mode: 'rule' });
  const wakes: string[] = [];
  autoTurn.configure({ broadcastWorkflow, dispatchAutoTurn: (id) => { wakes.push(id); }, isBusy: (id) => !!(workflows.get(id) as { busy?: boolean } | undefined)?.busy });
  recipient.wf.busy = true;
  boundary(recipient, 'send', 'primary_turn_started');
  await mailbox.enqueue(recipient.id, { msgId: randomUUID(), fromWorkflowId: sender.id, fromDisplayName: 'Builder', toWorkflowId: recipient.id, content: 'Please review the failing test.', createdAt: new Date().toISOString(), delivered: false });
  autoTurn.onPeerMessageSent({ clusterId: cluster.clusterId, senderWfid: sender.id, recipientWfid: recipient.id, incomingChainDepth: 0 });
  await tick(80);
  assert.deepEqual(wakes, []);
  recipient.wf.busy = false;
  boundary(recipient, 'send', 'primary_turn_ended');
  boundary(recipient, 'broadcastWorkflow', 'primary_turn_ended');
  await until(() => wakes.length > 0, 'the recipient is woken after its turn');
  await tick(150);
  assert.deepEqual(wakes, [recipient.id]);
  await clusterStore.deleteCluster(cluster.clusterId);
});

// A peer_send writes the mail first and broadcasts peer_message_sent after.
// A recipient whose turn ends in between finds the mail before its chain
// depth is known; the resume must use the depth the sender's turn will stamp
// on it, not 0, or a capped loop starts over at depth 1.
test('mail found by the turn-end resume before its peer_message_sent keeps the sender\'s chain depth', async () => {
  const sender = member(); const recipient = member();
  const cluster = await clusterStore.createCluster({ cwd: path.join(root, randomUUID()), memberWorkflowIds: [sender.id, recipient.id] });
  await clusterStore.setAutoPickup(cluster.clusterId, { mode: 'rule', ruleLimits: { maxChainDepth: 3, pingPongWakes: 10, wakesPerMemberHour: 30, wakesPerArming: 200 } });
  const outcomes: Array<{ fired: boolean; reason?: string; chainDepth: number }> = [];
  const dispatched: string[] = [];
  autoTurn.configure({
    broadcastWorkflow: (id, msg) => { if (msg.type === 'cluster_auto_turn_fired' && msg.workflowId === recipient.id) outcomes.push({ fired: msg.fired, reason: msg.fired ? undefined : msg.reason, chainDepth: msg.chainDepth }); broadcastWorkflow(id, msg); },
    dispatchAutoTurn: (id) => { dispatched.push(id); },
    isBusy: (id) => !!(workflows.get(id) as { busy?: boolean } | undefined)?.busy,
  });
  try {
    // The sender is in an auto-turn at depth 3, the last one the cap allows.
    boundary(sender, 'send', 'primary_turn_started');
    autoTurn.stampSharedGuards(cluster.clusterId, sender.id, 2);
    assert.equal(autoTurn.currentAutoTurnDepth(sender.id), 3);
    // The recipient is mid-turn when the mail file is written...
    recipient.wf.busy = true;
    boundary(recipient, 'send', 'primary_turn_started');
    await mailbox.enqueue(recipient.id, { msgId: randomUUID(), fromWorkflowId: sender.id, fromDisplayName: 'Builder', toWorkflowId: recipient.id, content: 'Your turn: please continue the review.', createdAt: new Date().toISOString(), delivered: false });
    // ...and its turn ends before the sender's peer_message_sent goes out.
    recipient.wf.busy = false;
    boundary(recipient, 'send', 'primary_turn_ended');
    await until(() => outcomes.length > 0, 'the turn-end resume looked at the held mail');
    assert.deepEqual(outcomes, [{ fired: false, reason: 'depth_capped', chainDepth: 3 }]);
    assert.deepEqual(dispatched, []);
  } finally {
    boundary(sender, 'send', 'primary_turn_ended');
    await clusterStore.deleteCluster(cluster.clusterId);
  }
});

// A ring of three members whose every turn mails the next one. Each woken
// turn starts and ends through send(), like a real turn, and drains its mail
// at the start; turns overlap, so mail also arrives mid-turn. The chain must
// still stop, with the turn-end sweep and the periodic resume sweep running.
async function ring(ruleLimits: { maxChainDepth: number }): Promise<{ fired: number; reasons: string[] }> {
  const ring = [member(), member(), member()];
  const cluster = await clusterStore.createCluster({ cwd: path.join(root, randomUUID()), memberWorkflowIds: ring.map((m) => m.id) });
  await clusterStore.setAutoPickup(cluster.clusterId, { mode: 'rule', ruleLimits: { ...ruleLimits, pingPongWakes: 10, wakesPerMemberHour: 30, wakesPerArming: 200 } });
  let fired = 0;
  const reasons: string[] = [];
  const observe = (msg: ServerMessage) => {
    if (msg.type !== 'cluster_auto_turn_fired') return;
    if (msg.fired) fired++; else reasons.push(msg.reason);
  };
  const runTurn = async (id: string) => {
    const m = ring.find((r) => r.id === id)!;
    const next = ring[(ring.indexOf(m) + 1) % ring.length];
    m.wf.busy = true;
    boundary(m, 'send', 'primary_turn_started');
    await mailbox.drain(m.id);
    await mailbox.enqueue(next.id, { msgId: randomUUID(), fromWorkflowId: m.id, fromDisplayName: 'Member', toWorkflowId: next.id, content: 'Your turn: please continue the review.', createdAt: new Date().toISOString(), delivered: false });
    broadcastWorkflow(m.id, { type: 'peer_message_sent', workflowId: m.id, msgId: randomUUID(), from: m.id, to: next.id, contentPreview: 'Your turn' } as ServerMessage);
    await tick(5);
    m.wf.busy = false;
    boundary(m, 'send', 'primary_turn_ended');
  };
  autoTurn.configure({
    broadcastWorkflow: (id, msg) => { observe(msg); broadcastWorkflow(id, msg); },
    dispatchAutoTurn: (id) => { void runTurn(id); },
    isBusy: (id) => !!(workflows.get(id) as { busy?: boolean } | undefined)?.busy,
    resolveMembers: () => new Map([[cluster.clusterId, ring.map((m) => ({ workflowId: m.id, busy: m.wf.busy }))]]),
  });
  autoTurn.start();
  // The operator's turn on the first member starts the chain at depth 0.
  await runTurn(ring[0].id);
  // Long enough for several periodic sweeps over the held mail.
  await tick(1600);
  autoTurn.stop();
  await clusterStore.deleteCluster(cluster.clusterId);
  return { fired, reasons };
}

test('the chain-depth limit still stops a loop of real turns', async () => {
  const { fired, reasons } = await ring({ maxChainDepth: 3 });
  assert.equal(fired, 3);
  assert.ok(reasons.includes('depth_capped'), reasons.join(','));
});

test('the per-minute rate cap still stops a loop of real turns', async () => {
  const { fired, reasons } = await ring({ maxChainDepth: 20 });
  assert.equal(fired, 4);
  assert.ok(reasons.includes('rate_capped'), reasons.join(','));
});
