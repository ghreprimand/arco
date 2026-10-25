// planRefContext — how plan reference docs reach a working agent.
//
// Run: npm run test:plan-ref-context -w server

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { createPlan, writePlanRef } from './planStore.js';
import { extractRefSlugs, refsDoctrine, resolveLinkedRefs, renderLinkedRefsForReview, planItemContextFor } from './planRefContext.js';
import { parsePlan } from './primitives/reviewContent.js';

test('extractRefSlugs finds link, wiki and bare forms, deduped, not inside words or URLs', () => {
  const text = '- [ ] build it per [API shape](ref:api-shape) and [[ref:auth-flow]]\n  see ref:api-shape, ref:edge-cases. prefref:nope https://x/ref:nope2';
  assert.deepEqual(extractRefSlugs(text).sort(), ['api-shape', 'auth-flow', 'edge-cases']);
});

test('refsDoctrine stays one line (PLAN_PREFIX_RE in turnEngine is single-line-anchored)', () => {
  const planId = '00000000-0000-4000-8000-000000000000';
  for (const d of [refsDoctrine(planId, []), refsDoctrine(planId, ['a', 'b']), refsDoctrine(planId, Array.from({ length: 30 }, (_, i) => `r${i}`))]) {
    assert.ok(!d.includes('\n'), d);
  }
  assert.match(refsDoctrine(planId, Array.from({ length: 30 }, (_, i) => `r${i}`)), /\+18 more/);
  assert.match(refsDoctrine(planId, ['spec']), /read that ref/);
});

test('resolveLinkedRefs marks existing vs dangling and returns paths', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'archon-plan-ref-ctx-'));
  try {
    const plan = await createPlan(cwd, { title: 'P', body: '### A\n- [ ] x per [s](ref:spec)\n' });
    assert.ok((await writePlanRef(cwd, plan.id, 'spec', '# The Spec\n\nDo the thing.\n')).ok);
    const linked = await resolveLinkedRefs(cwd, [plan.id], ['task per ref:spec', 'and [[ref:missing]]']);
    const spec = linked.find((r) => r.slug === 'spec');
    const missing = linked.find((r) => r.slug === 'missing');
    assert.equal(spec?.exists, true);
    assert.equal(spec?.title, 'The Spec');
    assert.equal(spec?.path, `.archon/plans/${plan.id}.refs/spec.md`);
    assert.equal(missing?.exists, false);
    assert.deepEqual(await resolveLinkedRefs(cwd, [plan.id], ['no links here']), []);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('renderLinkedRefsForReview inlines linked refs and flags missing ones', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'archon-plan-ref-ctx-'));
  try {
    const plan = await createPlan(cwd, { title: 'P', body: '### A\n- [x] x\n' });
    await writePlanRef(cwd, plan.id, 'spec', '# The Spec\n\nUNIQUE-SPEC-BODY\n');
    const out = await renderLinkedRefsForReview(cwd, plan.id, '- [x] built per [s](ref:spec), see ref:gone');
    assert.match(out, /UNIQUE-SPEC-BODY/);
    assert.match(out, /ref:gone[\s\S]*does not exist/);
    assert.equal(await renderLinkedRefsForReview(cwd, plan.id, '- [x] nothing linked'), '');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('planItemContextFor: a board task inherits refs from its plan item block and phase preamble', () => {
  const plan = parsePlan([
    '# Plan',
    '### Phase 1 - Auth',
    '> Design: ref:auth-design',
    '- [ ] Implement the token refresh flow end to end',
    '  - follow [refresh spec](ref:refresh-spec)',
    '- [ ] Write tests',
    '### Phase 2 - UI',
    '- [ ] Build the settings screen per ref:settings-ui',
  ].join('\n'));
  // Promoted title (exact item text) picks up the sub-bullet + phase refs.
  const exact = planItemContextFor(plan, 'Implement the token refresh flow end to end');
  assert.deepEqual(extractRefSlugs(exact ?? '').sort(), ['auth-design', 'refresh-spec']);
  // A member's trimmed/extended title still matches by containment.
  const contained = planItemContextFor(plan, 'Implement the token refresh flow end to end (server side)');
  assert.deepEqual(extractRefSlugs(contained ?? '').sort(), ['auth-design', 'refresh-spec']);
  // Link markup in the title doesn't defeat the match.
  assert.ok(planItemContextFor(plan, 'Build the settings screen per ref:settings-ui')?.includes('settings-ui'));
  // A short generic title doesn't latch onto an arbitrary item.
  assert.equal(planItemContextFor(plan, 'tests'), null);
  assert.equal(planItemContextFor(plan, 'Something unrelated entirely here'), null);
});

test('planItemContextFor: a nested stage checkbox inherits its parent item block', () => {
  const plan = parsePlan([
    '### Phase 2 - Scripts',
    '- [ ] P2 DELIBERATE BEHAVIOR CHANGE: every script clustered ([spec](ref:script-coverage))',
    '  - [ ] T1 Grapheme-cluster ownership for every script',
    '  - [ ] T2 Font shaping for scripts outside the tuned groups',
    '- [ ] P2.1 Wide shaped clusters borrow the next blank cell ([spec](ref:other))',
  ].join('\n'));
  const ctx = planItemContextFor(plan, 'T1 Grapheme-cluster ownership for every script');
  assert.deepEqual(extractRefSlugs(ctx ?? ''), ['script-coverage']);
});

test('planItemContextFor: reworded board titles match by leading item id or despite link labels', () => {
  const plan = parsePlan([
    '### Phase 1',
    '- [ ] P1.3 Record the conformance baseline at v0.17.0 ([spec](ref:design-and-baselines))',
    '- [ ] P1.30 Something else ([spec](ref:other))',
    '### Phase 6',
    '- [ ] P6.9 Live tab drag follow on X11, accepted on two real X11 window managers ([spec](ref:post-freeze-findings), [validation](ref:rules-validation))',
  ].join('\n'));
  // Reworded, same id.
  assert.deepEqual(extractRefSlugs(planItemContextFor(plan, 'P1.3 Conformance baseline at v0.17.0') ?? ''), ['design-and-baselines']);
  // P1.3 must not pick P1.30.
  assert.ok(!(planItemContextFor(plan, 'P1.3 Conformance baseline') ?? '').includes('ref:other'));
  // Suffixed title, no id needed: link labels no longer block containment.
  const sfx = planItemContextFor(plan, 'Live tab drag follow on X11, accepted on two real X11 window managers (open item 10)');
  assert.deepEqual(extractRefSlugs(sfx ?? '').sort(), ['post-freeze-findings', 'rules-validation']);
});
