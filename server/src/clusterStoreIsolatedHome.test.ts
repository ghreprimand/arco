import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installIsolatedTestHome } from './testSupport/isolatedHome.js';

test('member removal and replacement remove isolated CLI homes', { skip: process.platform !== 'linux' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'arco-worker-credentials-'));
  installIsolatedTestHome(root);
  const store = await import('./clusterStore.js');
  const project = join(root, 'project');
  await mkdir(project);
  const [first, second, standard, unowned] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  try {
    const cluster = await store.createCluster({ cwd: project, memberWorkflowIds: [first, second, standard, unowned] });
    for (const id of [first, second, unowned]) await store.setMemberAccessMode(cluster.clusterId, id, 'isolated');
    const outside = join(root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'keep'), 'preserved');
    const { prepareIsolatedCliHome } = await import('./workers/isolatedCliHome.js');
    const [cliOne, cliTwo] = await Promise.all([prepareIsolatedCliHome(cluster.clusterId, first), prepareIsolatedCliHome(cluster.clusterId, second)]);
    const workspace = store.isolatedWorkspaceFor(cluster.clusterId, first);
    await writeFile(join(workspace, 'artifact'), 'keep');
    await store.removeMember(cluster.clusterId, first);
    await assert.rejects(stat(cliOne));
    assert.equal(await readFile(join(workspace, 'artifact'), 'utf8'), 'keep');
    const replacementHome = await prepareIsolatedCliHome(cluster.clusterId, unowned);
    await writeFile(join(replacementHome, 'session'), 'private session');
    await store.replaceMember(cluster.clusterId, unowned, randomUUID(), 'isolated');
    await assert.rejects(stat(replacementHome));

  } finally { await rm(root, { recursive: true, force: true }); }
});
