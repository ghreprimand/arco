import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cachedHandoffSeed, invalidateHandoffSeed, isHandoffSeed } from './handoffSeedCache.js';
test('unchanged callers scan once; seed writes and reopened callers rescan', async () => {
 const owner = {}, cwd = 'fixture', id = 'caller'; let scans = 0;
 const scan = async () => { scans++; return `seed-${scans}`; };
 assert.equal(await cachedHandoffSeed(cwd, id, owner, scan), 'seed-1');
 assert.equal(await cachedHandoffSeed(cwd, id, owner, scan), 'seed-1');
 assert.equal(scans, 1);
 invalidateHandoffSeed(cwd, id);
 assert.equal(await cachedHandoffSeed(cwd, id, owner, scan), 'seed-2');
 assert.equal(await cachedHandoffSeed(cwd, id, {}, scan), 'seed-3');
 assert.ok(isHandoffSeed('[HANDOFF: new session initialized for this tab.]'));
 assert.equal(isHandoffSeed('ordinary turn'), false);
});
