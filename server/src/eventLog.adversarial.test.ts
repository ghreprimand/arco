import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { brotliCompressSync } from 'node:zlib';
import path from 'node:path';
import type { ServerMessage } from '@arco/shared';
import {
  flushWorkflowBuffer, forgetWorkflowBuffer, getHeadSeq, initWorkflowStore, persistAndStampSeq, replayEvents,
} from './workflowStore.js';
import { readLogText, sealLiveLog, segmentName, unsealLog } from './eventLog.js';
import { removeProjectDir } from './testSupport/projectWrites.js';

// Adversarial checks for P7.3. A seal that stops at any step, a reader that
// holds the live file open, and a later seal must keep every record once.

type Rec = { seq: number; type: string; text: string };

function textOf(records: Rec[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n') + '\n';
}

function records(from: number, to: number): Rec[] {
  return Array.from({ length: to - from + 1 }, (_, i) => {
    const seq = from + i;
    return { seq, type: seq % 5 === 0 ? 'user_message_echo' : 'primary_text', text: `event ${seq} ${'x'.repeat(80)}` };
  });
}

async function dirFor(name: string): Promise<{ cwd: string; dir: string }> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'arco-seal-adv-'));
  const dir = path.join(cwd, '.arco', 'workflows', name);
  await mkdir(dir, { recursive: true });
  return { cwd, dir };
}

function seqsOf(events: readonly unknown[]): number[] {
  return events.map((event) => (event as { seq: number }).seq);
}

async function assertHistory(cwd: string, id: string, count: number): Promise<void> {
  const seqs = seqsOf(await replayEvents(cwd, id, 0));
  assert.equal(seqs.length, count, `replayed ${seqs.length} records, wanted ${count}`);
  for (let i = 0; i < seqs.length; i++) assert.equal(seqs[i], i + 1, `sequence broke at ${seqs[i]}`);
}

test('a crash after a good segment is sealed, before the live file is replaced, keeps every record once', async () => {
  const id = 'seal-crash-good';
  const { cwd, dir } = await dirFor(id);
  try {
    const all = records(1, 30);
    await writeFile(path.join(dir, segmentName(1, 10)), brotliCompressSync(textOf(all.slice(0, 10))));
    await writeFile(path.join(dir, 'log-format.json'), '{"format":2}\n');
    await writeFile(path.join(dir, 'events.jsonl'), textOf(all));
    const sealed = await sealLiveLog(dir, 2048);
    assert.ok(sealed);
    await assertHistory(cwd, id, 30);
  } finally { await removeProjectDir(cwd); }
});

test('a segment whose bytes do not match its name does not discard the live copy on the next seal', async () => {
  const id = 'seal-crash-bad';
  const { cwd, dir } = await dirFor(id);
  const original = console.error;
  console.error = () => {};
  try {
    const all = records(1, 30);
    // Read-back failed after the segment was renamed into place: the name
    // claims seq 1-30, the bytes are only seq 1, and the live file still
    // holds the only complete copy. The next seal is a restart.
    await writeFile(path.join(dir, segmentName(1, 30)), brotliCompressSync(textOf(all.slice(0, 1))));
    await writeFile(path.join(dir, 'events.jsonl'), textOf(all));
    await sealLiveLog(dir, 2048);
    await assertHistory(cwd, id, 30);
    assert.ok((await readdir(dir)).some((name) => name.endsWith('.jsonl.br')));
  } finally {
    console.error = original;
    await removeProjectDir(cwd);
  }
});

test('an unreadable segment does not discard the live copy on the next seal', async () => {
  const id = 'seal-crash-corrupt';
  const { cwd, dir } = await dirFor(id);
  const original = console.error;
  console.error = () => {};
  try {
    const all = records(1, 30);
    await writeFile(path.join(dir, segmentName(1, 10)), Buffer.from('not brotli'));
    await writeFile(path.join(dir, 'events.jsonl'), textOf(all));
    await sealLiveLog(dir, 2048);
    await assertHistory(cwd, id, 30);
  } finally {
    console.error = original;
    await removeProjectDir(cwd);
  }
});

test('sealing while a reader holds the live file open keeps one ordered history past 16 MiB', async () => {
  const id = 'seal-open-reader';
  const { cwd, dir } = await dirFor(id);
  const live = path.join(dir, 'events.jsonl');
  try {
    const payload = 'y'.repeat(400);
    const writer = await open(live, 'w');
    let bytes = 0;
    let seq = 0;
    const batch: string[] = [];
    while (bytes < 17 * 1024 * 1024) {
      seq += 1;
      const line = JSON.stringify({ seq, type: 'primary_text', text: payload }) + '\n';
      batch.push(line);
      bytes += Buffer.byteLength(line);
      if (batch.length === 2000) {
        await writer.write(batch.join(''));
        batch.length = 0;
      }
    }
    if (batch.length) await writer.write(batch.join(''));
    await writer.close();
    const reader = await open(live, 'r');
    let replaced = true;
    try {
      await reader.read(Buffer.alloc(64), 0, 64, 0);
      const original = console.error; console.error = () => {};
      let sealed;
      try { sealed = await sealLiveLog(dir); } finally { console.error = original; }
      assert.ok(sealed && sealed.segments.length >= 1);
      // POSIX renames over the open file. Windows refuses: the seal keeps its
      // segments and the complete live file, and leaves no temporary file.
      if (process.platform !== 'win32') assert.equal(sealed.liveReplaced, true);
      replaced = sealed.liveReplaced;
      assert.deepEqual((await readdir(dir)).filter((n) => n.endsWith('.tmp')), []);
      if (!replaced) await assertHistory(cwd, id, seq);
    } finally { await reader.close(); }
    if (!replaced) {
      // Once the reader is gone, the next seal replaces the live file.
      const finished = await sealLiveLog(dir);
      assert.ok(finished && finished.liveReplaced);
    }
    await assertHistory(cwd, id, seq);
    const plainTail = (await readFile(live, 'utf8')).trim().split('\n').at(-1);
    assert.equal(JSON.parse(plainTail!).seq, seq);
  } finally { await removeProjectDir(cwd); }
});

test('writes that arrive during a seal appear once, and unseal then reopen continues the sequence', async () => {
  const id = 'seal-unseal-reopen';
  const cwd = await mkdtemp(path.join(tmpdir(), 'arco-seal-adv-'));
  const before = process.env.ARCO_EVENT_SEGMENT_BYTES;
  process.env.ARCO_EVENT_SEGMENT_BYTES = '2048';
  try {
    await initWorkflowStore(cwd, id);
    for (let i = 0; i < 40; i++) {
      persistAndStampSeq(cwd, id, { type: 'primary_text', workflowId: id, text: `early ${i} ${'z'.repeat(40)}` } as unknown as ServerMessage);
    }
    await flushWorkflowBuffer(cwd, id);
    const sealing = (async () => {
      const { sealWorkflowLogNow } = await import('./workflowStore.js');
      return sealWorkflowLogNow(cwd, id);
    })();
    for (let i = 0; i < 25; i++) {
      persistAndStampSeq(cwd, id, { type: 'user_message_echo', workflowId: id, content: `during ${i}` } as unknown as ServerMessage);
    }
    await sealing;
    await flushWorkflowBuffer(cwd, id);
    const count = seqsOf(await replayEvents(cwd, id, 0)).length;
    await assertHistory(cwd, id, count);
    const full = await readLogText(path.join(cwd, '.arco', 'workflows', id));
    const exported = await unsealLog(path.join(cwd, '.arco', 'workflows', id));
    assert.ok(exported);
    assert.equal(await readFile(path.join(cwd, '.arco', 'workflows', id, 'events.jsonl'), 'utf8'), full);
    forgetWorkflowBuffer(cwd, id);
    await initWorkflowStore(cwd, id);
    assert.equal(await getHeadSeq(cwd, id), count);
    persistAndStampSeq(cwd, id, { type: 'primary_text', workflowId: id, text: 'after reopen' } as unknown as ServerMessage);
    await flushWorkflowBuffer(cwd, id);
    await assertHistory(cwd, id, count + 1);
  } finally {
    if (before === undefined) delete process.env.ARCO_EVENT_SEGMENT_BYTES;
    else process.env.ARCO_EVENT_SEGMENT_BYTES = before;
    await removeProjectDir(cwd);
  }
});
