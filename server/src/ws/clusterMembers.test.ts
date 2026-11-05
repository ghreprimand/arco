import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WorkflowConfig } from '@arco/shared';
import { memberConfigFromSpec, memberConfigFromTemplate, memberModelProblem, type ProviderChoice } from './clusterMembers.js';

// The member settings functions, with a stand-in Codex account lookup.

const TEMPLATE = { name: 'Lead', workingDirectory: '/old', primaryModel: 'sonnet', primaryEffort: 'high', autoCompaction: { enabled: true, thresholdPercent: 70 }, resumeSessionId: 's', resumeWorkflowId: 'w', researchSpawnToken: 'r', templateSpawnToken: 't', providerAccountRef: 'acct-1', claudeTransport: 'cli', ultracode: true } as unknown as WorkflowConfig;
const claude: ProviderChoice = { inherited: 'claude', provider: 'claude', requested: false };
const toCodex: ProviderChoice = { inherited: 'claude', provider: 'codex', requested: true };
const lookups: Array<[string | undefined, string]> = [];
const accounts = async (ref: string | undefined, cwd: string) => { lookups.push([ref, cwd]); return ref === 'known' ? 'profile-known' : null; };
const clean = (c: WorkflowConfig) => JSON.parse(JSON.stringify(c));

test('a fresh member: new name, no resume or auto-compaction, no account unless Codex', async () => {
  const c = clean(await memberConfigFromTemplate({ template: TEMPLATE, cwd: '/p', kind: 'fresh', name: 'Worker #1', choice: claude, isolated: false, resolveCodexAccount: accounts }));
  assert.deepEqual(c, { name: 'Worker #1', workingDirectory: '/p', primaryModel: 'sonnet', primaryEffort: 'high', researchSpawnToken: 'r', templateSpawnToken: 't', claudeTransport: 'cli', ultracode: true });
});

test('a replacement keeps the name, auto-compaction and a non-Codex account; spawn tokens are cleared', async () => {
  const c = clean(await memberConfigFromTemplate({ template: TEMPLATE, cwd: '/p', kind: 'replacement', choice: claude, isolated: false, resolveCodexAccount: accounts }));
  assert.deepEqual(c, { name: 'Lead', workingDirectory: '/p', primaryModel: 'sonnet', primaryEffort: 'high', autoCompaction: { enabled: true, thresholdPercent: 70 }, providerAccountRef: 'acct-1', claudeTransport: 'cli', ultracode: true });
});

test('a provider change sets the provider, model and effort, and looks up the Codex account', async () => {
  lookups.length = 0;
  for (const kind of ['fresh', 'replacement'] as const) {
    const c = await memberConfigFromTemplate({ template: TEMPLATE, cwd: '/p', kind, name: 'N', choice: toCodex, model: 'gpt-5.5', effort: 'low', accountRef: 'known', isolated: false, resolveCodexAccount: accounts });
    assert.equal(c.primaryProvider, 'codex');
    assert.equal(c.primaryModel, 'gpt-5.5');
    assert.equal(c.primaryEffort, 'low');
    assert.equal(c.providerAccountRef, 'profile-known');
    // An unknown account keeps the template's reference.
    assert.equal((await memberConfigFromTemplate({ template: TEMPLATE, cwd: '/p', kind, choice: toCodex, isolated: false, resolveCodexAccount: accounts })).providerAccountRef, 'acct-1');
  }
  assert.deepEqual(lookups, [['known', '/p'], ['acct-1', '/p'], ['known', '/p'], ['acct-1', '/p']]);
  // Back to Claude from a Codex template: the provider is stored as undefined.
  const fromCodex = await memberConfigFromTemplate({ template: { ...TEMPLATE, primaryProvider: 'codex' }, cwd: '/p', kind: 'replacement', choice: { inherited: 'codex', provider: 'claude', requested: true }, model: 'sonnet', isolated: false, resolveCodexAccount: accounts });
  assert.equal(fromCodex.primaryProvider, undefined);
  assert.equal(fromCodex.providerAccountRef, undefined);
});

test('an isolated member is a Claude Native tab without an account', async () => {
  for (const kind of ['fresh', 'replacement'] as const) {
    const c = await memberConfigFromTemplate({ template: { ...TEMPLATE, primaryProvider: 'codex' }, cwd: '/p', kind, name: 'N', choice: { inherited: 'codex', provider: 'codex', requested: false }, isolated: true, resolveCodexAccount: accounts });
    assert.equal(c.primaryProvider, undefined, kind);
    assert.equal(c.claudeTransport, 'native');
    assert.equal(c.ultracode, false);
    assert.equal(c.providerAccountRef, undefined);
    assert.equal(c.resumeSessionId, undefined);
  }
});

test('a from-scratch member uses only its list entry, with defaults', async () => {
  assert.deepEqual(clean(await memberConfigFromSpec({ provider: 'claude', model: 'sonnet', displayName: '  ' }, 2, '/p', accounts)),
    { name: 'Member #3', primaryModel: 'sonnet', primaryEffort: 'medium', skipPermissions: true, workingDirectory: '/p' });
  assert.deepEqual(clean(await memberConfigFromSpec({ provider: 'codex', model: 'gpt-5.5', displayName: 'Scout', effort: 'high', skipPermissions: false, fastMode: true, efficiencyToolFilter: 'conservative', outputStyle: 'lite', providerAccountRef: 'known' }, 0, '/p', accounts)),
    { name: 'Scout', primaryProvider: 'codex', primaryModel: 'gpt-5.5', primaryEffort: 'high', skipPermissions: false, workingDirectory: '/p', fastMode: true, efficiencyToolFilter: 'conservative', outputStyle: 'lite', providerAccountRef: 'profile-known' });
  const isolated = await memberConfigFromSpec({ provider: 'claude', model: 'sonnet', accessMode: 'isolated', efficiencyToolFilter: 'off', outputStyle: 'normal' }, 0, '/p', accounts);
  assert.equal(isolated.claudeTransport, 'native');
  assert.equal(isolated.efficiencyToolFilter, undefined);
  assert.equal(isolated.outputStyle, undefined);
});

test('model checks: empty, unknown and a provider change without a model, in that order', async () => {
  const known = async (_p: string, m: string) => m === 'gpt-5.5';
  const base = { op: 'op', choice: toCodex, isKnownModel: known, rejectEmptyModel: true, changedWithoutModel: 'needs_model' };
  assert.equal(await memberModelProblem({ ...base, model: ' ' }), 'op rejected: unknown_model');
  assert.equal(await memberModelProblem({ ...base, model: ' ', rejectEmptyModel: false }), 'op rejected: unknown_model: ');
  assert.equal(await memberModelProblem({ ...base, model: 'nope' }), 'op rejected: unknown_model:nope');
  assert.equal(await memberModelProblem({ ...base, model: undefined }), 'op rejected: needs_model');
  assert.equal(await memberModelProblem({ ...base, model: 'gpt-5.5' }), null);
  assert.equal(await memberModelProblem({ ...base, choice: claude, model: undefined }), null);
});
