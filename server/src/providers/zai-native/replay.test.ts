import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ZaiNativeHistoryMessage } from '@archon/shared';
import { replayZaiNativeMessages, zaiCompactSummarySeed } from './worker.js';

test('Z.ai native replay preserves reasoning_content byte-for-byte', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'archon-zai-replay-'));
  const workflowId = 'wf-zai-replay';
  const dir = path.join(cwd, '.archon', 'workflows', workflowId);
  await mkdir(dir, { recursive: true });
  const reasoning = 'think\nexactly: {"a":1}\n\u2603';
  const event = {
    seq: 1,
    ts: Date.now(),
    type: 'zai_native_history',
    workflowId,
    messages: [
      { role: 'user', content: 'inspect' },
      {
        role: 'assistant',
        content: '',
        reasoning_content: reasoning,
        tool_calls: [{
          id: 'call_read',
          type: 'function',
          function: { name: 'Read', arguments: '{"file_path":"a.ts"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call_read', content: 'file body' },
      { role: 'assistant', content: 'done', reasoning_content: 'final-think' },
    ],
  };
  await writeFile(path.join(dir, 'events.jsonl'), JSON.stringify(event) + '\n', 'utf8');

  const messages = await replayZaiNativeMessages(cwd, workflowId);
  assert.equal(messages[1]?.reasoning_content, reasoning);
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);
});

test('Z.ai native replay prunes dangling assistant tool calls', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'archon-zai-replay-'));
  const workflowId = 'wf-zai-orphan';
  const dir = path.join(cwd, '.archon', 'workflows', workflowId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'events.jsonl'), JSON.stringify({
    seq: 1,
    ts: Date.now(),
    type: 'zai_native_history',
    workflowId,
    messages: [
      { role: 'user', content: 'inspect' },
      {
        role: 'assistant',
        content: '',
        reasoning_content: 'partial',
        tool_calls: [{
          id: 'dangling',
          type: 'function',
          function: { name: 'Read', arguments: '{"file_path":"a.ts"}' },
        }],
      },
    ],
  }) + '\n', 'utf8');

  const messages = await replayZaiNativeMessages(cwd, workflowId);
  assert.deepEqual(messages, [{ role: 'user', content: 'inspect' }]);
});

test('Z.ai native replay preserves complete multi-tool rounds', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'archon-zai-replay-'));
  const workflowId = 'wf-zai-multi';
  const dir = path.join(cwd, '.archon', 'workflows', workflowId);
  await mkdir(dir, { recursive: true });
  const event = {
    seq: 1,
    ts: Date.now(),
    type: 'zai_native_history',
    workflowId,
    messages: [
      { role: 'user', content: 'inspect both' },
      {
        role: 'assistant',
        content: '',
        reasoning_content: 'need two reads',
        tool_calls: [
          { id: 'call_a', type: 'function', function: { name: 'Read', arguments: '{"file_path":"a.ts"}' } },
          { id: 'call_b', type: 'function', function: { name: 'Read', arguments: '{"file_path":"b.ts"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_a', content: 'a' },
      { role: 'tool', tool_call_id: 'call_b', content: 'b' },
      { role: 'assistant', content: 'done' },
    ],
  };
  await writeFile(path.join(dir, 'events.jsonl'), JSON.stringify(event) + '\n', 'utf8');

  const messages = await replayZaiNativeMessages(cwd, workflowId);
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'tool', 'tool', 'assistant']);
  assert.equal(messages[2]?.tool_call_id, 'call_a');
  assert.equal(messages[3]?.tool_call_id, 'call_b');
});

test('Z.ai native replay reseeds from native_compacted marker', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'archon-zai-replay-'));
  const workflowId = 'wf-zai-compact';
  const dir = path.join(cwd, '.archon', 'workflows', workflowId);
  await mkdir(dir, { recursive: true });
  const summary = 'Older investigation folded. Current task is to finish compact.';
  const keptTail: ZaiNativeHistoryMessage[] = [
    { role: 'user', content: 'continue from here' },
    { role: 'assistant', content: 'ready' },
  ];
  await writeFile(path.join(dir, 'events.jsonl'), [
    JSON.stringify({
      seq: 1,
      ts: Date.now(),
      type: 'zai_native_history',
      workflowId,
      messages: [
        { role: 'user', content: 'old' },
        { role: 'assistant', content: 'old answer', reasoning_content: 'old reasoning' },
      ],
    }),
    JSON.stringify({
      seq: 2,
      ts: Date.now(),
      type: 'native_compacted',
      workflowId,
      summary,
      keptTail,
    }),
  ].join('\n') + '\n', 'utf8');

  const messages = await replayZaiNativeMessages(cwd, workflowId);
  assert.deepEqual(messages, zaiCompactSummarySeed(summary, keptTail));
});

test('Z.ai native replay lets post-compact history snapshot preserve native tail', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'archon-zai-replay-'));
  const workflowId = 'wf-zai-compact-snapshot';
  const dir = path.join(cwd, '.archon', 'workflows', workflowId);
  await mkdir(dir, { recursive: true });
  const summary = 'Compacted summary.';
  const exactHistory = zaiCompactSummarySeed(summary, [
    { role: 'user', content: 'recent question' },
    { role: 'assistant', content: 'recent answer', reasoning_content: 'recent exact reasoning' },
  ]);
  await writeFile(path.join(dir, 'events.jsonl'), [
    JSON.stringify({ seq: 1, ts: Date.now(), type: 'native_compacted', workflowId, summary }),
    JSON.stringify({ seq: 2, ts: Date.now(), type: 'zai_native_history', workflowId, messages: exactHistory }),
  ].join('\n') + '\n', 'utf8');

  const messages = await replayZaiNativeMessages(cwd, workflowId);
  assert.equal(messages.at(-1)?.reasoning_content, 'recent exact reasoning');
  assert.deepEqual(messages, exactHistory);
});
