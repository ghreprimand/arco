import { getRecallIndex } from '../recall/index.js';

// writeMeta schedules recall projections without awaiting them. Track those
// projections so fixture teardown cannot close the index while one is pending.
export function trackRecallFixture(): () => Promise<void> {
  const index = getRecallIndex();
  const original = index.upsertFromMeta.bind(index);
  const pending = new Set<Promise<void>>();
  index.upsertFromMeta = (meta) => {
    const operation = original(meta);
    pending.add(operation);
    void operation.then(() => pending.delete(operation), () => pending.delete(operation));
    return operation;
  };
  return async () => {
    await Promise.allSettled([...pending]);
    index.upsertFromMeta = original;
    index.close();
  };
}
