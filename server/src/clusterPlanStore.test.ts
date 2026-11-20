import assert from 'node:assert/strict';
import test from 'node:test';
import { validatePlanWritePreservesCheckboxes } from './clusterPlanStore.js';

const EXISTING = [
  '# Cluster Plan',
  '',
  '- [ ] Audit account-provider truthfulness',
  '- [x] Record metadata follow-up',
  '',
  '## Later',
  '- [ ] Run public-repo safety scan',
].join('\n');

test('model plan writes may append checkbox items without changing existing tasks', () => {
  const next = [
    '# Cluster Plan',
    '',
    '## Immediate focus',
    '- [ ] Investigate local worker reporting',
    '',
    '## Original',
    '- [ ] Audit account-provider truthfulness',
    '- [x] Record metadata follow-up',
    '- [ ] Run public-repo safety scan',
  ].join('\n');

  assert.deepEqual(validatePlanWritePreservesCheckboxes(EXISTING, next), { ok: true });
});

test('model plan writes reject removed checkbox items', () => {
  const next = [
    '# Cluster Plan',
    '',
    '- [ ] Audit account-provider truthfulness',
    '- [x] Record metadata follow-up',
  ].join('\n');

  const result = validatePlanWritePreservesCheckboxes(EXISTING, next);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.deepEqual(result.violation.removed, ['Run public-repo safety scan']);
    assert.deepEqual(result.violation.statusChanged, []);
  }
});

test('model plan writes reject checkbox status changes', () => {
  const next = [
    '# Cluster Plan',
    '',
    '- [x] Audit account-provider truthfulness',
    '- [x] Record metadata follow-up',
    '- [ ] Run public-repo safety scan',
  ].join('\n');

  const result = validatePlanWritePreservesCheckboxes(EXISTING, next);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.deepEqual(result.violation.removed, []);
    assert.deepEqual(result.violation.statusChanged, [
      { text: 'Audit account-provider truthfulness', before: '[ ]', after: '[x]' },
    ]);
  }
});

test('model writes limit new or lengthened summaries while allowing safe numbered shortening', async () => {
  const { oversizedPlanItems } = await import('./clusterPlanStore.js');
  const long = 'a'.repeat(250);
  assert.deepEqual(oversizedPlanItems('', `- [ ] P1.1 ${long}`), [`P1.1 ${long}`]);
  const existing = `- [x] P1.1 ${long} [spec](ref:before)`;
  const shortened = `- [x] P1.1 ${'a'.repeat(245)} [spec](ref:after)`;
  assert.deepEqual(oversizedPlanItems(existing, shortened), []);
  assert.deepEqual(validatePlanWritePreservesCheckboxes(existing, shortened), { ok: true });
  assert.equal(validatePlanWritePreservesCheckboxes(existing, shortened.replace('[x]', '[ ]')).ok, false);
  assert.equal(validatePlanWritePreservesCheckboxes(`${existing}\n${existing}`, `${shortened}\n${shortened}`).ok, false);
  assert.deepEqual(oversizedPlanItems(existing, `${existing}\n- [ ] P2 ${'b'.repeat(241)}`).length, 1);
  assert.deepEqual(validatePlanWritePreservesCheckboxes(existing, existing.replace('ref:before', 'ref:after')), { ok: true });
});
