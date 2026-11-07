import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { brotliCompressSync } from 'node:zlib';
import path from 'node:path';
import {
  listSegments, readLogHeadSync, readLogLines, readLogTail, readLogTailSync, readLogText, readLogTextSync,
  sealLiveLog, segmentName, unsealLog as unsealServer,
} from './eventLog.js';
import { replayEvents } from './workflowStore.js';
// @ts-expect-error plain ES module without types
import { unsealLog as unsealPackage } from '../../scripts/packaging/storage.mjs';

// Logs written before 0.1.5 can hold live records whose numbers repeat or go
// back (a checkpoint record carried its checkpoint's number; REVERT TO HERE
// and a restart right after it reused numbers), including right after a seal.
// Every reader, the seal and both unseal exports must keep every such record,
// in file order, and still show the copied newest sealed record only once.

const rec = (seq: number, content: string) => JSON.stringify({ seq, type: 'user_message_echo', content });
const text = (rs: Array<[number, string]>) => rs.map(([s, c]) => rec(s, c)).join('\n') + '\n';
const contents = (t: string) => t.split('\n').filter(Boolean).map((l) => JSON.parse(l).content as string);

async function tmp(): Promise<string> { return mkdtemp(path.join(tmpdir(), 'arco-legacy-seq-')); }
async function lines(dir: string): Promise<string[]> { const out: string[] = []; for await (const l of readLogLines(dir)) out.push(JSON.parse(l).content); return out; }
async function everyReader(dir: string): Promise<Record<string, string[]>> {
  return {
    readLogLines: await lines(dir),
    readLogText: contents(await readLogText(dir)),
    readLogTextSync: contents(readLogTextSync(dir)),
    readLogTail: contents((await readLogTail(dir, 1 << 20)).text),
    readLogTailSync: contents(readLogTailSync(dir, 1 << 20).text),
    readLogHeadSync: contents(readLogHeadSync(dir, 1 << 20)),
  };
}
function assertAll(got: Record<string, string[]>, want: string[], when: string): void {
  for (const [reader, seen] of Object.entries(got)) assert.deepEqual(seen, want, `${when}: ${reader}`);
}

// R1: unseal kept only records numbered above every earlier one.
test('both unseal exports keep live records with repeated or older numbers, in file order', async () => {
  const want = ['a', 'b', 'c', 'duplicate-checkpoint', 'revert', 'after-revert'];
  for (const [name, unseal] of [['server', unsealServer], ['package', unsealPackage]] as const) {
    const dir = await tmp();
    try {
      await writeFile(path.join(dir, segmentName(1, 2)), brotliCompressSync(text([[1, 'a'], [2, 'b']])));
      await writeFile(path.join(dir, 'events.jsonl'), text([[2, 'b'], [3, 'c'], [3, 'duplicate-checkpoint'], [1, 'revert'], [2, 'after-revert']]));
      assertAll(await everyReader(dir), want, `${name}: before unseal`);
      const result = await unseal(dir);
      assert.equal(result.records, 6, name);
      assert.deepEqual(contents(await readFile(path.join(dir, 'events.jsonl'), 'utf8')), want, `${name}: exported file`);
      assert.deepEqual(await listSegments(dir), [], name);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});

// R2: right after a seal, a revert reused numbers the segment already holds.
test('records with old numbers right after a seal are shown by every reader and sealed, not dropped', async () => {
  const dir = await tmp();
  const old = Array.from({ length: 10 }, (_, i) => [i + 1, `old-${i + 1}`] as [number, string]);
  const want = [...old.map(([, c]) => c), 'revert', 'AFTER-REVERT'];
  try {
    await writeFile(path.join(dir, segmentName(1, 10)), brotliCompressSync(text(old)));
    await writeFile(path.join(dir, 'events.jsonl'), text([[10, 'old-10'], [2, 'revert'], [3, 'AFTER-REVERT']]));
    assertAll(await everyReader(dir), want, 'before the seal');
    const sealed = await sealLiveLog(dir, 1024);
    assert.ok(sealed);
    assert.equal(sealed.sealedRecords, 2);
    assert.deepEqual((await listSegments(dir)).map((s) => [s.firstSeq, s.lastSeq]), [[1, 10], [2, 3]]);
    assert.deepEqual(contents(await readFile(path.join(dir, 'events.jsonl'), 'utf8')), ['old-10'], 'the live file keeps the copied newest record');
    assertAll(await everyReader(dir), want, 'after the seal');
    // Replay gives them numbers after the sealed ones, in file order.
    const cwd = await tmp();
    try {
      const conv = path.join(cwd, '.arco', 'workflows', 'legacy-0001');
      await cp(dir, conv, { recursive: true });
      const events = await replayEvents(cwd, 'legacy-0001', 0);
      assert.deepEqual(events.map((e) => (e as unknown as { content: string }).content), want);
      assert.deepEqual(events.map((e) => (e as unknown as { seq: number }).seq), Array.from({ length: 12 }, (_, i) => i + 1));
    } finally { await rm(cwd, { recursive: true, force: true }); }
    await unsealServer(dir);
    assert.deepEqual(contents(await readFile(path.join(dir, 'events.jsonl'), 'utf8')), want, 'unsealed after the seal');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a record with an old number that cannot be sealed in order keeps the log a plain file, nothing lost', async () => {
  const dir = await tmp();
  const old = Array.from({ length: 10 }, (_, i) => [i + 1, `old-${i + 1}`] as [number, string]);
  const want = [...old.map(([, c]) => c), 'revert', 'after'];
  try {
    await writeFile(path.join(dir, segmentName(1, 5)), brotliCompressSync(text(old.slice(0, 5))));
    await writeFile(path.join(dir, segmentName(6, 10)), brotliCompressSync(text(old.slice(5))));
    const live = text([[10, 'old-10'], [2, 'revert'], [3, 'after']]);
    await writeFile(path.join(dir, 'events.jsonl'), live);
    await assert.rejects(sealLiveLog(dir, 1024), /cannot be sealed/);
    assert.equal(await readFile(path.join(dir, 'events.jsonl'), 'utf8'), live);
    assert.equal((await readdir(dir)).filter((n) => n.endsWith('.br')).length, 2);
    assertAll(await everyReader(dir), want, 'after the refused seal');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the copied record and an interrupted seal are still shown once', async () => {
  const dir = await tmp();
  const all = Array.from({ length: 30 }, (_, i) => [i + 1, `r${i + 1}`] as [number, string]);
  try {
    await writeFile(path.join(dir, segmentName(1, 10)), brotliCompressSync(text(all.slice(0, 10))));
    await writeFile(path.join(dir, segmentName(11, 20)), brotliCompressSync(text(all.slice(10, 20))));
    // A seal wrote 11-20 and stopped before it replaced the live file.
    await writeFile(path.join(dir, 'events.jsonl'), text(all.slice(9)));
    assertAll(await everyReader(dir), all.map(([, c]) => c), 'interrupted seal');
    await sealLiveLog(dir, 1 << 20);
    assertAll(await everyReader(dir), all.map(([, c]) => c), 'after the next seal');
    assert.deepEqual(contents(await readFile(path.join(dir, 'events.jsonl'), 'utf8')), ['r30']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
