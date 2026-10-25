// Pins the init memoization: concurrent initWorkflowStore calls for one
// (cwd, wfid) must share a single prime. Before, the second call's
// readLatestSeq could land after the first had stamped events and roll
// buf.seq back — duplicate seqs in events.jsonl, corrupted replay.

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentSeq, forgetWorkflowBuffer, initWorkflowStore, persistAndStampSeq } from './workflowStore.js';

test('concurrent inits share one prime and never roll seq back', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'archon-wfstore-'));
  const wfid = 'wf-init-race-0001';
  try {
    const dir = join(cwd, '.archon', 'workflows', wfid);
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
    forgetWorkflowBuffer(cwd, wfid);
    await rm(cwd, { recursive: true, force: true });
  }
});
