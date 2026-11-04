import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { nativeSqliteOptions, nativeSqliteRemediation } from './nativeSqlite.js';

test('source checkouts retain the normal sqlite binding resolver', () => {
  assert.deepEqual(nativeSqliteOptions({}, 'win32', 'x64', '137'), {});
});

test('native SQLite recovery points to the correct install path', () => {
  assert.match(nativeSqliteRemediation({}), /npm ci --include=dev/);
  assert.match(nativeSqliteRemediation({ ARCO_PACKAGED: '1' }), /arco setup --repair-native/);
});

test('packaged sqlite selects one Node-API binding across Node ABIs', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'arco-native-test-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { ARCO_PACKAGED: '1', ARCO_HOME: home };
  const binding = nativeSqliteOptions(env, 'win32', 'arm64', '137').nativeBinding;
  const other = nativeSqliteOptions(env, 'win32', 'arm64', '150').nativeBinding;
  assert.ok(binding?.endsWith(join('native', 'win32-arm64', 'better_sqlite3.node')));
  assert.equal(binding, other);
});
