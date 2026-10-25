import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WorkflowMeta } from '../workflowMeta.js';
import { cleanModelTitle, maybeGenerateModelTitle, type ModelTitleDeps } from './modelTitles.js';
import { readSessionIndex, readTitleEvents, renameSession, upsertSessionIndexFromMeta } from './sessionIndex.js';
import { resolveUtilityConfig } from '../providers/ollamaUtility.js';

function makeMeta(cwd: string, workflowId: string): WorkflowMeta {
  return {
    workflowId,
    name: workflowId,
    cwd,
    createdAt: 1_000,
    lastActiveAt: 2_000,
    primaryProvider: 'ollama',
    primaryModel: 'qwen3.8:27b' as WorkflowMeta['primaryModel'],
    primaryEffort: 'medium' as WorkflowMeta['primaryEffort'],
    cliSessions: [{ provider: 'ollama', sessionId: `sess-${workflowId}`, createdAt: 1_000 }],
    operator: 'test',
    lastEventSeq: 3,
    lastTranscriptSeq: null,
    compactedAt: null,
  } as WorkflowMeta;
}

async function seeded(messages: string[]): Promise<{ cwd: string; meta: WorkflowMeta }> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'archon-model-titles-'));
  const meta = makeMeta(cwd, 'wf-title001');
  const dir = path.join(cwd, '.archon', 'workflows', meta.workflowId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta), 'utf8');
  const lines = messages.map((content, i) => JSON.stringify({ seq: i + 1, type: 'user_message_echo', content }));
  await fs.writeFile(path.join(dir, 'events.jsonl'), lines.join('\n') + '\n', 'utf8');
  await upsertSessionIndexFromMeta(meta);
  return { cwd, meta };
}

function deps(opts: { titles?: boolean; reply?: string; ok?: boolean; enabled?: boolean }): ModelTitleDeps & { calls: number; notices: string[]; prompts: string[] } {
  const d = {
    calls: 0,
    notices: [] as string[],
    prompts: [] as string[],
    readSettings: async () => ({ ollama: { utility: { model: 'qwen3.5:4b', baseUrl: 'http://tank:11434', titles: opts.titles, enabled: opts.enabled } } }),
    runUtilityJob: (async (input: { prompt?: string; onNotice?: (l: string) => void }) => {
      d.calls++;
      d.prompts.push(input.prompt ?? '');
      input.onNotice?.('[utility] session-title · qwen3.5:4b');
      return opts.ok === false
        ? { ok: false, reason: 'error' }
        : { ok: true, text: opts.reply ?? 'Fix Ollama context window', model: 'qwen3.5:4b', backend: 'tank', inputTokens: 50, outputTokens: 6 };
    }) as unknown as ModelTitleDeps['runUtilityJob'],
    notify: (_wfid: string, line: string) => { d.notices.push(line); },
  };
  return d;
}

test('cleanModelTitle strips small-model noise', () => {
  assert.equal(cleanModelTitle('Title: "Fix Ollama Context Window."'), 'Fix Ollama Context Window');
  assert.equal(cleanModelTitle('\n\n**Wire utility titles**\nextra'), 'Wire utility titles');
  assert.equal(cleanModelTitle('# JWT auth migration'), 'JWT auth migration');
  assert.equal(cleanModelTitle('   '), null);
  assert.equal(cleanModelTitle('x'.repeat(150)), null);
});

test('flag off → no model call (arming the utility model alone does not arm titles)', async () => {
  const { meta } = await seeded(['Fix the num_ctx clamp for stock models']);
  const d = deps({ titles: undefined });
  assert.equal(await maybeGenerateModelTitle(meta, d), 'skipped');
  assert.equal(d.calls, 0);
});

test('flag on → one bounded call, title applied + logged, notice visible', async () => {
  const { cwd, meta } = await seeded(['continue', 'Fix the num_ctx clamp for stock models', 'and add tests']);
  const d = deps({ titles: true, reply: 'Title: Fix stock-model num_ctx clamp.' });
  assert.equal(await maybeGenerateModelTitle(meta, d), 'applied');
  assert.equal(d.calls, 1);
  assert.ok(d.prompts[0].includes('Fix the num_ctx clamp for stock models'));
  assert.equal(d.notices.length, 1);
  const entry = (await readSessionIndex(cwd)).entries.find((e) => e.workflowId === meta.workflowId)!;
  assert.equal(entry.title, 'Fix stock-model num_ctx clamp');
  assert.equal(entry.titleSource, 'model');
  assert.equal((await readTitleEvents(cwd)).length, 1);

  // One-shot: a later turn doesn't regenerate.
  assert.equal(await maybeGenerateModelTitle(meta, d), 'skipped');
  assert.equal(d.calls, 1);
});

test('operator rename outranks — no call', async () => {
  const { cwd, meta } = await seeded(['Fix the num_ctx clamp for stock models']);
  const r = await renameSession(cwd, { provider: 'ollama', sessionId: `sess-${meta.workflowId}` }, 'My own name');
  assert.ok(r, 'rename landed');
  const d = deps({ titles: true });
  assert.equal(await maybeGenerateModelTitle(meta, d), 'skipped');
  assert.equal(d.calls, 0);
});

test('utility failure → derived title untouched (fail-soft)', async () => {
  const { cwd, meta } = await seeded(['Fix the num_ctx clamp for stock models']);
  const d = deps({ titles: true, ok: false });
  assert.equal(await maybeGenerateModelTitle(meta, d), 'failed');
  const entry = (await readSessionIndex(cwd)).entries.find((e) => e.workflowId === meta.workflowId)!;
  assert.equal(entry.title, 'Fix the num_ctx clamp for stock models');
  assert.equal(entry.titleSource, 'deterministic');
});

test('paused utility (enabled:false) → unconfigured for every caller, titles skip', async () => {
  const cfg = { model: 'qwen3.5:4b', baseUrl: 'http://tank:11434' };
  assert.deepEqual(resolveUtilityConfig({ utility: cfg }), cfg);
  assert.equal(resolveUtilityConfig({ utility: { ...cfg, enabled: false } }), null);
  // Absent = enabled (pre-existing configs keep working).
  assert.notEqual(resolveUtilityConfig({ utility: { ...cfg, enabled: undefined } }), null);

  const { meta } = await seeded(['Fix the num_ctx clamp for stock models']);
  const d = deps({ titles: true, enabled: false });
  assert.equal(await maybeGenerateModelTitle(meta, d), 'skipped');
  assert.equal(d.calls, 0);
});
