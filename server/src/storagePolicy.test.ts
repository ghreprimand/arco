import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readPolicy, writePolicy } from './storageOverview.js';

test('overlapping partial policy saves keep every value', async () => {
  for (let i = 0; i < 20; i++) {
    await Promise.all([writePolicy({ budgetGiB: 5 + i }), writePolicy({ autoArchiveClosedDays: 30 + i })]);
    const policy = await readPolicy();
    assert.equal(policy.budgetGiB, 5 + i);
    assert.equal(policy.autoArchiveClosedDays, 30 + i);
  }
});
