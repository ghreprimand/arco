import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openAiCompatibleAdapter, requireLoadedLocalModel } from './smartPickupAdapters.js';
import { queueLocalProvider } from './providers/localProviderQueue.js';

const request = { model: 'fixture', instructions: 'Be brief.', prompt: 'Question', timeoutMs: 500, maxOutputTokens: 64, freeText: true };

test('local model checks only read runtime status and refuse unloaded models', async () => {
  const paths: string[] = [];
  const server = createServer((req, res) => {
    paths.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url === '/api/v1/models'
      ? { models: [{ key: 'fixture', loaded_instances: [{ id: 'instance' }] }] }
      : { model: 'fixture', loaded: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  try {
    for (const provider of ['lmstudio', 'strata', 'deepseek'] as const) {
      assert.equal(await requireLoadedLocalModel(provider, base, 'fixture', new AbortController().signal), base);
      await assert.rejects(requireLoadedLocalModel(provider, base, 'other', new AbortController().signal), new RegExp(`model_not_loaded_${provider}`));
    }
    assert.ok(paths.every((path) => path.startsWith('GET ')));
  } finally { server.closeAllConnections(); server.close(); }
});

test('local OpenAI-compatible evaluator is bounded, cancellable and never requests tools', async () => {
  let body: Record<string, unknown> = {};
  let mode = 'ok';
  const server = createServer((req, res) => {
    let raw = ''; req.on('data', (chunk) => raw += chunk); req.on('end', () => {
      body = JSON.parse(raw);
      if (mode === 'hang') return;
      if (mode === 'http') { res.writeHead(503); res.end(); return; }
      if (mode === 'auth') { res.writeHead(401); res.end(); return; }
      if (mode === 'huge') { res.end('x'.repeat(25_000)); return; }
      res.setHeader('content-type', 'application/json');
      if (mode === 'bad') { res.end('{'); return; }
      const message = mode === 'tool' ? { content: null, tool_calls: [{ id: 'tool' }] } : { content: mode === 'nontext' ? [{ type: 'image' }] : mode === 'empty' ? '' : mode === 'long' ? 'x'.repeat(513) : 'OK' };
      res.end(JSON.stringify({ choices: [{ message, finish_reason: mode === 'truncated' ? 'length' : 'stop' }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const adapter = openAiCompatibleAdapter('lmstudio', { base: async () => base, available: async () => true });
  try {
    for (const provider of ['lmstudio', 'llamacpp', 'strata', 'deepseek'] as const) {
      const candidate = openAiCompatibleAdapter(provider, { base: async () => base, available: async () => true });
      assert.deepEqual(await candidate.capability(), { provider, available: true });
      assert.equal(await candidate.evaluate(request), 'OK');
    }
    assert.equal(body.stream, false); assert.equal(body.max_tokens, 64); assert.equal('tools' in body, false);
    for (const [next, reason] of [['tool', 'tool_attempted'], ['empty', 'empty_answer'], ['nontext', 'non_text_answer'], ['long', 'output_too_long'], ['truncated', 'output_too_long'], ['bad', 'unreadable_answer'], ['huge', 'output_too_long'], ['auth', 'not_signed_in'], ['http', 'provider_http_503']] as const) {
      mode = next; await assert.rejects(adapter.evaluate(request), new RegExp(reason));
    }
    mode = 'hang'; await assert.rejects(adapter.evaluate({ ...request, timeoutMs: 30 }), /timeout/);
    const controller = new AbortController(); const pending = adapter.evaluate({ ...request, signal: controller.signal }); controller.abort();
    await assert.rejects(pending, /cancelled/);
  } finally { server.closeAllConnections(); server.close(); }
});

test('a cancelled request waiting for a local slot never reaches the provider', async () => {
  let release!: () => void; let called = false;
  const holding = queueLocalProvider('strata', () => new Promise<void>((resolve) => { release = resolve; }));
  await new Promise((resolve) => setImmediate(resolve));
  const adapter = openAiCompatibleAdapter('strata', { base: async () => { called = true; return 'http://127.0.0.1:1/v1'; }, available: async () => true, run: (work) => queueLocalProvider('strata', work) });
  const controller = new AbortController();
  const pending = adapter.evaluate({ ...request, signal: controller.signal }); controller.abort();
  await assert.rejects(pending, /cancelled/);
  release(); await holding; await new Promise((resolve) => setImmediate(resolve));
  assert.equal(called, false);
});
