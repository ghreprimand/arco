import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireCheckoutWriter, observeCheckoutWriters } from './checkoutOwnership.js';

test('observes other managed writers before and during a turn without blocking them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arco-observe-'));
  const project = join(root, 'project'), other = join(root, 'other');
  await mkdir(project); await mkdir(other);
  const self = {}, peer = {};
  try {
    const own = acquireCheckoutWriter([project], undefined, self);
    const observed = observeCheckoutWriters([project], self);
    const same = acquireCheckoutWriter([project], undefined, self, false, 'primary');
    observed.setPrimaryWorker('primary');
    const snapshot = acquireCheckoutWriter([project], undefined, undefined, true);
    const disjoint = acquireCheckoutWriter([other], undefined, peer);
    const isolated = acquireCheckoutWriter([project], undefined, {}, false, undefined, [other]);
    assert.equal(observed.hasOverlap(), false);
    const foreign = acquireCheckoutWriter([join(project, 'child')], undefined, peer);
    assert.equal(observed.hasOverlap(), true);
    foreign(); isolated(); disjoint(); snapshot(); same(); observed.stop();
    const newObs = observeCheckoutWriters([project], self); newObs.setPrimaryWorker('primary');
    const ownAuxiliary = acquireCheckoutWriter([project], undefined, self, false, 'reviewer');
    assert.equal(newObs.hasOverlap(), true); ownAuxiliary(); newObs.stop(); own();
    const fallbackObs = observeCheckoutWriters([project], self);
    const malformedObservedPath = acquireCheckoutWriter([project], undefined, peer, false, undefined, ['\0']);
    assert.equal(fallbackObs.hasOverlap(), true);
    malformedObservedPath(); fallbackObs.stop();
    const active = acquireCheckoutWriter([project], undefined, peer);
    const later = observeCheckoutWriters([project], self);
    assert.equal(later.hasOverlap(), true);
    later.stop(); active();
  } finally { await rm(root, {recursive:true,force:true}); }
});
