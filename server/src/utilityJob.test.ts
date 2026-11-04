import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sanitizeUtilityAgent, UTILITY_JOB_INPUT_MAX_CHARS, suggestUtilityModel } from '@arco/shared';
import { buildUtilityPrompt, cancelUtilityJob, runUtilityJob, runningUtilityJobs } from './utilityJob.js';
import { claudeAdapter, setEvaluatorAdaptersForTest, EvaluatorRefused, type EvaluatorAdapter, type EvaluatorRequest } from './smartPickupAdapters.js';

const agent = { provider: 'ollama' as const, model: 'small' };
function fake(evaluate: (req: EvaluatorRequest) => Promise<string>, available = true): EvaluatorAdapter {
  return { provider: 'ollama', capability: async () => ({ provider: 'ollama', available }), evaluate };
}

test('agent sanitizer accepts only supported providers and bounded models', () => {
  assert.deepEqual(sanitizeUtilityAgent({ provider: 'cursor', model: ' auto ' }), { provider: 'cursor', model: 'auto' });
  assert.deepEqual(sanitizeUtilityAgent({ provider: 'codex', model: ' gpt-6-luna ' }), { provider: 'codex', model: 'gpt-6-luna' });
  assert.equal(sanitizeUtilityAgent({ provider: 'strata', model: 'x' }), null);
  assert.equal(sanitizeUtilityAgent({ provider: 'claude', model: '' }), null);
  assert.equal(sanitizeUtilityAgent({ provider: 'claude', model: 'x'.repeat(201) }), null);
  assert.equal(sanitizeUtilityAgent(null), null);
  assert.equal(suggestUtilityModel('claude', ['claude-sonnet-5', 'claude-haiku-4-5-20251001']), 'claude-haiku-4-5-20251001');
  assert.equal(suggestUtilityModel('cursor', ['gpt', 'auto']), 'auto');
  assert.equal(suggestUtilityModel('ollama', ['llama']), null);
  assert.equal(suggestUtilityModel('claude', ['claude-sonnet-5']), null);
});

test('prompt keeps facts first and stays within the input limit', () => {
  const small = buildUtilityPrompt([{ label: 'A', value: 'one' }], 'recent text');
  assert.equal(small.truncated, false);
  assert.match(small.prompt, /^Facts:\n- A: one\n\nMaterial:\nrecent text$/);
  const big = buildUtilityPrompt([{ label: 'A', value: 'v'.repeat(900) }], 'm'.repeat(UTILITY_JOB_INPUT_MAX_CHARS * 2));
  assert.equal(big.truncated, true);
  assert.ok(big.prompt.length <= UTILITY_JOB_INPUT_MAX_CHARS);
  assert.ok(big.prompt.startsWith('Facts:'));
  assert.ok(big.facts[0]!.value.length <= 403);
});

test('a job without a utility agent reports not_set and calls nothing', async () => {
  let called = false;
  const restore = setEvaluatorAdaptersForTest({ ollama: fake(async () => { called = true; return 'x'; }) });
  try {
    const r = await runUtilityJob({ jobId: 'job-none-1', instructions: 'i', facts: [], agent: null });
    assert.equal(r.status, 'not_set');
    assert.equal(called, false);
  } finally { restore(); }
});

test('success returns text, the answering model and the facts, with no tools requested', async () => {
  let seen: EvaluatorRequest | undefined;
  const restore = setEvaluatorAdaptersForTest({ ollama: fake(async (req) => { seen = req; return '  Fine.  '; }) });
  try {
    const r = await runUtilityJob({ jobId: 'job-ok-1', instructions: 'Say it.', facts: [{ label: 'State', value: 'idle' }], agent });
    assert.equal(r.status, 'ok');
    assert.equal(r.text, 'Fine.');
    assert.deepEqual(r.agent, agent);
    assert.deepEqual(r.facts, [{ label: 'State', value: 'idle' }]);
    assert.equal(seen?.freeText, true);
    assert.equal(seen?.model, 'small');
    assert.equal(seen?.timeoutMs, 60_000);
    assert.deepEqual(runningUtilityJobs(), []);
  } finally { restore(); }
});

test('cluster brief and tidy use the Claude text beside thinking with room for longer replies', async () => {
  const budgets: number[] = [];
  const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body)); budgets.push(body.max_tokens);
    const text = body.system[1].text === 'cluster' ? Array.from({ length: 6 }, (_, i) => `Member ${i}: working; no pending question.`).join('\n') : 'A clear revised instruction.';
    return new Response(JSON.stringify({ id: 'msg', type: 'message', role: 'assistant', model: 'fixture', content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const adapter = claudeAdapter({ fetchImpl, tokens: async () => ({ accessToken: 'fixture' }), hasCredentials: async () => true });
  const restore = setEvaluatorAdaptersForTest({ claude: adapter });
  const claude = { provider: 'claude' as const, model: 'fixture' };
  try {
    const brief = await runUtilityJob({ jobId: 'brief-six-members', instructions: 'cluster', facts: [], agent: claude });
    const tidy = await runUtilityJob({ jobId: 'tidy-example', instructions: 'tidy', facts: [], material: 'draft', agent: claude });
    assert.equal(brief.status, 'ok'); assert.equal(brief.text?.split('\n').length, 6);
    assert.equal(tidy.status, 'ok'); assert.equal(tidy.text, 'A clear revised instruction.');
    assert.deepEqual(budgets, [2048, 2048]);
  } finally { restore(); }
});

test('timeout, cancel, unavailable and empty answers have their own statuses', async () => {
  const restore = setEvaluatorAdaptersForTest({ ollama: fake(async (req) => {
    if (req.instructions === 'timeout') throw new EvaluatorRefused('timeout');
    if (req.instructions === 'empty') return '   ';
    if (req.instructions === 'slow') return await new Promise<string>((_, reject) => req.signal!.addEventListener('abort', () => reject(new EvaluatorRefused('cancelled'))));
    throw new Error('provider detail with a secret path');
  }) });
  try {
    assert.equal((await runUtilityJob({ jobId: 'job-t-1', instructions: 'timeout', facts: [], agent })).status, 'timeout');
    assert.equal((await runUtilityJob({ jobId: 'job-e-1', instructions: 'empty', facts: [], agent })).reason, 'empty_answer');
    const failed = await runUtilityJob({ jobId: 'job-f-1', instructions: 'x', facts: [], agent });
    assert.equal(failed.status, 'error');
    assert.equal(failed.reason, 'request_failed');
    const pending = runUtilityJob({ jobId: 'job-c-1', instructions: 'slow', facts: [], agent });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(runningUtilityJobs(), ['job-c-1']);
    assert.equal((await runUtilityJob({ jobId: 'job-c-1', instructions: 'slow', facts: [], agent })).reason, 'job_already_running');
    assert.equal(cancelUtilityJob('job-c-1'), true);
    assert.equal((await pending).status, 'cancelled');
    assert.equal(cancelUtilityJob('job-c-1'), false);
  } finally { restore(); }
  const off = setEvaluatorAdaptersForTest({ ollama: fake(async () => 'x', false) });
  try { assert.equal((await runUtilityJob({ jobId: 'job-u-1', instructions: 'x', facts: [], agent })).reason, 'unavailable'); } finally { off(); }
});

test('cancellation during capability discovery does not start a provider request', async () => {
  let release!: () => void, called = false;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const restore = setEvaluatorAdaptersForTest({ ollama: {
    provider: 'ollama', capability: async () => { await wait; return { provider: 'ollama', available: true }; },
    evaluate: async () => { called = true; return 'unexpected'; },
  } });
  try {
    const pending = runUtilityJob({ jobId: 'job-discovery', instructions: 'x', facts: [], agent });
    assert.equal(cancelUtilityJob('job-discovery'), true); release();
    assert.equal((await pending).status, 'cancelled'); assert.equal(called, false);
    assert.equal(cancelUtilityJob('job-discovery'), false);
  } finally { restore(); }
});


test('a response arriving after cancellation is discarded', async () => {
  let release!: (text: string) => void;
  const restore = setEvaluatorAdaptersForTest({ ollama: fake(() => new Promise<string>((resolve) => { release = resolve; })) });
  try {
    const pending = runUtilityJob({ jobId: 'job-late', instructions: 'x', facts: [], agent });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(cancelUtilityJob('job-late'), true); release('late answer');
    const result = await pending; assert.equal(result.status, 'cancelled'); assert.equal(result.text, undefined);
  } finally { restore(); }
});
