import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clusterDirectorProblem } from './clusterCoordination.js';

test('director role count recognizes director and coordinator prefixes', () => {
  assert.equal(clusterDirectorProblem([]), null);
  assert.equal(clusterDirectorProblem(['Builder', ' Director role']), null);
  assert.match(clusterDirectorProblem([' Director role', 'coordinator leads']) ?? '', /at most one director/);
  assert.equal(clusterDirectorProblem(['Directorial', 'Coordinatorish']), null);
});
