import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
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
