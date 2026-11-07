import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ServerMessage } from '@arco/shared';
import { flushWorkflowBuffer, initWorkflowStore, persistAndStampSeq, replayEvents } from './workflowStore.js';
import { removeProjectDir } from './testSupport/projectWrites.js';

// A crash or a failed append can leave the live log ending in an incomplete
// record without its newline. The first event saved after the restart must
// start on its own line instead of being glued to that record and lost on
// replay. The incomplete bytes are kept beside the log, never deleted.

async function project(fn: (cwd: string, dir: (id: string) => string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'arco-partial-tail-'));
  try { await fn(cwd, (id) => path.join(cwd, '.arco', 'workflows', id)); }
  finally { await removeProjectDir(cwd); }
}
const BEFORE = JSON.stringify({ seq: 1, ts: 1, type: 'user_message_echo', content: 'before' }) + '\n';
const contentOf = (e: unknown) => (e as { content?: string }).content;

async function restartAndSave(cwd: string, id: string): Promise<unknown[]> {
  await initWorkflowStore(cwd, id);
  persistAndStampSeq(cwd, id, { type: 'user_message_echo', workflowId: id, content: 'AFTER-RESTART' } as unknown as ServerMessage);
  await flushWorkflowBuffer(cwd, id);
  return replayEvents(cwd, id, 0);
}

test('an incomplete last record does not swallow the next saved event; its bytes are kept aside', async () => {
  await project(async (cwd, dir) => {
    const id = 'partial-0001';
    const cut = '{"seq":2,"type":"user_message_echo","content":"cut';
    await mkdir(dir(id), { recursive: true });
    await writeFile(path.join(dir(id), 'events.jsonl'), BEFORE + cut);
    const events = await restartAndSave(cwd, id);
    assert.deepEqual(events.map(contentOf), ['before', 'AFTER-RESTART']);
    const live = await readFile(path.join(dir(id), 'events.jsonl'), 'utf8');
    assert.ok(live.startsWith(BEFORE) && live.endsWith('\n'));
    assert.ok(live.split('\n').filter(Boolean).every((l) => { try { JSON.parse(l); return true; } catch { return false; } }), 'every line of the live log parses');
    const aside = (await readdir(dir(id))).filter((n) => n.startsWith('events.jsonl.partial-'));
    assert.equal(aside.length, 1);
    assert.equal(await readFile(path.join(dir(id), aside[0]), 'utf8'), cut);
  });
});

test('a complete last record that only lacks its newline is kept in place', async () => {
  await project(async (cwd, dir) => {
    const id = 'partial-0002';
    const whole = JSON.stringify({ seq: 2, ts: 2, type: 'user_message_echo', content: 'whole' });
    await mkdir(dir(id), { recursive: true });
    await writeFile(path.join(dir(id), 'events.jsonl'), BEFORE + whole);
    const events = await restartAndSave(cwd, id);
    assert.deepEqual(events.map(contentOf), ['before', 'whole', 'AFTER-RESTART']);
    assert.deepEqual(events.map((e) => (e as { seq: number }).seq), [1, 2, 3]);
    assert.deepEqual((await readdir(dir(id))).filter((n) => n.startsWith('events.jsonl.partial-')), []);
  });
});

test('a live log that is only an incomplete record', async () => {
  await project(async (cwd, dir) => {
    const id = 'partial-0003';
    await mkdir(dir(id), { recursive: true });
    await writeFile(path.join(dir(id), 'events.jsonl'), '{"seq":1,"type":"workflow_cr');
    const events = await restartAndSave(cwd, id);
    assert.deepEqual(events.map(contentOf), ['AFTER-RESTART']);
  });
});
