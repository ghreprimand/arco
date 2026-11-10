import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkerConfig } from '@arco/shared';
import { getOllamaToolDefinitions, executeOllamaTool, ToolLoopDetector } from './ollamaTools.js';
import { OllamaProvider, ollamaToolCandidates } from './ollama.js';
import { LlamacppProvider } from './llamacpp.js';
import { LmstudioProvider } from './lmstudio.js';
import { StrataProvider } from './strata.js';
import { DeepSeekProvider } from './deepseek.js';
import { subsetOllamaTools } from './ollamaToolSubset.js';

const names = ['list', 'show', 'create', 'claim', 'update', 'heartbeat', 'comment', 'link', 'unlink', 'block', 'complete'].map(n => `cluster_task_${n}`);
const config = { cwd: process.cwd(), workflowId: 'member', clusterId: 'cluster', clusterTaskBoardAttached: true, clusterAccessMode: 'standard' } as WorkerConfig;

test('attached standard members receive all board tools, including under Ollama subsetting', () => {
  const tools = ollamaToolCandidates(config)!;
  for (const name of names) assert.ok(tools.some(t => t.function.name === name), name);
  const subset = subsetOllamaTools({ tools, taskContext: 'Read source code', clusterMember: true });
  for (const name of names) assert.ok(subset.tools.some(t => t.function.name === name), `subset: ${name}`);
  for (const override of [{ clusterTaskBoardAttached: false }, { clusterId: undefined }, { workflowId: undefined }, { clusterAccessMode: 'blind' }, { interactionMode: 'chat' }]) {
    assert.ok(!(ollamaToolCandidates({ ...config, ...override } as WorkerConfig) ?? []).some(t => names.includes(t.function.name)));
  }
  assert.ok(!getOllamaToolDefinitions().some(t => names.includes(t.function.name)));
});

test('board operations use the existing member REST routes and preserve errors', async t => {
  const requests: Array<{ url: URL; init?: RequestInit }> = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: new URL(String(input)), init });
    return new Response(JSON.stringify({ task: 'fixture' }), { status: 200 });
  });
  for (const name of names) {
    const result = await executeOllamaTool(name, { id: 'item', title: 'Task', body: 'Note', summary: 'Ready', reason: 'Waiting', parentId: 'parent', childId: 'child', workflowId: 'spoofed' }, {
      cwd: config.cwd!, workflowId: 'member', clusterId: 'cluster', taskBoardAttached: true, accessMode: 'standard',
    } as Parameters<typeof executeOllamaTool>[2]);
    assert.ok(!result.startsWith('[error]'), `${name}: ${result}`);
    const request = requests.at(-1)!;
    assert.equal(request.url.pathname, `/api/clusters/cluster/peer/${name.replace('cluster_', '').replaceAll('_', '-')}`);
    if (name === 'cluster_task_list' || name === 'cluster_task_show') {
      assert.equal(request.init?.method, 'GET');
      assert.equal(request.url.searchParams.get('workflowId'), 'member');
      if (name.endsWith('show')) assert.equal(request.url.searchParams.get('id'), 'item');
    } else {
      assert.equal(request.init?.method, 'POST');
      assert.equal(JSON.parse(String(request.init?.body)).workflowId, 'member');
    }
  }
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: 'not_owner' }), { status: 403 }));
  assert.match(await executeOllamaTool('cluster_task_complete', { id: 'item', summary: 'Done' }, {
    cwd: config.cwd!, workflowId: 'member', clusterId: 'cluster', taskBoardAttached: true,
  } as Parameters<typeof executeOllamaTool>[2]), /\[error\].*not_owner/);
});

test('every local worker carries board and access gates into dispatch', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; return new Response('{"activeCount":0,"tasks":[]}'); });
  const providers = { ollama: OllamaProvider, llamacpp: LlamacppProvider, lmstudio: LmstudioProvider, strata: StrataProvider, deepseek: DeepSeekProvider };
  for (const [kind, provider] of Object.entries(providers)) {
    for (const extra of [{}, { clusterTaskBoardAttached: false }, { clusterAccessMode: 'blind' }]) {
      const worker = provider.create('member', { ...config, ...extra } as WorkerConfig) as unknown as {
        advertisedTools?: Set<string>;
        dispatchToolCalls(calls: unknown[], auto: boolean, loop: ToolLoopDetector): Promise<Array<{ content: string }>>;
        on(event: string, cb: () => void): void;
      };
      worker.on('error', () => {});
      worker.advertisedTools = new Set(names);
      const call = kind === 'ollama' ? { function: { name: 'cluster_task_list', arguments: {} } }
        : { id: 'call', type: 'function', function: { name: 'cluster_task_list', arguments: '{}' } };
      const before = requests;
      const result = await worker.dispatchToolCalls([call], true, new ToolLoopDetector());
      if (Object.keys(extra).length === 0) {
        assert.equal(requests, before + 1, kind);
        assert.match(result[0].content, /activeCount/);
      } else {
        assert.equal(requests, before, kind);
        assert.match(result[0].content, /board_detached|access_denied|not available|not advertised/, kind);
      }
    }
  }
});
