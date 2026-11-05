import { rm } from 'node:fs/promises';
import { settleMetaSideEffects } from '../workflowMeta.js';
import { flushAll } from '../workflowStore.js';

// Writes into <cwd>/.arco that callers start but do not await: the debounced
// event-log flush and the index upserts writeMeta fires. A test that removes
// its project folder while one of them still runs races it (the write
// recreates a folder mid-removal and rm fails with ENOTEMPTY), so it waits
// for all of them first.
export async function settleProjectWrites(): Promise<void> {
  await settleMetaSideEffects();
  await flushAll();
  await settleMetaSideEffects();
}

/** Wait for the background writes, then remove the folder. */
export async function removeProjectDir(dir: string): Promise<void> {
  await settleProjectWrites();
  await rm(dir, { recursive: true, force: true });
}
