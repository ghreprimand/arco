// leanPlanWarnings — soft lean-plan check on plan_create (warns, never refuses).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leanPlanWarnings, lintPlanBody } from './planMcpTools.js';

test('a lean plan has no warnings', () => {
  const body = '### Phase 1\n- [ ] Add the route — see [spec](ref:route-spec)\n- [ ] Wire the UI\n';
  assert.deepEqual(leanPlanWarnings(body), []);
  assert.equal(lintPlanBody(body).ok, true);
});

test('long task prose warns', () => {
  const body = `### Phase 1\n- [ ] Task\n${'  detail '.repeat(80)}\n- [ ] Short\n`;
  const w = leanPlanWarnings(body);
  assert.equal(w.length, 1);
  assert.match(w[0], /1 task/);
});

test('oversized body warns', () => {
  const body = `### Phase\n${Array.from({ length: 400 }, (_, i) => `- [ ] task number ${i} with a bit of text`).join('\n')}\n`;
  assert.ok(leanPlanWarnings(body).some((w) => /KB/.test(w)));
});
