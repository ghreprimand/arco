import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { promises as fs, mkdtempSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { installIsolatedTestHome } from './testSupport/isolatedHome.js';
const root = realpathSync(mkdtempSync(join(tmpdir(), 'arco-directory-modes-')));
installIsolatedTestHome(root);
const { restoreLegacyTar } = await import('./legacyTarRestore.js');
after(() => fs.rm(root, { recursive: true, force: true }));
let serial = 0;
function entry(name: string, mode: number, body = '', directory = false) {
  const bytes = Buffer.from(body), header = Buffer.alloc(512);
  header.write(name, 0, 100);
  const oct = (n: number, start: number, width: number) => header.write(n.toString(8).padStart(width - 1, '0') + '\0', start, width);
  oct(mode, 100, 8); oct(bytes.length, 124, 12); header.fill(32, 148, 156);
  header.write(directory ? '5' : '0', 156, 1); header.write('ustar\0', 257, 6);
  header.write(header.reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return Buffer.concat([header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)]);
}
async function fixture(entries: Buffer[]) {
  const cwd = join(root, `project-${++serial}`); await fs.mkdir(cwd);
  const archive = join(root, `archive-${serial}.tar`);
  await fs.writeFile(archive, Buffer.concat([...entries, Buffer.alloc(1024)]));
  return { cwd, archive };
}
test('LA08: legacy restore keeps nested archived directory and file modes', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture([entry('private', 0o700, '', true), entry('private/shared', 0o750, '', true), entry('private/shared/note.txt', 0o600, 'fixture')]);
  const mask = process.umask(0);
  try {
    assert.equal(await restoreLegacyTar(f.archive, f.cwd), 1);
    assert.equal((await fs.stat(join(f.cwd, 'private'))).mode & 0o777, 0o700);
    assert.equal((await fs.stat(join(f.cwd, 'private/shared'))).mode & 0o777, 0o750);
    assert.equal((await fs.stat(join(f.cwd, 'private/shared/note.txt'))).mode & 0o777, 0o600);
    assert.equal(await fs.readFile(join(f.cwd, 'private/shared/note.txt'), 'utf8'), 'fixture');
  } finally { process.umask(mask); }
});
test('LA08: destination directories stay private while files are extracted', async t => {
  const f = await fixture([entry('nested', 0o755, '', true), entry('nested/note.txt', 0o644, 'fixture')]);
  const mkdir = fs.mkdir.bind(fs); const modes: unknown[] = [];
  t.mock.method(fs, 'mkdir', async (...args: Parameters<typeof fs.mkdir>) => {
    if (String(args[0]).startsWith(f.cwd + sep)) modes.push((args[1] as { mode?: number })?.mode);
    return mkdir(...args);
  }); syncBuiltinESMExports();
  try { await restoreLegacyTar(f.archive, f.cwd); assert.ok(modes.length); assert.ok(modes.every(mode => mode === 0o700)); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});
test('LA08: restrictive modes are applied only after descendants are populated', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture([entry('private', 0o500, '', true), entry('private/closed', 0, '', true), entry('private/closed/note.txt', 0o600, 'fixture')]);
  try {
    assert.equal(await restoreLegacyTar(f.archive, f.cwd), 1);
    assert.equal((await fs.stat(join(f.cwd, 'private'))).mode & 0o777, 0o500);
    assert.equal((await fs.stat(join(f.cwd, 'private/closed'))).mode & 0o777, 0);
  } finally { await fs.chmod(join(f.cwd, 'private'), 0o700); await fs.chmod(join(f.cwd, 'private/closed'), 0o700); }
  assert.equal(await fs.readFile(join(f.cwd, 'private/closed/note.txt'), 'utf8'), 'fixture');
});
test('LA08: a directory redirected before mode application is never chmodded through its link', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture([entry('private', 0o700, '', true), entry('private/note.txt', 0o600, 'fixture')]);
  const outside = join(root, `outside-${serial}`); await fs.mkdir(outside, { mode: 0o755 });
  const before = (await fs.stat(outside)).mode, open = fs.open.bind(fs); let swapped = false;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]) === join(f.cwd, 'private') && !swapped) {
      swapped = true; await fs.rename(join(f.cwd, 'private'), join(f.cwd, 'saved')); await fs.symlink(outside, join(f.cwd, 'private'));
    }
    return open(...args);
  }); syncBuiltinESMExports();
  try { await assert.rejects(restoreLegacyTar(f.archive, f.cwd)); assert.ok(swapped); assert.equal((await fs.stat(outside)).mode, before); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});
