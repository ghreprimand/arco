import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshotTempFolders, remainingTempFolders } from '../temp-folder-gate.mjs';

test('reports new Arco temporary directories, including when counts are unchanged', t => {
  const root = mkdtempSync(join(tmpdir(), 'arco-gate-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'arco-existing'));
  const before = snapshotTempFolders(root);
  rmSync(join(root, 'arco-existing'), { recursive: true });
  mkdirSync(join(root, 'arco-leftover'));
  mkdirSync(join(root, 'unrelated'));
  writeFileSync(join(root, 'arco-file'), 'fixture');
  assert.deepEqual(remainingTempFolders(root, before), ['arco-leftover']);
  rmSync(join(root, 'arco-leftover'), { recursive: true });
  assert.deepEqual(remainingTempFolders(root, before), []);
});

test('isolated browser runner warns and removes leaked folders without changing the suite result', async t => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const parent = mkdtempSync(join(tmpdir(), 'arco-gate-parent-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const wrapper = fileURLToPath(new URL('../temp-folder-runner.mjs', import.meta.url));
  const child = 'require("fs").mkdirSync(require("path").join(require("os").tmpdir(), "arco-leaked"))';
  const result = spawnSync(process.execPath, [wrapper, process.execPath, '-e', child], { env: { ...process.env, TMPDIR: parent, TMP: parent, TEMP: parent }, encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stderr, /WARNING: Temporary folders left by browser tests \(1\): arco-leaked/);
  assert.equal(readdirSync(parent).length, 0);

  const failed = spawnSync(process.execPath, [wrapper, process.execPath, '-e', `${child}; process.exit(7)`], { env: { ...process.env, TMPDIR: parent, TMP: parent, TEMP: parent }, encoding: 'utf8' });
  assert.equal(failed.status, 7);
  assert.match(failed.stderr, /WARNING: Temporary folders left by browser tests \(1\): arco-leaked/);
  assert.equal(readdirSync(parent).length, 0);
});
