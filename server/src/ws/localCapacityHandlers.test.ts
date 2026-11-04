// Server enforcement of the per-runtime local cluster capacity on create,
// add and replace. Synthetic workflows and a temporary home; no providers run.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'arco-local-capacity-handlers-'));
process.env.HOME = home;
process.env.ARCO_HOME = join(home, '.arco');
delete process.env.ARCO_CLUSTER_ALLOW_MULTIPLE_LOCAL;

test('local capacity is enforced on from-scratch create, add, add fresh and replace', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'arco-local-capacity-project-'));
  const { workflows } = await import('../server/state.js');
  const clusterStore = await import('../clusterStore.js');
  const { patchSettings } = await import('../settings.js');
  const handlers = await import('./clusterHandlers.js');
  const errors: string[] = [];
  const ws = { readyState: 1, OPEN: 1, send: (raw: string) => { const m = JSON.parse(raw); if (m.type === 'error') errors.push(m.message); } } as never;
  const session = { id: 's', workflowIds: new Set<string>(), clusterIds: new Set<string>(), clusterObserved: new Map() } as never;
  const created: string[] = [];
  const addWorkflow = (provider: string, model: string): string => {
    const id = randomUUID();
    workflows.set(id, { config: { name: `${provider} worker`, workingDirectory: cwd, primaryProvider: provider === 'claude' ? undefined : provider, primaryModel: model, primaryEffort: 'medium' }, busy: false, observers: new Set(), primary: { provider } } as never);
    return id;
  };
  handlers.initClusterHandlers({
    handleUserMessage: async () => {},
    handleRemoveWorkflow: () => {},
    assertAllMembersClaudeOrCodex: async () => null,
    createBlankNativeWorkflow: async (_ws, _session, config) => { const id = addWorkflow(config.primaryProvider ?? 'claude', String(config.primaryModel)); created.push(id); return id; },
  });
  const lastError = () => errors.at(-1) ?? '';
  const clusters: string[] = [];
  try {
    // Default 1: two Ollama members are refused before any workflow is minted.
    await handlers.handleClusterCreateFromScratch(ws, session, { type: 'cluster_create_from_scratch', cwd, members: [{ provider: 'ollama', model: 'a' }, { provider: 'ollama', model: 'b' }] } as never);
    assert.match(lastError(), /cluster_create_from_scratch rejected: local_capacity: 2 members use Ollama, but it allows 1 at once/);
    assert.equal(created.length, 0);

    // Existing cluster with one Claude and one Ollama member.
    const claudeId = addWorkflow('claude', 'opus');
    const ollamaId = addWorkflow('ollama', 'a');
    const cluster = await clusterStore.createCluster({ cwd, memberWorkflowIds: [claudeId, ollamaId] });
    clusters.push(cluster.clusterId);

    // Add an existing Ollama workflow: refused at the default.
    const extra = addWorkflow('ollama', 'b');
    await handlers.handleClusterMemberAdd(ws, cluster.clusterId, extra);
    assert.match(lastError(), /cluster_member_add rejected: local_capacity:/);
    assert.deepEqual((await clusterStore.readCluster(cluster.clusterId))?.members, [claudeId, ollamaId]);

    // Add fresh Ollama workers: refused.
    await handlers.handleClusterAddFreshWorkers(ws, session, { type: 'cluster_add_fresh_workers', clusterId: cluster.clusterId, count: 1, provider: 'ollama', model: 'b' } as never);
    assert.match(lastError(), /cluster_add_fresh_workers rejected: local_capacity:/);

    // Replace the Claude member with an Ollama one: refused.
    await handlers.handleClusterMemberReplace(ws, session, { type: 'cluster_member_replace', clusterId: cluster.clusterId, workflowId: claudeId, provider: 'ollama', model: 'b' } as never);
    assert.match(lastError(), /cluster_member_replace rejected: local_capacity:/);
    // A replacement that adds no local member is not checked.
    const before = errors.length;
    await handlers.handleClusterMemberReplace(ws, session, { type: 'cluster_member_replace', clusterId: cluster.clusterId, workflowId: ollamaId, provider: 'ollama', model: 'a' } as never);
    assert.ok(errors.slice(before).every((e) => !/local_capacity/.test(e)), errors.slice(before).join('\n'));

    // Capacity 3: three accepted, four refused.
    await patchSettings({ localClusterCapacity: { ollama: 3 } });
    await handlers.handleClusterMemberAdd(ws, cluster.clusterId, extra);
    const afterAdd = (await clusterStore.readCluster(cluster.clusterId))?.members ?? [];
    assert.equal(afterAdd.length, 3);
    assert.ok(afterAdd.includes(extra));
    const fourth = addWorkflow('ollama', 'c');
    const third = addWorkflow('ollama', 'd');
    const errorsBefore = errors.length;
    await handlers.handleClusterMemberAdd(ws, cluster.clusterId, third);
    assert.equal(errors.length, errorsBefore, errors.slice(errorsBefore).join('\n'));
    await handlers.handleClusterMemberAdd(ws, cluster.clusterId, fourth);
    assert.match(lastError(), /4 members use Ollama, but it allows 3 at once/);

    // From scratch with three Ollama members passes the capacity check.
    const createdBefore = created.length;
    await handlers.handleClusterCreateFromScratch(ws, session, { type: 'cluster_create_from_scratch', cwd: mkdtempSync(join(tmpdir(), 'arco-local-capacity-scratch-')), members: [{ provider: 'ollama', model: 'a' }, { provider: 'ollama', model: 'b' }, { provider: 'ollama', model: 'c' }] } as never);
    assert.equal(created.length - createdBefore, 3, errors.join('\n'));

    // Environment override lifts the limit.
    process.env.ARCO_CLUSTER_ALLOW_MULTIPLE_LOCAL = '1';
    await handlers.handleClusterMemberAdd(ws, cluster.clusterId, fourth);
    assert.equal((await clusterStore.readCluster(cluster.clusterId))?.members.length, 5);
  } finally {
    delete process.env.ARCO_CLUSTER_ALLOW_MULTIPLE_LOCAL;
    for (const id of clusters) await clusterStore.deleteCluster(id).catch(() => {});
    rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
