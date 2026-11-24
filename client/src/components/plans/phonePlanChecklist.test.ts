import test from 'node:test';
import assert from 'node:assert/strict';
import { phonePlanChecklist } from './phonePlanChecklist';

test('the phone checklist keeps the body line of each item, so a tick flips the right line', () => {
  const body = ['# Plan', 'Intro text.', '', '### Phase 1', '- [x] First', '- [ ] Second', '  - a sub-point', '### Phase 2', 'Phase note.', '  - [ ] Nested', '## Later', 'Closing text.'].join('\n');
  const plan = phonePlanChecklist(body);
  assert.deepEqual(plan.intro, ['# Plan', 'Intro text.', '## Later', 'Closing text.']);
  assert.deepEqual(plan.phases.map((p) => [p.heading, p.items.map((i) => [i.lineIndex, i.checked, i.text, i.depth])]), [
    ['Phase 1', [[4, true, 'First', 0], [5, false, 'Second', 0]]],
    ['Phase 2', [[9, false, 'Nested', 1]]],
  ]);
  assert.deepEqual(plan.phases[0]!.items[1]!.notes, ['a sub-point']);
  assert.deepEqual(plan.phases[1]!.notes, ['Phase note.']);
  assert.equal(plan.done, 1);
  assert.equal(plan.total, 3);
});
