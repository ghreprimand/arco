import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codexQuota } from './usage.js';
test('quota preserves actual freshness, distinguishes used/remaining and never guesses missing percentages', () => {
  const snapshot = { available: true, source: 'camoufox' as const, fetchedAt: 123, analyticsUrl: 'unused', profileDir: '/secret', rawText: 'secret', rows: [
    { label: '5 hour', value: '80% remaining Resets 8 pm' }, { label: 'Weekly', value: '32% used' },
    { label: 'Other', value: '42% something' }, { label: 'Invalid', value: '150% used' }] };
  const result = codexQuota(snapshot);
  assert.equal(result.fetchedAt, 123); assert.equal(result.windows![0].percentageUsed, 20); assert.equal(result.windows![1].percentageUsed, 32);
  assert.equal(result.windows![2].percentageUsed, undefined); assert.equal(result.windows![3].percentageUsed, undefined);
  assert(!JSON.stringify(result).includes('secret')); assert.equal(codexQuota(null).available, false);
});
