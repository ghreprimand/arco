import assert from 'node:assert/strict';
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
  assert.match(text!, /Never wait inside a turn/);
  assert.match(text!, /no sleep or polling longer than 60 seconds/);
  assert.match(text!, /say what is pending and end the turn/);
  assert.match(text!, /Do not write or edit product code or tests yourself/);
  assert.match(text!, /a second implementation of existing logic, a wrapper that only passes calls through/);
});

test('non-director roles get no director doctrine', () => {
  assert.equal(buildClusterDirectorDoctrine('Tester role.'), undefined);
  assert.equal(buildClusterDirectorDoctrine(undefined), undefined);
});
