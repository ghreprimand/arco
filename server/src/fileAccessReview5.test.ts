import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { promises as fs, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installIsolatedTestHome } from './testSupport/isolatedHome.js';
const root = realpathSync(mkdtempSync(join(tmpdir(), 'arco-open-review-')));
installIsolatedTestHome(root);
after(() => rmSync(root, { recursive: true, force: true }));
const { readFileForExplorer } = await import('./http/fileRead.js');
const { writeFileWithinCwd } = await import('./http/fileWriteRoutes.js');
for (const action of ['read', 'write'] as const) test(`FA5 ${action} refuses a parent replaced between validation and access`, async t => {
  const cwd = join(root, action), parent = join(cwd, 'folder'), outside = join(root, `${action}-outside`);
  mkdirSync(parent, { recursive: true }); mkdirSync(outside);
  const target = join(parent, 'note.txt');
  writeFileSync(target, 'inside'); writeFileSync(join(outside, 'note.txt'), 'outside');
  let swapped = false;
  async function swap() { if (swapped) return; swapped = true; await fs.rename(parent, `${parent}-old`); await fs.symlink(outside, parent, 'junction'); }
  const originalOpen = fs.open.bind(fs), originalMkdir = fs.mkdir.bind(fs);
  if (action === 'read') t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => { if (args[0] === target) await swap(); return originalOpen(...args); });
  else t.mock.method(fs, 'mkdir', async (...args: Parameters<typeof fs.mkdir>) => { const result = await originalMkdir(...args); if (args[0] === parent) await swap(); return result; });
  syncBuiltinESMExports();
  try {
    if (action === 'read') await assert.rejects(readFileForExplorer(target));
    else { await assert.rejects(writeFileWithinCwd(cwd, 'folder/note.txt', 'changed')); assert.equal(readFileSync(join(outside, 'note.txt'), 'utf8'), 'outside'); }
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});
test('FA5 reads and writes still work for unchanged ordinary files', async () => {
  const cwd = join(root, 'ordinary'); mkdirSync(cwd);
  const target = join(cwd, 'note.txt'); writeFileSync(target, 'original');
  assert.equal((await writeFileWithinCwd(cwd, 'note.txt', 'replacement')).ok, true);
  assert.equal((await readFileForExplorer(target) as { content: string }).content, 'replacement');
});
