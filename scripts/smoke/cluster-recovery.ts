// Lost cluster-tab recovery — headless WS + HTTP smoke.
//
// Proves the browser can rediscover an intact durable cluster without
// snapshot-forking, and that a genuinely stale tab gets a structured
// cluster_not_found response rather than a generic reconnect error.

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, step, assert, assertEq, summary } from './lib.js';

const PORT = parseInt(process.env.ARCHON_PORT || '3001', 10);
const REST_BASE = `http://127.0.0.1:${PORT}`;

async function main(): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), 'archon-cluster-recovery-'));
  const c = await connect();
  let sourceWfid = '';
  let clusterId = '';
  let members: string[] = [];

  await step('1: create a two-member live cluster', async () => {
    c.send({
      type: 'create_workflow',
      config: {
        name: 'Recovery Source',
        primaryProvider: 'claude',
        primaryModel: 'claude-opus-4-7',
        primaryEffort: 'normal',
        skipPermissions: true,
        workingDirectory: cwd,
        claudeTransport: 'native',
      },
    });
    const created = await c.waitFor(
      (x) => x.type === 'workflow_created' && (x.config as { name?: string }).name === 'Recovery Source',
      5000,
      'workflow_created',
    );
    sourceWfid = created.workflowId as string;

    c.send({
      type: 'cluster_create_with_fresh_workers',
      sourceWorkflowId: sourceWfid,
      additionalCount: 1,
      name: 'Recovery Cluster',
    });
    const cluster = await c.waitFor(
      (x) => x.type === 'cluster_created' &&
        (x.state as { members?: Array<{ workflowId: string }> }).members?.some((m) => m.workflowId === sourceWfid) === true,
      5000,
      'cluster_created',
    );
    clusterId = cluster.clusterId as string;
    members = (cluster.state as { members: Array<{ workflowId: string }> }).members.map((m) => m.workflowId);
    assertEq(members.length, 2, 'cluster has two members');
  });

  await step('2: GET /api/clusters catalogs the original live id', async () => {
    const response = await fetch(`${REST_BASE}/api/clusters`);
    const body = await response.json() as {
      clusters?: Array<{ clusterId: string; name?: string; memberCount: number }>;
    };
    assert(response.ok, 'live cluster catalog returns 200');
    const row = body.clusters?.find((candidate) => candidate.clusterId === clusterId);
    assert(!!row, 'catalog contains the original cluster id');
    assertEq(row?.name, 'Recovery Cluster', 'catalog preserves display name');
    assertEq(row?.memberCount, 2, 'catalog reports member count');
  });

  await step('3: original id resubscribes; missing id is structured', async () => {
    const stateP = c.waitFor(
      (x) => x.type === 'cluster_state' && x.clusterId === clusterId,
      3000,
      'cluster_state',
    );
    c.send({ type: 'cluster_subscribe', clusterId });
    await stateP;

    const missingId = randomUUID();
    const missingP = c.waitFor(
      (x) => x.type === 'cluster_not_found' && x.clusterId === missingId,
      3000,
      'cluster_not_found',
    );
    c.send({ type: 'cluster_subscribe', clusterId: missingId });
    await missingP;
  });

  await step('4: teardown', async () => {
    c.send({ type: 'cluster_delete', clusterId });
    for (const workflowId of members) c.send({ type: 'remove_workflow', workflowId });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await c.close();
    rmSync(cwd, { recursive: true, force: true });
  });

  summary('Cluster recovery smoke');
}

main().catch((err) => {
  console.error('Cluster recovery smoke crashed:', err);
  process.exit(2);
});
