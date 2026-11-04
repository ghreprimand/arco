import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tabStatus, TAB_STATUS_LABEL } from './tabStatus.js';

test('a waiting question outranks a running turn and an unviewed reply', () => {
  assert.equal(tabStatus({ waiting: true, busy: true, unviewed: true }), 'needs-you');
  assert.equal(tabStatus({ waiting: false, busy: true, unviewed: true }), 'working');
  assert.equal(tabStatus({ waiting: false, busy: false, unviewed: true }), 'new-reply');
  assert.equal(tabStatus({ waiting: false, busy: false, unviewed: false }), 'idle');
});

test('the four words are the ones shown to the operator', () => {
  assert.deepEqual(Object.values(TAB_STATUS_LABEL), ['Needs you', 'Working', 'New reply', 'Idle']);
});

import { clusterHasIdleMail } from './tabStatus.js';

test('an idle member with mail needs the operator; a busy one or one without mail does not', () => {
  const cluster = (status: string, depth: number) => ({ members: [{ workflowId: 'm', status }], mailboxDepth: { m: depth } });
  assert.equal(clusterHasIdleMail(cluster('idle', 2), {}), true);
  assert.equal(clusterHasIdleMail(cluster('busy', 2), {}), false);
  assert.equal(clusterHasIdleMail(cluster('idle', 2), { m: { busy: true } }), false);
  assert.equal(clusterHasIdleMail(cluster('idle', 0), {}), false);
  assert.equal(clusterHasIdleMail({ members: [{ workflowId: 'm', status: 'idle' }] }, {}), false);
});
