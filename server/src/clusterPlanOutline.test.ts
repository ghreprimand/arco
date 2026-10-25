import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planOutline } from './clusterPlanOutline.js';

const PLAN = [
  '# OdyTTY — Release Closeout',
  '',
  'Long prose paragraph explaining context that should be dropped.',
  '',
  '## Phase 1 — Themes',
  'More prose.',
  '- [ ] add six palettes',
  '  - [x] indented sub-item done',
  '* [X] star-bullet uppercase-x item',
  '- plain bullet without checkbox (dropped)',
  '### Notes',
  'trailing prose',
].join('\n');

test('outline keeps headings + checkbox lines verbatim, drops prose', () => {
  const out = planOutline(PLAN);
  assert.equal(out, [
    '# OdyTTY — Release Closeout',
    '## Phase 1 — Themes',
    '- [ ] add six palettes',
    '  - [x] indented sub-item done',
    '* [X] star-bullet uppercase-x item',
    '### Notes',
  ].join('\n'));
});

test('outline of prose-only body is empty', () => {
  assert.equal(planOutline('just words\nand more words'), '');
});

test('outline is dramatically smaller than a checkbox-sparse plan', () => {
  const big = '# Title\n' + ('prose line that pads the plan out considerably\n'.repeat(400)) + '- [ ] the one task';
  const out = planOutline(big);
  assert.ok(out.length < big.length / 10);
  assert.ok(out.includes('- [ ] the one task'));
});

test('outline preserves standing directive sections including ordinary bullets', () => {
  const plan = [
    '# Release',
    '**Standing gates (apply every turn)**',
    '- Commit and push each accepted packet.',
    '- Keep the plan and board current.',
    '',
    '### Phase 1',
    'phase prose is omitted',
    '- [ ] ship it',
  ].join('\n');
  const out = planOutline(plan);
  assert.ok(out.includes('**Standing gates (apply every turn)**'));
  assert.ok(out.includes('- Commit and push each accepted packet.'));
  assert.ok(out.includes('- Keep the plan and board current.'));
  assert.ok(!out.includes('phase prose is omitted'));
});
