import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { brotliCompressSync } from 'node:zlib';
import path from 'node:path';
import type { ServerMessage } from '@arco/shared';
import {
  flushWorkflowBuffer, forgetWorkflowBuffer, getHeadSeq, initWorkflowStore, persistAndStampSeq,
  readEventsPageBefore, readFirstSeq, replayEvents, replayEventsWithTs, replayTailEvents, scanEventsOfTypes,
} from './workflowStore.js';
import { listSegments, readLogHeadSync, readLogLines, readLogTail, readLogTailSync, readLogText, readLogTextSync, sealLiveLog, sealTestHooks, segmentName } from './eventLog.js';
import { readCatchUpEvents } from './catchUp.js';
import { removeProjectDir } from './testSupport/projectWrites.js';
import { scanOperatorMessages } from './workflows/sessionIndex.js';
import { readMemberActivity } from './management/clusterActivity.js';
import { aggregateUsageForCwd } from './http/usageStatsRoutes.js';
import { replayMessagesWithResumePolicy } from './providers/claude-native/resumeSummary.js';
// @ts-expect-error plain ES module without types
import { unsealLog } from '../../scripts/packaging/storage.mjs';

// P7.3 (docs/STORAGE_PLAN.md): sealed, compressed segments. Every reader sees
// one history, each record once, in sequence order; nothing is lost when a
// seal is interrupted; the plain-log export gives the whole history back.

const SEAL = 4096;
type Rec = { seq: number; type: string; [k: string]: unknown };

async function withProject(fn: (cwd: string, dir: (id: string) => string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'arco-seal-'));
  const before = process.env.ARCO_EVENT_SEGMENT_BYTES;
  process.env.ARCO_EVENT_SEGMENT_BYTES = String(SEAL);
  try { await fn(cwd, (id) => path.join(cwd, '.arco', 'workflows', id)); }
  finally {
    if (before === undefined) delete process.env.ARCO_EVENT_SEGMENT_BYTES; else process.env.ARCO_EVENT_SEGMENT_BYTES = before;
    await removeProjectDir(cwd);
  }
}

// One conversation: an operator turn and assistant text, repeated.
async function writeTurns(cwd: string, id: string, turns: number): Promise<void> {
  await initWorkflowStore(cwd, id);
  for (let t = 0; t < turns; t++) {
    persistAndStampSeq(cwd, id, { type: 'user_message_echo', workflowId: id, content: `question ${t}` } as unknown as ServerMessage);
    persistAndStampSeq(cwd, id, { type: 'primary_turn_started', workflowId: id } as unknown as ServerMessage);
    persistAndStampSeq(cwd, id, { type: 'primary_text', workflowId: id, text: `answer ${t} `.repeat(20) } as unknown as ServerMessage);
    persistAndStampSeq(cwd, id, { type: 'primary_turn_token_usage', workflowId: id, turnStartedAt: Date.now() + t, durationMs: 1, provider: 'claude', model: 'm', input: 1, output: 1, cacheRead: 0, cacheCreate: 0 } as unknown as ServerMessage);
    persistAndStampSeq(cwd, id, { type: 'primary_turn_ended', workflowId: id } as unknown as ServerMessage);
    await flushWorkflowBuffer(cwd, id);
  }
}

function seqs(events: readonly unknown[]): number[] { return events.map((e) => (e as { seq: number }).seq); }
function range(a: number, b: number): number[] { return Array.from({ length: b - a + 1 }, (_, i) => a + i); }

test('sealing on write keeps one ordered history for every reader, across a restart', async () => {
  await withProject(async (cwd, dir) => {
    const id = 'seal-0001';
    await writeTurns(cwd, id, 40);
    const segments = await listSegments(dir(id));
    assert.ok(segments.length >= 2, 'the live file was sealed into several segments');
    const head = await getHeadSeq(cwd, id);
    assert.equal(head, 200);
    // Full replay, with timestamps, from a sequence number, and typed scans.
    assert.deepEqual(seqs(await replayEvents(cwd, id, 0)), range(1, 200));
    assert.deepEqual(seqs(await replayEvents(cwd, id, 150)), range(151, 200));
    assert.deepEqual((await replayEventsWithTs(cwd, id, 0)).map((e) => (e.message as { seq?: number }).seq), range(1, 200));
    assert.equal((await scanEventsOfTypes(cwd, id, ['user_message_echo'])).length, 40);
    // HISTORY pages across a segment boundary.
    const page = await readEventsPageBefore(cwd, id, 120, 50);
    assert.deepEqual(seqs(page.events), range(70, 119)); assert.equal(page.total, 119); assert.equal(page.hasEarlier, true);
    // Gap fallback uses the first sealed record.
    assert.equal(await readFirstSeq(cwd, id), 1);
    // A tail longer than the live file reaches into the segments.
    const tail = await replayTailEvents(cwd, id, SEAL * 2);
    assert.equal(tail.truncated, true);
    assert.equal((tail.events[0] as { type: string }).type, 'user_message_echo');
    assert.equal((tail.events.at(-1) as unknown as { seq: number }).seq, 200);
    assert.deepEqual(seqs(tail.events), range(seqs(tail.events)[0], 200));
    // Restart: the sequence continues from the segments and live file.
    forgetWorkflowBuffer(cwd, id);
    await writeTurns(cwd, id, 1);
    assert.deepEqual(seqs(await replayEvents(cwd, id, 0)), range(1, 205));
    // Direct readers.
    assert.equal((await scanOperatorMessages(cwd, id)).length, 41);
    assert.match(readLogHeadSync(dir(id), 4096), /question 0/);
    const usage = await aggregateUsageForCwd(cwd);
    assert.equal(usage.turnsAggregated, 41);
    const catchUp = await readCatchUpEvents(cwd, id);
    assert.equal((catchUp.events.at(-1) as { seq?: number }).seq, 205);
    const activity = readMemberActivity(cwd, id);
    assert.ok(activity.some((row) => row.kind === 'turn-started'));
    const resume = await replayMessagesWithResumePolicy(cwd, id, undefined, { exactReplayBytes: 1, recentTailBytes: 2048 });
    assert.equal(resume.mode, 'summary_tail');
    const exact = await replayMessagesWithResumePolicy(cwd, id);
    assert.equal(exact.mode, 'exact');
    assert.equal(exact.messages.filter((m) => m.role === 'user').length, 41);
  });
});

test('an interrupted seal loses nothing and shows nothing twice; the next seal finishes it', async () => {
  await withProject(async (cwd, dir) => {
    const id = 'seal-0002';
    await mkdir(dir(id), { recursive: true });
    const records: Rec[] = range(1, 30).map((seq) => ({ seq, type: seq % 3 ? 'primary_text' : 'user_message_echo', text: 'x'.repeat(200) }));
    const text = (rs: Rec[]) => rs.map((r) => JSON.stringify(r)).join('\n') + '\n';
    // Segments for 1..10 were written, the live file was not replaced yet,
    // and a temporary file from the interrupted next segment is left over.
    await writeFile(path.join(dir(id), segmentName(1, 10)), brotliCompressSync(text(records.slice(0, 10))));
    await writeFile(path.join(dir(id), `${segmentName(11, 20)}.0f0f0f0f-0000-0000-0000-000000000000.tmp`), 'partial');
    await writeFile(path.join(dir(id), 'events.jsonl'), text(records));
    assert.deepEqual(seqs(await replayEvents(cwd, id, 0)), range(1, 30));
    assert.equal((await readLogText(dir(id))).split('\n').filter(Boolean).length, 30);
    assert.equal(readLogTailSync(dir(id), 1 << 20).text.split('\n').filter(Boolean).length, 30);
    const sealed = await sealLiveLog(dir(id), 2048);
    assert.ok(sealed);
    const names = await readdir(dir(id));
    assert.equal(names.some((n) => n.endsWith('.tmp')), false);
    assert.deepEqual(seqs(await replayEvents(cwd, id, 0)), range(1, 30));
    // The new live file holds only the newest sealed record.
    const live = (await readFile(path.join(dir(id), 'events.jsonl'), 'utf8')).split('\n').filter(Boolean);
    assert.deepEqual(live.map((l) => JSON.parse(l).seq), [30]);
    assert.equal(JSON.parse(await readFile(path.join(dir(id), 'log-format.json'), 'utf8')).format, 2);
  });
});

test('a large final record, concurrent appends during a seal, and the 0.1.3 view', async () => {
  await withProject(async (cwd, dir) => {
    const id = 'seal-0003';
    await initWorkflowStore(cwd, id);
    for (let i = 0; i < 20; i++) persistAndStampSeq(cwd, id, { type: 'primary_text', workflowId: id, text: 'y'.repeat(300) } as unknown as ServerMessage);
    // One record larger than the 1 MiB sequence-recovery read.
    persistAndStampSeq(cwd, id, { type: 'primary_tool_use', workflowId: id, output: 'z'.repeat(1_200_000) } as unknown as ServerMessage);
    const flushing = flushWorkflowBuffer(cwd, id);
    for (let i = 0; i < 10; i++) persistAndStampSeq(cwd, id, { type: 'primary_text', workflowId: id, text: `late ${i}` } as unknown as ServerMessage);
    await flushing; await flushWorkflowBuffer(cwd, id);
    assert.deepEqual(seqs(await replayEvents(cwd, id, 0)), range(1, 31));
    forgetWorkflowBuffer(cwd, id);
    assert.equal(await getHeadSeq(cwd, id), 31);
    // A release that reads only events.jsonl still finds the newest sequence
    // number in its tail (the copied record), so it would continue at 32.
    const live = (await readFile(path.join(dir(id), 'events.jsonl'), 'utf8')).split('\n').filter(Boolean);
    assert.equal(JSON.parse(live.at(-1)!).seq, 31);
  });
});

test('an unreadable segment is reported and skipped, never deleted', async () => {
  await withProject(async (cwd, dir) => {
    const id = 'seal-0004';
    await writeTurns(cwd, id, 30);
    const segments = await listSegments(dir(id));
    assert.ok(segments.length >= 2);
    await writeFile(segments[0].file, 'not brotli');
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.join(' ')); };
    let lines = 0;
    try { for await (const _ of readLogLines(dir(id))) { void _; lines++; } } finally { console.error = original; }
    assert.ok(lines > 0 && lines < 150);
    assert.ok(errors.some((e) => e.includes('could not be read')));
    assert.ok((await readdir(dir(id))).includes(segments[0].name));
  });
});

test('arco storage unseal writes the whole history back to one plain log', async () => {
  await withProject(async (cwd, dir) => {
    const id = 'seal-0005';
    const plans = path.join(cwd, '.arco', 'plans');
    await mkdir(plans, { recursive: true });
    await writeFile(path.join(plans, 'p.md'), '# Plan\n');
    await writeTurns(cwd, id, 30);
    const full = await readLogText(dir(id));
    const result = await unsealLog(dir(id));
    assert.equal(result.records, 150);
    assert.deepEqual(await listSegments(dir(id)), []);
    assert.equal(await readFile(path.join(dir(id), 'events.jsonl'), 'utf8'), full);
    assert.deepEqual((await readdir(dir(id))).filter((n) => n.startsWith('log-format')), []);
    assert.equal(await readFile(path.join(plans, 'p.md'), 'utf8'), '# Plan\n');
  });
});

test('a log written by a newer format is not written to', async () => {
  await withProject(async (cwd, dir) => {
    const id = 'seal-0006';
    await mkdir(dir(id), { recursive: true });
    await writeFile(path.join(dir(id), 'log-format.json'), '{ "format": 99 }\n');
    await writeFile(path.join(dir(id), 'events.jsonl'), '{"seq":1,"type":"workflow_created"}\n');
    const original = console.error; console.error = () => {};
    try { await initWorkflowStore(cwd, id); } finally { console.error = original; }
    const out = persistAndStampSeq(cwd, id, { type: 'primary_text', workflowId: id, text: 'new' } as unknown as ServerMessage);
    assert.equal((out as { seq?: number }).seq, undefined);
    await flushWorkflowBuffer(cwd, id);
    assert.equal(await readFile(path.join(dir(id), 'events.jsonl'), 'utf8'), '{"seq":1,"type":"workflow_created"}\n');
    await assert.rejects(sealLiveLog(dir(id), 10), /newer storage format/);
  });
});

test('COMPRESS OLD LOGS seals closed conversations only, without losing events written meanwhile', async () => {
  const { compressOldLogs } = await import('./storageActions.js');
  const { sealWorkflowLogNow } = await import('./workflowStore.js');
  await withProject(async (cwd, dir) => {
    delete process.env.ARCO_EVENT_SEGMENT_BYTES; // the default 16 MiB, so writes alone never seal
    const big = (id: string) => range(1, 3000).map((seq) => JSON.stringify({ seq, ts: seq, type: 'primary_text', workflowId: id, text: `${id} ${seq} `.repeat(30) })).join('\n') + '\n';
    for (const id of ['old-0001', 'open-0001', 'tiny-0001']) await mkdir(dir(id), { recursive: true });
    await writeFile(path.join(dir('old-0001'), 'events.jsonl'), big('old-0001'));
    await writeFile(path.join(dir('open-0001'), 'events.jsonl'), big('open-0001'));
    await writeFile(path.join(dir('tiny-0001'), 'events.jsonl'), '{"seq":1,"type":"workflow_created"}\n');
    const before = await readLogText(dir('old-0001'));
    // The conversation is reopened and writes an event while it is sealed.
    await initWorkflowStore(cwd, 'old-0001');
    const sealing = compressOldLogs(cwd, {
      isOpen: (id) => id === 'open-0001', isBusy: () => false,
      seal: async (c, id) => {
        const done = sealWorkflowLogNow(c, id);
        await new Promise((r) => setImmediate(r));
        persistAndStampSeq(c, id, { type: 'primary_text', workflowId: id, text: 'written during the seal' } as unknown as ServerMessage);
        await flushWorkflowBuffer(c, id);
        return done;
      },
    });
    const result = await sealing;
    assert.equal(result.sealed, 1);
    assert.deepEqual(result.skippedOpen, ['open-0001']);
    assert.ok(result.afterBytes < result.beforeBytes / 5);
    await flushWorkflowBuffer(cwd, 'old-0001');
    assert.ok((await listSegments(dir('old-0001'))).length >= 1);
    assert.deepEqual(await listSegments(dir('open-0001')), []);
    assert.deepEqual(await listSegments(dir('tiny-0001')), []);
    const after = await readLogText(dir('old-0001'));
    assert.ok(after.startsWith(before));
    assert.match(after.slice(before.length), /written during the seal/);
    assert.deepEqual(seqs(await replayEvents(cwd, 'old-0001', 0)), range(1, 3001));
    const log = (await readFile(path.join(cwd, '.arco', 'storage-actions.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(log.at(-1).action, 'compress_logs');
  });
});

// Damaged segments (gate finding): a name is never trusted over the live copy.
function recordsText(from: number, to: number): string {
  return Array.from({ length: to - from + 1 }, (_, i) => JSON.stringify({ seq: from + i, type: 'primary_text', text: `r${from + i} ${'x'.repeat(60)}` })).join('\n') + '\n';
}
function seqsOfText(text: string): number[] {
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l).seq as number);
}

test('every reader prefers the live copy over a segment whose content does not match its name', async () => {
  await withProject(async (cwd, dir) => {
    const id = 'seal-0010';
    await mkdir(dir(id), { recursive: true });
    await writeFile(path.join(dir(id), segmentName(1, 30)), brotliCompressSync(recordsText(1, 1)));
    await writeFile(path.join(dir(id), 'events.jsonl'), recordsText(1, 30));
    const original = console.error; console.error = () => {};
    try {
      assert.deepEqual(seqs(await replayEvents(cwd, id, 0)), range(1, 30));
      assert.deepEqual(seqsOfText(await readLogText(dir(id))), range(1, 30));
      assert.deepEqual(seqsOfText(readLogTextSync(dir(id))), range(1, 30));
      assert.deepEqual(seqsOfText((await readLogTail(dir(id), 1 << 20)).text), range(1, 30));
      assert.deepEqual(seqsOfText(readLogTailSync(dir(id), 1 << 20).text), range(1, 30));
      assert.deepEqual(seqsOfText(readLogHeadSync(dir(id), 1 << 20)), range(1, 30));
    } finally { console.error = original; }
  });
});

test('a damaged segment between sound ones is moved aside and its records sealed again from the live log', async () => {
  await withProject(async (cwd, dir) => {
    const id = 'seal-0011';
    await mkdir(dir(id), { recursive: true });
    await writeFile(path.join(dir(id), segmentName(1, 10)), brotliCompressSync(recordsText(1, 10)));
    await writeFile(path.join(dir(id), segmentName(11, 20)), Buffer.from('not brotli'));
    await writeFile(path.join(dir(id), segmentName(21, 30)), brotliCompressSync(recordsText(21, 30)));
    await writeFile(path.join(dir(id), 'events.jsonl'), recordsText(1, 35));
    const original = console.error; console.error = () => {};
    let result;
    try { result = await sealLiveLog(dir(id), 1 << 20); } finally { console.error = original; }
    assert.ok(result);
    assert.equal(result.movedAside.length, 1);
    const names = await readdir(dir(id));
    assert.ok(names.some((n) => n.startsWith(`${segmentName(11, 20)}.damaged-`)), 'the damaged segment is kept, renamed');
    assert.deepEqual((await listSegments(dir(id))).map((s) => [s.firstSeq, s.lastSeq]), [[1, 10], [11, 20], [21, 30], [31, 35]]);
    assert.deepEqual(seqs(await replayEvents(cwd, id, 0)), range(1, 35));
    assert.deepEqual(seqsOfText(readLogTailSync(dir(id), 1 << 20).text), range(1, 35));
    const live = (await readFile(path.join(dir(id), 'events.jsonl'), 'utf8')).split('\n').filter(Boolean);
    assert.deepEqual(live.map((l) => JSON.parse(l).seq), [35]);
  });
});

test('a seal with every live record already in sound segments only replaces the live file', async () => {
  await withProject(async (cwd, dir) => {
    const id = 'seal-0012';
    await mkdir(dir(id), { recursive: true });
    await writeFile(path.join(dir(id), segmentName(1, 20)), brotliCompressSync(recordsText(1, 20)));
    await writeFile(path.join(dir(id), 'events.jsonl'), recordsText(1, 20));
    const result = await sealLiveLog(dir(id), 1 << 20);
    assert.ok(result);
    assert.deepEqual(result.segments, []);
    assert.deepEqual((await readFile(path.join(dir(id), 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l).seq), [20]);
    assert.equal(await sealLiveLog(dir(id), 1 << 20), null, 'a live file holding only the copied record is left alone');
    assert.deepEqual(seqs(await replayEvents(cwd, id, 0)), range(1, 20));
  });
});

// Windows refuses a rename over a live file a reader holds open. Simulated
// here on every system: the seal keeps segments and the complete live file,
// the appends are never affected, and a later seal finishes the job.
test('a live file that cannot be replaced is kept complete, appends continue, and a later seal replaces it', async () => {
  const { compressOldLogs } = await import('./storageActions.js');
  const { sealWorkflowLogNow } = await import('./workflowStore.js');
  await withProject(async (cwd, dir) => {
    const id = 'seal-0013';
    const refused = Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    const original = console.error; console.error = () => {};
    sealTestHooks.beforeLiveReplace = async () => { throw refused; };
    try {
      await writeTurns(cwd, id, 30);
      assert.deepEqual(seqs(await replayEvents(cwd, id, 0)), range(1, 150), 'every append was saved');
      assert.ok((await listSegments(dir(id))).length >= 1, 'segments are in place');
      const live = (await readFile(path.join(dir(id), 'events.jsonl'), 'utf8')).split('\n').filter(Boolean);
      assert.equal(JSON.parse(live[0]).seq, 1, 'the live file is still complete');
      assert.deepEqual((await readdir(dir(id))).filter((n) => n.endsWith('.tmp')), []);
      assert.deepEqual(seqsOfText(readLogTailSync(dir(id), 1 << 20).text), range(1, 150));
      const again = await sealWorkflowLogNow(cwd, id);
      assert.equal(again?.liveReplaced, false, 'COMPRESS OLD LOGS meets the same refusal');
      // COMPRESS OLD LOGS reports such a log as deferred, not sealed or failed.
      const big = path.join(dir('seal-0014'));
      await mkdir(big, { recursive: true });
      await writeFile(path.join(big, 'events.jsonl'), recordsText(1, 12000));
      const compressed = await compressOldLogs(cwd, { isOpen: (w) => w === id, isBusy: () => false, seal: sealWorkflowLogNow });
      assert.deepEqual([compressed.deferred, compressed.sealed, compressed.failed], [1, 0, 0]);
    } finally {
      sealTestHooks.beforeLiveReplace = undefined;
      console.error = original;
    }
    const finished = await sealWorkflowLogNow(cwd, id);
    assert.ok(finished && finished.liveReplaced);
    const live = (await readFile(path.join(dir(id), 'events.jsonl'), 'utf8')).split('\n').filter(Boolean);
    assert.deepEqual(live.map((l) => JSON.parse(l).seq), [150]);
    assert.deepEqual(seqs(await replayEvents(cwd, id, 0)), range(1, 150));
    persistAndStampSeq(cwd, id, { type: 'primary_text', workflowId: id, text: 'after' } as unknown as ServerMessage);
    await flushWorkflowBuffer(cwd, id);
    assert.deepEqual(seqs(await replayEvents(cwd, id, 0)), range(1, 151));
  });
});
