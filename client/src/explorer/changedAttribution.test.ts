import test from 'node:test';
import assert from 'node:assert/strict';
import { changedAttribution } from './changedAttribution.js';
import type { RecentRecord } from './types.js';

const record = (path: string, ts: number, tabTitle = 'Build'): RecentRecord => ({ path, ts, tabTitle, provider: 'fixture', tool: 'write', workflowId: 'one', op: 'modified' });
test('changed files use the newest matching, current ledger entry only', () => {
  assert.equal(changedAttribution('/project/file.md', 10000, [record('/project/file.md', 8000)]), 'Build · fixture');
  assert.equal(changedAttribution('/project/file.md', 10001, [record('/project/file.md', 8000)]), undefined);
  assert.equal(changedAttribution('/project/file.md', 10000, [record('/project/other.md', 10000)]), undefined);
  assert.equal(changedAttribution('/project/file.md', 10000, [record('/project/file.md', 8000, 'Old'), record('/project/file.md', 9900, 'New')]), 'New · fixture');
  assert.equal(changedAttribution(String.raw`C:\\Project\\file.md`, 10000, [record('c:/project/file.md', 10000)]), 'Build · fixture');
  assert.equal(changedAttribution('/Project/file.md', 10000, [record('/project/file.md', 10000)]), undefined);
});
