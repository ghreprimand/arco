import test from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectArtifacts, realpathWithinHome } from './explorerArtifacts.js';

async function withHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.HOME;
  process.env.HOME = home;
  try { return await fn(); } finally { if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous; }
}

test('projects stay inside the home fence when the home is reached through a symlink', { skip: process.platform === 'win32' ? 'POSIX HOME symlink' : false }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'arco-home-fence-'));
  try {
    const realHome = join(root, 'real-home');
    await mkdir(join(realHome, 'proj'), { recursive: true });
    const linkHome = join(root, 'link-home');
    await symlink(realHome, linkHome, 'dir');
    const expected = await realpath(join(realHome, 'proj'));
    await withHome(linkHome, async () => {
      assert.equal(await realpathWithinHome(join(linkHome, 'proj')), expected);
      assert.equal(await realpathWithinHome(root), null, 'a folder above the home stays outside');
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('artifact listings omit protected paths and do not use linked private metadata', { skip: process.platform === 'win32' ? 'symlink privileges vary' : false }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'arco-artifact-policy-')));
  try {
    const project = join(root, 'project');
    const wf = join(project, '.arco', 'workflows', 'fixture');
    const artifacts = join(wf, 'artifacts');
    await mkdir(artifacts, { recursive: true });
    await writeFile(join(artifacts, 'ordinary.txt'), 'fixture');
    await writeFile(join(artifacts, 'credentials.json'), 'fixture');
    await writeFile(join(project, 'credentials.json'), JSON.stringify({ name: 'private fixture title' }));
    await symlink(join(project, 'credentials.json'), join(wf, 'meta.json'));
    const privateProject = join(root, '.ssh', 'project');
    await mkdir(join(privateProject, '.arco', 'workflows', 'private', 'artifacts'), { recursive: true });
    await writeFile(join(privateProject, '.arco', 'workflows', 'private', 'artifacts', 'report.txt'), 'fixture');
    await withHome(root, async () => {
      const list = await collectArtifacts({ project });
      assert.deepEqual(list.map((entry) => entry.name), ['ordinary.txt']);
      assert.equal(list[0]?.tabTitle, 'fixture');
      assert.deepEqual(await collectArtifacts({ project: privateProject }), []);
      await rm(join(wf, 'meta.json'));
      await link(join(project, 'credentials.json'), join(wf, 'meta.json'));
      assert.equal((await collectArtifacts({ project }))[0]?.tabTitle, 'fixture');
      await rm(join(wf, 'meta.json'));
      await writeFile(join(wf, 'meta.json'), JSON.stringify({ name: 'ordinary title' }));
      assert.equal((await collectArtifacts({ project }))[0]?.tabTitle, 'ordinary title');
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});
