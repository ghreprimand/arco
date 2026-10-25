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
