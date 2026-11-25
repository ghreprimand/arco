// Pins the init memoization: concurrent initWorkflowStore calls for one
// (cwd, wfid) must share a single prime. Before, the second call's
// readLatestSeq could land after the first had stamped events and roll
// buf.seq back — duplicate seqs in events.jsonl, corrupted replay.

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentSeq, hasPendingWorkflowWrites, flushWorkflowBuffer, forgetWorkflowBuffer, initWorkflowStore, persistAndStampSeq } from './workflowStore.js';
import { removeProjectDir } from './testSupport/projectWrites.js';

test('concurrent inits share one prime and never roll seq back', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'arco-wfstore-'));
  const wfid = 'wf-init-race-0001';
  try {
    const dir = join(cwd, '.arco', 'workflows', wfid);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'events.jsonl'), JSON.stringify({ seq: 5, ts: 1, message: { type: 'system_notice' } }) + '\n');

    const first = initWorkflowStore(cwd, wfid);
    const second = initWorkflowStore(cwd, wfid);
    await first;
    // Stamp between the two resolutions — the window the old code lost.
    const stamped = persistAndStampSeq(cwd, wfid, { type: 'system_notice', workflowId: wfid, content: 'x' } as never) as unknown as { seq: number };
    assert.equal(stamped.seq, 6);
    await second;
    await initWorkflowStore(cwd, wfid);
    assert.equal(currentSeq(cwd, wfid), 6);
  } finally {
    await flushWorkflowBuffer(cwd, wfid);
    forgetWorkflowBuffer(cwd, wfid);
    await removeProjectDir(cwd);
  }
});

test('failed conversation append retains the remaining bytes, then writes newer events in order', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'arco-wfstore-'));
  const wfid = 'wf-write-retry';
  const log = join(cwd, '.arco', 'workflows', wfid, 'events.jsonl');
  try {
    await initWorkflowStore(cwd, wfid);
    persistAndStampSeq(cwd, wfid, { type: 'system_notice', workflowId: wfid, content: 'First é' });
    const open = fs.open.bind(fs);
    const fixtureError = Object.assign(new Error('fixture disk full'), { code: 'ENOSPC' });
    t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      if (args[0] === log && args[1] === 'a') {
        const write = handle.write.bind(handle);
        let first = true;
        handle.write = ((buffer: Buffer, offset: number) => {
          if (!first) return Promise.reject(fixtureError);
          first = false;
          const middleOfCharacter = buffer.indexOf(Buffer.from('é')) + 1;
          return write(buffer, offset, middleOfCharacter, null);
        }) as typeof handle.write;
      }
      return handle;
    });
    await assert.rejects(flushWorkflowBuffer(cwd, wfid), { code: 'ENOSPC' });
    assert.equal(hasPendingWorkflowWrites(cwd, wfid), true);
    t.mock.restoreAll();

    persistAndStampSeq(cwd, wfid, { type: 'system_notice', workflowId: wfid, content: 'Second' });
    await flushWorkflowBuffer(cwd, wfid);
    const events = (await readFile(log, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(events.map(event => [event.seq, event.content]), [[1, 'First é'], [2, 'Second']]);
    assert.equal(hasPendingWorkflowWrites(cwd, wfid), false);
  } finally {
    t.mock.restoreAll();
    await flushWorkflowBuffer(cwd, wfid);
    forgetWorkflowBuffer(cwd, wfid);
    await removeProjectDir(cwd);
  }
});
