import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';

test('scratch uploads refuse a linked configured root', async (t) => {
  const fixture = mkdtempSync(path.join(realpathSync(os.tmpdir()), 'arco-scratch-root-'));
  const home = path.join(fixture, 'home');
  const outside = path.join(fixture, 'outside');
  mkdirSync(home); mkdirSync(outside);
  const previousHome = process.env.ARCO_HOME;
  try {
    try { symlinkSync(outside, path.join(home, 'media-scratch'), 'dir'); }
    catch (error) { if (['EPERM', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) return t.skip('symlinks unavailable'); throw error; }
    process.env.ARCO_HOME = home;
    const { reapScratch, saveScratchUpload } = await import('./scratch.js');
    await assert.rejects(saveScratchUpload(Readable.from(['fixture']), 'sample.txt'), /link|folder/i);
    assert.deepEqual(readdirSync(outside), []);
    const oldEntry = path.join(outside, 'old-entry');
    mkdirSync(oldEntry);
    writeFileSync(path.join(oldEntry, 'fixture.txt'), 'fixture');
    utimesSync(oldEntry, new Date(0), new Date(0));
    await reapScratch();
    assert.deepEqual(readdirSync(outside), ['old-entry']);
  } finally {
    if (previousHome === undefined) delete process.env.ARCO_HOME; else process.env.ARCO_HOME = previousHome;
    rmSync(fixture, { recursive: true, force: true });
  }
});
