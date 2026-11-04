import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Readable } from 'node:stream';

const home = mkdtempSync(join(tmpdir(), 'arco-cluster-enabled-'));
process.env.HOME = home;
process.env.ARCO_HOME = join(home, '.arco');

test('cluster admission rejects disabled providers before creating or changing members', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'arco-cluster-project-'));
  const { workflows } = await import('../server/state.js');
  const store = await import('../clusterStore.js');
  const { patchSettings } = await import('../settings.js');
  const h = await import('./clusterHandlers.js');
  const errors: string[] = [];
  const ws = { readyState: 1, OPEN: 1, send: (raw: string) => { const m = JSON.parse(raw); if (m.type === 'error') errors.push(m.message); } } as never;
  const session = { id: 's', workflowIds: new Set(), clusterIds: new Set(), clusterObserved: new Map() } as never;
  let minted = 0;
  const add = (provider: string) => { const id = randomUUID(); workflows.set(id, { config: { name: 'Fixture', workingDirectory: cwd, primaryProvider: provider === 'claude' ? undefined : provider, primaryModel: 'fixture' }, busy: false, observers: new Set(), primary: { provider } } as never); return id; };
  h.initClusterHandlers({ handleUserMessage: async () => {}, handleRemoveWorkflow: () => {}, assertAllMembersClaudeOrCodex: async () => null, createBlankNativeWorkflow: async () => { minted++; return add('claude'); } });
  const claude = add('claude');
  const disabled = add('ollama');
  const extra = add('ollama');
  const cluster = await store.createCluster({ cwd, memberWorkflowIds: [claude, disabled] });
  try {
    await patchSettings({ enabledProviders: { ollama: false } } as never);
    const check = async (prefix: string, action: () => Promise<void>) => {
      const n = errors.length;
      await action();
      assert.equal(errors.length, n + 1, prefix);
      assert.match(errors.at(-1)!, new RegExp(`${prefix} rejected: provider_disabled:ollama`));
      assert.equal(minted, 0);
    };
    await check('cluster_create', () => h.handleClusterCreate(ws, session, cwd, [claude, extra]));
    await check('cluster_create_with_fresh_workers', () => h.handleClusterCreateWithFreshWorkers(ws, session, { sourceWorkflowId: claude, additionalCount: 1, provider: 'ollama', model: 'fixture' } as never));
    await check('cluster_create_from_scratch', () => h.handleClusterCreateFromScratch(ws, session, { cwd, members: [{ provider: 'claude', model: 'fixture' }, { provider: 'ollama', model: 'fixture' }] } as never));
    await check('cluster_member_add', () => h.handleClusterMemberAdd(ws, cluster.clusterId, extra));
    await check('cluster_add_fresh_workers', () => h.handleClusterAddFreshWorkers(ws, session, { clusterId: cluster.clusterId, count: 1, provider: 'ollama', model: 'fixture' } as never));
    await check('cluster_member_replace', () => h.handleClusterMemberReplace(ws, session, { clusterId: cluster.clusterId, workflowId: claude, provider: 'ollama', model: 'fixture' } as never));
    const { tryHandleClusterRoutes } = await import('../http/clusterRoutes.js');
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ cwd, memberWorkflowIds: [claude, extra] }))]), { url: '/api/clusters', method: 'POST' });
    let status = 0, body = '';
    const res = { writeHead: (code: number) => { status = code; }, end: (data: string) => { body = data; } };
    await tryHandleClusterRoutes(req as never, res as never, { assertAllMembersClaudeOrCodex: async () => null } as never);
    assert.equal(status, 400);
    assert.equal(JSON.parse(body).error, 'provider_disabled:ollama');
    assert.deepEqual((await store.readCluster(cluster.clusterId))?.members, [claude, disabled]);
    await patchSettings({ enabledProviders: { ollama: true } } as never);
    const { disabledClusterProvider } = await import('../localCapacity.js');
    assert.equal(await disabledClusterProvider(['ollama']), null, 'enabled offline runtimes do not require a login check');
  } finally {
    await store.deleteCluster(cluster.clusterId).catch(() => {});
    rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
