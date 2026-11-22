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
  summarizeClaudeNativePriorTurns,
  type ClaudeResumeMessage,
} from './resumeSummary.js';
import { compactSplit, projectCompactSummaryMessages, projectKeptTail, SUMMARY_TOOL_RESULT_MAX_CHARS } from './workerHelpers.js';
import type { MessageParam } from './contentBlocks.js';
import { REPLACEMENT_RECENT_BYTES } from '../../replacementHistory.js';

test('resume summaries cap UTF-8 bytes, keep compacted context and newest whole notes, and preserve fitting output', () => {
  const small = [
    { type: 'user_message_echo', seq: 1, content: 'small request' },
    { type: 'primary_text', seq: 2, text: 'small reply' },
    { type: 'primary_complete', seq: 3 },
  ];
  assert.deepEqual(summarizeClaudeNativePriorTurns(small), {
    summary: '## Prior turns in this workflow (auto-summary)\n\n### Turn 1: small request\n- Assistant reply: "small reply"',
    throughSeq: 3, lastHandoffSeq: null,
  });
  const contextHeading = '## Earlier context (operator-compacted)\n\n';
  const exact = 'x'.repeat(REPLACEMENT_RECENT_BYTES - Buffer.byteLength(contextHeading));
  assert.equal(summarizeClaudeNativePriorTurns([{ type: 'native_compacted', summary: exact }]).summary, contextHeading + exact);

  const compact = 'COMPACTED_' + '界'.repeat(9000);
  const marker = { type: 'native_compacted', seq: 4, summary: compact,
    keptTail: [{ role: 'user' as const, content: 'KEPT_TAIL' }] };
  const turns = Array.from({ length: 300 }, (_, i) => [
    { type: 'user_message_echo', seq: 5 + i * 3, content: `request-${i + 1} ${'界'.repeat(100)}` },
    { type: 'primary_text', seq: 6 + i * 3, text: `answer-${i + 1} ${'海'.repeat(240)}` },
    { type: 'primary_complete', seq: 7 + i * 3 },
  ]).flat();
  const result = summarizeClaudeNativePriorTurns([...small, marker, ...turns]);
  assert.ok(Buffer.byteLength(result.summary, 'utf8') <= REPLACEMENT_RECENT_BYTES);
  assert.ok(result.summary.startsWith(contextHeading + compact + '\n\n### Recent verbatim turns kept at that compaction\n**user:** KEPT_TAIL'));
  const omitted = Number(/Earlier context: (\d+) oldest turn notes were left out/.exec(result.summary)?.[1]);
  assert.ok(omitted > 0 && omitted < 300);
  assert.deepEqual([...result.summary.matchAll(/^### Turn (\d+):/gm)].map(match => Number(match[1])),
    Array.from({ length: 300 - omitted }, (_, i) => omitted + i + 1));
  assert.doesNotMatch(result.summary, /small request|\uFFFD/);
  assert.equal(result.throughSeq, 904);
  assert.ok(result.summaryNotice && result.summary.includes(result.summaryNotice));

  const oversizedContext = summarizeClaudeNativePriorTurns([{ ...marker, summary: '界'.repeat(REPLACEMENT_RECENT_BYTES) }]).summary;
  assert.ok(Buffer.byteLength(oversizedContext, 'utf8') <= REPLACEMENT_RECENT_BYTES);
  assert.match(oversizedContext, /\*\*user:\*\* KEPT_TAIL/);
  assert.match(oversizedContext, /0 oldest turn notes were left out and compacted context was shortened/);
  assert.doesNotMatch(oversizedContext, /\uFFFD/);

  const oversizedNote = summarizeClaudeNativePriorTurns([
    { type: 'user_message_echo', content: 'one huge note' },
    { type: 'primary_tool_use', tool: 'Write', input: JSON.stringify({ file_path: 'x'.repeat(REPLACEMENT_RECENT_BYTES * 2) }) },
  ]).summary;
  assert.ok(Buffer.byteLength(oversizedNote, 'utf8') <= REPLACEMENT_RECENT_BYTES);
  assert.match(oversizedNote, /1 oldest turn note was left out/);
  assert.doesNotMatch(oversizedNote, /### Turn/);
});

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

// The summarizer never receives tool blocks or tool ids (an unpaired call
// would make the request fail), but completed tool work reaches it as capped
// text: a summary that loses what a tool returned once led an agent to claim
// it never read a brief it had answered.
test('compact summary projection sends tool work as capped text, never tool blocks or ids', () => {
  const page = 'Go 1.27.4 released 2026-11-10. '.repeat(200);
  const liveMessages: MessageParam[] = [
    { role: 'user', content: 'please inspect src/core/mod.rs' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'I will read the file first.' },
        { type: 'tool_use', id: 'tu_orphan', name: 'Read', input: { file_path: 'src/core/mod.rs' } },
      ] as unknown as MessageParam['content'],
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_old', content: 'old file body' }] as unknown as MessageParam['content'] },
    {
      role: 'assistant',
      content: [
        { type: 'server_tool_use', id: 'srv_1', name: 'web_fetch', input: { url: 'https://go.dev/dl/' } },
        { type: 'web_fetch_tool_result', tool_use_id: 'srv_1', content: { type: 'web_fetch_result', url: 'https://go.dev/dl/', content: { type: 'document', source: { type: 'text', media_type: 'text/plain', data: page } } } },
        { type: 'server_tool_use', id: 'srv_2', name: 'web_search', input: { query: 'go release date' } },
        { type: 'web_search_tool_result', tool_use_id: 'srv_2', content: [{ type: 'web_search_result', title: 'Go releases', url: 'https://go.dev/doc/devel/release', encrypted_content: 'zzz' }] },
        { type: 'text', text: 'The relevant split is in the core module.' },
      ] as unknown as MessageParam['content'],
    },
  ];

  const projected = projectCompactSummaryMessages(liveMessages);
  const text = JSON.stringify(projected);
  assert.deepEqual(projected.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
  assert.doesNotMatch(text, /tool_use|tool_result|tu_orphan|tu_old|srv_\d|encrypted|zzz/);
  assert.match(text, /\[Tool call Read \{\\"file_path\\":\\"src\/core\/mod.rs\\"\}\]/);
  assert.match(text, /\[Tool result: old file body\]/);
  assert.match(text, /\[Web fetch: https:\/\/go.dev\/dl\/\]/);
  assert.match(text, /\[Web fetch result https:\/\/go.dev\/dl\/:\\nGo 1.27.4 released 2026-11-10/);
  assert.match(text, new RegExp(`\\[cut at ${SUMMARY_TOOL_RESULT_MAX_CHARS} of ${page.trim().length} characters\\]`));
  assert.match(text, /\[Web search: go release date\][\s\S]*Go releases https:\/\/go.dev\/doc\/devel\/release/);
  assert.ok(text.length < page.length);
});

// The kept tail holds clean text only. Cutting tail.length raw messages off
// the end dropped a tool result that sat among them from both the summary
// and the tail; a real run summarized a turn that had read a brief as
// "nothing executed yet".
test('a compaction summarizes the tool messages its text-only tail skips', () => {
  const brief: MessageParam[] = [
    { role: 'user', content: 'research the brief in your mail' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'peer_read', input: {} }] as unknown as MessageParam['content'] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'Brief: latest Go release' }] as unknown as MessageParam['content'] },
  ];
  brief.push({ role: 'assistant', content: [{ type: 'text', text: 'Report sent.' }] }, { role: 'user', content: 'now check the date' });
  const tail = projectKeptTail(brief, 3);
  const split = compactSplit(brief, tail);
  assert.equal(split.summarize.length, 5);
  assert.match(JSON.stringify(projectCompactSummaryMessages(split.summarize)), /Brief: latest Go release/);
  // The latest messages stay word for word even when everything is summarized.
  assert.deepEqual(split.tail, tail);
  assert.equal((split.tail.at(-1) as { content: string }).content, 'now check the date');

  const plain: MessageParam[] = [
    { role: 'user', content: 'one' },
    { role: 'assistant', content: [{ type: 'text', text: 'two' }] },
    { role: 'user', content: 'three' },
    { role: 'assistant', content: [{ type: 'text', text: 'four' }] },
  ];
  assert.deepEqual(compactSplit(plain, projectKeptTail(plain, 2)).summarize, plain.slice(0, 2));
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

test('Native reconstruction failure emits one durable-style notice without removing the saved history', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'arco-resume-notice-'));
  try {
    const id = 'unreadable-history', dir = join(cwd, '.arco', 'workflows', id);
    const file = join(dir, 'events.jsonl');
    await fs.mkdir(file, { recursive: true });
    // Windows can open a directory and report zero bytes. Exercise that
    // metadata on other platforms so replay cannot mistake it for an empty file.
    const open = fs.open;
    t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      if (args[0] === file) {
        const stat = await handle.stat();
        t.mock.method(handle, 'stat', async () => Object.assign(stat, { size: 0 }));
      }
      return handle;
    });
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
        t.mock.method(handle, 'stat', async () => Object.assign(stat, { size: NATIVE_RECONSTRUCTION_MAX_BYTES + 1 }));
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
