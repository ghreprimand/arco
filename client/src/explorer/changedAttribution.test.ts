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

test('POSIX paths never inherit a UNC writer', () => {
  assert.equal(changedAttribution('/server/share/file.md', 10000, [record(String.raw`\\SERVER\SHARE\FILE.MD`, 10000)]), undefined);
});

test('forward and backslash UNC paths match without case sensitivity', () => {
  assert.equal(changedAttribution('//SERVER/Share/file.md', 10000, [record(String.raw`\\server\share\FILE.MD`, 10000)]), 'Build · fixture');
  assert.equal(changedAttribution(String.raw`\\SERVER\Share\file.md`, 10000, [record('//server/share/FILE.MD', 10000)]), 'Build · fixture');
});

test('POSIX filenames preserve literal backslashes and case', () => {
  assert.equal(changedAttribution(String.raw`/project/a\file.md`, 10000, [record('/project/a/file.md', 10000)]), undefined);
  assert.equal(changedAttribution('/project/File.md', 10000, [record('/project/file.md', 10000)]), undefined);
});
