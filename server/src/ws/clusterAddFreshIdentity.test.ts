import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'arco-add-fresh-identity-'));
process.env.HOME = home;
process.env.ARCO_HOME = join(home, '.arco');

test('ADD FRESH applies the chosen name and role and names unnamed workers after the role', async () => {
  const store = await import('../clusterStore.js');
  const handlers = await import('./clusterHandlers.js');
  const { workflows } = await import('../server/state.js');
  const errors: string[] = [];
  const ws = { readyState: 1, OPEN: 1, send: (raw: string) => { const m = JSON.parse(raw); if (m.type === 'error') errors.push(m.message); } } as never;
  const session = { id: 's', workflowIds: new Set<string>(), clusterIds: new Set<string>(), clusterObserved: new Map() } as never;
  const allIds: string[] = [];
  let spawned = 0;
  const make = (name: string) => {
    const id = randomUUID(); allIds.push(id);
    workflows.set(id, { config: { name, workingDirectory: home, primaryProvider: 'claude', primaryModel: 'sonnet', primaryEffort: 'medium' }, busy: false, observers: new Set(), primary: { provider: 'claude' } } as never);
    return id;
  };
  handlers.initClusterHandlers({ handleUserMessage: async () => {}, handleRemoveWorkflow: () => {}, assertAllMembersClaudeOrCodex: async () => null, createBlankNativeWorkflow: async (_ws, _session, config) => {
    spawned++;
    const id = randomUUID(); allIds.push(id);
    workflows.set(id, { config, busy: false, observers: new Set(), primary: { provider: 'claude' } } as never);
    return id;
  } });
  const directorId = make('Lead');
  const cluster = await store.createCluster({ cwd: home, memberWorkflowIds: [directorId, make('Anchor')] });
  const nameOf = (id: string) => workflows.get(id)!.config.name;
  const add = async (extra: Record<string, unknown>) => {
    const before = new Set((await store.readCluster(cluster.clusterId))!.members);
    await handlers.handleClusterAddFreshWorkers(ws, session, { clusterId: cluster.clusterId, ...extra } as never);
    const after = (await store.readCluster(cluster.clusterId))!;
    return after.members.filter((id) => !before.has(id)).map((id) => ({ id, name: nameOf(id), role: after.memberRoles?.[id] }));
  };
  try {
    await store.setMemberRole(cluster.clusterId, directorId, 'Director', { restoringSnapshot: true });

    // Empty name, no role: "Worker #k", never the template member's name.
    const plain = await add({ count: 1 });
    assert.deepEqual(plain.map((m) => [m.name, m.role]), [['Worker #1', undefined]]);

    // Empty name with a preset role: the role label drives the name.
    const builders = await add({ count: 2, role: 'Implementer role. Finish assigned work and routine compatible choices; send one blocker or final evidence via peer_send.' });
    assert.deepEqual(builders.map((m) => m.name), ['Builder #1', 'Builder #2']);
    assert.ok(builders.every((m) => m.role?.startsWith('Implementer role')));
    const more = await add({ count: 1, role: 'Builder' });
    assert.deepEqual(more.map((m) => m.name), ['Builder #3']);

    // Custom role is persisted and used for the automatic name.
    const custom = await add({ count: 1, role: 'Migration reviewer' });
    assert.deepEqual(custom.map((m) => [m.name, m.role]), [['Migration reviewer #1', 'Migration reviewer']]);

    // Typed name: as typed for one worker, numbered for several.
    const one = await add({ count: 1, name: '  Scout  ', role: 'Researcher' });
    assert.deepEqual(one.map((m) => m.name), ['Scout']);
    const several = await add({ count: 2, name: 'Scout' });
    assert.deepEqual(several.map((m) => m.name), ['Scout #1', 'Scout #2']);
    // Repeated UI requests and direct protocol requests continue past the highest suffix.
    const repeated = await add({ type: 'cluster_add_fresh_workers', count: 2, name: 'Scout' });
    assert.deepEqual(repeated.map((m) => m.name), ['Scout #3', 'Scout #4']);
    await add({ count: 1, name: 'Scout #9' });
    const gap = await add({ count: 2, name: 'Scout' });
    assert.deepEqual(gap.map((m) => m.name), ['Scout #10', 'Scout #11']);
    await add({ count: 1, name: 'A.[x] #4' });
    const special = await add({ count: 2, name: 'A.[x]' });
    assert.deepEqual(special.map((m) => m.name), ['A.[x] #5', 'A.[x] #6']);
    const longBase = 'x'.repeat(60);
    await add({ count: 1, name: `${longBase} #99` });
    const beforeLong = spawned;
    assert.deepEqual(await add({ count: 2, name: longBase }), []);
    assert.match(errors.at(-1) ?? '', /name_too_long/);
    assert.equal(spawned, beforeLong);

    // A second director is refused and nothing is spawned.
    const spawnedBefore = spawned;
    const membersBefore = (await store.readCluster(cluster.clusterId))!.members.length;
    assert.deepEqual(await add({ count: 1, role: 'Director' }), []);
    assert.match(errors.at(-1) ?? '', /cluster_add_fresh_workers rejected: multiple_directors:/);
    assert.equal(spawned, spawnedBefore);
    assert.equal((await store.readCluster(cluster.clusterId))!.members.length, membersBefore);

    // Other invalid input also spawns nothing.
    await add({ count: 1, name: 'x'.repeat(65) });
    assert.match(errors.at(-1) ?? '', /name_too_long/);
    await add({ count: 2, name: 'x'.repeat(61) });
    assert.match(errors.at(-1) ?? '', /name_too_long/);
    await add({ count: 1, role: 5 });
    assert.match(errors.at(-1) ?? '', /invalid_role/);
    assert.equal(spawned, spawnedBefore);

    // Several directors in one request are refused even when the cluster has none.
    await store.setMemberRole(cluster.clusterId, directorId, '', { restoringSnapshot: true });
    assert.deepEqual(await add({ count: 2, role: 'Director' }), []);
    assert.match(errors.at(-1) ?? '', /multiple_directors/);
    const first = await add({ count: 1, role: 'Director' });
    assert.deepEqual(first.map((m) => [m.name, m.role]), [['Director #1', 'Director']]);
  } finally {
    await store.deleteCluster(cluster.clusterId).catch(() => {});
    for (const id of allIds) workflows.delete(id);
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
