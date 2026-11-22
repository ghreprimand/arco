import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';

test('Codex isolated launch rejects existing configuration', { skip: process.platform !== 'linux' }, async () => {
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
    const { prepareCodexIsolatedLaunch } = await import('./codexIsolatedLaunch.js');
    const { prepareIsolatedCliHome } = await import('./isolatedCliHome.js');
    const [cliOne, cliTwo] = await Promise.all([prepareIsolatedCliHome(cluster.clusterId, first), prepareIsolatedCliHome(cluster.clusterId, second)]);
    await mkdir(join(cliOne, 'config'), { mode: 0o700 });
    await writeFile(join(cliOne, 'config', 'config.toml'), 'untrusted configuration');
    await assert.rejects(prepareCodexIsolatedLaunch({ clusterId: cluster.clusterId, workflowId: first, arcoPort: 1234, binary: '/usr/bin/false', credentials: {}, webAccess: false, mode: 'isolated' }), /unexpected configuration/);
    await rm(join(cliOne, 'config', 'config.toml'));
    await rm(join(cliOne, 'config'), { recursive: true });

  } finally { await rm(root, { recursive: true, force: true }); }
});
