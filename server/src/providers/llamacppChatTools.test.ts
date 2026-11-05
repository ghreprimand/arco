import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { WorkerConfig } from '@arco/shared';
import { LlamacppProvider } from './llamacpp.js';
import { defaultRecoveryConfig } from './llamacppRecovery.js';
import { ToolLoopDetector } from './ollamaTools.js';

// A llama.cpp Chat tab, or a plan-review turn in an agent tab, offers the
// model no tools. The XML fallback can still turn `<tool_call>` text in the
// reply into a call; dispatch must refuse it even with AUTO on.

type Call = { id: string; type: 'function'; function: { name: string; arguments: string } };
interface Dispatcher {
  abortController: AbortController | null;
  dispatchToolCalls(calls: Call[], autoMode: boolean, loop: ToolLoopDetector): Promise<Array<{ content: string }>>;
  streamOneTurn(baseUrl: string, model: string, messages: unknown[], tools: undefined, recovery: unknown): Promise<{ assistantMessage: { tool_calls?: Call[] } } | null>;
  on(event: string, fn: (...args: unknown[]) => void): unknown;
}

function worker(cwd: string, extra: Partial<WorkerConfig>): Dispatcher {
  const w = LlamacppProvider.create('fixture', { cwd, skipPermissions: true, workflowId: 'fixture', ...extra } as WorkerConfig) as unknown as Dispatcher;
  w.on('error', () => {});
  return w;
}

const bash = (command: string): Call => ({ id: 'c1', type: 'function', function: { name: 'Bash', arguments: JSON.stringify({ command }) } });

const cases: Array<[string, Partial<WorkerConfig>]> = [
  ['Chat tab', { interactionMode: 'chat', chatWebAccess: false }],
  ['plan-review turn', { interactionMode: 'chat', chatWebAccess: false, disableProviderHooks: true }],
];

for (const [label, extra] of cases) {
  test(`llama.cpp ${label}: a Bash call with AUTO on runs nothing`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'arco-llamacpp-chat-'));
    try {
      const out = await worker(dir, extra).dispatchToolCalls([bash('touch ran.txt')], true, new ToolLoopDetector());
      assert.equal(existsSync(join(dir, 'ran.txt')), false);
      assert.equal(out.length, 1);
      assert.match(out[0].content, /not enabled for this turn/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('llama.cpp Chat tab: an XML tool call in the reply is extracted and still refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arco-llamacpp-chat-'));
  const realFetch = globalThis.fetch;
  const text = '<tool_call><function=Bash><parameter=command>touch ran.txt</parameter></function></tool_call>';
  const sse = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`,
    'data: [DONE]\n\n',
  ].join('');
  globalThis.fetch = (async () => new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })) as typeof fetch;
  try {
    const w = worker(dir, { interactionMode: 'chat', chatWebAccess: false });
    w.abortController = new AbortController();
    const turn = await w.streamOneTurn('http://127.0.0.1:9', 'fixture', [{ role: 'user', content: 'hi' }], undefined, defaultRecoveryConfig());
    const calls = turn?.assistantMessage.tool_calls ?? [];
    assert.equal(calls.length, 1, 'the XML fallback produced the call');
    const out = await w.dispatchToolCalls(calls, true, new ToolLoopDetector());
    assert.equal(existsSync(join(dir, 'ran.txt')), false);
    assert.match(out[0].content, /not enabled for this turn/);
  } finally {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('llama.cpp agent turn with AUTO still runs the call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arco-llamacpp-chat-'));
  try {
    await worker(dir, { interactionMode: 'agent' }).dispatchToolCalls([bash('touch ran.txt')], true, new ToolLoopDetector());
    assert.equal(existsSync(join(dir, 'ran.txt')), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
