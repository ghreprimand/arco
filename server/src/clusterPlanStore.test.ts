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
