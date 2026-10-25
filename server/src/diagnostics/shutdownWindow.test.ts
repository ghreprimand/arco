// Unit tests for H42 part A — systemd shutdown-window probe.
//
// Two pure pieces back the probe: parseSystemdDuration (handles `systemctl show`
// forms: "1min 30s", "90s", "500ms", "infinity") and classifyShutdownWindow
// (ok when the stop-timeout covers the graceful budget, warn when it's short,
// ok for infinity, skipped when unreadable).
//
// Run with: node --import tsx --test src/diagnostics/shutdownWindow.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSystemdDuration, classifyShutdownWindow, GRACEFUL_SHUTDOWN_WINDOW_SEC } from './shutdownWindow.js';

test('parseSystemdDuration: composite and single-unit forms', () => {
  assert.equal(parseSystemdDuration('1min 30s'), 90);
  assert.equal(parseSystemdDuration('90s'), 90);
  assert.equal(parseSystemdDuration('2min'), 120);
  assert.equal(parseSystemdDuration('1h 2min 3s'), 3723);
  assert.equal(parseSystemdDuration('500ms'), 0.5);
  assert.equal(parseSystemdDuration('infinity'), Infinity);
  assert.equal(parseSystemdDuration('0'), 0);
});

test('parseSystemdDuration: unparseable → null', () => {
  assert.equal(parseSystemdDuration(''), null);
  assert.equal(parseSystemdDuration('garbage'), null);
});

test('classify: default 90s stop-timeout covers the budget → ok', () => {
  const r = classifyShutdownWindow(90);
  assert.equal(r.status, 'ok');
});

test('classify: infinity → ok', () => {
  const r = classifyShutdownWindow(Infinity);
  assert.equal(r.status, 'ok');
  assert.match(r.detail, /infinity/);
});

test('classify: stop-timeout below budget → warn with raise hint', () => {
  const r = classifyShutdownWindow(2);
  assert.equal(r.status, 'warn');
  assert.match(r.detail, /SIGKILL mid-flush/);
  assert.ok(r.hint && /TimeoutStopSec/.test(r.hint));
});

test('classify: exactly at the budget → ok (>=)', () => {
  assert.equal(classifyShutdownWindow(GRACEFUL_SHUTDOWN_WINDOW_SEC).status, 'ok');
});

test('classify: unreadable timeout → skipped', () => {
  const r = classifyShutdownWindow(null);
  assert.equal(r.status, 'skipped');
});
