import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { installIsolatedTestHome } from './testSupport/isolatedHome.js';
const root = await realpath(await mkdtemp(join(tmpdir(), 'arco-explorer-root-')));
installIsolatedTestHome(root);
const { listBrowserDirectory, resolveBrowserRead } = await import('./http/readConfinement.js');
const { patchSettings } = await import('./settings.js');
after(() => rm(root, { recursive: true, force: true }));
test('B73: home fallback lists and opens project content when default is missing', async () => {
  const project = join(homedir(), 'sample'); await mkdir(project);
  const file = join(project, 'note.txt'); await writeFile(file, 'fixture');
  await patchSettings({ defaultWorkingDirectory: join(root, 'unavailable') });
  assert.equal(await (await import('./http/explorerRoot.js')).explorerRoot(), homedir());
  const tree = await listBrowserDirectory(homedir(), false);
  assert.ok(tree.entries.some(e => e.name === 'sample' && e.isDirectory));
  assert.equal(await resolveBrowserRead(file), file);
});

test('B73: a readable Projects folder wins over home when the setting is unavailable', async () => {
  const projects = join(homedir(), 'Projects'); await mkdir(projects);
  assert.equal(await (await import('./http/explorerRoot.js')).explorerRoot(), projects);
  await listBrowserDirectory(projects, false);
});
test('B73: a readable configured root wins and fallback does not grant write access', async () => {
  const configured = join(root, 'configured'); await mkdir(configured);
  await patchSettings({ defaultWorkingDirectory: configured });
  assert.equal(await (await import('./http/explorerRoot.js')).explorerRoot(), configured);
  assert.equal((await (await import('./http/writeConfinement.js')).resolveBoundCwd(homedir(), undefined)).ok, false);
  await assert.rejects(resolveBrowserRead(join(homedir(), 'sample', 'note.txt')));
});
