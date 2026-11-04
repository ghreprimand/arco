import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./collect-native.mjs', import.meta.url));
test('native collection verifies bindings and refuses to overwrite an artifact', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'arco-native-test-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const first = spawnSync(process.execPath, [script, base], { encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  const name = `${process.platform}-${process.arch}`;
  const directory = join(base, name);
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.binding, 'napi');
  assert.ok(existsSync(join(directory, 'pty', 'pty.node')));
  assert.ok(existsSync(join(directory, 'better_sqlite3.node')));
  const second = spawnSync(process.execPath, [script, base], { encoding: 'utf8' });
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /already exists/);
});
