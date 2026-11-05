import type { CheckpointRestoreChanges } from '@arco/shared';

const files = (n: number) => `${n} ${n === 1 ? 'file' : 'files'}`;

// One line for what a checkpoint restore changes (or changed): used by the
// REVERT TO HERE confirmation, its result line and the REVERTED history row.
export function describeRestoreChanges(c: CheckpointRestoreChanges): string {
  const parts: string[] = [];
  if (c.changed) parts.push(`${files(c.changed)} changed back`);
  if (c.removed) parts.push(`${files(c.removed)} created since removed`);
  if (c.restored) parts.push(`${files(c.restored)} deleted since restored`);
  if (parts.length === 0) return `no file changes; all ${files(c.unchanged)} already match`;
  return `${parts.join(', ')}; ${files(c.unchanged)} unchanged`;
}

export function restoreChangesNothing(c: CheckpointRestoreChanges): boolean {
  return c.changed + c.removed + c.restored === 0;
}
