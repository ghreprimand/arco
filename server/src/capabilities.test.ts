import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeLatestVersions, probeVersion } from './capabilities.js';

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

test('llama.cpp update metadata selects the newest published numeric build and stays unknown on failure', async (t) => {
  const releases = [
    { tag_name: 'v1.0.0' }, { tag_name: 'b10549' }, { tag_name: 'b9037' },
    { tag_name: 'b12110' }, { tag_name: 'b99999', draft: true },
    { tag_name: 'b12111', prerelease: true }, { tag_name: 'b123not-a-build' },
  ];
  let response: unknown = releases;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    return new Response(JSON.stringify(url.includes('/ggml-org/llama.cpp/') ? response : {}));
  });
  const codex = Promise.resolve({ kind: 'unknown' as const });
  assert.equal((await probeLatestVersions(codex))?.llamacpp, 'b12111');
  response = [{ tag_name: 'v1.0.0' }];
  assert.equal((await probeLatestVersions(codex))?.llamacpp, undefined);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
  assert.equal((await probeLatestVersions(codex))?.llamacpp, undefined);
});
