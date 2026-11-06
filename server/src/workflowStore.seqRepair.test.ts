import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { brotliCompressSync } from 'node:zlib';
import path from 'node:path';
import type { ServerMessage } from '@arco/shared';
import {
  flushWorkflowBuffer, forgetWorkflowBuffer, getHeadSeq, initWorkflowStore, persistAndStampSeq,
  readEventsPageBefore, replayEvents, replayEventsWithTs, replayTailEvents, scanEventsOfTypes, sealWorkflowLogNow,
} from './workflowStore.js';
import { listSegments, readLogText, segmentName, segmentTextMatches } from './eventLog.js';
import { removeProjectDir } from './testSupport/projectWrites.js';

// Logs written before 0.1.5 carry a checkpoint's own number in `seq`: every
// checkpoint_created repeats the previous record's number, a REVERT TO HERE
// record goes back to the restored checkpoint's number, and a restart right
// after it reused numbers already in the log. Readers give each record, in
// file order, one effective number; nothing on disk is rewritten.

type Rec = { seq: number; ts?: number; type: string; n?: number; [k: string]: unknown };
const seqOf = (e: unknown) => (e as { seq: number }).seq;
const nOf = (e: unknown) => (e as { n?: number }).n;

async function project(fn: (cwd: string, dir: (id: string) => string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'arco-seq-repair-'));
  try { await fn(cwd, (id) => path.join(cwd, '.arco', 'workflows', id)); }
  finally { await removeProjectDir(cwd); }
}

async function seed(dir: string, records: Rec[]): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'events.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

// A legacy log shaped like the one found on a release candidate: turns with a
// checkpoint record repeating the previous number, a revert record with the
// checkpoint's old number, then (after a restart) numbers reused from just
// above it, running on past the old head. `n` numbers the records in file order.
function legacyLog(): Rec[] {
  const out: Rec[] = [];
  let n = 0, seq = 0;
  const add = (r: Omit<Rec, 'n'>) => { out.push({ ...r, n: n++ } as Rec); };
  for (let t = 0; t < 30; t++) {
    seq++; add({ seq, ts: seq, type: 'user_message_echo', workflowId: 'w', content: `question ${t}` });
    add({ seq, ts: seq, type: 'checkpoint_created', workflowId: 'w', ref: `refs/arco/w/${seq}`, label: `before turn ${t}`, fileCount: 1 });
    seq += 2; add({ seq, ts: seq, type: 'primary_text', workflowId: 'w', text: `answer ${t}` });
    seq++; add({ seq, ts: seq, type: 'primary_turn_ended', workflowId: 'w' });
  }
  const head = seq;
  add({ seq: head, ts: head, type: 'checkpoint_created', workflowId: 'w', ref: `refs/arco/w/${head}`, label: 'pre-revert', fileCount: 1 });
  add({ seq: 9, ts: head + 1, type: 'checkpoint_reverted', workflowId: 'w', restoredSeq: 9, fileCount: 1, safetySnapshotRef: `refs/arco/w/${head}`, safetySnapshotSeq: head, backend: 'git' });
  // Restart: numbering continued from 9, reusing 10.. and past the old head.
  seq = 9;
  for (let t = 0; t < 30; t++) {
    seq++; add({ seq, ts: head + 2 + t, type: 'user_message_echo', workflowId: 'w', content: `after ${t}` });
    seq++; add({ seq, ts: head + 2 + t, type: 'primary_text', workflowId: 'w', text: `reply ${t}` });
    seq++; add({ seq, ts: head + 2 + t, type: 'primary_turn_ended', workflowId: 'w' });
  }
  return out;
}

function assertFileOrder(events: readonly unknown[], expected: number[]): void {
  assert.deepEqual(events.map(nOf), expected, 'each record once, in file order');
  const seqs = events.map(seqOf);
  for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i] > seqs[i - 1], `seq rises at ${i}: ${seqs[i - 1]} -> ${seqs[i]}`);
}

test('a legacy log with repeated and backward numbers reads in file order, every record once, on every reader', async () => {
  await project(async (cwd, dir) => {
    const id = 'legacy-0001';
    const records = legacyLog();
    await seed(dir(id), records);
    const before = await readFile(path.join(dir(id), 'events.jsonl'), 'utf8');
    const all = records.map((r) => r.n as number);

    const full = await replayEvents(cwd, id, 0);
    assertFileOrder(full, all);
    // Checkpoint records keep what identifies the checkpoint.
    const created = full.find((e) => (e as { type: string }).type === 'checkpoint_created') as unknown as Rec;
    assert.equal(created.ref, 'refs/arco/w/1');
    const reverted = full.find((e) => (e as { type: string }).type === 'checkpoint_reverted') as unknown as Rec;
    assert.equal(reverted.restoredSeq, 9);
    // parentEventSeq follows the effective numbers where they were repaired.
    const ri = full.indexOf(reverted as unknown as ServerMessage);
    assert.equal((full[ri + 1] as unknown as Rec).parentEventSeq, seqOf(full[ri]));

    const effective = new Map(full.map((e) => [nOf(e), seqOf(e)]));
    // Readers starting partway agree with the full read.
    const from = seqOf(full[100]);
    assert.deepEqual((await replayEvents(cwd, id, from)).map(nOf), all.slice(101));
    assert.deepEqual((await replayEventsWithTs(cwd, id, from)).map((e) => nOf(e.message)), all.slice(101));
    const page = await readEventsPageBefore(cwd, id, seqOf(full[150]), 40);
    assert.deepEqual(page.events.map(nOf), all.slice(110, 150));
    for (const e of page.events) assert.equal(seqOf(e), effective.get(nOf(e)));
    const tail = await replayTailEvents(cwd, id, 2048);
    for (const e of tail.events) assert.equal(seqOf(e), effective.get(nOf(e)), 'tail numbers match the full read');
    assert.equal(nOf(tail.events.at(-1)), all.at(-1));
    const echoes = await scanEventsOfTypes(cwd, id, ['user_message_echo']);
    assert.equal(echoes.length, 60);
    for (const e of echoes) assert.equal(seqOf(e), effective.get(nOf(e)));

    // New records continue after the last effective number.
    await initWorkflowStore(cwd, id);
    assert.equal(await getHeadSeq(cwd, id), seqOf(full.at(-1)));
    persistAndStampSeq(cwd, id, { type: 'user_message_echo', workflowId: id, content: 'new', n: all.length } as unknown as ServerMessage);
    await flushWorkflowBuffer(cwd, id);
    assertFileOrder(await replayEvents(cwd, id, 0), [...all, all.length]);

    // Nothing written before was changed.
    assert.ok((await readFile(path.join(dir(id), 'events.jsonl'), 'utf8')).startsWith(before));
    forgetWorkflowBuffer(cwd, id);
  });
});

test('a log whose only repeats are checkpoint records keeps its numbers and reads the same from a tail', async () => {
  await project(async (cwd, dir) => {
    const id = 'legacy-0002';
    const records = legacyLog().slice(0, 120); // 30 turns, no revert
    await seed(dir(id), records);
    const full = await replayEvents(cwd, id, 0);
    assertFileOrder(full, records.map((r) => r.n as number));
    // The checkpoint record takes the number its envelope was given (N + 1).
    assert.deepEqual(full.slice(0, 4).map(seqOf), [1, 2, 3, 4]);
    const effective = new Map(full.map((e) => [nOf(e), seqOf(e)]));
    const tail = await replayTailEvents(cwd, id, 2048);
    assert.equal(tail.truncated, true, 'read from the tail, not in full');
    for (const e of tail.events) assert.equal(seqOf(e), effective.get(nOf(e)));
    assert.deepEqual((await replayEvents(cwd, id, 60)).map(nOf), full.filter((e) => seqOf(e) > 60).map(nOf));
  });
});

test('a payload seq never replaces the number the log assigns', async () => {
  await project(async (cwd, dir) => {
    const id = 'writer-0001';
    await initWorkflowStore(cwd, id);
    for (let i = 0; i < 5; i++) persistAndStampSeq(cwd, id, { type: 'user_message_echo', workflowId: id, content: `q${i}` } as unknown as ServerMessage);
    const wire = persistAndStampSeq(cwd, id, { type: 'checkpoint_created', workflowId: id, checkpointSeq: 5, seq: 5, parentEventSeq: 1, ref: 'refs/arco/x/5', label: 'l', ts: 1, fileCount: 1 } as unknown as ServerMessage) as unknown as Rec;
    assert.equal(wire.seq, 6); assert.equal(wire.parentEventSeq, 5); assert.equal(wire.checkpointSeq, 5);
    await flushWorkflowBuffer(cwd, id);
    const lines = (await readFile(path.join(dir(id), 'events.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as Rec);
    assert.deepEqual(lines.map((l) => l.seq), [1, 2, 3, 4, 5, 6]);
    assert.equal(lines[5].checkpointSeq, 5);
    assert.equal(lines[5].parentEventSeq, 5);
    forgetWorkflowBuffer(cwd, id);
  });
});

test('segments of a legacy log with repeated numbers stay sound, and sealing a legacy log loses nothing', async () => {
  // Content check: a repeated or older number inside a segment is allowed;
  // the first record and the highest number must match the name.
  const text = [1, 2, 2, 4, 3, 5].map((seq) => JSON.stringify({ seq, type: 't' })).join('\n') + '\n';
  assert.equal(segmentTextMatches({ firstSeq: 1, lastSeq: 5 }, text), true);
  assert.equal(segmentTextMatches({ firstSeq: 1, lastSeq: 4 }, text), false);
  assert.equal(segmentTextMatches({ firstSeq: 2, lastSeq: 5 }, text), false);

  await project(async (cwd, dir) => {
    const before = process.env.ARCO_EVENT_SEGMENT_BYTES;
    process.env.ARCO_EVENT_SEGMENT_BYTES = '2048';
    try {
      const id = 'legacy-seal-1';
      const records = legacyLog();
      // An earlier seal (as 0.1.4 wrote it) holds the first turns, with their
      // repeated checkpoint numbers; the live file starts with its copied
      // newest record.
      const sealed = records.slice(0, 20);
      const top = sealed.reduce((m, r) => (r.seq > m.seq ? r : m), sealed[0]);
      await mkdir(dir(id), { recursive: true });
      await writeFile(path.join(dir(id), segmentName(1, top.seq)), brotliCompressSync(Buffer.from(sealed.map((r) => JSON.stringify(r)).join('\n') + '\n')));
      await writeFile(path.join(dir(id), 'log-format.json'), JSON.stringify({ format: 2 }) + '\n');
      await writeFile(path.join(dir(id), 'events.jsonl'), [top, ...records.slice(20)].map((r) => JSON.stringify(r)).join('\n') + '\n');
      const all = records.map((r) => r.n as number);
      assertFileOrder(await replayEvents(cwd, id, 0), all);

      const result = await sealWorkflowLogNow(cwd, id);
      assert.ok(result && result.segments.length > 0, 'the live file was sealed');
      assert.deepEqual(result.movedAside, [], 'the legacy segment is not treated as damaged');
      const names = (await readdir(dir(id))).filter((name) => name.includes('.damaged-'));
      assert.deepEqual(names, []);
      assertFileOrder(await replayEvents(cwd, id, 0), all);
      // Segment names keep file order.
      const segments = await listSegments(dir(id));
      for (let i = 1; i < segments.length; i++) assert.ok(segments[i].firstSeq > segments[i - 1].lastSeq, 'segments do not overlap');
      // A second seal after a restart (segment checks redone from disk) keeps everything.
      forgetWorkflowBuffer(cwd, id);
      await initWorkflowStore(cwd, id);
      persistAndStampSeq(cwd, id, { type: 'user_message_echo', workflowId: id, content: 'x'.repeat(3000), n: all.length } as unknown as ServerMessage);
      await flushWorkflowBuffer(cwd, id);
      await sealWorkflowLogNow(cwd, id);
      assertFileOrder(await replayEvents(cwd, id, 0), [...all, all.length]);
      const text = await readLogText(dir(id));
      assert.equal(text.trim().split('\n').length, all.length + 1, 'the plain history holds every record once');
      forgetWorkflowBuffer(cwd, id);
    } finally {
      if (before === undefined) delete process.env.ARCO_EVENT_SEGMENT_BYTES; else process.env.ARCO_EVENT_SEGMENT_BYTES = before;
    }
  });
});
