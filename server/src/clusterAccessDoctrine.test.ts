import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BLIND_CLUSTER_DOCTRINE } from './clusterAccessDoctrine.js';

test('blind doctrine names the mailbox-only board-transition fallback', () => {
  assert.match(BLIND_CLUSTER_DOCTRINE, /only cluster communication tools are peer_send and peer_read/);
  assert.match(BLIND_CLUSTER_DOCTRINE, /Do not probe Arco HTTP APIs/);
  assert.match(BLIND_CLUSTER_DOCTRINE, /ask a standard member or the operator to perform the board transition/);
  assert.match(BLIND_CLUSTER_DOCTRINE, /missing board tool is intentional/);
});
