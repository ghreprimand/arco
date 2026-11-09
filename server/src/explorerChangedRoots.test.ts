import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installIsolatedTestHome } from './testSupport/isolatedHome.js';
const root = realpathSync(mkdtempSync(join(tmpdir(), 'arco-changed-roots-')));
installIsolatedTestHome(root);
after(() => rmSync(root, { recursive: true, force: true }));
const alpha = join(process.env.HOME!, 'alpha'), beta = join(process.env.HOME!, 'beta');
const external = join(root, 'external'), unknown = join(root, 'unknown');
for (const dir of [alpha, beta, external, unknown]) {
  mkdirSync(dir); writeFileSync(join(dir, 'note.md'), 'fixture');
}
const { patchSettings } = await import('./settings.js');
const { scanChangedPage } = await import('./explorerChanged.js');
async function configure(projects = [alpha, beta, external]) {
  await patchSettings({ defaultWorkingDirectory: alpha, projects, projectRoots: [] });
}

test('all-project changes include nondefault and outside-HOME registered projects', async () => {
  await configure();
  const result = await scanChangedPage({ within: '48h' });
  for (const dir of [alpha, beta, external]) assert.ok(result.entries.some(e => e.path === join(dir, 'note.md')), dir);
  assert.deepEqual([...new Set(result.entries.map(e => e.project))].sort(), ['alpha', 'beta', 'external']);
  const scoped = await scanChangedPage({ project: external });
  assert.deepEqual(scoped.entries.map(e => e.path), [join(external, 'note.md')]);
  assert.equal(result.partial, false);
});

test('changed scans refuse unregistered roots and protected files and cannot follow escape links', async () => {
  await configure();
  writeFileSync(join(beta, '.env'), 'synthetic private setting');
  await fs.symlink(unknown, join(beta, 'escape'), 'dir');
  const result = await scanChangedPage();
  assert.ok(!result.entries.some(e => e.path.startsWith(unknown) || e.name === '.env' || e.path.includes('escape')));
  assert.deepEqual((await scanChangedPage({ project: unknown })).entries, []);
  assert.deepEqual((await scanChangedPage({ project: process.env.HOME })).entries, []);
  await patchSettings({ projects: [alpha] });
  assert.deepEqual((await scanChangedPage({ project: external })).entries, []);
});

test('nested registered roots are scanned once even when an ancestor skips nested checkouts', async t => {
  const nested = join(alpha, 'nested'); mkdirSync(nested);
  mkdirSync(join(nested, '.git')); writeFileSync(join(nested, 'nested.md'), 'fixture');
  await configure([alpha, nested]);
  const original = fs.opendir;
  let opens = 0;
  t.mock.method(fs, 'opendir', (...args: Parameters<typeof fs.opendir>) => {
    if (String(args[0]) === nested) opens++;
    return (original as any)(...args);
  });
  syncBuiltinESMExports();
  try {
    const result = await scanChangedPage();
    assert.equal(result.entries.filter(e => e.path === join(nested, 'nested.md')).length, 1);
    assert.equal(opens, 1);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test('one large root cannot spend the entry budget reserved for another root', async t => {
  await configure([alpha, beta]);
  const original = fs.opendir;
  let reads = 0;
  t.mock.method(fs, 'opendir', (...args: Parameters<typeof fs.opendir>) => {
    if (String(args[0]) !== alpha) return (original as any)(...args);
    return Promise.resolve({
      read: async () => ++reads <= 30_000 ? { name: `noise-${reads}`, isDirectory: () => false, isFile: () => false } : null,
      close: async () => {},
    });
  });
  syncBuiltinESMExports();
  try {
    const result = await scanChangedPage();
    assert.ok(reads > 0 && reads <= 10_000, `first root consumed ${reads} entries`);
    assert.ok(result.entries.some(e => e.path === join(beta, 'note.md')));
    assert.equal(result.partial, true);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});


test('a stalled root uses only its time share while another project still returns', async t => {
  await configure([alpha, beta]);
  const original = fs.opendir;
  let finish!: (value: Awaited<ReturnType<typeof fs.opendir>>) => void;
  const stalled = new Promise<Awaited<ReturnType<typeof fs.opendir>>>(resolve => { finish = resolve; });
  t.mock.method(fs, 'opendir', (...args: Parameters<typeof fs.opendir>) => String(args[0]) === alpha ? stalled : (original as any)(...args));
  syncBuiltinESMExports();
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  try {
    const started = performance.now();
    const result = await scanChangedPage();
    assert.ok(result.entries.some(e => e.path === join(beta, 'note.md')));
    assert.equal(result.partial, true);
    assert.ok(performance.now() - started < 900);
    assert.ok(ticks > 0, 'other request callbacks can run during discovery');
  } finally {
    clearInterval(timer); t.mock.restoreAll(); syncBuiltinESMExports();
    finish(await original(alpha));
    await new Promise(resolve => setImmediate(resolve));
  }
});
