import { transformSync } from 'esbuild';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WorkflowConfig } from '@arco/shared';
import { memberAccountRefusal, memberConfigFromSpec, memberConfigFromTemplate, memberModelRefusal, memberTuningRefusal, templateModelRefusal, type ProviderChoice } from './clusterMembers.js';

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

test('a provider change sets the provider, model and effort; a picked account is used as picked', async () => {
  lookups.length = 0;
  for (const kind of ['fresh', 'replacement'] as const) {
    const c = await memberConfigFromTemplate({ template: TEMPLATE, cwd: '/p', kind, name: 'N', choice: toCodex, model: 'gpt-5.5', effort: 'low', accountRef: 'known', isolated: false, resolveCodexAccount: accounts });
    assert.equal(c.primaryProvider, 'codex');
    assert.equal(c.primaryModel, 'gpt-5.5');
    assert.equal(c.primaryEffort, 'low');
    assert.equal(c.providerAccountRef, 'known');
    // No pick: the template's reference is looked up and kept when unknown.
    assert.equal((await memberConfigFromTemplate({ template: TEMPLATE, cwd: '/p', kind, choice: toCodex, isolated: false, resolveCodexAccount: accounts })).providerAccountRef, 'acct-1');
  }
  assert.deepEqual(lookups, [['acct-1', '/p'], ['acct-1', '/p']]);
  // Back to Claude from a Codex template: the provider is stored as undefined.
  const fromCodex = await memberConfigFromTemplate({ template: { ...TEMPLATE, primaryProvider: 'codex' }, cwd: '/p', kind: 'replacement', choice: { inherited: 'codex', provider: 'claude', requested: true }, model: 'sonnet', isolated: false, resolveCodexAccount: accounts });
  assert.equal(fromCodex.primaryProvider, undefined);
  assert.equal(fromCodex.providerAccountRef, undefined);
});

test('tuning from the dialog overrides the template; a replacement can be renamed', async () => {
  const tuned = clean(await memberConfigFromTemplate({ template: { ...TEMPLATE, fastMode: true, outputStyle: 'terse', efficiencyToolFilter: 'aggressive' }, cwd: '/p', kind: 'replacement', name: ' Renamed ', choice: claude, isolated: false, resolveCodexAccount: accounts,
    tuning: { fastMode: false, outputStyle: 'plain', efficiencyToolFilter: 'off', autoCompaction: null } }));
  assert.equal(tuned.name, 'Renamed');
  // The default output style (plain) is stored as unset, like OFF.
  for (const key of ['fastMode', 'outputStyle', 'efficiencyToolFilter', 'autoCompaction']) assert.equal(key in tuned, false, key);
  const fresh = await memberConfigFromTemplate({ template: TEMPLATE, cwd: '/p', kind: 'fresh', name: 'W', choice: claude, isolated: false, resolveCodexAccount: accounts,
    tuning: { fastMode: true, outputStyle: 'terse', efficiencyToolFilter: 'conservative', autoCompaction: { enabled: false, thresholdPercent: 60 } } });
  assert.deepEqual([fresh.fastMode, fresh.outputStyle, fresh.efficiencyToolFilter, fresh.autoCompaction], [true, 'terse', 'conservative', { enabled: false, thresholdPercent: 60 }]);
  // An explicit NORMAL is kept, and a stale client's 'lite' becomes the default (unset).
  const normal = await memberConfigFromTemplate({ template: { ...TEMPLATE, outputStyle: 'terse' }, cwd: '/p', kind: 'replacement', name: 'N', choice: claude, isolated: false, resolveCodexAccount: accounts, tuning: { outputStyle: 'normal' } });
  assert.equal(normal.outputStyle, 'normal');
  const stale = await memberConfigFromTemplate({ template: { ...TEMPLATE, outputStyle: 'terse' }, cwd: '/p', kind: 'replacement', name: 'N', choice: claude, isolated: false, resolveCodexAccount: accounts, tuning: { outputStyle: 'lite' as never } });
  assert.equal(stale.outputStyle, undefined);
  // An empty name keeps the old one.
  assert.equal((await memberConfigFromTemplate({ template: TEMPLATE, cwd: '/p', kind: 'replacement', name: '  ', choice: claude, isolated: false, resolveCodexAccount: accounts })).name, 'Lead');
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
  assert.deepEqual(clean(await memberConfigFromSpec({ provider: 'codex', model: 'gpt-5.5', displayName: 'Scout', effort: 'high', skipPermissions: false, fastMode: true, efficiencyToolFilter: 'conservative', outputStyle: 'terse', providerAccountRef: 'known' }, 0, '/p', accounts)),
    { name: 'Scout', primaryProvider: 'codex', primaryModel: 'gpt-5.5', primaryEffort: 'high', skipPermissions: false, workingDirectory: '/p', fastMode: true, efficiencyToolFilter: 'conservative', outputStyle: 'terse', providerAccountRef: 'known' });
  const isolated = await memberConfigFromSpec({ provider: 'claude', model: 'sonnet', accessMode: 'isolated', efficiencyToolFilter: 'off', outputStyle: 'normal' }, 0, '/p', accounts);
  assert.equal(isolated.claudeTransport, 'native');
  assert.equal(isolated.efficiencyToolFilter, undefined);
  assert.equal(isolated.outputStyle, 'normal', 'an explicit NORMAL is kept');
  for (const [given, stored] of [['plain', undefined], ['lite', undefined], [undefined, undefined], ['caveman', 'terse']] as const) {
    assert.equal((await memberConfigFromSpec({ provider: 'ollama', model: 'm', outputStyle: given as never }, 0, '/p', accounts)).outputStyle, stored, String(given));
  }
});

test('one model check for every path: missing, other provider, unknown', async () => {
  const known = async (_p: string, m: string) => m === 'gpt-5.5' || m === 'sonnet' || m === 'claude-4.5-sonnet';
  assert.equal(await memberModelRefusal('codex', ' ', known), 'missing_model');
  assert.equal(await memberModelRefusal('codex', undefined, known), 'missing_model');
  assert.equal(await memberModelRefusal('claude', 'gpt-5.5', known), 'provider_model_mismatch:claude:gpt-5.5');
  assert.equal(await memberModelRefusal('codex', 'gpt-nope', known), 'unknown_model:gpt-nope');
  assert.equal(await memberModelRefusal('codex', 'gpt-5.5', known), null);
  // Cursor serves the claude-* family, so that is not a mismatch.
  assert.equal(await memberModelRefusal('cursor', 'claude-4.5-sonnet', known), null);
  // Template paths: no model keeps the template's, unless the provider changed.
  assert.equal(await templateModelRefusal(claude, undefined, known), null);
  assert.equal(await templateModelRefusal(toCodex, undefined, known), 'missing_model');
  assert.equal(await templateModelRefusal(claude, '', known), 'missing_model');
  assert.equal(await templateModelRefusal(toCodex, 'nope', known), 'unknown_model:nope');
});

test('a picked Codex account must exist; other providers ignore it', async () => {
  const exists = async (ref: string) => ref === 'acct-1';
  assert.equal(await memberAccountRefusal('codex', undefined, '/p', exists), null);
  assert.equal(await memberAccountRefusal('codex', 'acct-1', '/p', exists), null);
  assert.equal(await memberAccountRefusal('codex', '@terminal', '/p', exists), null);
  assert.equal(await memberAccountRefusal('codex', 'gone', '/p', exists), 'unknown_account:gone');
  assert.equal(await memberAccountRefusal('codex', '', '/p', exists), 'unknown_account:');
  assert.equal(await memberAccountRefusal('claude', 'gone', '/p', exists), null);
});

test('member tuning shape check', () => {
  assert.equal(memberTuningRefusal({}), null);
  assert.equal(memberTuningRefusal({ tier: null, focus: '', outputStyle: 'plain', efficiencyToolFilter: 'off', fastMode: false, autoCompaction: null }), null);
  // A stale client's 'lite' is accepted (stored as plain).
  assert.equal(memberTuningRefusal({ outputStyle: 'lite' as never }), null);
  assert.equal(memberTuningRefusal({ tier: 'huge' as never }), 'invalid_tier:huge');
  assert.equal(memberTuningRefusal({ focus: 'x'.repeat(161) }), 'invalid_focus');
  assert.equal(memberTuningRefusal({ outputStyle: 'loud' as never }), 'invalid_output_style');
  assert.equal(memberTuningRefusal({ efficiencyToolFilter: 'max' as never }), 'invalid_tool_filter');
  assert.equal(memberTuningRefusal({ fastMode: 'yes' as never }), 'invalid_fast_mode');
  assert.equal(memberTuningRefusal({ autoCompaction: { enabled: true, thresholdPercent: 10 } }), 'invalid_auto_compaction');
});

test('B136 fresh and replacement members keep the north star but never inherit an armed run', async () => {
  const template={...TEMPLATE,goal:'standing direction',goalRun:{enabled:true,total:4,remaining:3,tokensUsed:5}};
  for(const kind of ['fresh','replacement'] as const) {
    const child=await memberConfigFromTemplate({template,cwd:'/p',kind,choice:claude,isolated:false,resolveCodexAccount:accounts});
    assert.equal(child.goal,'standing direction');assert.equal(child.goalRun,undefined);
  }
  assert.equal(template.goalRun.remaining,3);
});

test('B136 Native Task child does not reuse its parent run budget',()=>{
  const source=readFileSync(new URL('../index.ts',import.meta.url),'utf8');
  const body=source.match(/const childConfig: WorkflowConfig = (\{[\s\S]*?\n  \});/)![1];
  const parent={config:{goal:'direction',goalRun:{enabled:true,remaining:2}}};
  const code=transformSync(`return (${body})`,{loader:'ts'}).code;
  const child=new Function('parent','childName','model',code)(parent,'fixture','haiku');
  assert.equal(child.primaryModel,'haiku');
  assert.equal(child.goal,'direction');assert.equal(child.goalRun,undefined);
});
