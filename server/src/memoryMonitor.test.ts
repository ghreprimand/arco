// Unit tests for H46 — server RSS/heap trend logging.
//
// Covers the pure formatter (the line shape the operator greps) and the gate:
// startMemoryMonitor must be inert when disabled (no timer, no output) and must
// emit a baseline sample when enabled. We assert no real interval lingers by
// always stopping it.
//
// Run with: node --import tsx --test src/memoryMonitor.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMemorySample, startMemoryMonitor, stopMemoryMonitor, logMemorySample } from './memoryMonitor.js';

const MB = 1024 * 1024;
const sample: NodeJS.MemoryUsage = {
  rss: 512 * MB,
  heapTotal: 260 * MB,
  heapUsed: 210 * MB,
  external: 15 * MB,
  arrayBuffers: 3 * MB,
};

test('formatMemorySample: core fields present', () => {
  const line = formatMemorySample(sample);
  assert.match(line, /\[arco\]\[mem\]/);
  assert.match(line, /rss=512\.0MB/);
  assert.match(line, /heapUsed=210\.0MB/);
  assert.match(line, /heapTotal=260\.0MB/);
  assert.match(line, /external=15\.0MB/);
});

test('formatMemorySample: delta + peak when provided', () => {
  const line = formatMemorySample(sample, { prevRss: 500 * MB, peakRss: 480 * MB, label: 'tick' });
  assert.match(line, /\[arco\]\[mem:tick\]/);
  assert.match(line, /rssΔ=\+12\.0MB/);   // 512 - 500
  assert.match(line, /rssPeak=512\.0MB/); // peak max(480, 512)
});

test('formatMemorySample: negative delta is signed', () => {
  const line = formatMemorySample(sample, { prevRss: 520 * MB });
  assert.match(line, /rssΔ=-8\.0MB/);
});

test('startMemoryMonitor: disabled → inert, no output', () => {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };
  try {
    const stop = startMemoryMonitor({ enabled: false });
    stop();
  } finally {
    console.log = orig;
  }
  assert.equal(logs.filter((l) => l.includes('[arco][mem')).length, 0, 'no memory lines when disabled');
});

test('startMemoryMonitor: enabled → emits a boot baseline', () => {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };
  try {
    startMemoryMonitor({ enabled: true, intervalMs: 60_000 });
  } finally {
    console.log = orig;
    stopMemoryMonitor(); // tear down the (unref'd) interval immediately
  }
  assert.ok(logs.some((l) => l.includes('[arco][mem:boot]')), 'boot baseline emitted');
});

test('logMemorySample: emits a single labelled line', () => {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };
  try {
    logMemorySample('shutdown');
  } finally {
    console.log = orig;
  }
  assert.equal(logs.filter((l) => l.includes('[arco][mem:shutdown]')).length, 1);
});
