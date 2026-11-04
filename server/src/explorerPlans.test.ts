import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countPlanCheckboxes } from './explorerPlans.js';

test('counts checked and unchecked plan items', () => {
  assert.deepEqual(countPlanCheckboxes('- [x] done\n  - [ ] open\n* [X] done\n- ordinary'), { checkboxTotal: 3, checkboxDone: 2 });
  assert.deepEqual(countPlanCheckboxes('No checklist'), { checkboxTotal: 0, checkboxDone: 0 });
});
