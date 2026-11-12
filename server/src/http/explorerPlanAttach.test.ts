import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { settleProjectWrites } from '../testSupport/projectWrites.js';
import { linkFolder } from '../testSupport/links.js';

const root = await mkdtemp(join(tmpdir(), 'arco-plan-attach-'));
process.once('exit', () => rmSync(root, { recursive: true, force: true }));
process.env.ARCO_HOME = join(root, 'home');
const clusters = await import('../clusterStore.js');
const plans = await import('../planStore.js');
const { tryHandleExplorerRoutes } = await import('./explorerRoutes.js');
const { isAgentToolRoute } = await import('./wsAuth.js');
const { releaseClusterPlansWatcher } = await import('../server/broadcast.js');
const { workflowCwds } = await import('../server/state.js');

test('plan library attaches to the selected cluster only in the same project', async () => {
  const cwd = join(root, 'one');
  const other = join(root, 'two');
  await Promise.all([mkdir(cwd), mkdir(other)]);
  const alias = join(root, 'alias');
  await linkFolder(cwd, alias);
  const cluster = await clusters.createCluster({ cwd, memberWorkflowIds: [randomUUID(), randomUUID()] });
  const own = await plans.createPlan(cwd, { title: 'Own plan', body: '- [ ] Task' });
  const foreign = await plans.createPlan(other, { title: 'Other plan', body: '- [ ] Other' });
  async function attach(path: string, planId: string, clusterId = cluster.clusterId) {
    const params = new URLSearchParams({ path, planId, clusterId });
    const req = { method: 'POST', url: `/api/explorer/plans/attach?${params}`, headers: {} } as IncomingMessage;
    let status = 0;
    const res = { writeHead: (code: number) => { status = code; }, end: () => {} } as unknown as ServerResponse;
    assert.equal(await tryHandleExplorerRoutes(req, res), true);
    return status;
  }
  async function target(path: string, kind = 'cluster', id = cluster.clusterId) {
    const params = new URLSearchParams({ path, kind, id });
    const req = { method: 'GET', url: `/api/explorer/plans/target?${params}`, headers: {} } as IncomingMessage;
    let status = 0, body = '';
    const res = { writeHead: (code: number) => { status = code; }, end: (value: string) => { body = value; } } as unknown as ServerResponse;
    assert.equal(await tryHandleExplorerRoutes(req, res), true);
    assert.equal(status, 200);
    return JSON.parse(body) as { sameProject: boolean };
  }
  try {
    assert.equal(isAgentToolRoute('/api/explorer/plans/attach'), false);
    assert.equal(isAgentToolRoute('/api/explorer/plans/target'), false);
    assert.equal((await target(alias)).sameProject, true);
    assert.equal((await target(other)).sameProject, false);
    const workflowId = randomUUID();
    workflowCwds.set(workflowId, cwd);
    assert.equal((await target(alias, 'workflow', workflowId)).sameProject, true);
    assert.equal((await target(other, 'workflow', workflowId)).sameProject, false);
    workflowCwds.delete(workflowId);
    assert.equal(await attach(other, foreign.id), 400);
    assert.equal((await clusters.readCluster(cluster.clusterId))?.planId, undefined);
    assert.equal(await attach(cwd, foreign.id), 404);
    assert.equal(await attach(cwd, own.id, '../escape'), 400);
    assert.equal(await attach(alias, own.id), 200);
    assert.equal((await clusters.readCluster(cluster.clusterId))?.planId, own.id);
  } finally {
    releaseClusterPlansWatcher(cluster.clusterId);
    await settleProjectWrites();
    await rm(root, { recursive: true, force: true });
  }
});
