import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { isAutoCompactionPolicy, resolveAutoCompactionPolicy } from './workflows.js';

test('auto-compaction validates explicit bounded integer policy', () => {
  for (const n of [50, 70, 95]) assert.equal(isAutoCompactionPolicy({ enabled: true, thresholdPercent: n }), true);
  for (const n of [49, 95.1, 96, NaN, Infinity]) assert.equal(isAutoCompactionPolicy({ enabled: true, thresholdPercent: n }), false);
  assert.equal(isAutoCompactionPolicy({ thresholdPercent: 80 }), false);
});

test('worker override including off takes precedence; absence retains inheritance', () => {
  const cluster = { enabled: true, thresholdPercent: 80 };
  const off = { enabled: false, thresholdPercent: 75 };
  assert.deepEqual(resolveAutoCompactionPolicy(undefined, undefined), undefined);
  assert.deepEqual(resolveAutoCompactionPolicy(undefined, cluster), cluster);
  assert.deepEqual(resolveAutoCompactionPolicy(off, cluster), off);
  assert.deepEqual(resolveAutoCompactionPolicy({enabled:true,thresholdPercent:Infinity}, cluster), {enabled:false,thresholdPercent:80});
});
