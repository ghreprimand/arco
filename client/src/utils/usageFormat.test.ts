import test from 'node:test';
import assert from 'node:assert/strict';
import { formatResetLabel, formatResetText } from './usageFormat';

test('ISO reset timestamps become local labels and other text is kept', () => {
  const now = new Date(2026, 10, 3, 9, 0);
  const sameDay = new Date(2026, 10, 3, 15, 5).toISOString();
  assert.equal(formatResetLabel(sameDay, now), '3:05 p.m.');
  assert.equal(formatResetText(sameDay, now), '3:05 p.m.');
  const later = new Date(2026, 10, 7, 10, 5).toISOString();
  assert.match(formatResetText(later, now), /10:05 a\.m\.$/);
  assert.doesNotMatch(formatResetText(later, now), /T|Z|2026/);
  assert.equal(formatResetText('Nov 7, 2026 at 9:00 AM', now), 'Nov 7, 2026 at 9:00 AM');
});
