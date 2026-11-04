import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';
const root = await mkdtemp(path.join(tmpdir(), 'arco-tuneup-safety-'));
installIsolatedTestHome(root);
after(async () => { await rm(root, { recursive: true, force: true }); });
const { backupAndWriteInstructionFile } = await import('./runMdTuneup.js');

test('accept refuses a symlink that leaves the project', async (t) => {
  const cwd = path.join(root, 'project'), outside = path.join(root, 'outside.md');
  await mkdir(cwd); await writeFile(outside, 'outside');
  try { await symlink(outside, path.join(cwd, 'AGENTS.md')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') return t.skip('symlinks unavailable'); throw error; }
  await assert.rejects(backupAndWriteInstructionFile(cwd, 'AGENTS.md', 'replacement', Date.now()));
  assert.equal(await readFile(outside, 'utf8'), 'outside');
});

test('accept refuses invalid UTF-8 without changing the instruction file', async () => {
  const cwd = path.join(root, 'invalid-text'); await mkdir(cwd); const target = path.join(cwd, 'AGENTS.md');
  const raw = Buffer.from([0xff, 0xfe, 0x61]); await writeFile(target, raw);
  await assert.rejects(backupAndWriteInstructionFile(cwd, target, 'replacement', Date.now()), /valid UTF-8/);
  assert.deepEqual(await readFile(target), raw);
});

test('accept refuses a hard-linked instruction file', async (t) => {
  const cwd = path.join(root, 'hard-link'); await mkdir(cwd); const target = path.join(cwd, 'AGENTS.md');
  const outside = path.join(root, 'hard-link-outside.md'); await writeFile(outside, 'outside');
  try { await link(outside, target); }
  catch (error) { if (['EPERM', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) return t.skip('hard links unavailable'); throw error; }
  await assert.rejects(backupAndWriteInstructionFile(cwd, target, 'replacement', Date.now()));
  assert.equal(await readFile(outside, 'utf8'), 'outside');
});

test('accept refuses a state directory redirected outside the project', async (t) => {
  const cwd = path.join(root, 'redirected-state'), outside = path.join(root, 'state-outside');
  await mkdir(cwd); await mkdir(outside); const target = path.join(cwd, 'AGENTS.md'); await writeFile(target, 'original');
  try { await symlink(outside, path.join(cwd, '.arco'), 'dir'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') return t.skip('symlinks unavailable'); throw error; }
  await assert.rejects(backupAndWriteInstructionFile(cwd, target, 'replacement', Date.now()), /escapes/);
  assert.equal(await readFile(target, 'utf8'), 'original');
  await assert.rejects(readFile(path.join(outside, '.gitignore')));
});


test('accept skips an existing hard-linked backup', async (t) => {
  const cwd = path.join(root, 'backup-hard-link'), outside = path.join(root, 'backup-outside.md');
  await mkdir(path.join(cwd, '.arco', 'md-backups'), { recursive: true });
  await writeFile(path.join(cwd, 'AGENTS.md'), 'original'); await writeFile(outside, 'outside');
  const ts = 0, stamp = new Date(ts).toISOString().replace(/[:.]/g, '-');
  try { await link(outside, path.join(cwd, '.arco', 'md-backups', `AGENTS.md.${stamp}.bak`)); }
  catch (error) { if (['EPERM', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) return t.skip('hard links unavailable'); throw error; }
  const saved = await backupAndWriteInstructionFile(cwd, 'AGENTS.md', 'replacement', ts);
  assert.equal(await readFile(outside, 'utf8'), 'outside');
  assert.equal(await readFile(saved.backupPath, 'utf8'), 'original');
  assert.equal(await readFile(path.join(cwd, 'AGENTS.md'), 'utf8'), 'replacement');
});
