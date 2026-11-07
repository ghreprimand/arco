import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { brotliCompressSync } from 'node:zlib';
import path from 'node:path';
import { readLogLines, segmentName } from './eventLog.js';
// @ts-expect-error plain ES module without types
import { unsealLog } from '../../scripts/packaging/storage.mjs';

// A sealed segment that disappears (ARCHIVE or DELETE running meanwhile) or
// cannot be opened between listing and reading is reported and skipped like
// any unreadable segment; the reader does not crash the process.

const rec = (seq: number) => JSON.stringify({ seq, type: 'primary_text', text: `r${seq}` }) + '\n';

test('a segment removed while a full-history reader runs is skipped, not a crash', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'arco-vanish-'));
  try {
    await writeFile(path.join(dir, segmentName(1, 1)), brotliCompressSync(rec(1)));
    await writeFile(path.join(dir, segmentName(2, 2)), brotliCompressSync(rec(2)));
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.join(' ')); };
    const seen: number[] = [];
    try {
      for await (const line of readLogLines(dir)) {
        seen.push(JSON.parse(line).seq);
        if (seen.length === 1) await rm(path.join(dir, segmentName(2, 2)));
      }
    } finally { console.error = original; }
    assert.deepEqual(seen, [1]);
    assert.ok(errors.some((e) => e.includes(segmentName(2, 2)) && e.includes('could not be read')), errors.join('\n'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('arco storage unseal reports a segment it cannot open and keeps the others', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'arco-vanish-'));
  try {
    await writeFile(path.join(dir, segmentName(1, 1)), brotliCompressSync(rec(1)));
    // A name that lists as a segment but cannot be opened as a file.
    await import('node:fs/promises').then((fs) => fs.mkdir(path.join(dir, segmentName(2, 2))));
    await writeFile(path.join(dir, 'events.jsonl'), rec(2));
    await assert.rejects(unsealLog(dir));
    const { readdir } = await import('node:fs/promises');
    assert.ok((await readdir(dir)).includes(segmentName(1, 1)), 'nothing is removed when a segment cannot be read');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
