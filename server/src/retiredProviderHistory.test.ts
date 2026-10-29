import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'arco-retired-history-'));
process.env.ARCO_HOME = join(root, 'home');
mkdirSync(process.env.ARCO_HOME, { recursive: true });

for (const provider of ['antigravity', 'gemini']) test(`retired ${provider} identity remains explicit in defaults and readable workflow history`, async () => {
  mkdirSync(process.env.ARCO_HOME!, { recursive: true });
  const settingsPath = join(process.env.ARCO_HOME!, 'settings.json');
  const cwd = join(root, 'project');
  const workflowId = '11111111-2222-4333-8444-555555555555';
  const folder = join(cwd, '.arco', 'workflows', workflowId);
  mkdirSync(join(folder, 'artifacts'), { recursive: true });
  const settings = { workflowDefaults: { primaryProvider: provider, primaryModel: `${provider}-historical`, outputStyle: 'terse' }, enabledProviders: { [provider]: true, codex: false }, fallbackChains: { reviewer: [{ provider: provider, model: `${provider}-historical` }] }, themeId: 'matrix', textBrightness: 19, projects: [cwd], onboardingComplete: true };
  writeFileSync(settingsPath, JSON.stringify(settings));
  const meta = { workflowId, name: 'Historical work', cwd, primaryProvider: provider, primaryModel: `${provider}-historical`, primaryEffort: 'high', cliSessions: [{ provider: provider, sessionId: 'opaque-session', createdAt: 1 }], createdAt: 1, lastActiveAt: 2 };
  const metaBytes = JSON.stringify(meta);
  const events = JSON.stringify({ type: 'primary_text', workflowId, content: 'Historical answer', seq: 1 }) + '\n';
  writeFileSync(join(folder, 'meta.json'), metaBytes);
  writeFileSync(join(folder, 'events.jsonl'), events);
  writeFileSync(join(folder, 'artifacts', 'answer.md'), '# Historical artifact\n');
  try {
    const { readSettings, patchSettings } = await import('./settings.js');
    const { createProviderProcess, isKnownProvider } = await import('./providers/index.js');
    const { readMeta, workflowConfigFromMeta, arcoInternalSessionInfoForMeta } = await import('./workflowMeta.js');
    const { replayEvents } = await import('./workflowStore.js');
    const { PRIMARY_PROVIDERS, retiredProviderReason } = await import('@arco/shared');
    const read = await readSettings();
    assert.equal(read.workflowDefaults?.primaryProvider, provider);
    assert.equal(read.workflowDefaults?.primaryModel, `${provider}-historical`);
    const patched = await patchSettings({ updateCheck: false });
    assert.equal(patched.workflowDefaults?.primaryProvider, provider);
    assert.equal(patched.workflowDefaults?.primaryModel, `${provider}-historical`);
    assert.deepEqual(patched.fallbackChains?.reviewer, settings.fallbackChains.reviewer);
    assert.equal(patched.enabledProviders.codex, false);
    assert.equal(patched.textBrightness, 19);
    assert.deepEqual(patched.projects, [cwd]);
    assert.equal(isKnownProvider(provider), false);
    assert.equal((PRIMARY_PROVIDERS as string[]).includes(provider), false);
    assert.match(retiredProviderReason(provider)!, /removed.*preserved.*explicitly/);
    const loaded = await readMeta(cwd, workflowId);
    assert.ok(loaded);
    const config = workflowConfigFromMeta(loaded, cwd);
    assert.equal(config.primaryProvider, provider);
    assert.equal(arcoInternalSessionInfoForMeta(loaded)?.arcoWorkflowId, workflowId);
    assert.throws(() => createProviderProcess('retired-test', { provider: config.primaryProvider } as never), /support has been removed/);
    const replay = await replayEvents(cwd, workflowId, 0);
    assert.equal(replay.length, 1);
    assert.equal(readFileSync(join(folder, 'meta.json'), 'utf8'), metaBytes);
    assert.equal(readFileSync(join(folder, 'events.jsonl'), 'utf8'), events);
    assert.equal(readFileSync(join(folder, 'artifacts', 'answer.md'), 'utf8'), '# Historical artifact\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
