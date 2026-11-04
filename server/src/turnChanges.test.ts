import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTurnNumstat } from './turnChanges.js';

test('turn numstat counts text and binary files and preserves unusual file names', () => {
  assert.deepEqual(parseTurnNumstat('2\t1\tfile with\ttab.txt\0-\t-\timage.png\0'), {
    fileCount: 2, added: 2, removed: 1, binaryFiles: 1,
    paths: ['file with\ttab.txt', 'image.png'], pathsTruncated: false,
  });
  assert.deepEqual(parseTurnNumstat(''), {fileCount:0,added:0,removed:0,binaryFiles:0,paths:[],pathsTruncated:false});
});
test('turn numstat bounds paths and rejects malformed or unsafe counts', () => {
  const input = Array.from({length: 14}, (_, i) => `1\t0\t${i}-${'x'.repeat(210)}\0`).join('');
  const summary = parseTurnNumstat(input)!;
  assert.equal(summary.fileCount, 14); assert.equal(summary.paths.length, 12);
  assert.equal(summary.paths[0].length, 200); assert.equal(summary.pathsTruncated, true);
  assert.equal(parseTurnNumstat('bad\0'), null);
  assert.equal(parseTurnNumstat('-\t1\ta\0'), null);
  assert.equal(parseTurnNumstat('9007199254740992\t1\ta\0'), null);
});

test('a late pre-turn snapshot is discarded and a timely failure does not block', async () => {
  const { timelyCheckpoint } = await import('./turnChanges.js');
  let finish!: (value: string) => void;
  const late = new Promise<string>(resolve => { finish = resolve; });
  assert.equal(await timelyCheckpoint(late, 5), null);
  finish('too late');
  assert.equal(await timelyCheckpoint(Promise.resolve('ready'), 50), 'ready');
  assert.equal(await timelyCheckpoint(Promise.reject(new Error('fixture')), 50), null);
});

test('only provably read-only turns skip capture', async () => {
  const { shouldCaptureTurn } = await import('./turnChanges.js');
  const base = {chatMode:false,planMode:false,isolated:false,provider:'ollama'};
  assert.equal(shouldCaptureTurn({...base,tools:['Read','Grep']}), false);
  assert.equal(shouldCaptureTurn({...base,tools:[]}), false);
  assert.equal(shouldCaptureTurn({...base,tools:['Bash']}), true);
  assert.equal(shouldCaptureTurn({...base,tools:['custom']}), true);
  assert.equal(shouldCaptureTurn({...base,provider:'codex',tools:[]}), true);
  assert.equal(shouldCaptureTurn({...base,chatMode:true}), false);
  assert.equal(shouldCaptureTurn({...base,isolated:true}), false);
  assert.equal(shouldCaptureTurn({...base,planMode:true}), false);
});
