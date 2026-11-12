import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { installIsolatedTestHome } from './testSupport/isolatedHome.js';
const root = realpathSync(mkdtempSync(join(tmpdir(), 'arco-tar-review-')));
installIsolatedTestHome(root);
after(() => rmSync(root, { recursive: true, force: true }));
const { revertToCheckpoint } = await import('./gitSnapshots.js');
function entry(name: string, body: string, type = '0', link = '') {
  const data = Buffer.from(body), header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  const octal = (value: number, at: number, len: number) => header.write(value.toString(8).padStart(len - 1, '0') + '\0', at, len, 'ascii');
  octal(0o644, 100, 8); octal(0, 108, 8); octal(0, 116, 8); octal(data.length, 124, 12); octal(0, 136, 12);
  header.fill(32, 148, 156); header.write(type, 156, 1); header.write(link, 157, 100); header.write('ustar\0', 257, 6); header.write('00', 263, 2);
  const sum = header.reduce((a, b) => a + b, 0); header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return Buffer.concat([header, data, Buffer.alloc((512 - data.length % 512) % 512)]);
}
let serial = 0;
function archive(parts: Buffer[]) {
  const cwd = join(root, `project-${++serial}`); mkdirSync(cwd); writeFileSync(join(cwd, 'note.txt'), 'original');
  const hash = createHash('sha256').update(resolve(cwd)).digest('hex').slice(0, 16);
  const dir = join(process.env.ARCO_HOME!, 'checkpoints', hash); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'fixture.1.tar'), Buffer.concat([...parts, Buffer.alloc(1024)]));
  return cwd;
}
for (const kind of ['link', 'traversal'] as const) test(`FA8 legacy tar ${kind} is refused before any project file changes`, async () => {
  const bad = kind === 'link' ? entry('linked', '', '2', '../outside') : entry('../outside.txt', 'bad');
  const cwd = archive([entry('note.txt', 'replacement'), bad]);
  assert.equal(await revertToCheckpoint({ cwd, workflowId: 'fixture', seq: 1 }), null);
  assert.equal(readFileSync(join(cwd, 'note.txt'), 'utf8'), 'original');
  assert.equal(existsSync(join(cwd, 'linked')), false);
});
test('FA8 ordinary legacy tar still restores files without deleting newer files', async () => {
  const cwd = archive([entry('note.txt', 'replacement'), entry('nested/new.txt', 'restored')]);
  writeFileSync(join(cwd, 'newer.txt'), 'keep');
  const result = await revertToCheckpoint({ cwd, workflowId: 'fixture', seq: 1 });
  assert.equal(result?.backend, 'tar'); assert.equal(result?.fileCount, 2);
  assert.equal(readFileSync(join(cwd, 'note.txt'), 'utf8'), 'replacement');
  assert.equal(readFileSync(join(cwd, 'nested/new.txt'), 'utf8'), 'restored');
  assert.equal(readFileSync(join(cwd, 'newer.txt'), 'utf8'), 'keep');
});
test('FA8 a linked existing destination refuses the whole restore', async () => {
  const { symlinkSync } = await import('node:fs');
  const cwd = archive([entry('note.txt', 'replacement'), entry('nested/new.txt', 'restored')]);
  const outside = join(root, 'outside-destination'); mkdirSync(outside);
  symlinkSync(outside, join(cwd, 'nested'), 'junction');
  assert.equal(await revertToCheckpoint({ cwd, workflowId: 'fixture', seq: 1 }), null);
  assert.equal(readFileSync(join(cwd, 'note.txt'), 'utf8'), 'original');
  assert.equal(existsSync(join(outside, 'new.txt')), false);
});
test('FA8 GNU long names and POSIX path metadata remain readable', async () => {
  const long = 'folder/' + 'a'.repeat(110) + '.txt';
  const payload = `path=${long}\n`;
  let length = Buffer.byteLength(payload) + 2;
  while (Buffer.byteLength(`${length} ${payload}`) !== length) length = Buffer.byteLength(`${length} ${payload}`);
  for (const metadata of [entry('././@LongLink', long + '\0', 'L'), entry('PaxHeader', `${length} ${payload}`, 'x')]) {
    const cwd = archive([metadata, entry('short.txt', 'restored')]);
    assert.equal((await revertToCheckpoint({ cwd, workflowId: 'fixture', seq: 1 }))?.fileCount, 1);
    assert.equal(readFileSync(join(cwd, long), 'utf8'), 'restored');
  }
});
test('FA8 system tar regular archives restore through staging', async t => {
  const { execFileSync } = await import('node:child_process');
  const cwd = archive([]), source = join(root, `source-${++serial}`);
  const long = 'nested/' + 'b'.repeat(110) + '.txt';
  mkdirSync(join(source, 'nested'), { recursive: true }); writeFileSync(join(source, long), 'system tar fixture');
  const hash = createHash('sha256').update(resolve(cwd)).digest('hex').slice(0, 16);
  const tar = join(process.env.ARCO_HOME!, 'checkpoints', hash, 'fixture.1.tar');
  try { execFileSync('tar', ['-cf', basename(tar), '-C', source, '.'], { cwd: dirname(tar), stdio: 'pipe' }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { t.skip('system tar unavailable'); return; } throw error; }
  assert.equal((await revertToCheckpoint({ cwd, workflowId: 'fixture', seq: 1 }))?.fileCount, 1);
  assert.equal(readFileSync(join(cwd, long), 'utf8'), 'system tar fixture');
});
