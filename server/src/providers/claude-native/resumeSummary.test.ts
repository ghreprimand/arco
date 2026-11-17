import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildMessagesFromReplayEvents,
  compactSummarySeed,
  replayMessagesWithResumePolicy,
  type ClaudeResumeMessage,
} from './resumeSummary.js';
import { projectCompactSummaryMessages, projectKeptTail } from './workerHelpers.js';
import type { MessageParam } from './contentBlocks.js';

function line(ev: Record<string, unknown>): string {
  return JSON.stringify(ev) + '\n';
}

test('replay builder drops summary and earlier history after successful handoff', () => {
  const messages = buildMessagesFromReplayEvents(
    [
      { type: 'handoff_artifact_ready', seq: 10 },
      { type: 'user_message_echo', seq: 11, content: 'new prompt' },
      { type: 'primary_text', seq: 12, text: 'new reply' },
      { type: 'primary_complete', seq: 13 },
    ],
    [
      { role: 'user', content: 'summary' },
      { role: 'assistant', content: [{ type: 'text', text: 'ack' }] },
    ],
  );

  assert.deepEqual(messages, [
    { role: 'user', content: 'new prompt' },
    { role: 'assistant', content: [{ type: 'text', text: 'new reply' }] },
  ]);
});

test('compact keep-tail: live seed and replay reseed are byte-identical', () => {
  // Mirror the live worker's messages[] just before compactInPlace: a mix of
  // plain user/assistant turns plus a tool_use-bearing assistant message that
  // the projection must flatten/skip. The projection produces the keptTail that
  // rides the native_compacted event.
  const liveMessages: MessageParam[] = [
    { role: 'user', content: 'old prompt 1' },
    { role: 'assistant', content: [{ type: 'text', text: 'old reply 1' }] },
    { role: 'user', content: 'recent prompt' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'recent reply with a tool call' },
        { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: 'x.ts' } },
      ] as unknown as MessageParam['content'],
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'file body' }] as unknown as MessageParam['content'] },
    { role: 'assistant', content: [{ type: 'text', text: 'final answer' }] },
  ];

  const summary = 'Dense continuation brief covering the older prefix.';
  const keptTail = projectKeptTail(liveMessages, 6);

  // LIVE: messages[] after compactInPlace = compactSummarySeed(summary, keptTail).
  const liveAfter = compactSummarySeed(summary, keptTail);

  // REPLAY: a persisted native_compacted event carrying that same keptTail,
  // rebuilt through the replay path.
  const replayed = buildMessagesFromReplayEvents([
    { type: 'native_compacted', seq: 1, summary, keptTail } as unknown as Record<string, unknown> as never,
  ]);

  // Byte-identical (load-bearing: docs/GOTCHAS.md § Claude Native transport).
  assert.equal(JSON.stringify(replayed), JSON.stringify(liveAfter));

  // The kept tail survived verbatim after the seed (the seed is 2 messages:
  // summary user + ack assistant). The tool_result user was skipped, and the
  // mid-turn narration assistant ("recent reply with a tool call") collapsed
  // into the most recent same-role reply ("final answer") so alternation stays
  // strict — the SAME shape replay's pair-flush would yield.
  const tail = liveAfter.slice(2) as ClaudeResumeMessage[];
  assert.deepEqual(tail, [
    { role: 'user', content: 'old prompt 1' },
    { role: 'assistant', content: [{ type: 'text', text: 'old reply 1' }] },
    { role: 'user', content: 'recent prompt' },
    { role: 'assistant', content: [{ type: 'text', text: 'final answer' }] },
  ]);
});

test('compact keep-tail: later turns replay on top of seed + tail', () => {
  const summary = 'older brief';
  const keptTail: ClaudeResumeMessage[] = [
    { role: 'user', content: 'kept prompt' },
    { role: 'assistant', content: [{ type: 'text', text: 'kept reply' }] },
  ];
  const messages = buildMessagesFromReplayEvents([
    { type: 'native_compacted', seq: 1, summary, keptTail } as unknown as never,
    { type: 'user_message_echo', seq: 2, content: 'next prompt' },
    { type: 'primary_text', seq: 3, text: 'next reply' },
    { type: 'primary_complete', seq: 4 },
  ]);
  assert.deepEqual(messages, [
    ...compactSummarySeed(summary, keptTail),
    { role: 'user', content: 'next prompt' },
    { role: 'assistant', content: [{ type: 'text', text: 'next reply' }] },
  ]);
});

test('compact keep-tail: drops leading assistant so alternation after the ack stays valid', () => {
  // A tail that begins on an assistant message would invert the order right
  // after the seed's trailing assistant ack — projectKeptTail must drop it.
  const liveMessages: MessageParam[] = [
    { role: 'assistant', content: [{ type: 'text', text: 'orphan assistant' }] },
    { role: 'user', content: 'a user turn' },
    { role: 'assistant', content: [{ type: 'text', text: 'an assistant turn' }] },
  ];
  const tail = projectKeptTail(liveMessages, 6);
  assert.deepEqual(tail, [
    { role: 'user', content: 'a user turn' },
    { role: 'assistant', content: [{ type: 'text', text: 'an assistant turn' }] },
  ]);
});

test('compact summary projection drops tool protocol blocks before summarizer request', () => {
  const liveMessages: MessageParam[] = [
    { role: 'user', content: 'please inspect src/core/mod.rs' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'I will read the file first.' },
        { type: 'tool_use', id: 'tu_orphan', name: 'Read', input: { file_path: 'src/core/mod.rs' } },
      ] as unknown as MessageParam['content'],
    },
    // This result belongs to an earlier completed tool call and must not be
    // re-sent to the compact summarizer.
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_old', content: 'old file body' }] as unknown as MessageParam['content'] },
    { role: 'assistant', content: [{ type: 'text', text: 'The relevant split is in the core module.' }] },
  ];

  const projected = projectCompactSummaryMessages(liveMessages);
  assert.deepEqual(projected, [
    { role: 'user', content: 'please inspect src/core/mod.rs' },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'I will read the file first.\n\nThe relevant split is in the core module.' }],
    },
  ]);
  assert.doesNotMatch(JSON.stringify(projected), /tool_use|tool_result|tu_orphan|tu_old/);
});

test('large resume uses cached older summary plus exact recent tail', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'arco-resume-summary-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const workflowId = 'wf-summary-test';
  const dir = join(cwd, '.arco', 'workflows', workflowId);
  await fs.mkdir(dir, { recursive: true });

  let seq = 1;
  let raw = '';
  for (let i = 0; i < 8; i++) {
    raw += line({ seq: seq++, type: 'user_message_echo', content: `old prompt ${i}` });
    raw += line({ seq: seq++, type: 'primary_tool_use', tool: 'Edit', input: JSON.stringify({ file_path: `src/old-${i}.ts` }) });
    raw += line({ seq: seq++, type: 'primary_text', text: `old reply ${i} ${'x'.repeat(120)}` });
    raw += line({ seq: seq++, type: 'primary_complete' });
  }
  raw += line({ seq: seq++, type: 'user_message_echo', content: 'recent prompt' });
  raw += line({ seq: seq++, type: 'primary_text', text: 'recent reply' });
  raw += line({ seq: seq++, type: 'primary_complete' });
  await fs.writeFile(join(dir, 'events.jsonl'), raw);

  const replay = await replayMessagesWithResumePolicy(cwd, workflowId, undefined, {
    exactReplayBytes: 100,
    recentTailBytes: 320,
  });

  assert.equal(replay.mode, 'summary_tail');
  assert.ok(replay.summaryThroughSeq, 'cache should carry a throughSeq watermark');
  assert.match(JSON.stringify(replay.messages[0]), /Prior turns in this workflow/);
  assert.deepEqual(replay.messages.slice(-2), [
    { role: 'user', content: 'recent prompt' },
    { role: 'assistant', content: [{ type: 'text', text: 'recent reply' }] },
  ]);

  const cacheRaw = await fs.readFile(join(dir, 'resume-summary.json'), 'utf8');
  const cache = JSON.parse(cacheRaw) as { throughSeq?: number; summary?: string };
  assert.equal(cache.throughSeq, replay.summaryThroughSeq);
  assert.match(cache.summary ?? '', /old prompt/);
});


test('resume byte source streams sealed large records with unchanged offsets and branch replay', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'arco-resume-stream-'));
  try {
    const { brotliCompressSync } = await import('node:zlib');
    const { openLogByteSource, readLogText, segmentName } = await import('../../eventLog.js');
    const id = 'large-record', dir = join(cwd, '.arco', 'workflows', id);
    await fs.mkdir(dir, { recursive: true });
    const rows = [
      { seq: 1, type: 'user_message_echo', content: 'a'.repeat(9 * 1024 * 1024) + 'é' },
      { seq: 2, parentEventSeq: 1, type: 'primary_text', text: 'whole answer' },
      { seq: 3, parentEventSeq: 2, type: 'primary_complete' },
    ];
    await fs.writeFile(join(dir, segmentName(1, 2)), brotliCompressSync(Buffer.from(rows.slice(0, 2).map(line).join(''))));
    await fs.writeFile(join(dir, 'events.jsonl'), line(rows[1]) + line(rows[2]) + '{"seq":4');
    const expected = await readLogText(dir), source = (await openLogByteSource(dir))!;
    let size = 0;
    for await (const chunk of source.chunks(0, source.size)) { assert.ok(chunk.length <= 65536); size += chunk.length; }
    assert.equal(size, Buffer.byteLength(expected));
    assert.equal(source.size, size);
    assert.equal(await source.read(9 * 1024 * 1024 - 10, 100), Buffer.from(expected).subarray(9 * 1024 * 1024 - 10, 9 * 1024 * 1024 + 90).toString('utf8'));
    await source.close();
    const result = await replayMessagesWithResumePolicy(cwd, id, undefined, { leafSeq: 3 });
    assert.deepEqual(result.messages, buildMessagesFromReplayEvents(rows));
    assert.equal(result.eventBytes, size);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('Native reconstruction failure emits one durable-style notice without removing the saved history', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'arco-resume-notice-'));
  try {
    const id = 'unreadable-history', dir = join(cwd, '.arco', 'workflows', id);
    // A directory in place of the live file causes an actual read failure on
    // every supported host without depending on permission bits or root status.
    await fs.mkdir(join(dir, 'events.jsonl'), { recursive: true });
    const { ClaudeNativeWorker } = await import('./worker.js');
    const worker = new ClaudeNativeWorker({ workflowId: id, config: { cwd, model: 'haiku' } as never });
    const notices: string[] = [];
    worker.on('system_notice', content => notices.push(content));
    await (worker as unknown as { restoreSavedHistory(): Promise<void> }).restoreSavedHistory();
    await (worker as unknown as { restoreSavedHistory(): Promise<void> }).restoreSavedHistory();
    assert.deepEqual(notices, ['Earlier context could not be rebuilt for this conversation, so the agent continues without it. Earlier messages remain in this tab.']);
    assert.ok((await fs.stat(join(dir, 'events.jsonl'))).isDirectory());
  } finally { await rm(cwd, { recursive: true, force: true }); }
});


test('Native reconstruction above its size bound notices once without reading the range', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'arco-resume-bound-'));
  try {
    const { NATIVE_RECONSTRUCTION_MAX_BYTES } = await import('./resumeSummary.js');
    const id = 'large-sized-source', dir = join(cwd, '.arco', 'workflows', id), file = join(dir, 'events.jsonl');
    await fs.mkdir(dir, { recursive: true });
    const original = line({ seq: 1, type: 'user_message_echo', content: 'Saved history stays here' });
    await fs.writeFile(file, original);
    await fs.writeFile(join(dir, 'meta.json'), JSON.stringify({ workflowId: id, leafSeq: 1 }));
    const open = fs.open;
    let rangeReads = 0;
    t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      if (String(args[0]) === file) {
        const stat = await handle.stat();
        t.mock.method(handle, 'stat', async () => ({ ...stat, size: NATIVE_RECONSTRUCTION_MAX_BYTES + 1 }));
        t.mock.method(handle, 'read', async () => { rangeReads++; throw new Error('The oversized range must not be read'); });
      }
      return handle;
    });
    const { ClaudeNativeWorker } = await import('./worker.js');
    const worker = new ClaudeNativeWorker({ workflowId: id, config: { cwd, model: 'haiku' } as never });
    const notices: string[] = [];
    worker.on('system_notice', content => notices.push(content));
    await (worker as unknown as { restoreSavedHistory(): Promise<void> }).restoreSavedHistory();
    await (worker as unknown as { restoreSavedHistory(): Promise<void> }).restoreSavedHistory();
    assert.equal(rangeReads, 0);
    assert.deepEqual(notices, ['Earlier context could not be rebuilt within the 1024 MiB reconstruction limit, so the agent continues without it. Earlier messages remain in this tab.']);
    assert.equal(await fs.readFile(file, 'utf8'), original);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
