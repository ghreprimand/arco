import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkerConfig } from '@arco/shared';

test('an isolated Cursor member runs the fenced print transport and reads its stream-json events', async () => {
  const { createProviderProcess } = await import('../index.js');
  const config = { provider: 'cursor', model: 'auto', clusterAccessMode: 'isolated', clusterId: 'cluster-1', workflowId: 'member-1' } as unknown as WorkerConfig;
  const proc = createProviderProcess('worker-1', config);
  // Never the long-lived ACP worker, which ignores Cursor's sandbox.
  assert.equal(proc.constructor.name, 'CursorIsolatedProcess');
  assert.notEqual(createProviderProcess('worker-2', { ...config, clusterAccessMode: 'standard' } as WorkerConfig).constructor.name, 'CursorIsolatedProcess');

  const events: Array<[string, unknown]> = [];
  for (const name of ['init', 'text', 'thinking', 'tool_use', 'result', 'error']) proc.on(name, (data: unknown) => events.push([name, data]));
  let withdrawn = 0;
  (proc as unknown as { withdrawPass: () => Promise<void> }).withdrawPass = async () => { withdrawn++; };
  const feed = (event: unknown) => (proc as unknown as { onLine(line: string): void }).onLine(JSON.stringify(event));
  feed({ type: 'system', subtype: 'init', session_id: 'chat-1', model: 'Auto' });
  feed({ type: 'thinking', subtype: 'delta', text: 'hm' });
  feed({ type: 'tool_call', subtype: 'started', call_id: 'c1', tool_call: { shellToolCall: { args: { command: 'ls' } } } });
  feed({ type: 'tool_call', subtype: 'completed', call_id: 'c1', tool_call: { shellToolCall: { args: { command: 'ls' }, result: { rejected: { reason: 'User Rejected' } } } } });
  feed({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'READY' }] } });
  feed({ type: 'result', subtype: 'success', is_error: false, result: 'READY', duration_ms: 12, usage: { inputTokens: 9, outputTokens: 2, cacheReadTokens: 1 } });
  assert.deepEqual(events.map(([name]) => name), ['init', 'thinking', 'tool_use', 'tool_use', 'text', 'result']);
  assert.deepEqual(events[0][1], { model: 'Auto', sessionId: 'chat-1' });
  // The sign-in is withdrawn when the agent reports its start, before any tool runs.
  assert.equal(withdrawn, 1);
  assert.deepEqual(events[2][1], { id: 'c1', name: 'Shell', input: '{"command":"ls"}', status: 'started', provider: 'cursor' });
  assert.equal((events[3][1] as { status: string }).status, 'failed');
  assert.deepEqual(events[5][1], { text: 'READY', costUsd: 0, durationMs: 12, usage: { input_tokens: 9, output_tokens: 2, cache_read_input_tokens: 1 }, thinkingBytes: 0, toolResultBytes: -1, toolResultBytesRaw: -1 });
  assert.equal(proc.status, 'completed');
});
