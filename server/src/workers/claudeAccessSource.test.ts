import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';

test('Claude sign-in source reads its own regular file and rejects a symlink', { skip: process.platform !== 'linux' }, async () => {
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
    const { readClaudeAccessSource } = await import('./claudeAccessSource.js');
    const sourceDir = join(root, 'claude-config'); await mkdir(sourceDir);
    const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = sourceDir;
    try {
      await writeFile(join(sourceDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fixture' } }));
      assert.deepEqual(await readClaudeAccessSource(), { claudeAiOauth: { accessToken: 'fixture' } });
      await rm(join(sourceDir, '.credentials.json'));
      await symlink(join(outside, 'keep'), join(sourceDir, '.credentials.json'));
      await assert.rejects(readClaudeAccessSource(), /sign-in needs renewing/);
    } finally { if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = savedConfigDir; }

  } finally { await rm(root, { recursive: true, force: true }); }
});
