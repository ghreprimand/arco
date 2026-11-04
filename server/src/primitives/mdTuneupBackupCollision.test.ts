import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';
const root = await mkdtemp(path.join(tmpdir(), 'arco-tuneup-collision-'));
installIsolatedTestHome(root);
after(async () => { await rm(root, { recursive: true, force: true }); });
const { backupAndWriteInstructionFile } = await import('./runMdTuneup.js');

test('same-name backups created in the same millisecond do not overwrite one another', async () => {
  const cwd = path.join(root, 'two-files'); await mkdir(path.join(cwd, 'one'), { recursive: true }); await mkdir(path.join(cwd, 'two'));
  await writeFile(path.join(cwd, 'one', 'AGENTS.md'), 'first original');
  await writeFile(path.join(cwd, 'two', 'AGENTS.md'), 'second original');
  const ts = Date.now();
  const a = await backupAndWriteInstructionFile(cwd, 'one/AGENTS.md', 'first tuned', ts);
  const b = await backupAndWriteInstructionFile(cwd, 'two/AGENTS.md', 'second tuned', ts);
  assert.notEqual(a.backupPath, b.backupPath);
  assert.equal(await readFile(a.backupPath, 'utf8'), 'first original');
  assert.equal(await readFile(b.backupPath, 'utf8'), 'second original');
});

