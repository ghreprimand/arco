// OUTPUT STYLE on every read path: a saved 'lite' (before 0.1.5) reads as
// 'plain', the older 'caveman' as 'terse', an explicit 'normal' is kept, and
// an unset value runs with the default (plain). Covers the settings file, the
// cluster presets and templates files, meta.json (rehydrate and member
// reconstruction), update_primary_config and the per-turn settings.
import { reportCleanupFailure } from './testSupport/cleanupDiagnostics.test-support.js';
import { installIsolatedTestHome } from './testSupport/isolatedHome.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { WorkflowState, Session } from './workflows/types.js';
import type { WebSocket } from 'ws';

const temp = mkdtempSync(join(tmpdir(), 'arco-output-style-read-'));
installIsolatedTestHome(temp);
const { trackRecallFixture } = await import('./testSupport/recallFixture.test-support.js');
const closeRecall = trackRecallFixture();
const shared = await import('@arco/shared');
const { arcoHome } = await import('./arcoHome.js');

after(async () => {
  const { settleProjectWrites } = await import('./testSupport/projectWrites.js');
  await settleProjectWrites();
  await closeRecall();
  try { rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch (error) { try { reportCleanupFailure(temp); } catch { /* diagnostics only */ } throw error; }
});

// [saved value, what a read returns (undefined = unset), what a turn runs with]
const CASES = [
  ['lite', 'plain', 'plain'],
  ['caveman', 'terse', 'terse'],
  ['normal', 'normal', 'normal'],
  ['plain', 'plain', 'plain'],
  ['terse', 'terse', 'terse'],
  [undefined, undefined, 'plain'],
  ['loud', undefined, 'plain'],
] as const;

test('the shared helpers: one default, legacy values aliased, the default stored as unset', () => {
  assert.equal(shared.DEFAULT_OUTPUT_STYLE, 'plain');
  assert.deepEqual(shared.OUTPUT_STYLES, ['normal', 'plain', 'terse']);
  for (const [saved, read, runs] of CASES) {
    assert.equal(shared.normalizeOutputStyle(saved), read, String(saved));
    assert.equal(shared.resolveOutputStyle(saved), runs, String(saved));
  }
  assert.equal(shared.storedOutputStyle('plain'), undefined);
  assert.equal(shared.storedOutputStyle('lite'), undefined);
  assert.equal(shared.storedOutputStyle('normal'), 'normal');
  assert.equal(shared.storedOutputStyle('caveman'), 'terse');
});

test('settings file: New-tab defaults', async () => {
  const { readSettings } = await import('./settings.js');
  mkdirSync(arcoHome(), { recursive: true });
  for (const [saved, read] of CASES) {
    writeFileSync(join(arcoHome(), 'settings.json'), JSON.stringify({ workflowDefaults: { primaryEffort: 'low', ...(saved ? { outputStyle: saved } : {}) } }));
    const s = await readSettings();
    assert.equal(s.workflowDefaults?.outputStyle, read, String(saved));
    assert.equal(s.workflowDefaults?.primaryEffort, 'low', 'other settings are kept');
  }
});

test('cluster presets and templates files', async () => {
  const { listPresets } = await import('./clusterPresets.js');
  const { listTemplates } = await import('./templates/store.js');
  const member = (outputStyle: unknown) => ({ provider: 'claude', model: 'sonnet', effort: 'high', ...(outputStyle ? { outputStyle } : {}) });
  writeFileSync(join(arcoHome(), 'cluster-presets.json'), JSON.stringify({ version: 1, presets: [{ id: 'p', name: 'P', createdAt: '2026-01-01', members: CASES.map(([saved]) => member(saved)) }] }));
  writeFileSync(join(arcoHome(), 'templates.json'), JSON.stringify({ version: 1, templates: CASES.map(([saved], i) => ({ id: `t${i}`, name: `T${i}`, createdAt: `2026-01-0${i + 1}`, config: { primaryModel: 'sonnet', ...(saved ? { outputStyle: saved } : {}) } })) }));
  const [preset] = await listPresets();
  assert.deepEqual(preset.members.map((m) => m.outputStyle), CASES.map(([, read]) => read));
  assert.ok(preset.members.every((m) => m.model === 'sonnet'), 'other member settings are kept');
  const templates = (await listTemplates()).sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(templates.map((t) => t.config.outputStyle), CASES.map(([, read]) => read));
  assert.ok(templates.every((t) => t.config.primaryModel === 'sonnet'), 'other template settings are kept');
});

test('meta.json: member reconstruction, update_primary_config and the turn settings', async () => {
  const { writeMeta, readMeta, workflowConfigFromMeta } = await import('./workflowMeta.js');
  const { handleUpdatePrimaryConfig } = await import('./ws/updatePrimaryConfig.js');
  const { resolveTurnSettings } = await import('./ws/turnSettings.js');
  const { workflows } = await import('./server/state.js');
  const cwd = join(temp, 'project');
  mkdirSync(cwd, { recursive: true });
  const base = { name: 'fixture', cwd, kind: 'chat', createdAt: 1, lastActiveAt: 1, primaryProvider: 'cursor', primaryModel: 'auto', cliSessions: [] };
  for (const [saved, read, runs] of CASES) {
    const id = randomUUID();
    await writeMeta(cwd, { ...base, workflowId: id, ...(saved ? { outputStyle: saved } : {}) } as never);
    const config = workflowConfigFromMeta((await readMeta(cwd, id))!, cwd);
    assert.equal(config.outputStyle, read, String(saved));
    assert.equal(config.primaryModel, 'auto');
    for (const provider of ['claude', 'codex', 'cursor', 'ollama', 'llamacpp', 'lmstudio']) {
      assert.equal(resolveTurnSettings({ provider, config, cascade: null, isolatedMember: false }).outputStyle, runs, `${provider} ${String(saved)}`);
    }
  }
  // A stale client's 'lite' means 'plain'; an explicit 'normal' is kept; an unknown value changes nothing.
  const id = randomUUID();
  const ws = { readyState: 1, send: () => {} } as unknown as WebSocket;
  const wf = { config: { name: 'fixture', workingDirectory: cwd }, primary: { provider: 'cursor', model: 'auto', effort: 'high' }, observers: new Set([ws]), bootMaterialized: true } as unknown as WorkflowState;
  workflows.set(id, wf);
  try {
    await writeMeta(cwd, { ...base, workflowId: id } as never);
    const update = (outputStyle: unknown) => handleUpdatePrimaryConfig(ws, {} as Session, { type: 'update_primary_config', workflowId: id, outputStyle } as never);
    await update('terse');
    assert.equal((await readMeta(cwd, id))?.outputStyle, 'terse');
    // The default is written as unset, so 0.1.4 never reads 'plain'.
    await update('lite');
    assert.equal(wf.config.outputStyle, 'plain');
    assert.equal((await readMeta(cwd, id))?.outputStyle, undefined);
    assert.equal(resolveTurnSettings({ provider: 'cursor', config: workflowConfigFromMeta((await readMeta(cwd, id))!, cwd), cascade: null, isolatedMember: false }).outputStyle, 'plain');
    await update('normal');
    assert.equal(wf.config.outputStyle, 'normal');
    assert.equal((await readMeta(cwd, id))?.outputStyle, 'normal');
    await update('loud');
    assert.equal(wf.config.outputStyle, 'normal');
    assert.equal((await readMeta(cwd, id))?.outputStyle, 'normal');
    assert.equal((await readMeta(cwd, id))?.primaryModel, 'auto', 'other settings are kept');
  } finally { workflows.delete(id); }
});
