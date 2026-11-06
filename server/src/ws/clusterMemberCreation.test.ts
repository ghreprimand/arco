// The four ways to create a cluster member, through their real handlers:
// CREATE WITH FRESH WORKERS (a source tab plus fresh workers), CREATE FROM
// SCRATCH (the creator's member list), ADD WORKERS (ADD FRESH in MEMBERS) and
// REPLACE. Pins the workflow settings each passes for a new member, what each
// accepts and refuses, and the identity a from-scratch member gets. Synthetic
// tabs in a temporary home; the workflow factory is a stand-in. One Codex
// account (acct-2) is configured; any other picked account is refused.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'arco-member-creation-'));
process.env.HOME = home;
process.env.ARCO_HOME = join(home, '.arco');

const TEMPLATE = { name: 'Lead', primaryModel: 'sonnet', primaryEffort: 'high', autoCompaction: { enabled: true, thresholdPercent: 70 }, resumeSessionId: 'old-session', resumeWorkflowId: 'old-wf', researchSpawnToken: 'r', templateSpawnToken: 't', providerAccountRef: 'acct-1', claudeTransport: 'cli', ultracode: true, skipPermissions: false, efficiencyToolFilter: 'aggressive' };
// The template's settings a new member keeps in every template-based path.
const KEPT = { primaryModel: 'sonnet', primaryEffort: 'high', claudeTransport: 'cli', ultracode: true, skipPermissions: false, efficiencyToolFilter: 'aggressive' };

test('each creation path builds the new member from its request', async () => {
  const { patchSettings } = await import('../settings.js');
  await patchSettings({ providerAccounts: { codex: [{ id: 'acct-2', label: 'Second' }] } } as never);
  const store = await import('../clusterStore.js');
  const h = await import('./clusterHandlers.js');
  const { workflows } = await import('../server/state.js');
  const cwd = home;
  const errors: string[] = [];
  let createdCluster: string | null = null;
  const ws = { readyState: 1, OPEN: 1, send: (raw: string) => { const m = JSON.parse(raw); if (m.type === 'error') errors.push(m.message); if (m.type === 'cluster_created') createdCluster = m.clusterId; } } as never;
  const session = { id: 's', workflowIds: new Set(), clusterIds: new Set(), clusterObserved: new Map() } as never;
  const captured: Array<Record<string, unknown>> = [];
  const tab = (config: Record<string, unknown>) => { const id = randomUUID(); workflows.set(id, { config: { workingDirectory: cwd, ...config }, busy: false, observers: new Set(), primary: { provider: (config.primaryProvider as string) ?? 'claude' } } as never); return id; };
  const catalogChecks: string[] = [];
  h.initClusterHandlers({ catalogModelKnown: async (provider) => { catalogChecks.push(provider); return true; }, handleUserMessage: async () => {}, handleRemoveWorkflow: () => {}, assertAllMembersClaudeOrCodex: async () => null, createBlankNativeWorkflow: async (_w, _s, config) => { captured.push(config as never); return tab(config as never); } });
  const run = async (f: () => Promise<void>) => {
    captured.length = 0; const n = errors.length; await f();
    for (const c of captured) assert.equal(c.workingDirectory, cwd);
    // Unset keys and keys set to undefined count the same.
    return { configs: captured.map(({ workingDirectory: _w, ...rest }) => JSON.parse(JSON.stringify(rest))), errors: errors.slice(n) };
  };
  const last = async (clusterId: string) => (await store.readCluster(clusterId))!.members.at(-1)!;

  // CREATE WITH FRESH WORKERS: the source's settings, a numbered name, no
  // resume, no auto-compaction; on a provider change the template's own account
  // is looked up (an unconfigured one falls back to the first configured).
  assert.deepEqual(await run(() => h.handleClusterCreateWithFreshWorkers(ws, session, { sourceWorkflowId: tab(TEMPLATE), additionalCount: 1 } as never)),
    { configs: [{ name: 'Lead #2', ...KEPT, researchSpawnToken: 'r', templateSpawnToken: 't' }], errors: [] });
  assert.deepEqual(await run(() => h.handleClusterCreateWithFreshWorkers(ws, session, { sourceWorkflowId: tab(TEMPLATE), additionalCount: 1, provider: 'codex', model: 'gpt-5.5', effort: 'low' } as never)),
    { configs: [{ name: 'Lead #2', ...KEPT, primaryModel: 'gpt-5.5', primaryEffort: 'low', researchSpawnToken: 'r', templateSpawnToken: 't', providerAccountRef: 'acct-2', primaryProvider: 'codex' }], errors: [] });
  assert.deepEqual(await run(() => h.handleClusterCreateWithFreshWorkers(ws, session, { sourceWorkflowId: tab(TEMPLATE), additionalCount: 1, provider: 'codex' } as never)),
    { configs: [], errors: ['cluster_create_with_fresh_workers rejected: missing_model'] });
  assert.deepEqual(await run(() => h.handleClusterCreateWithFreshWorkers(ws, session, { sourceWorkflowId: tab(TEMPLATE), additionalCount: 1, provider: 'codex', model: 'gpt-5.5', providerAccountRef: 'gone' } as never)),
    { configs: [], errors: ['cluster_create_with_fresh_workers rejected: unknown_account:gone'] });

  // ADD WORKERS: the first member is the template; automatic names follow the role.
  const anchor = tab(TEMPLATE);
  const c = await store.createCluster({ cwd, memberWorkflowIds: [anchor, tab({ ...TEMPLATE, name: 'Other' })] });
  assert.deepEqual(await run(() => h.handleClusterAddFreshWorkers(ws, session, { clusterId: c.clusterId, count: 1 } as never)),
    { configs: [{ name: 'Worker #1', ...KEPT, researchSpawnToken: 'r', templateSpawnToken: 't' }], errors: [] });
  assert.deepEqual(await run(() => h.handleClusterAddFreshWorkers(ws, session, { clusterId: c.clusterId, count: 1, provider: 'codex', model: 'gpt-5.5', effort: 'low', providerAccountRef: 'acct-2' } as never)),
    { configs: [{ name: 'Worker #2', ...KEPT, primaryModel: 'gpt-5.5', primaryEffort: 'low', researchSpawnToken: 'r', templateSpawnToken: 't', providerAccountRef: 'acct-2', primaryProvider: 'codex' }], errors: [] });
  // A picked account that is not configured is refused, with no fallback.
  assert.deepEqual(await run(() => h.handleClusterAddFreshWorkers(ws, session, { clusterId: c.clusterId, count: 1, provider: 'codex', model: 'gpt-5.5', providerAccountRef: 'gone' } as never)),
    { configs: [], errors: ['cluster_add_fresh_workers rejected: unknown_account:gone'] });
  assert.deepEqual(await run(() => h.handleClusterAddFreshWorkers(ws, session, { clusterId: c.clusterId, count: 1, accessMode: 'isolated', role: 'Reviewer' } as never)),
    { configs: [{ name: 'Reviewer #1', ...KEPT, claudeTransport: 'native', ultracode: false, researchSpawnToken: 'r', templateSpawnToken: 't' }], errors: [] });
  assert.equal(store.getMemberAccessMode(c.clusterId, await last(c.clusterId)), 'isolated');
  assert.equal((await store.readCluster(c.clusterId))!.memberRoles?.[await last(c.clusterId)], 'Reviewer');
  assert.deepEqual(await run(() => h.handleClusterAddFreshWorkers(ws, session, { clusterId: c.clusterId, count: 1, accessMode: 'isolated', provider: 'codex', model: 'gpt-5.5' } as never)),
    { configs: [], errors: ['cluster_add_fresh_workers rejected: isolated_requires_claude_native'] });
  assert.deepEqual(await run(() => h.handleClusterAddFreshWorkers(ws, session, { clusterId: c.clusterId, count: 1, model: '' } as never)),
    { configs: [], errors: ['cluster_add_fresh_workers rejected: missing_model'] });
  assert.deepEqual(await run(() => h.handleClusterAddFreshWorkers(ws, session, { clusterId: c.clusterId, count: 1, provider: 'claude', model: 'gpt-5.5' } as never)),
    { configs: [], errors: ['cluster_add_fresh_workers rejected: provider_model_mismatch:claude:gpt-5.5'] });
  // ADD WORKERS takes the full member settings: tier and focus as cluster
  // metadata, the tuning as tab settings over the template's.
  assert.deepEqual(await run(() => h.handleClusterAddFreshWorkers(ws, session, { clusterId: c.clusterId, count: 1, tier: 'heavy', focus: ' tests ', efficiencyToolFilter: 'off', outputStyle: 'normal', fastMode: true, autoCompaction: { enabled: true, thresholdPercent: 85 } } as never)),
    { configs: [{ name: 'Worker #3', ...KEPT, efficiencyToolFilter: undefined, researchSpawnToken: 'r', templateSpawnToken: 't', outputStyle: 'normal', fastMode: true, autoCompaction: { enabled: true, thresholdPercent: 85 } }].map((x) => JSON.parse(JSON.stringify(x))), errors: [] });
  assert.equal(store.tierFor(await last(c.clusterId)), 'heavy');
  assert.equal(store.focusFor(await last(c.clusterId)), 'tests');
  assert.deepEqual(await run(() => h.handleClusterAddFreshWorkers(ws, session, { clusterId: c.clusterId, count: 1, tier: 'huge' } as never)),
    { configs: [], errors: ['cluster_add_fresh_workers rejected: invalid_tier:huge'] });

  // REPLACE: the old member's settings, its name and auto-compaction kept,
  // resume and spawn tokens cleared, the access mode kept unless changed.
  const victim = tab({ ...TEMPLATE, name: 'Victim' });
  await store.addMember(c.clusterId, victim);
  assert.deepEqual(await run(() => h.handleClusterMemberReplace(ws, session, { clusterId: c.clusterId, workflowId: victim } as never)),
    { configs: [{ name: 'Victim', ...KEPT, autoCompaction: { enabled: true, thresholdPercent: 70 }, providerAccountRef: 'acct-1' }], errors: [] });
  assert.deepEqual(await run(async () => h.handleClusterMemberReplace(ws, session, { clusterId: c.clusterId, workflowId: await last(c.clusterId), provider: 'codex', model: 'gpt-5.5', providerAccountRef: 'acct-3' } as never)),
    { configs: [], errors: ['cluster_member_replace rejected: unknown_account:acct-3'] });
  assert.deepEqual(await run(async () => h.handleClusterMemberReplace(ws, session, { clusterId: c.clusterId, workflowId: await last(c.clusterId), provider: 'codex', model: 'gpt-5.5', providerAccountRef: 'acct-2' } as never)),
    { configs: [{ name: 'Victim', ...KEPT, primaryModel: 'gpt-5.5', autoCompaction: { enabled: true, thresholdPercent: 70 }, providerAccountRef: 'acct-2', primaryProvider: 'codex' }], errors: [] });
  const codexMember = await last(c.clusterId);
  assert.deepEqual(await run(() => h.handleClusterMemberReplace(ws, session, { clusterId: c.clusterId, workflowId: codexMember, model: '' } as never)),
    { configs: [], errors: ['cluster_member_replace rejected: missing_model'] });
  assert.deepEqual(await run(() => h.handleClusterMemberReplace(ws, session, { clusterId: c.clusterId, workflowId: codexMember, provider: 'claude' } as never)),
    { configs: [], errors: ['cluster_member_replace rejected: missing_model'] });
  // An unknown model depends on the catalog (an unavailable catalog accepts
  // any name); clusterMembers.test.ts covers that refusal with a stand-in.
  assert.deepEqual(await run(() => h.handleClusterMemberReplace(ws, session, { clusterId: c.clusterId, workflowId: codexMember, provider: 'codex', model: 'claude-x' } as never)),
    { configs: [], errors: ['cluster_member_replace rejected: provider_model_mismatch:codex:claude-x'] });
  // REPLACE takes everything the dialog shows: a new name, role, tier, focus
  // and tuning; nothing is forced to stay.
  await store.setMemberTier(c.clusterId, codexMember, 'light');
  await store.setMemberFocus(c.clusterId, codexMember, 'old focus');
  assert.deepEqual(await run(() => h.handleClusterMemberReplace(ws, session, { clusterId: c.clusterId, workflowId: codexMember, name: 'Fresh', role: 'Tester', tier: 'heavy', focus: '', efficiencyToolFilter: 'conservative', outputStyle: 'terse', fastMode: true, autoCompaction: null } as never)),
    { configs: [{ name: 'Fresh', ...KEPT, primaryModel: 'gpt-5.5', providerAccountRef: 'acct-2', primaryProvider: 'codex', efficiencyToolFilter: 'conservative', outputStyle: 'terse', fastMode: true }], errors: [] });
  const renamed = await last(c.clusterId);
  assert.deepEqual([(await store.readCluster(c.clusterId))!.memberRoles?.[renamed], store.tierFor(renamed), store.focusFor(renamed) ?? null], ['Tester', 'heavy', null]);
  // A second director is refused before anything is created.
  await store.setMemberRole(c.clusterId, anchor, 'Director');
  assert.deepEqual((await run(() => h.handleClusterMemberReplace(ws, session, { clusterId: c.clusterId, workflowId: renamed, role: 'Director' } as never))).configs, []);
  assert.equal((await store.readCluster(c.clusterId))!.members.includes(renamed), true);
  assert.deepEqual(await run(() => h.handleClusterMemberReplace(ws, session, { clusterId: c.clusterId, workflowId: renamed, accessMode: 'isolated', provider: 'claude', model: 'sonnet' } as never)),
    { configs: [{ name: 'Fresh', ...KEPT, efficiencyToolFilter: 'conservative', outputStyle: 'terse', fastMode: true, claudeTransport: 'native', ultracode: false }], errors: [] });

  // CREATE FROM SCRATCH: settings from the member list only, with defaults
  // (effort medium, skip-permissions on, "Member #n"); identity saved after.
  assert.deepEqual(await run(() => h.handleClusterCreateFromScratch(ws, session, { cwd, members: [
    { provider: 'claude', model: 'sonnet', displayName: ' Lead ', role: 'Director', tier: 'heavy', focus: 'releases' },
    { provider: 'codex', model: 'gpt-5.5', effort: 'high', fastMode: true, efficiencyToolFilter: 'conservative', outputStyle: 'terse', skipPermissions: false, providerAccountRef: 'acct-2' },
    { provider: 'claude', model: 'sonnet', accessMode: 'isolated', efficiencyToolFilter: 'off', outputStyle: 'normal' },
  ] } as never)), { configs: [
    { name: 'Lead', primaryModel: 'sonnet', primaryEffort: 'medium', skipPermissions: true },
    { name: 'Member #2', primaryProvider: 'codex', primaryModel: 'gpt-5.5', primaryEffort: 'high', skipPermissions: false, fastMode: true, efficiencyToolFilter: 'conservative', outputStyle: 'terse', providerAccountRef: 'acct-2' },
    { name: 'Member #3', primaryModel: 'sonnet', primaryEffort: 'medium', skipPermissions: true, outputStyle: 'normal', claudeTransport: 'native', ultracode: false },
  ], errors: [] });
  assert.ok(catalogChecks.includes('codex'), 'Codex model checks use the fixture catalog');
  const scratch = (await store.readCluster(createdCluster!))!;
  assert.deepEqual(scratch.members.map((id) => [scratch.memberRoles?.[id] ?? null, store.tierFor(id) ?? null, store.focusFor(id) ?? null, store.getMemberAccessMode(scratch.clusterId, id)]),
    [['Director', 'heavy', 'releases', 'standard'], [null, null, null, 'standard'], [null, null, null, 'isolated']]);
  assert.deepEqual(await run(() => h.handleClusterCreateFromScratch(ws, session, { cwd, members: [{ provider: 'claude', model: 'gpt-5.5' }] } as never)),
    { configs: [], errors: ['cluster_create_from_scratch rejected: member[0] provider_model_mismatch:claude:gpt-5.5'] });
  assert.deepEqual(await run(() => h.handleClusterCreateFromScratch(ws, session, { cwd, members: [{ provider: 'codex', model: ' ' }] } as never)),
    { configs: [], errors: ['cluster_create_from_scratch rejected: member[0] missing_model'] });
  assert.deepEqual(await run(() => h.handleClusterCreateFromScratch(ws, session, { cwd, members: [{ provider: 'codex', model: 'gpt-5.5', providerAccountRef: 'gone' }] } as never)),
    { configs: [], errors: ['cluster_create_from_scratch rejected: member[0] unknown_account:gone'] });
  assert.deepEqual(await run(() => h.handleClusterCreateFromScratch(ws, session, { cwd, members: [{ provider: 'codex', model: 'gpt-5.5', accessMode: 'isolated' }] } as never)),
    { configs: [], errors: ['cluster_create_from_scratch rejected: member[0] isolated_requires_claude_native'] });
});

test.after(async () => {
  const { settleWorkspaceWrites } = await import('../workspace.js');
  const { settleMetaSideEffects } = await import('../workflowMeta.js');
  await settleWorkspaceWrites();
  await settleMetaSideEffects();
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
