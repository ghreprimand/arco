import assert from 'node:assert/strict';
import { syncBuiltinESMExports } from 'node:module';
import { promises as fs, mkdtempSync, mkdirSync, readdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ensureStorageRoot } from './storageRoot.js';

test('managed roots allow linked parents but reject linked storage folders', async (t) => {
  const fixture = mkdtempSync(path.join(realpathSync(os.tmpdir()), 'arco-root-check-'));
  const outside = path.join(fixture, 'outside');
  mkdirSync(outside);
  try {
    await ensureStorageRoot(path.join(fixture, 'safe', 'uploads'));
    assert.deepEqual(readdirSync(path.join(fixture, 'safe')), ['uploads']);
    try { symlinkSync(outside, path.join(fixture, 'linked'), 'dir'); }
    catch (error) { if (['EPERM', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) return t.skip('symlinks unavailable'); throw error; }
    await assert.rejects(ensureStorageRoot(path.join(fixture, 'linked')), /not a link/i);
    await ensureStorageRoot(path.join(fixture, 'linked', 'uploads'));
    assert.deepEqual(readdirSync(outside), ['uploads']);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('managed roots use the same canonical spelling as synchronous path checks', async t => {
  const fixture = mkdtempSync(path.join(realpathSync(os.tmpdir()), 'arco-root-spelling-'));
  const alias = `${fixture}-alias`;
  try {
    try { symlinkSync(fixture, alias, 'junction'); }
    catch (error) { if (['EPERM', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) return t.skip('symlinks unavailable'); throw error; }
    const actual = fs.realpath.bind(fs);
    t.mock.method(fs, 'realpath', async (...args: Parameters<typeof fs.realpath>) => {
      const result = await actual(...args);
      return (String(args[0]) === fixture ? alias : result) as typeof result;
    });
    syncBuiltinESMExports();
    const root = await ensureStorageRoot(path.join(fixture, 'uploads'));
    assert.equal(root, path.join(realpathSync(fixture), 'uploads'));
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(alias, { force: true }); rmSync(fixture, { recursive: true, force: true }); }
});
