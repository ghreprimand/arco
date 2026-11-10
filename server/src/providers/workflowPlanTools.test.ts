import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';
import type { WorkerConfig } from '@arco/shared';
const home = realpathSync(mkdtempSync(join(tmpdir(), 'arco-plan-tools-')));
installIsolatedTestHome(home);
after(() => rmSync(home, { recursive: true, force: true }));
const { ClaudeNativeWorker } = await import('./claude-native/worker.js');
const { ollamaToolCandidates } = await import('./ollama.js');
const { executeOllamaTool } = await import('./ollamaTools.js');
const { subsetOllamaTools } = await import('./ollamaToolSubset.js');
const names = ['plan_create', 'plan_attach', 'plan_list', 'plan_ref_write', 'plan_ref_list', 'plan_ref_read'];
const config = { cwd: home, workflowId: 'member', model: 'fixture', effort: 'low', skipPermissions: true } as WorkerConfig;
function native(extra: Record<string, unknown> = {}) {
  const worker = new ClaudeNativeWorker({ workflowId: 'member', config: { ...config, ...extra } }) as any;
  worker.workflowEventBroadcast = () => {};
  worker.runHooks = async () => ({ blocks: [], context: [], systemMessages: [], notices: [], rewrites: [] });
  return worker;
}

test('Native and local Agent tabs announce all six workflow plan tools with cwd and identity', async () => {
  const worker = native();
  try {
    const definitions = worker.buildToolDefs();
    const local = ollamaToolCandidates(config)!;
    const subset = subsetOllamaTools({ tools: local, taskContext: 'Create a project plan' });
    for (const name of names) {
      assert.ok(definitions.some((t: any) => t.name === name), `Native ${name}`);
      assert.ok(local.some(t => t.function.name === name), `local ${name}`);
      assert.ok(subset.tools.some(t => t.function.name === name), `subset ${name}`);
    }
    for (const override of [{ cwd: undefined }, { workflowId: undefined }, { interactionMode: 'chat' }]) {
      assert.ok(!(ollamaToolCandidates({ ...config, ...override } as WorkerConfig) ?? []).some(t => names.includes(t.function.name)));
    }
  } finally { await worker.dispose(); }
  for (const extra of [{ cwd: undefined }, { interactionMode: 'chat' }, { clusterAccessMode: 'isolated' }]) {
    const denied = native(extra);
    try { assert.ok(!denied.buildToolDefs().some((t: any) => names.includes(t.name))); }
    finally { await denied.dispose(); }
  }
});

test('Ollama guarantees plan tools only for plan tasks or authoring turns', () => {
  const tools = ollamaToolCandidates(config)!;
  const ordinary = subsetOllamaTools({ tools, taskContext: 'Read source code with Read Grep Glob Bash Edit Write' });
  assert.equal(ordinary.cap, 9);
  assert.ok(!names.every(name => ordinary.kept.includes(name)));
  for (const input of [{ taskContext: 'Write the release plan' }, { taskContext: 'Read source code', planAuthoring: true }]) {
    const result = subsetOllamaTools({ tools, ...input });
    assert.equal(result.cap, 15);
    for (const name of names) assert.ok(result.kept.includes(name), name);
  }
});

test('Native and local plan execution shares routes, caller identity and validation', async t => {
  const requests: Array<{ url: URL; init?: RequestInit }> = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: new URL(String(input)), init });
    return new Response(JSON.stringify({ ok: true, plan: { id: 'plan', title: 'Fixture' }, plans: [], refs: [], ref: { title: 'Spec', body: 'Read this first' }, created: true }));
  });
  const cases: Array<[string, Record<string, unknown>]> = [
    ['plan_create', { title: 'Fixture', body: '### Phase\n- [ ] Task', workflowId: 'spoofed' }],
    ['plan_attach', { planId: 'plan' }], ['plan_list', {}],
    ['plan_ref_write', { planId: 'plan', slug: 'spec', body: '# Spec' }],
    ['plan_ref_list', { planId: 'plan' }], ['plan_ref_read', { planId: 'plan', slug: 'spec' }],
  ];
  const worker = native();
  try {
    for (const [name, input] of cases) {
      const local = await executeOllamaTool(name, input, { cwd: home, workflowId: 'member' });
      const localRequest = requests.at(-1);
      const result = await worker.dispatchTool({ id: name, name, input });
      assert.equal(result.isError, false, result.text);
      assert.equal(result.text, local, name);
      assert.deepEqual(requests.at(-1), localRequest, name);
      assert.equal(requests.at(-1)!.url.searchParams.get('path'), home);
      if (name === 'plan_create') assert.equal(JSON.parse(String(requests.at(-1)!.init?.body)).workflowId, 'member');
    }
    const count = requests.length;
    for (const [name, input] of [['plan_create', { title: 'Bad', body: 'No tasks' }], ['plan_ref_read', { planId: 'plan', slug: '../escape' }]] as const) {
      assert.match(await executeOllamaTool(name, input, { cwd: home, workflowId: 'member' }), /\[error\]/);
      assert.equal((await worker.dispatchTool({ id: name + '-invalid', name, input })).isError, true);
    }
    assert.equal(requests.length, count, 'invalid requests never reach REST');
    assert.match(await executeOllamaTool('plan_list', {}, { cwd: home }), /\[error\]/);
    assert.equal(requests.length, count);
  } finally { await worker.dispose(); }
});

test('MCP still exposes the same six schemas and executes the shared handlers', async t => {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { registerPlanTools } = await import('../mcp/planMcpTools.js');
  const server = new McpServer({ name: 'fixture', version: '1' });
  const client = new Client({ name: 'fixture', version: '1' });
  registerPlanTools(server, { cwd: home, workflowId: 'member', arcoPort: 1 });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.mock.method(globalThis, 'fetch', async () => new Response('{"plans":[{"id":"fixture"}]}'));
  try {
    assert.deepEqual((await client.listTools()).tools.map(t => t.name).sort(), [...names].sort());
    const result = await client.callTool({ name: 'plan_list', arguments: {} });
    assert.match(JSON.stringify(result), /fixture/);
    const invalid = await client.callTool({ name: 'plan_ref_read', arguments: { planId: 'plan', slug: '../escape' } });
    assert.equal(invalid.isError, true);
  } finally { await client.close(); await server.close(); }
});

test('all local worker dispatchers execute workflow plan tools in AUTO mode', async t => {
  const { OllamaProvider } = await import('./ollama.js');
  const { LlamacppProvider } = await import('./llamacpp.js');
  const { LmstudioProvider } = await import('./lmstudio.js');
  const { StrataProvider } = await import('./strata.js');
  const { DeepSeekProvider } = await import('./deepseek.js');
  const { ToolLoopDetector } = await import('./ollamaTools.js');
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; return new Response('{"plans":[{"id":"fixture"}]}'); });
  for (const [name, provider] of Object.entries({ ollama: OllamaProvider, llamacpp: LlamacppProvider, lmstudio: LmstudioProvider, strata: StrataProvider, deepseek: DeepSeekProvider })) {
    const worker = provider.create('member', config) as any;
    worker.on('error', () => {});
    worker.advertisedTools = new Set(names);
    const call = { id: 'call', type: 'function', function: { name: 'plan_list', arguments: name === 'ollama' ? {} : '{}' } };
    const before = requests;
    const result = await worker.dispatchToolCalls([call], true, new ToolLoopDetector());
    assert.equal(requests, before + 1, name);
    assert.match(result[0].content, /fixture/, name);
    const safe = await worker.dispatchToolCalls([call], false, new ToolLoopDetector());
    assert.match(safe[0].content, /SAFE/);
    assert.equal(requests, before + 1, 'SAFE must not execute');
  }
});
