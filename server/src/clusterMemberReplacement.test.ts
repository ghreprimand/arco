import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as clusterMailbox from './clusterMailbox.js';
import * as clusterStore from './clusterStore.js';

test('member replacement transfers pending mail for workers and the director', async () => {
  const cwd = await fs.mkdtemp(join(tmpdir(), 'arco-cluster-replace-mail-'));
  const directorId = randomUUID();
  const oldWorkerId = randomUUID();
  const newWorkerId = randomUUID();
  const newDirectorId = randomUUID();
  let clusterId: string | undefined;
  try {
    const cluster = await clusterStore.createCluster({
      cwd,
      memberWorkflowIds: [directorId, oldWorkerId],
    });
    clusterId = cluster.clusterId;
    const pending: clusterMailbox.PeerMessage = {
      msgId: clusterMailbox.mintMsgId(),
      fromWorkflowId: directorId,
      fromDisplayName: 'Director',
      toWorkflowId: oldWorkerId,
      content: 'Continue the assigned implementation.',
      createdAt: new Date().toISOString(),
      delivered: false,
    };
    await clusterMailbox.enqueue(oldWorkerId, pending);

    const replaced = await clusterStore.replaceMember(clusterId, oldWorkerId, newWorkerId);

    assert.ok(replaced);
    assert.deepEqual(replaced.members, [directorId, newWorkerId]);
    assert.deepEqual(await clusterMailbox.peek(oldWorkerId), []);
    const transferred = await clusterMailbox.peek(newWorkerId);
    assert.equal(transferred.length, 1);
    assert.equal(transferred[0].msgId, pending.msgId);
    assert.equal(transferred[0].fromWorkflowId, directorId);
    assert.equal(transferred[0].toWorkflowId, newWorkerId);
    assert.equal(transferred[0].content, pending.content);

    const drained = await clusterMailbox.drain(newWorkerId);
    assert.equal(drained.length, 1);
    assert.equal(drained[0].msgId, pending.msgId);
    assert.deepEqual(await clusterMailbox.peek(newWorkerId), []);

    const directorMail: clusterMailbox.PeerMessage = {
      msgId: clusterMailbox.mintMsgId(),
      fromWorkflowId: newWorkerId,
      fromDisplayName: 'Worker',
      toWorkflowId: directorId,
      content: 'Implementation is ready for review.',
      createdAt: new Date().toISOString(),
      delivered: false,
    };
    await clusterMailbox.enqueue(directorId, directorMail);
    const directorReplaced = await clusterStore.replaceMember(clusterId, directorId, newDirectorId);

    assert.ok(directorReplaced);
    assert.deepEqual(directorReplaced.members, [newDirectorId, newWorkerId]);
    assert.deepEqual(await clusterMailbox.peek(directorId), []);
    const transferredDirectorMail = await clusterMailbox.peek(newDirectorId);
    assert.equal(transferredDirectorMail.length, 1);
    assert.equal(transferredDirectorMail[0].msgId, directorMail.msgId);
    assert.equal(transferredDirectorMail[0].fromWorkflowId, newWorkerId);
    assert.equal(transferredDirectorMail[0].toWorkflowId, newDirectorId);
    assert.equal(transferredDirectorMail[0].content, directorMail.content);
  } finally {
    if (clusterId) await clusterStore.deleteCluster(clusterId);
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('a replaced member id resolves to the member now in its slot until that member leaves', async () => {
  const cwd = await fs.mkdtemp(join(tmpdir(), 'arco-cluster-replace-id-'));
  const [directorId, firstId, secondId, thirdId, otherId] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  let clusterId: string | undefined;
  try {
    clusterId = (await clusterStore.createCluster({ cwd, memberWorkflowIds: [directorId, firstId, otherId] })).clusterId;
    await clusterStore.replaceMember(clusterId, firstId, secondId);
    await clusterStore.replaceMember(clusterId, secondId, thirdId);

    assert.deepEqual(clusterStore.resolvePeerTarget(clusterId, firstId), { workflowId: thirdId, replaced: firstId });
    assert.deepEqual(clusterStore.resolvePeerTarget(clusterId, secondId.slice(0, 8)), { workflowId: thirdId, replaced: secondId });
    assert.equal(clusterStore.resolvePeer(clusterId, firstId.slice(0, 7)), undefined);
    assert.equal(clusterStore.resolvePeer(clusterId, otherId), otherId);

    await clusterStore.removeMember(clusterId, thirdId);
    assert.equal(clusterStore.resolvePeer(clusterId, firstId), undefined);
    assert.equal((await clusterStore.readCluster(clusterId))?.formerMembers, undefined);
  } finally {
    if (clusterId) await clusterStore.deleteCluster(clusterId);
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('a member removal that cannot be saved keeps routing and pending mail', async () => {
  const cwd = await fs.mkdtemp(join(tmpdir(), 'arco-cluster-remove-fail-'));
  const [directorId, workerId, otherId] = [randomUUID(), randomUUID(), randomUUID()];
  let clusterId: string | undefined;
  try {
    clusterId = (await clusterStore.createCluster({ cwd, memberWorkflowIds: [directorId, workerId, otherId] })).clusterId;
    await clusterMailbox.enqueue(workerId, {
      msgId: clusterMailbox.mintMsgId(), fromWorkflowId: directorId, fromDisplayName: 'Director',
      toWorkflowId: workerId, content: 'Keep me.', createdAt: new Date().toISOString(), delivered: false,
    });
    // Make the membership write fail: a directory cannot be renamed over by a file.
    const meta = clusterStore.clusterMetaPath(clusterId);
    await fs.rm(meta);
    await fs.mkdir(join(meta, 'blocker'), { recursive: true });
    await assert.rejects(clusterStore.removeMember(clusterId, workerId));
    assert.equal(clusterStore._peekCache().memberIndex[workerId], clusterId);
    assert.equal((await clusterMailbox.peek(workerId)).length, 1);
  } finally {
    if (clusterId) await fs.rm(clusterStore.clusterMetaPath(clusterId), { recursive: true, force: true });
    if (clusterId) await clusterStore.deleteCluster(clusterId).catch(() => undefined);
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('a member removal stays successful when mailbox cleanup fails after the commit', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
  const cwd = await fs.mkdtemp(join(tmpdir(), 'arco-cluster-remove-cleanup-'));
  const [directorId, workerId, otherId] = [randomUUID(), randomUUID(), randomUUID()];
  let clusterId: string | undefined;
  let boxRoot = '';
  try {
    clusterId = (await clusterStore.createCluster({ cwd, memberWorkflowIds: [directorId, workerId, otherId] })).clusterId;
    await clusterMailbox.enqueue(workerId, {
      msgId: clusterMailbox.mintMsgId(), fromWorkflowId: directorId, fromDisplayName: 'Director',
      toWorkflowId: workerId, content: 'x', createdAt: new Date().toISOString(), delivered: false,
    });
    boxRoot = join(clusterStore.clusterDir(clusterId), 'mailbox');
    await fs.chmod(boxRoot, 0o500);
    const result = await clusterStore.removeMember(clusterId, workerId);
    assert.deepEqual(result.remaining, [directorId, otherId]);
    assert.equal(clusterStore._peekCache().memberIndex[workerId], undefined);
  } finally {
    if (boxRoot) await fs.chmod(boxRoot, 0o700).catch(() => undefined);
    if (clusterId) await clusterStore.deleteCluster(clusterId).catch(() => undefined);
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
