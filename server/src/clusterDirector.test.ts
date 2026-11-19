import assert from 'node:assert/strict';
import { buildTurnWaitInstructions } from '@arco/shared';
import { test } from 'node:test';
import { buildClusterDirectorDoctrine, isClusterDirectorRole } from './clusterDirector.js';

test('director doctrine requires stay-available handoff and no long waits', () => {
  assert.equal(isClusterDirectorRole('Director role.'), true);
  assert.equal(isClusterDirectorRole('Implementer role.'), false);
  const text = buildClusterDirectorDoctrine('Director role. Delegate via peer_send.');
  assert.ok(text);
  assert.match(text!, /Stay available to the operator/);
  assert.match(text!, /the project's checks to the tester/);
  assert.match(text!, /CI watching to the change's author/);
  const combined = [buildTurnWaitInstructions('Director'), text].join('\n\n');
  assert.equal(combined.match(/60 seconds/g)?.length, 1);
  assert.match(combined, /report what is running, and end the turn/);
  assert.match(text!, /Do not write or edit product code or tests yourself/);
  assert.match(text!, /a second implementation of existing logic, a wrapper that only passes calls through/);
});

test('non-director roles get no director doctrine', () => {
  assert.equal(buildClusterDirectorDoctrine('Tester role.'), undefined);
  assert.equal(buildClusterDirectorDoctrine(undefined), undefined);
});

test('director closing check covers question turns, handoffs and operator actions', () => {
  const text = buildClusterDirectorDoctrine('Director role.')!;
  assert.match(text, /Answer the operator first, then continue already approved work in the same turn\. A question from the operator pauses only new work, which waits for the operator's approval/);
  assert.match(text, /If an issue remains open, recommend the next step, name who owns the work, and say what the operator needs to decide or do and when, if anything./);
  assert.match(text, /Before you end any turn, including one that only answers a question, check the approved work that is open now.*Approved work that can run and has no one working on it goes to its owner with peer_send in this turn\. Work an owner is doing, or that waits on a peer review or another dependency, needs no new handoff/);
  assert.match(text, /use the actual delivery and wake status: the peer_send result and the member's unread mail and state.*A handoff already queued for a member needs no second copy; when it cannot wake the member, ask the operator to nudge that member/);
  assert.match(text, /Before you send the operator to a local link or server, check that it answers; when it does not, hand its restoration to its owner in this turn/);
  assert.match(text, /For each task waiting on the operator, read its reason with cluster_task_show and name in your reply the exact action, where to do it.*Never say that no action is needed while a task waits on the operator\. Do not promise to coordinate, restore or follow up later; send the handoff in the same turn\. Backlog and new work wait for the operator's approval/);
});
