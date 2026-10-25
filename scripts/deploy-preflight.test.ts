import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activeClusterMembers } from './deploy-preflight.js';

test('deployment cannot mistake cluster status for the standalone busy field', () => {
  assert.deepEqual(activeClusterMembers([
    { workflowId: 'a', displayName: 'Builder 1', status: 'idle' },
    { workflowId: 'b', displayName: 'Builder 2', status: 'busy' },
  ]), [{ workflowId: 'b', name: 'Builder 2' }]);
  assert.throws(() => activeClusterMembers([
    { workflowId: 'b', displayName: 'Builder 2', busy: true } as never,
  ]), /Unknown member status/);
});
