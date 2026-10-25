// Genesis M2 — scratch→real store rebind invariant smoke.
//
// Module-level (no live server, no API spend). The risky part of M2's chosen
// "scratch dir + rebind" model is carrying the workflow's on-disk store from the
// hidden ideation dir to the real project dir WITHOUT losing the transcript or
// breaking monotonic seq. This proves that contract against the real workflowStore
// API + the same move the handler performs:
//
//   (1) run some events in the scratch store, flush.
//   (2) flush + move .arco/workflows/<wfid> scratch→real, forget the scratch
//       buffer, re-init the store at the real dir.
//   (3) assert: seq is recovered from the moved events.jsonl (continues, no reset),
//       the prior events replay in order (transcript carried over), and the next
//       event continues the sequence.
//
// Run: npm run smoke:genesis-rebind   (no server needed)

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { step, assert, assertEq, summary } from './lib.js';
import {
  initWorkflowStore,
  persistAndStampSeq,
  currentSeq,
  replayEvents,
  flushWorkflowBuffer,
  forgetWorkflowBuffer,
  flushAll,
} from '../../server/src/workflowStore.js';
import type { ServerMessage } from '../../shared/src/protocol/index.js';

// A workflow-scoped event shaped like the ones the server stamps.
function notice(wfid: string, content: string): ServerMessage {
  return { type: 'system_notice', workflowId: wfid, content } as ServerMessage;
}

// The same move handleGenesisScaffold performs (rename with EXDEV fallback).
async function moveStore(scratch: string, real: string, wfid: string): Promise<void> {
  const from = path.join(scratch, '.arco', 'workflows', wfid);
  const to = path.join(real, '.arco', 'workflows', wfid);
  await fs.mkdir(path.dirname(to), { recursive: true });
  try {
    await fs.rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    await fs.cp(from, to, { recursive: true });
    await fs.rm(from, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'arco-genesis-rebind-'));
  const scratch = path.join(tmp, 'scratch');
  const real = path.join(tmp, 'project');
  await fs.mkdir(scratch, { recursive: true });
  await fs.mkdir(real, { recursive: true });
  const wfid = randomUUID();

  try {
    await step('ideation: 3 events land in the scratch store', async () => {
      await initWorkflowStore(scratch, wfid);
      const a = persistAndStampSeq(scratch, wfid, notice(wfid, 'spark captured')) as { seq?: number };
      const b = persistAndStampSeq(scratch, wfid, notice(wfid, 'concept captured')) as { seq?: number };
      const c = persistAndStampSeq(scratch, wfid, notice(wfid, 'case captured')) as { seq?: number };
      assertEq(a.seq, 1, 'first seq');
      assertEq(b.seq, 2, 'second seq');
      assertEq(c.seq, 3, 'third seq');
      await flushAll();
      assertEq(currentSeq(scratch, wfid), 3, 'scratch head seq after 3 events');
    });

    await step('rebind: move the store, forget scratch buffer, re-init at real dir', async () => {
      await flushWorkflowBuffer(scratch, wfid);
      await moveStore(scratch, real, wfid);
      forgetWorkflowBuffer(scratch, wfid);
      await initWorkflowStore(real, wfid);
      // Seq recovered from the MOVED events.jsonl tail — not reset to 0.
      assertEq(currentSeq(real, wfid), 3, 'real head seq recovered from moved file');
      // The scratch store dir is gone (rename moved it).
      const scratchStore = path.join(scratch, '.arco', 'workflows', wfid);
      const stillThere = await fs.lstat(scratchStore).then(() => true).catch(() => false);
      assert(!stillThere, 'scratch store dir no longer exists after move');
    });

    await step('continuity: transcript replays + the next event continues the sequence', async () => {
      const replayed = await replayEvents(real, wfid, 0);
      assertEq(replayed.length, 3, 'all 3 ideation events carried over');
      const contents = replayed.map((m) => (m as { content?: string }).content);
      assertEq(contents.join('|'), 'spark captured|concept captured|case captured', 'transcript order preserved');
      const next = persistAndStampSeq(real, wfid, notice(wfid, 'scaffolded')) as { seq?: number };
      assertEq(next.seq, 4, 'post-rebind event continues the sequence');
      await flushAll();
      const all = await replayEvents(real, wfid, 0);
      assertEq(all.length, 4, 'real store now holds all 4 events');
    });
  } finally {
    await flushAll();
    await fs.rm(tmp, { recursive: true, force: true });
  }

  summary('genesis-rebind');
}

main().catch((err) => { console.error(err); process.exit(1); });
