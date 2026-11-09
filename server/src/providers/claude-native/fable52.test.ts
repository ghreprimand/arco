import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installIsolatedTestHome } from '../../testSupport/isolatedHome.js';
import { CLAUDE_MODELS, CLAUDE_MODEL_LABELS, CLAUDE_MODEL_EFFORTS, enforcesPreservedThinking, supportsThinkingDisplayUpdates } from '@arco/shared';
import { buildThinkingParams, lookupCtx, shortTextRequestParams } from './modelParams.js';
import { nativeContextEstimate } from '../../contextEstimator.js';
import { supportsServerFold } from './serverFold.js';
import { CLAUDE_CLI_VERSION } from './wireFingerprint.js';

const home = mkdtempSync(join(tmpdir(), 'arco-fable-compat-'));
installIsolatedTestHome(home);
const { ClaudeNativeWorker } = await import('./worker.js');
const { claudeAdapter } = await import('../../smartPickupAdapters.js');
const { saveTokens } = await import('./auth.js');
const { getCatalog } = await import('./catalog.js');
after(() => rmSync(home, { recursive: true, force: true }));

for (const family of ['fable', 'mythos']) test(`${family} point releases bind thinking; bare 5 does not`, () => {
  for (const suffix of ['1', '2', '2-20261109', '3', '10']) {
    const model = `claude-${family}-5-${suffix}`;
    assert.equal(enforcesPreservedThinking(model), true, model);
    assert.equal(supportsThinkingDisplayUpdates(model), true, model);
    assert.deepEqual(buildThinkingParams(model, 'high', 'updates'), buildThinkingParams('claude-fable-5-1', 'high', 'updates'));
    assert.equal(lookupCtx(model), 1_000_000);
    assert.equal(nativeContextEstimate(model, 100)?.windowSize, 1_000_000);
    assert.equal(supportsServerFold(model), true);
  }
  assert.equal(enforcesPreservedThinking(`claude-${family}-5`), false);
  assert.equal(enforcesPreservedThinking(`claude-${family}-5-0`), false);
  assert.equal('block_binding' in (buildThinkingParams(`claude-${family}-5`, 'high').thinking as object), false);
});

test('Fable 5.2 leads its picker group and both 5.2 models have all five efforts', () => {
  assert.equal(CLAUDE_MODELS.filter(m => m.includes('fable'))[0], 'claude-fable-5-2');
  assert.equal(CLAUDE_MODEL_LABELS['claude-fable-5-2'], 'FABLE 5.2');
  for (const model of ['claude-fable-5-2', 'claude-mythos-5-2']) {
    assert.deepEqual(CLAUDE_MODEL_EFFORTS[model], ['low', 'medium', 'high', 'xhigh', 'max']);
  }
});

async function captureRound(model: string) {
  const worker: any = new ClaudeNativeWorker({ workflowId: 'fixture-compat', config: { cwd: home, model, effort: 'high', claudeNativeThinkingDisplay: 'updates' } });
  let body: any, options: any;
  worker.messages = [{ role: 'user', content: 'Synthetic task' }];
  worker.workflowEventBroadcast = () => {};
  worker.on('error', (error: unknown) => { throw Error(String(error)); });
  worker.client = { messages: { create: async (request: unknown, opts: unknown) => {
    body = request; options = opts;
    return (async function* () {
      yield { type: 'message_start', message: { model, usage: { input_tokens: 100, output_tokens: 0 } } };
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Fixture answer' } };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } };
      yield { type: 'message_stop' };
    })();
  } } };
  try {
    assert.equal((await worker.streamOneRound()).text, 'Fixture answer');
    return { body, beta: options.headers['anthropic-beta'], headers: worker.buildDefaultHeaders() };
  } finally { await worker.dispose(); }
}

test('5.2 Native round uses the 5.1 request and current shared wire version', async () => {
  const prior = await captureRound('claude-fable-5-1');
  for (const model of ['claude-fable-5-2', 'claude-mythos-5-2']) {
    const current = await captureRound(model);
    assert.deepEqual({ ...current.body, model: prior.body.model }, prior.body);
    assert.equal(current.beta, prior.beta);
    assert.match(current.beta, /thinking.*binding/);
    assert.equal(current.headers['user-agent'], 'claude-cli/2.1.319');
    assert.equal(current.body.max_tokens, 128_000);
  }
  assert.equal(CLAUDE_CLI_VERSION, '2.1.319');
});

test('catalog requests use the same current wire version', async t => {
  await saveTokens({ accessToken: 'fixture-access', refreshToken: 'fixture-refresh', expiresAt: Date.now() + 3600000, obtainedAt: 1, tokenType: 'Bearer', scope: 'fixture' });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url: any, init: any) => {
    calls++;
    assert.match(String(url), /\/v1\/models\?/);
    assert.equal(new Headers(init.headers).get('user-agent'), 'claude-cli/2.1.319');
    return Response.json({ data: [] });
  });
  assert.equal((await getCatalog(true)).fresh, true);
  assert.equal(calls, 1);
});

for (const model of ['claude-fable-5-2', 'claude-mythos-5-2']) test(`${model} short utility and summary requests leave room for text`, async () => {
  const sent: any[] = [];
  let answer = 'Fixture answer';
  const adapter = claudeAdapter({ tokens: async () => ({ accessToken: 'fixture-access' }), fetchImpl: (async (_url: unknown, init: any) => {
    const body = JSON.parse(String(init.body)); sent.push(body);
    // Synthetic provider spends the small default cap on reasoning, unless
    // the caller explicitly lowers effort and reserves reasoning headroom.
    const ready = body.output_config?.effort === 'low' && body.max_tokens >= 8256;
    return Response.json({ id: 'fixture', type: 'message', role: 'assistant', model, content: ready ? [{ type: 'text', text: answer }] : [{ type: 'thinking', thinking: 'Fixture reasoning' }], stop_reason: ready ? 'end_turn' : 'max_tokens', usage: { input_tokens: 1, output_tokens: 1 } });
  }) as typeof fetch });
  assert.equal(await adapter.evaluate({ model, prompt: 'Fixture', instructions: 'Answer directly without deliberating.', maxOutputTokens: 64, timeoutMs: 1000 }), 'Fixture answer');
  assert.equal(sent[0].output_config.effort, 'low');
  assert.equal('tools' in sent[0], false);
  answer = 'x'.repeat(513);
  await assert.rejects(adapter.evaluate({ model, prompt: 'Fixture', instructions: 'Short answer', maxOutputTokens: 64, timeoutMs: 1000 }), /output_too_long/);
  const worker: any = new ClaudeNativeWorker({ workflowId: 'fixture-summary', config: { cwd: home, model, effort: 'max' } });
  worker.client = { messages: { create: async (body: any) => {
    assert.equal(body.output_config.effort, 'low');
    assert.equal(body.max_tokens, 16_384);
    return (async function* () { yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Fixture summary' } }; })();
  } } };
  try { assert.equal(await worker.generateCompactSummary([{ role: 'user', content: 'Fixture history' }]), 'Fixture summary'); }
  finally { await worker.dispose(); }
});

test('5.2 summary splitting reserves the larger response cap and carried summary', async () => {
  const worker: any = new ClaudeNativeWorker({ workflowId: 'fixture-budget', config: { cwd: home, model: 'claude-fable-5-2', effort: 'high' } });
  const requests: any[] = [];
  worker.client = { messages: { create: async (body: any) => {
    requests.push(body);
    return (async function* () { yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Carried summary' } }; })();
  } } };
  try {
    assert.equal(await worker.summarizeInParts([{ role: 'user', content: 'u'.repeat(1500000) }, { role: 'assistant', content: 'a'.repeat(1500000) }]), 'Carried summary');
    assert.equal(requests.length, 2);
    for (const body of requests) {
      const inputTokens = body.messages.reduce((total: number, message: any) => total + Math.ceil(String(message.content).length / 3), 0);
      assert.ok(inputTokens + body.max_tokens < 1_000_000);
      assert.equal(body.max_tokens, 16384);
    }
    assert.match(String(requests[1].messages[0].content), /Carried summary/);
  } finally { await worker.dispose(); }
});

test('dated bare 5 models keep bare capabilities and short-request parameters', () => {
  for (const family of ['fable', 'mythos']) {
    const bare = `claude-${family}-5`;
    const dated = `${bare}-20260609`;
    assert.equal(enforcesPreservedThinking(dated), false, dated);
    assert.equal(supportsThinkingDisplayUpdates(dated), supportsThinkingDisplayUpdates(bare));
    assert.deepEqual(buildThinkingParams(dated, 'high', 'updates'), buildThinkingParams(bare, 'high', 'updates'));
    assert.deepEqual(shortTextRequestParams(dated, 64), { max_tokens: 64 });
    for (const suffix of ['1-20260901', '2-20261109', '10-20261109', '99']) {
      const point = `${bare}-${suffix}`;
      assert.equal(enforcesPreservedThinking(point), true, point);
      assert.equal(supportsThinkingDisplayUpdates(point), true, point);
      assert.deepEqual(shortTextRequestParams(point, 64), suffix.startsWith('1-') ? { max_tokens: 64 } : { max_tokens: 8256, output_config: { effort: 'low' } });
    }
  }
});
