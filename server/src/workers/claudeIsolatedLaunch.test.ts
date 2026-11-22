import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';

test('Claude isolated launch rejects permission overrides', { skip: process.platform !== 'linux' }, async () => {
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
    const { prepareClaudeIsolatedLaunch } = await import('./claudeIsolatedLaunch.js');
    await assert.rejects(prepareClaudeIsolatedLaunch({ clusterId: cluster.clusterId, workflowId: first, arcoPort: 1234, binary: '/usr/bin/false', credentials: {}, webAccess: false, mode: 'isolated', args: ['-p', '--dangerously-skip-permissions'] }), /conflict/);
    await assert.rejects(prepareClaudeIsolatedLaunch({ clusterId: cluster.clusterId, workflowId: first, arcoPort: 1234, binary: '/usr/bin/false', credentials: {}, webAccess: false, mode: 'isolated', args: ['-p', '--model', '--dangerously-skip-permissions'] }), /Invalid Claude isolation argument/);
    const mutable = { clusterId: cluster.clusterId, workflowId: first, arcoPort: 1234, binary: '/usr/bin/false', credentials: {}, webAccess: false, mode: 'isolated' as const, args: ['-p', '--dangerously-skip-permissions'] };
    const pending = prepareClaudeIsolatedLaunch(mutable);
    mutable.args.pop(); mutable.webAccess = true;
    await assert.rejects(pending, /conflict/);


  } finally { await rm(root, { recursive: true, force: true }); }
});
