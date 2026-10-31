import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Readable } from 'node:stream';

const home = mkdtempSync(join(tmpdir(), 'arco-director-handler-'));
process.env.HOME = home;
process.env.ARCO_HOME = join(home, '.arco');

test('creation, preset save and concurrent role changes reject a second director', async () => {
  const store = await import('../clusterStore.js');
  const handlers = await import('./clusterHandlers.js');
  const presets = await import('../clusterPresets.js');
  const { workflows } = await import('../server/state.js');
  const errors: string[] = [];
  const ws = { readyState: 1, OPEN: 1, send: (raw: string) => { const m = JSON.parse(raw); if (m.type === 'error') errors.push(m.message); } } as never;
  const session = { id: 's', workflowIds: new Set(), clusterIds: new Set(), clusterObserved: new Map() } as never;
  try {
    await handlers.handleClusterCreateFromScratch(ws, session, { cwd: home, members: [{ provider: 'claude', model: 'a', role: 'Director' }, { provider: 'claude', model: 'b', role: 'Coordinator' }] } as never);
    assert.match(errors.at(-1) ?? '', /cluster_create_from_scratch rejected: multiple_directors:/);
    await assert.rejects(presets.savePreset({ name: 'test', members: [{ provider: 'claude', model: 'a', role: 'Director' }, { provider: 'claude', model: 'b', role: 'Coordinator' }] } as never), /cluster_preset_save rejected: multiple_directors:/);
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    const cluster = await store.createCluster({ cwd: home, memberWorkflowIds: ids });
    await Promise.all(ids.slice(0, 2).map((id) => handlers.handleClusterMemberRoleSet(ws, cluster.clusterId, id, 'Director')));
    const saved = await store.readCluster(cluster.clusterId);
    assert.equal(Object.values(saved?.memberRoles ?? {}).filter((r) => r === 'Director').length, 1);
    assert.match(errors.at(-1) ?? '', /cluster_member_role_set rejected: multiple_directors:/);
    const remaining = ids.slice(0, 2).find((id) => !saved?.memberRoles?.[id])!;
    await store.setMemberRole(cluster.clusterId, remaining, 'Coordinator', { restoringSnapshot: true });
    const oldErrors = errors.length;
    await handlers.handleClusterMemberRoleSet(ws, cluster.clusterId, remaining, 'Coordinator revised');
    assert.equal(errors.length, oldErrors);
    assert.equal((await store.readCluster(cluster.clusterId))?.memberRoles?.[remaining], 'Coordinator revised');
    await handlers.handleClusterMemberRoleSet(ws, cluster.clusterId, ids[2]!, 'Builder');
    assert.equal(errors.length, oldErrors);
    workflows.set(remaining, { config: { name: 'Director', workingDirectory: home, primaryProvider: 'claude', primaryModel: 'sonnet' }, busy: false, observers: new Set(), primary: { provider: 'claude' } } as never);
    const replacementId = randomUUID();
    handlers.initClusterHandlers({ handleUserMessage: async () => {}, handleRemoveWorkflow: () => {}, assertAllMembersClaudeOrCodex: async () => null, createBlankNativeWorkflow: async (_ws, _session, config) => {
      workflows.set(replacementId, { config, busy: false, observers: new Set(), primary: { provider: 'claude' } } as never);
      return replacementId;
    } });
    await handlers.handleClusterMemberReplace(ws, session, { clusterId: cluster.clusterId, workflowId: remaining } as never);
    assert.equal(errors.length, oldErrors, errors.join('\n'));
    const replaced = await store.readCluster(cluster.clusterId); assert.ok(replaced);
    assert.ok(replaced.members.includes(replacementId));
    assert.ok(!replaced.members.includes(remaining));
    assert.equal(replaced.memberRoles?.[replacementId], 'Coordinator revised');
    assert.equal(replaced.memberRoles?.[ids.find((id) => saved?.memberRoles?.[id] === 'Director')!], 'Director');
    workflows.delete(remaining);
    workflows.delete(replacementId);
    await store.deleteCluster(cluster.clusterId);
  } finally { rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('roleless websocket and HTTP create and add paths preserve existing directors', async () => {
  const store = await import('../clusterStore.js');
  const handlers = await import('./clusterHandlers.js');
  const { tryHandleClusterRoutes } = await import('../http/clusterRoutes.js');
  const { workflows } = await import('../server/state.js');
  const messages: Array<{ type: string; message?: string; clusterId?: string }> = [];
  const ws = { readyState: 1, OPEN: 1, send: (raw: string) => messages.push(JSON.parse(raw)) } as never;
  const session = { id: 's', workflowIds: new Set<string>(), clusterIds: new Set<string>(), clusterObserved: new Map() } as never;
  const allIds: string[] = [];
  const make = () => {
    const id = randomUUID(); allIds.push(id);
    workflows.set(id, { config: { name: 'Fixture', workingDirectory: home, primaryProvider: 'claude', primaryModel: 'sonnet', primaryEffort: 'medium' }, busy: false, observers: new Set(), primary: { provider: 'claude' } } as never);
    return id;
  };
  handlers.initClusterHandlers({ handleUserMessage: async () => {}, handleRemoveWorkflow: () => {}, assertAllMembersClaudeOrCodex: async () => null, createBlankNativeWorkflow: async () => make() });
  const clusterIds: string[] = [];
  try {
    const direct = [make(), make()];
    await handlers.handleClusterCreate(ws, session, home, direct);
    const directCluster = store.getClusterIdForWorkflow(direct[0]!); assert.ok(directCluster); clusterIds.push(directCluster);
    assert.equal((await store.readCluster(directCluster))?.memberRoles, undefined);

    const anchor = make();
    await handlers.handleClusterCreateWithFreshWorkers(ws, session, { sourceWorkflowId: anchor, additionalCount: 1 } as never);
    const freshCluster = store.getClusterIdForWorkflow(anchor); assert.ok(freshCluster); clusterIds.push(freshCluster);
    assert.equal((await store.readCluster(freshCluster))?.memberRoles, undefined);

    await store.setMemberRole(directCluster, direct[0]!, 'Director', { restoringSnapshot: true });
    await store.setMemberRole(directCluster, direct[1]!, 'Coordinator', { restoringSnapshot: true });
    const added = make();
    await handlers.handleClusterMemberAdd(ws, directCluster, added);
    await handlers.handleClusterAddFreshWorkers(ws, session, { clusterId: directCluster, count: 1 } as never);
    const after = await store.readCluster(directCluster); assert.ok(after);
    assert.equal(after.members.length, 4);
    assert.deepEqual(direct.map((id) => after.memberRoles?.[id]), ['Director', 'Coordinator']);
    assert.equal(after.memberRoles?.[added], undefined);
    assert.equal(after.memberRoles?.[after.members[3]!], undefined);

    const httpIds = [make(), make()];
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ cwd: home, memberWorkflowIds: httpIds }))]), { url: '/api/clusters', method: 'POST' });
    let status = 0; let body = '';
    const res = { writeHead: (code: number) => { status = code; }, end: (value: string) => { body = value; } };
    assert.equal(await tryHandleClusterRoutes(req as never, res as never, { assertAllMembersClaudeOrCodex: async () => null } as never), true);
    assert.equal(status, 200, body);
    const httpId = JSON.parse(body).clusterId as string; clusterIds.push(httpId);
    assert.equal((await store.readCluster(httpId))?.memberRoles, undefined);
    assert.ok(messages.every((m) => m.type !== 'error'), JSON.stringify(messages));
  } finally {
    for (const id of clusterIds) await store.deleteCluster(id).catch(() => {});
    for (const id of allIds) workflows.delete(id);
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
