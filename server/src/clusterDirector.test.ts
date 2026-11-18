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

test('director handoff instructions identify the next step and any operator action', () => {
  const text = buildClusterDirectorDoctrine('Director role.')!;
  assert.match(text, /Answer the operator first.*recommend the next step, name who owns the work.*operator needs to decide or do and when.*worker already owns the follow-up.*operator has nothing to do.*Promise later follow-up only when an available trigger can wake you.*nudge the Director only when progress depends on it/);
  assert.match(text, /New work waits for the operator's approval; continue already approved work as usual/);
});
