import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installIsolatedTestHome } from './testSupport/isolatedHome.js';
const root = realpathSync(mkdtempSync(join(tmpdir(), 'arco-preparation-')));
installIsolatedTestHome(root);
after(() => rmSync(root, { recursive: true, force: true }));
const alpha = join(process.env.HOME!, 'alpha'), beta = join(root, 'beta');
for (const folder of [alpha, beta]) { mkdirSync(folder); writeFileSync(join(folder, 'note.md'), 'fixture'); }
const { patchSettings } = await import('./settings.js');
const { scanChangedPage } = await import('./explorerChanged.js');

test('a held nondefault registered-root stat returns healthy alpha with partial before release', async t => {
  await patchSettings({ projects: [alpha, beta], defaultWorkingDirectory: alpha, projectRoots: [] });
  const original = fs.stat;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  t.mock.method(fs, 'stat', async (...args: Parameters<typeof fs.stat>) => {
    if (String(args[0]) === beta) { started(); await held; }
    return (original as any)(...args);
  });
  syncBuiltinESMExports();
  const pending = scanChangedPage();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await entered;
    const result = await Promise.race([pending, new Promise<undefined>(resolve => { timeout = setTimeout(() => resolve(undefined), 800); })]);
    assert.ok(result, 'request must settle before the held root is released');
    assert.ok(result.entries.some(e => e.path === join(alpha, 'note.md')));
    assert.ok(!result.entries.some(e => e.path.startsWith(beta)));
    assert.equal(result.partial, true);
    const snapshot = JSON.stringify(result);
    release(); await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(JSON.stringify(result), snapshot, 'late work cannot mutate the returned page');
  } finally {
    if (timeout) clearTimeout(timeout);
    release(); await pending;
    t.mock.restoreAll(); syncBuiltinESMExports();
  }
});


test('healthy configured locations and their nested checkouts survive a different root stat hold', async t => {
  const location = join(root, 'location'), child = join(location, 'child');
  mkdirSync(join(child, '.git'), { recursive: true }); writeFileSync(join(child, 'child.md'), 'fixture');
  await patchSettings({ projects: [alpha], defaultWorkingDirectory: alpha, projectRoots: [{ name: 'Healthy', path: location }, { name: 'Unavailable', path: beta }] });
  const original = fs.stat;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(fs, 'stat', async (...args: Parameters<typeof fs.stat>) => {
    if (String(args[0]) === beta) await held;
    return (original as any)(...args);
  });
  syncBuiltinESMExports();
  const pending = scanChangedPage();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([pending, new Promise<undefined>(resolve => { timeout = setTimeout(() => resolve(undefined), 800); })]);
    assert.ok(result);
    assert.ok(result.entries.some(e => e.path === join(alpha, 'note.md')));
    assert.ok(result.entries.some(e => e.path === join(child, 'child.md')));
    assert.equal(result.partial, true);
  } finally {
    if (timeout) clearTimeout(timeout);
    release(); await pending;
    t.mock.restoreAll(); syncBuiltinESMExports();
  }
});

test('independent root discovery has the same healthy canonical grants as the ordinary explorer', async () => {
  const { createReadAccessContext } = await import('./fileAccessPolicy.js');
  const { readListingSettings } = await import('./settings.js');
  const { knownRoots } = await import('./http/writeConfinement.js');
  const recent = join(root, 'recent'), location = join(root, 'location');
  const alias = join(root, 'alpha-alias'), hidden = join(location, '.hidden');
  mkdirSync(recent); mkdirSync(hidden); await fs.symlink(alpha, alias, 'dir');
  mkdirSync(process.env.CODEX_HOME!, { recursive: true });
  await patchSettings({ projects: [alpha, beta, alias, process.env.CODEX_HOME!], defaultWorkingDirectory: alpha, projectRoots: [{ name: 'Location', path: location }] });
  writeFileSync(join(process.env.ARCO_HOME!, 'known-cwds.json'), JSON.stringify([recent]));
  const access = await createReadAccessContext(), settings = await readListingSettings(access);
  const canonical = async (paths: string[]) => [...new Set((await access.prepareRoots(paths)).map(r => r.canonical))].sort();
  const expected = await canonical([...await knownRoots(access, settings)]);
  const found: string[] = [];
  await knownRoots(access, settings, p => found.push(p));
  assert.deepEqual(await canonical(found), expected);
  assert.ok(expected.includes(recent));
  assert.ok(expected.includes(join(location, 'child')));
  assert.ok(!expected.includes(hidden));
  assert.ok(!expected.includes(process.env.CODEX_HOME!));
});

test('a timed-out configured canonical path is omitted without making a home alias a grant', async () => {
  const { createReadAccessContext } = await import('./fileAccessPolicy.js');
  const { readListingSettings } = await import('./settings.js');
  const { scanBudget } = await import('./projectScan.js');
  const homeAlias = join(root, 'home-alias');
  await fs.symlink(process.env.HOME!, homeAlias, 'dir');
  // Write the synthetic raw settings, before the ordinary canonical sanitizer.
  writeFileSync(join(process.env.ARCO_HOME!, 'settings.json'), JSON.stringify({ projects: [alpha], defaultWorkingDirectory: alpha, projectRoots: [{ path: homeAlias }] }));
  const access = await createReadAccessContext();
  let release!: (value: string) => void;
  const held = new Promise<string>(resolve => { release = resolve; });
  const budget = scanBudget(20_000, 25);
  try {
    const settings = await readListingSettings({ ...access, rootRealpath: p => p === homeAlias ? held : access.rootRealpath(p) }, budget);
    assert.equal(budget.partial, true);
    assert.deepEqual(settings.projectRoots, []);
    assert.deepEqual(settings.projects, [alpha]);
  } finally { release(process.env.HOME!); }
});

test('a held history registry read cannot suppress healthy registered projects', async t => {
  await patchSettings({ projects: [alpha], defaultWorkingDirectory: alpha, projectRoots: [] });
  const registry = join(process.env.ARCO_HOME!, 'known-cwds.json');
  const original = fs.readFile;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(fs, 'readFile', async (...args: Parameters<typeof fs.readFile>) => {
    if (String(args[0]) === registry) await held;
    return (original as any)(...args);
  });
  syncBuiltinESMExports();
  const pending = scanChangedPage();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([pending, new Promise<undefined>(resolve => { timeout = setTimeout(() => resolve(undefined), 800); })]);
    assert.ok(result);
    assert.ok(result.entries.some(e => e.path === join(alpha, 'note.md')));
    assert.equal(result.partial, true);
  } finally {
    if (timeout) clearTimeout(timeout);
    release(); await pending;
    t.mock.restoreAll(); syncBuiltinESMExports();
  }
});
