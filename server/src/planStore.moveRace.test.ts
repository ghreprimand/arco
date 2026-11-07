import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPlan, movePlan, readPlan, readPlanRef, updatePlan, writePlanRef } from './planStore.js';

// MOVE copies a plan to another project, then removes it from the source. An
// edit saved to the source in between (its text, or a reference document) must
// end up in the moved plan, never be deleted with the source.

async function projects(fn: (a: string, b: string) => Promise<void>): Promise<void> {
  const a = await mkdtemp(path.join(tmpdir(), 'arco-move-a-'));
  const b = await mkdtemp(path.join(tmpdir(), 'arco-move-b-'));
  try { await fn(a, b); } finally { await rm(a, { recursive: true, force: true }); await rm(b, { recursive: true, force: true }); }
}

// Holds MOVE once at its reference-document copy (before or after it), after
// the target body and index are written and before the source is removed.
function pauseAtCopy(when: 'before' | 'after' = 'before'): { reached: Promise<void>; release: () => void; restore: () => void } {
  const original = fs.cp;
  let reach!: () => void, release!: () => void;
  const reached = new Promise<void>((r) => { reach = r; });
  const gate = new Promise<void>((r) => { release = r; });
  let paused = false;
  (fs as { cp: typeof fs.cp }).cp = (async (...args: Parameters<typeof fs.cp>) => {
    if (paused) return original(...args);
    paused = true;
    if (when === 'after') await original(...args);
    reach(); await gate;
    if (when === 'before') return original(...args);
  }) as typeof fs.cp;
  return { reached, release, restore: () => { (fs as { cp: typeof fs.cp }).cp = original; } };
}

test('an edit saved to the source while MOVE runs is moved, not deleted', async () => {
  await projects(async (a, b) => {
    const plan = await createPlan(a, { title: 'Plan', body: 'OLD' });
    const hold = pauseAtCopy();
    try {
      const moving = movePlan(a, plan.id, b);
      await hold.reached;
      const saved = await updatePlan(a, plan.id, { body: 'NEW-ACKNOWLEDGED-EDIT' });
      assert.equal(saved?.body, 'NEW-ACKNOWLEDGED-EDIT');
      hold.release();
      const result = await moving;
      assert.equal(result.ok, true);
    } finally { hold.restore(); }
    assert.equal(await readPlan(a, plan.id), null);
    assert.equal((await readPlan(b, plan.id))?.body, 'NEW-ACKNOWLEDGED-EDIT');
  });
});

test('a reference document written to the source while MOVE runs is moved too', async () => {
  await projects(async (a, b) => {
    const plan = await createPlan(a, { title: 'Plan', body: 'Body' });
    await writePlanRef(a, plan.id, 'spec', '# Spec\nOLD');
    const hold = pauseAtCopy('after');
    try {
      const moving = movePlan(a, plan.id, b);
      await hold.reached;
      const written = await writePlanRef(a, plan.id, 'spec', '# Spec\nNEW-REF');
      assert.equal(written.ok, true);
      hold.release();
      assert.equal((await moving).ok, true);
    } finally { hold.restore(); }
    assert.equal(await readPlan(a, plan.id), null);
    assert.equal((await readPlanRef(b, plan.id, 'spec'))?.body, '# Spec\nNEW-REF');
  });
});

test('a plain MOVE still moves the plan and its reference documents', async () => {
  await projects(async (a, b) => {
    const plan = await createPlan(a, { title: 'Plan', body: 'Body' });
    await writePlanRef(a, plan.id, 'spec', '# Spec');
    assert.equal((await movePlan(a, plan.id, b)).ok, true);
    assert.equal(await readPlan(a, plan.id), null);
    assert.equal((await readPlan(b, plan.id))?.body, 'Body');
    assert.equal((await readPlanRef(b, plan.id, 'spec'))?.body, '# Spec');
  });
});
