import test from 'node:test';
import assert from 'node:assert/strict';
import { nextMemberName } from './spawnMemberName';

test('a role preset names the member by role and the next free number', () => {
  assert.equal(nextMemberName('', []), 'Worker #1');
  const builder = 'Implementer role. Focus on your assigned scope. Use peer_send to report progress + blockers, not to direct peers.';
  assert.equal(nextMemberName(builder, ['Builder #1', 'Builder #3', 'Tester #1']), 'Builder #2');
});
test('a custom role uses its first words and never the source name', () => {
  assert.equal(nextMemberName('Release notes editor for the docs site', []), 'Release notes editor #1');
});
