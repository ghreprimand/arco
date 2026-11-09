import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';
const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'arco-list-parity-')));
installIsolatedTestHome(root);
const home = process.env.HOME!;
const project = join(root, 'project'), sibling = join(root, 'sibling'), outside = join(root, 'outside');
const defaultRuntime = join(root, 'default-runtime'), runtime = join(root, 'runtime');
const provider = join(root, 'provider');
for (const folder of [project, sibling, outside, defaultRuntime, runtime, provider, join(home, '.ssh')]) fs.mkdirSync(folder, { recursive: true });
fs.symlinkSync(runtime, process.env.ARCO_HOME!, 'dir');
fs.symlinkSync(defaultRuntime, join(home, '.arco'), 'dir');
fs.symlinkSync(provider, join(home, '.codex'), 'dir');
fs.mkdirSync(join(project, 'folder', 'nested'), { recursive: true });
fs.mkdirSync(join(project, '.hidden-folder'));
fs.writeFileSync(join(project, 'plain.txt'), 'fixture');
fs.writeFileSync(join(project, '.hidden-file'), 'hidden');
fs.symlinkSync(join(project, 'plain.txt'), join(project, 'inside-file'));
fs.symlinkSync(join(project, 'folder'), join(project, 'inside-folder'), 'dir');
fs.symlinkSync(join(project, 'plain.txt'), join(project, 'folder', 'sibling-inside'));
fs.symlinkSync(sibling, join(project, 'other-project'), 'dir');
fs.symlinkSync(outside, join(project, 'escape'), 'dir');
fs.symlinkSync(join(outside, 'missing'), join(project, 'dangling'));
fs.symlinkSync(defaultRuntime, join(project, 'default-runtime-alias'), 'dir');
fs.symlinkSync(runtime, join(project, 'runtime-home-alias'), 'dir');
fs.symlinkSync(provider, join(project, 'provider-alias'), 'dir');
fs.symlinkSync(join(home, '.ssh'), join(project, 'credential-alias'), 'dir');
if (process.platform !== 'win32') execFileSync('mkfifo', [join(project, 'special')]);
const { patchSettings } = await import('../settings.js');
const { listBrowserDirectory } = await import('./readConfinement.js');
const { referenceListBrowserDirectory } = await import('../testSupport/browserListingReference.js');
after(() => fs.rmSync(root, { recursive: true, force: true }));
async function configure(projects = [project, sibling], defaultWorkingDirectory = project) {
  await patchSettings({ projects, defaultWorkingDirectory, projectRoots: [] });
}

test('listing and picker output is byte-for-byte identical to the original boundary', async () => {
  await configure();
  for (const folder of [project, join(project, 'folder'), home, root, runtime, defaultRuntime, provider]) {
    for (const directoriesOnly of [false, true]) {
      const capture = async (fn: typeof listBrowserDirectory) => {
        try { return JSON.stringify(await fn(folder, directoriesOnly)); }
        catch (error) { return JSON.stringify({ code: (error as NodeJS.ErrnoException).code, message: (error as Error).message }); }
      };
      assert.equal(await capture(listBrowserDirectory), await capture(referenceListBrowserDirectory), `${folder === project ? 'project' : 'fixture folder'} / directoriesOnly=${directoriesOnly}`);
    }
  }
  const listing = await listBrowserDirectory(project, false);
  assert.deepEqual(listing.entries.map(e => e.name), ['folder', 'inside-file', 'inside-folder', 'plain.txt']);
  assert.ok((await listBrowserDirectory(join(project, 'folder'), false)).entries.some(e => e.name === 'sibling-inside'));
  await assert.rejects(listBrowserDirectory('.', false));
});

test('listing does not perform synchronous boundary filesystem checks per entry', async t => {
  await configure();
  const original = fs.realpathSync;
  let calls = 0;
  t.mock.method(fs, 'realpathSync', (...args: Parameters<typeof fs.realpathSync>) => {
    const stack = new Error().stack ?? '';
    // The independent test-home guard intentionally remains synchronous.
    if (!stack.includes('arcoHome.ts')) calls++;
    return (original as any)(...args);
  });
  const originalStat = fs.statSync;
  t.mock.method(fs, 'statSync', (...args: Parameters<typeof fs.statSync>) => {
    calls++;
    return (originalStat as any)(...args);
  });
  syncBuiltinESMExports();
  try {
    await listBrowserDirectory(project, false);
    assert.equal(calls, 0);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test('new requests immediately apply project removal, provider roots and changed entry links', async () => {
  await configure();
  await listBrowserDirectory(project, false);
  await configure([sibling], sibling);
  await assert.rejects(listBrowserDirectory(project, false));
  await configure();
  const before = await listBrowserDirectory(project, false);
  assert.ok(before.entries.some(e => e.name === 'folder'));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(project, 'folder');
  try { assert.ok(!(await listBrowserDirectory(project, false)).entries.some(e => e.name === 'folder')); }
  finally { process.env.CODEX_HOME = previous; }
  fs.unlinkSync(join(project, 'inside-folder'));
  fs.symlinkSync(outside, join(project, 'inside-folder'), 'dir');
  assert.ok(!(await listBrowserDirectory(project, false)).entries.some(e => e.name === 'inside-folder'));
  fs.unlinkSync(join(project, 'inside-folder'));
  fs.symlinkSync(join(project, 'folder'), join(project, 'inside-folder'), 'dir');
});

test('async root discovery retains configured, scanned, recent and alias authority', async () => {
  const { knownRoots } = await import('./writeConfinement.js');
  const { createReadAccessContext } = await import('../fileAccessPolicy.js');
  const { readListingSettings } = await import('../settings.js');
  const alias = join(root, 'registered-alias'); fs.symlinkSync(project, alias, 'dir');
  const registry = join(process.env.ARCO_HOME!, 'known-cwds.json');
  fs.writeFileSync(registry, JSON.stringify([sibling, project, join(root, 'missing')]));
  await patchSettings({ defaultWorkingDirectory: project, projects: [alias, sibling], projectRoots: [{ name: 'Fixture location', path: root }] });
  try {
    const access = await createReadAccessContext();
    assert.equal(JSON.stringify([...await knownRoots(access, await readListingSettings(access))]), JSON.stringify([...await knownRoots()]));
    for (const directoriesOnly of [false, true]) assert.equal(JSON.stringify(await listBrowserDirectory(project, directoriesOnly)), JSON.stringify(await referenceListBrowserDirectory(project, directoriesOnly)));
  } finally { fs.unlinkSync(registry); await configure(); }
});

test('synthetic timing: 30 entries and 40 registered projects', async t => {
  const projects = Array.from({ length: 40 }, (_, i) => join(root, `timing-project-${i}`));
  projects.forEach(folder => fs.mkdirSync(folder));
  for (let i = 0; i < 30; i++) fs.writeFileSync(join(projects[0], `file-${i}.txt`), 'fixture');
  await configure(projects, projects[0]);
  const measure = async (fn: typeof listBrowserDirectory) => {
    const values: number[] = [];
    for (let i = 0; i < 3; i++) { const started = performance.now(); const result = await fn(projects[0], false); assert.equal(result.entries.length, 30); values.push(performance.now() - started); }
    return values;
  };
  const before = await measure(referenceListBrowserDirectory), after = await measure(listBrowserDirectory);
  assert.equal(JSON.stringify(await listBrowserDirectory(projects[0], false)), JSON.stringify(await referenceListBrowserDirectory(projects[0], false)));
  t.diagnostic(JSON.stringify({ beforeMilliseconds: before, afterMilliseconds: after }));
});
