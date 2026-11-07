import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeVersion } from './capabilities.js';

test('version probes terminate a stalled CLI and report it as broken', async () => {
  const result = await probeVersion(process.execPath, ['-e', 'setTimeout(() => console.log("1.2.3"), 250)'], 40);
  assert.equal(result, 'broken');
});

test('version probes bound stdout from a noisy CLI', async () => {
  const result = await probeVersion(process.execPath, ['-e', 'process.stdout.write("1.2.3" + "x".repeat(3 * 1024 * 1024))']);
  assert.equal(result, 'broken');
});

test('version probes keep successful and missing CLI results distinct', async () => {
  assert.equal(await probeVersion(process.execPath, ['-e', 'console.log("tool 1.2.3")']), '1.2.3');
  assert.equal(await probeVersion('arco-missing-probe-test-binary'), 'unknown');
});
