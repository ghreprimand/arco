import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';

test('isolated CLI homes keep sessions separate and reject replacement', { skip: process.platform !== 'linux' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'arco-worker-credentials-'));
  installIsolatedTestHome(root);
  const store = await import('../clusterStore.js');
  const project = join(root, 'project');
  await mkdir(project);
  const [first, second, standard, unowned] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  try {
    const cluster = await store.createCluster({ cwd: project, memberWorkflowIds: [first, second, standard, unowned] });
    for (const id of [first, second, unowned]) await store.setMemberAccessMode(cluster.clusterId, id, 'isolated');
    const outside = join(root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'keep'), 'preserved');
    const { prepareIsolatedCliHome } = await import('./isolatedCliHome.js');
    const [cliOne, cliTwo] = await Promise.all([prepareIsolatedCliHome(cluster.clusterId, first), prepareIsolatedCliHome(cluster.clusterId, second)]);
    assert.notEqual(cliOne, cliTwo);
    assert.deepEqual(await readdir(cliOne), []);
    await writeFile(join(cliOne, 'session'), 'private session');
    assert.equal(await readFile(join(await prepareIsolatedCliHome(cluster.clusterId, first), 'session'), 'utf8'), 'private session');
    assert.deepEqual(await readdir(cliTwo), []);
    await assert.rejects(prepareIsolatedCliHome(cluster.clusterId, standard), /isolated cluster member/);
    await rm(cliTwo, { recursive: true }); await symlink(outside, cliTwo, 'dir');
    await assert.rejects(prepareIsolatedCliHome(cluster.clusterId, second), /private owned directory/);

  } finally { await rm(root, { recursive: true, force: true }); }
});
