import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { dirname, join, resolve, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

test('B199: every per-file test process uses the selected namespace wrapper', () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const source = readFileSync(new URL('../test-unit.mjs', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replaceAll('import.meta.url', JSON.stringify(new URL('../test-unit.mjs', import.meta.url).href));
  runInNewContext(source, {
    dirname, join, resolve, delimiter, fileURLToPath, tmpdir: () => '/fixture',
    mkdirSync() {}, mkdtempSync: () => '/fixture/temp', rmSync() {}, writeFileSync() {},
    readdirSync: () => [{ name: 'fixture.test.ts', isDirectory: () => false, isFile: () => true }],
    process: { platform: 'linux', execPath: '/runtime/node', env: { PATH: '/runtime', ARCO_TEST_PER_FILE: '1', ARCO_TEST_REQUIRE_NETNS: '1' }, getuid: () => 1000, getgid: () => 1000 },
    console: { log() {}, error() {} },
    spawnSync(command: string, args: string[]) { if (args.at(-1) !== 'true') calls.push({ command, args }); return { status: 0 }; },
  });
  assert.ok(calls.length > 1);
  for (const call of calls) {
    assert.equal(call.command, 'unshare');
    assert.ok(call.args.includes('/runtime/node'));
    assert.ok(call.args.includes('--test'));
  }
});
