// Unit tests for H42 part B — the shutdown forensics line.
//
// Covers the pure formatter (the line shape the operator greps after a stop) and
// the uptime humanizer. The gather/emit side (snapshotWorkers + reap tally in
// onSignal) is exercised live; here we pin the rendered shape.
//
// Run with: node --import tsx --test src/diagnostics/shutdownForensics.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatShutdownForensics, formatUptime, type ShutdownForensics } from './shutdownForensics.js';

const MB = 1024 * 1024;

const base: ShutdownForensics = {
  signal: 'SIGTERM',
  uptimeSec: 3 * 3600 + 12 * 60,
  rssBytes: 512 * MB,
  reaped: { killed: 2, reused: 0, gone: 1 },
  inflightTurns: 2,
  busyByProvider: { 'claude-native': 1, codex: 1 },
  ptySessions: 1,
  flushBudgetMs: 100,
};

test('formatShutdownForensics: full line shape', () => {
  const line = formatShutdownForensics(base);
  assert.match(line, /^\[archon\]\[shutdown\]/);
  assert.match(line, /signal=SIGTERM/);
  assert.match(line, /uptime=3h12m/);
  assert.match(line, /rss=512\.0MB/);
  assert.match(line, /inflight-turns=2\(claude-native:1,codex:1\)/);
  assert.match(line, /reaped=3\(killed=2 reused=0 gone=1\)/);
  assert.match(line, /pty=1/);
  assert.match(line, /flush-budget=100ms/);
});

test('formatShutdownForensics: provider breakdown is sorted', () => {
  const line = formatShutdownForensics({
    ...base,
    inflightTurns: 3,
    busyByProvider: { zai: 1, codex: 1, 'claude-native': 1 },
  });
  // Alphabetical: claude-native, codex, zai — stable regardless of Map order.
  assert.match(line, /inflight-turns=3\(claude-native:1,codex:1,zai:1\)/);
});

test('formatShutdownForensics: idle shutdown omits the breakdown parens', () => {
  const line = formatShutdownForensics({
    ...base,
    inflightTurns: 0,
    busyByProvider: {},
    reaped: { killed: 0, reused: 0, gone: 0 },
  });
  assert.match(line, /inflight-turns=0 /); // no "(...)" when nothing was running
  assert.doesNotMatch(line, /inflight-turns=0\(/);
  assert.match(line, /reaped=0\(killed=0 reused=0 gone=0\)/);
});

test('formatShutdownForensics: missing busyByProvider treated as none', () => {
  const { busyByProvider, ...noProvider } = base;
  void busyByProvider;
  const line = formatShutdownForensics({ ...noProvider, inflightTurns: 0 });
  assert.match(line, /inflight-turns=0 /);
});

test('formatUptime: hours', () => {
  assert.equal(formatUptime(3 * 3600 + 12 * 60 + 30), '3h12m');
});

test('formatUptime: minutes carry seconds', () => {
  assert.equal(formatUptime(45 * 60 + 8), '45m8s');
});

test('formatUptime: sub-minute and zero/negative floor', () => {
  assert.equal(formatUptime(8), '8s');
  assert.equal(formatUptime(0), '0s');
  assert.equal(formatUptime(-5), '0s');
});
