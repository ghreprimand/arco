import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { brotliCompressSync } from 'node:zlib';
import path from 'node:path';
import type { ServerMessage } from '@arco/shared';
import {
  flushWorkflowBuffer, forgetWorkflowBuffer, initWorkflowStore, persistAndStampSeq,
} from './workflowStore.js';
import { removeProjectDir } from './testSupport/projectWrites.js';
import {
  readLogHeadSync, readLogTail, readLogTailSync, readLogText, readLogTextSync, sealLiveLog, segmentName,
} from './eventLog.js';
import { replayEvents } from './workflowStore.js';

// Further checks on the seal that moves a damaged segment aside instead of
// trusting its name. A reader may hold the damaged file. Records that exist
// only in a sound segment stay visible. A sequence number is never reused.

const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const original = console.error;
  console.error = () => {};
  try { return await fn(); } finally { console.error = original; }
};

function line(seq: number): string {
  return JSON.stringify({ seq, type: 'primary_text', text: `event ${seq} ${'x'.repeat(40)}` });
}
function text(from: number, to: number): string {
  return Array.from({ length: to - from + 1 }, (_, i) => line(from + i)).join('\n') + '\n';
}
function seqs(body: string): number[] {
  return body.split('\n').filter(Boolean).map((row) => JSON.parse(row).seq as number);
}

async function folder(): Promise<{ cwd: string; dir: string }> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'arco-damage-'));
  const dir = path.join(cwd, '.arco', 'workflows', 'damage-1');
  await mkdir(dir, { recursive: true });
  return { cwd, dir };
}

async function history(cwd: string): Promise<number[]> {
  return (await replayEvents(cwd, 'damage-1', 0)).map((event) => (event as unknown as { seq: number }).seq);
}

test('a damaged middle segment is moved aside while a reader holds it, and a later seal does not change the history', async () => {
  const { cwd, dir } = await folder();
  try {
    const damaged = path.join(dir, segmentName(11, 20));
    await writeFile(path.join(dir, segmentName(1, 10)), brotliCompressSync(text(1, 10)));
    await writeFile(damaged, Buffer.from('middle-not-brotli'));
    await writeFile(path.join(dir, segmentName(21, 30)), brotliCompressSync(text(21, 30)));
    await writeFile(path.join(dir, 'events.jsonl'), text(1, 35));
    const reader = await open(damaged, 'r');
    let replaced = true;
    const live = await open(path.join(dir, 'events.jsonl'), 'r');
    try {
      await reader.read(Buffer.alloc(8), 0, 8, 0);
      await live.read(Buffer.alloc(8), 0, 8, 0);
      const sealed = await quiet(() => sealLiveLog(dir, 1 << 20));
      assert.ok(sealed && sealed.movedAside.length === 1);
      // Windows refuses to replace the live file while it is open; the seal
      // then keeps it complete (see eventLog.adversarial.test.ts).
      if (process.platform !== 'win32') assert.equal(sealed.liveReplaced, true);
      replaced = sealed.liveReplaced;
    } finally {
      await reader.close();
      await live.close();
    }
    if (!replaced) {
      assert.deepEqual(await history(cwd), Array.from({ length: 35 }, (_, i) => i + 1));
      const finished = await quiet(() => sealLiveLog(dir, 1 << 20));
      assert.ok(finished && finished.liveReplaced);
    }
    assert.deepEqual(await history(cwd), Array.from({ length: 35 }, (_, i) => i + 1));
    const names = await readdir(dir);
    const aside = names.find((name) => name.includes('.damaged-'));
    assert.ok(aside, 'the damaged bytes are renamed, not deleted');
    assert.equal(await readFile(path.join(dir, aside!), 'utf8'), 'middle-not-brotli');
    const again = await quiet(() => sealLiveLog(dir, 1 << 20));
    const third = await quiet(() => sealLiveLog(dir, 1 << 20));
    assert.equal(again, null);
    assert.equal(third, null);
    assert.deepEqual(await history(cwd), Array.from({ length: 35 }, (_, i) => i + 1));
    assert.equal((await readdir(dir)).filter((name) => name.includes('.damaged-')).length, 1);
  } finally { await removeProjectDir(cwd); }
});

test('records that survive only in sound segments stay visible when the damaged segment is not in the live file', async () => {
  const { cwd, dir } = await folder();
  try {
    const damagedName = segmentName(11, 20);
    await writeFile(path.join(dir, segmentName(1, 10)), brotliCompressSync(text(1, 10)));
    await writeFile(path.join(dir, damagedName), Buffer.from('gone-from-live'));
    await writeFile(path.join(dir, segmentName(21, 30)), brotliCompressSync(text(21, 30)));
    // The live file holds only the copied newest record. Sequences 11-20 exist
    // only in the unreadable segment; 1-10 and 21-30 exist only in sound ones.
    await writeFile(path.join(dir, 'events.jsonl'), text(30, 30));
    const before = await readFile(path.join(dir, damagedName));
    const want = [...Array.from({ length: 10 }, (_, i) => i + 1), ...Array.from({ length: 10 }, (_, i) => i + 21)];
    const seen = (body: string, reader: string) => {
      const got = seqs(body);
      for (const seq of want) assert.ok(got.includes(seq), `${reader} is missing sequence ${seq}; saw ${got.join(',')}`);
    };
    await quiet(async () => {
      assert.deepEqual(await history(cwd), want);
      seen(await readLogText(dir), 'readLogText');
      seen(readLogTextSync(dir), 'readLogTextSync');
      seen(readLogHeadSync(dir, 1 << 20), 'readLogHeadSync');
      const sealed = await sealLiveLog(dir, 1 << 20);
      assert.equal(sealed, null, 'a seal must not rewrite history it cannot recover');
    });
    const names = await readdir(dir);
    assert.ok(names.includes(damagedName), 'the unreadable segment is still on disk');
    assert.deepEqual(await readFile(path.join(dir, damagedName)), before);
    await quiet(async () => {
      assert.deepEqual(await history(cwd), want);
      seen((await readLogTail(dir, 1 << 20)).text, 'readLogTail');
      seen(readLogTailSync(dir, 1 << 20).text, 'readLogTailSync');
    });
  } finally { await removeProjectDir(cwd); }
});

test('a sequence number named by a damaged segment is not allocated again', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'arco-seq-'));
  const id = 'seq-1';
  const dir = path.join(cwd, '.arco', 'workflows', id);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, segmentName(1, 10)), brotliCompressSync(text(1, 10)));
    await writeFile(path.join(dir, segmentName(11, 40)), Buffer.from('named-through-40'));
    await writeFile(path.join(dir, 'events.jsonl'), text(20, 20));
    await quiet(() => initWorkflowStore(cwd, id));
    const reserved = persistAndStampSeq(cwd, id, { type: 'primary_text', workflowId: id, text: 'while damaged' } as unknown as ServerMessage) as { seq?: number };
    assert.ok((reserved.seq ?? 0) > 40, `allocated ${reserved.seq} while a segment is still named through 40`);
    await flushWorkflowBuffer(cwd, id);
    forgetWorkflowBuffer(cwd, id);
    await quiet(() => sealLiveLog(dir, 1 << 20));
    const aside = (await readdir(dir)).find((name) => name.includes('.damaged-'));
    assert.ok(aside, 'the named segment is kept after it is moved aside');
    assert.equal(await readFile(path.join(dir, aside!), 'utf8'), 'named-through-40');
    await quiet(() => initWorkflowStore(cwd, id));
    const after = persistAndStampSeq(cwd, id, { type: 'primary_text', workflowId: id, text: 'after aside' } as unknown as ServerMessage) as { seq?: number };
    assert.ok((after.seq ?? 0) > 40, `allocated ${after.seq} after the segment named through 40 was moved aside`);
  } finally { await removeProjectDir(cwd); }
});
