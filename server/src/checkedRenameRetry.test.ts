import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { promises as fs, mkdtempSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { installIsolatedTestHome } from './testSupport/isolatedHome.js';
const root = realpathSync(mkdtempSync(join(tmpdir(), 'arco-checked-retry-')));
installIsolatedTestHome(root);
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
try { await import('./atomicFile.js'); } finally { Object.defineProperty(process, 'platform', platform); }
const { atomicCheckedWriteFile, replaceCheckedFile } = await import('./checkedFile.js');
after(() => fs.rm(root, { recursive: true, force: true }));
let serial = 0;
for (const writer of [atomicCheckedWriteFile, replaceCheckedFile]) {
  for (const code of ['EACCES', 'EPERM', 'EBUSY']) test(`LA09: ${writer.name} retries transient ${code}`, async t => {
    const folder = join(root, `case-${++serial}`); await fs.mkdir(folder); const file = join(folder, 'note.txt'); await fs.writeFile(file, 'before');
    const rename = fs.rename.bind(fs); let attempts = 0;
    t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => { if (++attempts === 1) throw Object.assign(new Error('fixture lock'), { code }); return rename(...args); });
    syncBuiltinESMExports();
    try { await writer(file, 'after'); assert.equal(attempts, 2); assert.equal(await fs.readFile(file, 'utf8'), 'after'); assert.deepEqual(await fs.readdir(folder), ['note.txt']); }
    finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  });
  test(`LA09: ${writer.name} revalidates a replaced destination after refusal`, async t => {
    const folder = join(root, `case-${++serial}`); await fs.mkdir(folder); const file = join(folder, 'note.txt'); await fs.writeFile(file, 'before');
    const rename = fs.rename.bind(fs); let attempts = 0;
    t.mock.method(fs, 'rename', async () => {
      attempts++; await rename(file, join(folder, 'original.txt')); await fs.writeFile(file, 'other writer');
      throw Object.assign(new Error('fixture lock'), { code: 'EACCES' });
    }); syncBuiltinESMExports();
    try { await assert.rejects(writer(file, 'after')); assert.equal(attempts, 1); assert.equal(await fs.readFile(file, 'utf8'), 'other writer'); assert.deepEqual((await fs.readdir(folder)).sort(), ['note.txt', 'original.txt']); }
    finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  });
}
for (const writer of [atomicCheckedWriteFile, replaceCheckedFile]) {
  test(`LA09: ${writer.name} refuses a parent identity change during backoff`, async t => {
    const folder = join(root, `case-${++serial}`); await fs.mkdir(folder); const file = join(folder, 'note.txt'); await fs.writeFile(file, 'before');
    const lstat = fs.lstat.bind(fs); let refused = false, attempts = 0;
    t.mock.method(fs, 'rename', async () => { attempts++; refused = true; throw Object.assign(new Error('fixture lock'), { code: 'EACCES' }); });
    t.mock.method(fs, 'lstat', async (...args: Parameters<typeof fs.lstat>) => {
      const result = await lstat(...args);
      return refused && String(args[0]) === folder ? Object.assign(Object.create(Object.getPrototypeOf(result)), result, { ino: Number(result.ino) + 1 }) : result;
    }); syncBuiltinESMExports();
    try { await assert.rejects(writer(file, 'after')); assert.equal(attempts, 1); assert.equal(await fs.readFile(file, 'utf8'), 'before'); assert.deepEqual(await fs.readdir(folder), ['note.txt']); }
    finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  });
  for (const code of ['EINVAL', 'EACCES']) test(`LA09: ${writer.name} cleans temporary files after ${code === 'EINVAL' ? 'permanent failure' : 'retry deadline'}`, async t => {
    const folder = join(root, `case-${++serial}`); await fs.mkdir(folder); const file = join(folder, 'note.txt'); await fs.writeFile(file, 'before'); let attempts = 0, calls = 0;
    t.mock.method(fs, 'rename', async () => { attempts++; throw Object.assign(new Error('fixture refusal'), { code }); });
    if (code === 'EACCES') t.mock.method(Date, 'now', () => calls++ ? 10000 : 0);
    syncBuiltinESMExports();
    try { await assert.rejects(writer(file, 'after')); assert.equal(attempts, 1); assert.equal(await fs.readFile(file, 'utf8'), 'before'); assert.deepEqual(await fs.readdir(folder), ['note.txt']); }
    finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  });
}
test('LA09: atomic create retries only while the destination remains absent', async t => {
  const folder = join(root, `case-${++serial}`); await fs.mkdir(folder); const file = join(folder, 'note.txt'); let attempts = 0;
  t.mock.method(fs, 'rename', async () => { attempts++; await fs.writeFile(file, 'other writer'); throw Object.assign(new Error('fixture lock'), { code: 'EACCES' }); }); syncBuiltinESMExports();
  try { await assert.rejects(atomicCheckedWriteFile(file, 'after')); assert.equal(attempts, 1); assert.equal(await fs.readFile(file, 'utf8'), 'other writer'); assert.deepEqual(await fs.readdir(folder), ['note.txt']); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});
test('LA09: atomic create succeeds after a transient refusal when no other destination appears', async t => {
  const folder = join(root, `case-${++serial}`); await fs.mkdir(folder); const file = join(folder, 'note.txt'); const rename = fs.rename.bind(fs); let attempts = 0;
  t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => { if (++attempts === 1) throw Object.assign(new Error('fixture lock'), { code: 'EACCES' }); return rename(...args); }); syncBuiltinESMExports();
  try { await atomicCheckedWriteFile(file, 'after'); assert.equal(attempts, 2); assert.equal(await fs.readFile(file, 'utf8'), 'after'); assert.deepEqual(await fs.readdir(folder), ['note.txt']); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});
