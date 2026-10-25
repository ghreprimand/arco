import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { WorkflowState } from '../workflows/types.js';
import { workflows } from '../server/state.js';
import { readConditionContext, restoreConditionContext } from './conditionContext.js';
import { observedWorker, observeConditionMessage, forgetObservedWorker } from './conditionFacts.js';

async function fixture(run: (id: string, wf: WorkflowState, write: (events: object[]) => Promise<void>, cwd: string) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), 'arco-condition-context-')), id = randomUUID();
  const dir = join(cwd, '.arco', 'workflows', id); await mkdir(dir, { recursive: true });
  const write = (events: object[]) => writeFile(join(dir, 'events.jsonl'), events.map((e, i) => JSON.stringify({ workflowId: id, seq: i + 1, ts: Date.now(), ...e })).join('\n') + '\n');
  const wf = { config: { kind: 'workflow', workingDirectory: cwd }, primary: { provider: 'claude', model: 'claude-opus-5-5' }, busy: false } as WorkflowState;
  try { await run(id, wf, write, cwd); } finally { workflows.delete(id); forgetObservedWorker(id); await rm(cwd, { recursive: true, force: true }); }
}

test('restart restores final-request tokens rather than billing totals; absolute tokens need no reported window', async () => fixture(async (id, wf, write) => {
  await write([{ type: 'primary_complete', lastPromptTokens: 300123, modelContextWindow: 1000000, tokens: { input: 9000000 } }]);
  workflows.set(id, wf); await restoreConditionContext(id, wf);
  assert.equal(observedWorker(id).tokens, 300123); assert(Math.abs(observedWorker(id).percent! - 30.0123) < 1e-9);
  await write([{ type: 'primary_complete', lastPromptTokens: 12345 }]);
  assert.deepEqual(await readConditionContext(id, wf), { tokens: 12345, window: null, percent: null });
}));

test('older Codex events recover the current account/session rollout; compaction boundaries refuse old measurements', async () => fixture(async (id, wf, write, cwd) => {
  wf.primary = { provider: 'codex', model: 'gpt-6-luna', effort: 'low' }; wf.primarySessionId = randomUUID(); wf.config.providerAccountRef = 'fixture';
  const home = join(cwd, 'account'), sessions = join(home, 'sessions', '2026', '10', '17'); await mkdir(sessions, { recursive: true });
  await writeFile(join(cwd, '.arco', 'settings.json'), JSON.stringify({ providerAccounts: { codex: [{ id: 'fixture', label: 'Fixture', codexHome: home }] } }));
  await writeFile(join(sessions, `rollout-fixture-${wf.primarySessionId}.jsonl`), JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 333333 }, total_token_usage: { input_tokens: 99999999 }, model_context_window: 828400 } } }) + '\n');
  await write([{ type: 'primary_complete', tokens: { input: 99999999 }, modelContextWindow: 828400 }]);
  assert.equal((await readConditionContext(id, wf))?.tokens, 333333);
  for (const boundary of [{ type: 'ctx_action', action: 'compact' }, { type: 'native_compacted' }, { type: 'context_folded' }, { type: 'handoff_complete' }, { type: 'leaf_move' }]) {
    await write([{ type: 'primary_complete', lastPromptTokens: 800000, modelContextWindow: 828400 }, boundary]);
    assert.equal(await readConditionContext(id, wf), null, boundary.type);
  }
}));

test('missing context stays unknown and private/other-provider history cannot supply a context reading', async () => fixture(async (id, wf, write) => {
  await write([{ type: 'primary_complete', tokens: { input: 500000, cacheRead: 100000 } }]);
  assert.equal(await readConditionContext(id, wf), null);
  await write([{ type: 'primary_complete', lastPromptTokens: 12345, modelContextWindow: 1000000 }, { type: 'primary_turn_token_usage', provider: 'ollama' }]);
  assert.equal(await readConditionContext(id, wf), null);
  wf.config.incognito = true;
  await write([{ type: 'primary_complete', lastPromptTokens: 12345, modelContextWindow: 1000000 }]);
  assert.equal(await readConditionContext(id, wf), null);
}));

test('live measurements fence slow restart reads, including compaction invalidation and removal', async () => fixture(async (id, wf, write) => {
  await write([{ type: 'primary_complete', lastPromptTokens: 800000, modelContextWindow: 1000000 }]); workflows.set(id, wf);
  const pending = restoreConditionContext(id, wf);
  observeConditionMessage(id, 'cluster', { type: 'primary_complete', workflowId: id, lastPromptTokens: 20000, modelContextWindow: 1000000 } as any);
  await pending; assert.equal(observedWorker(id).tokens, 20000);
  forgetObservedWorker(id); const compacting = restoreConditionContext(id, wf);
  observeConditionMessage(id, 'cluster', { type: 'native_compacting', workflowId: id } as any);
  await compacting; assert.equal(observedWorker(id).tokens, null);
  forgetObservedWorker(id); const removed = restoreConditionContext(id, wf); workflows.delete(id);
  await removed; assert.equal(observedWorker(id).tokens, null);
}));
