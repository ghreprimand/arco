// Plan reference docs (planStore listPlanRefs / readPlanRef / writePlanRef /
// deletePlanRef) + their lifecycle coupling to deletePlan / movePlan.
//
// Run: npm run test:plan-refs -w server

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import {
  createPlan, deletePlan, movePlan, reconcilePlanFile, listPlans,
  listPlanRefs, readPlanRef, writePlanRef, deletePlanRef, planRefsDir, REF_BODY_MAX,
} from './planStore.js';

async function tmpCwd(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'arco-plan-refs-'));
}

test('write / list / read / delete a ref', async () => {
  const cwd = await tmpCwd();
  const plan = await createPlan(cwd, { title: 'P', body: '### A\n- [ ] x\n' });
  const w = await writePlanRef(cwd, plan.id, 'auth-spec', '# Auth flow spec\n\nbody');
  assert.equal(w.ok, true);
  assert.equal(w.ok && w.created, true);
  const again = await writePlanRef(cwd, plan.id, 'auth-spec', '# Auth flow spec v2\n');
  assert.equal(again.ok && again.created, false);
  const refs = await listPlanRefs(cwd, plan.id);
  assert.deepEqual(refs.map((r) => [r.slug, r.title]), [['auth-spec', 'Auth flow spec v2']]);
  const full = await readPlanRef(cwd, plan.id, 'auth-spec');
  assert.equal(full?.body, '# Auth flow spec v2\n');
  assert.equal(await deletePlanRef(cwd, plan.id, 'auth-spec'), true);
  assert.equal(await deletePlanRef(cwd, plan.id, 'auth-spec'), false);
  assert.deepEqual(await listPlanRefs(cwd, plan.id), []);
});

test('title falls back to slug; bad slugs and unknown plans refused', async () => {
  const cwd = await tmpCwd();
  const plan = await createPlan(cwd, { title: 'P', body: '' });
  await writePlanRef(cwd, plan.id, 'notes', 'no heading here');
  assert.equal((await listPlanRefs(cwd, plan.id))[0].title, 'notes');
  for (const bad of ['Upper', '-lead', 'has space', '../x', '']) {
    const r = await writePlanRef(cwd, plan.id, bad, 'x');
    assert.equal(r.ok, false, `slug ${JSON.stringify(bad)} should be refused`);
  }
  const missing = await writePlanRef(cwd, '00000000-0000-0000-0000-000000000000', 'a', 'x');
  assert.equal(missing.ok, false);
  const big = await writePlanRef(cwd, plan.id, 'big', 'x'.repeat(REF_BODY_MAX + 1));
  assert.equal(big.ok, false);
});

test('hand-written ref files are listed; non-slug names skipped', async () => {
  const cwd = await tmpCwd();
  const plan = await createPlan(cwd, { title: 'P', body: '' });
  const dir = planRefsDir(cwd, plan.id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'design.md'), '# Design\n');
  await fs.writeFile(path.join(dir, 'Bad Name.md'), '# nope\n');
  await fs.writeFile(path.join(dir, 'notes.txt'), 'nope');
  assert.deepEqual((await listPlanRefs(cwd, plan.id)).map((r) => r.slug), ['design']);
});

test('the refs dir never reconciles as a plan', async () => {
  const cwd = await tmpCwd();
  const plan = await createPlan(cwd, { title: 'P', body: '' });
  await writePlanRef(cwd, plan.id, 'a', '# A\n');
  // The watcher only forwards `<id>.md` names; `<id>.refs` must not parse as one.
  assert.equal((await reconcilePlanFile(cwd, `${plan.id}.refs`)).kind, 'noop');
  assert.equal((await listPlans(cwd)).length, 1);
});

test('deletePlan removes refs; movePlan carries them', async () => {
  const a = await tmpCwd();
  const b = await tmpCwd();
  const p1 = await createPlan(a, { title: 'P1', body: '' });
  await writePlanRef(a, p1.id, 'one', '# One\n');
  assert.equal(await deletePlan(a, p1.id), true);
  await assert.rejects(fs.stat(planRefsDir(a, p1.id)));

  const p2 = await createPlan(a, { title: 'P2', body: '' });
  await writePlanRef(a, p2.id, 'two', '# Two\n');
  const moved = await movePlan(a, p2.id, b);
  assert.equal(moved.ok, true);
  assert.deepEqual((await listPlanRefs(b, p2.id)).map((r) => r.slug), ['two']);
  assert.deepEqual(await listPlanRefs(a, p2.id), []);
});
