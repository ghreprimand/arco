// updateMeta() read-modify-write serialization.
//
// Run: npm run test:workflow-meta
//   node --conditions development --import tsx --test server/src/workflowMeta.test.ts
//
// The pre-updateMeta helpers did readMeta → mutate → writeMeta with no lock, so
// two concurrent writers both loaded the same meta and the later write dropped
// the earlier field (a fire-and-forget setResolvedModelId clobbering a CONFIG
// toggle, etc.). These pin that concurrent updateMeta calls all land.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

// writeMeta fires a recall-index upsert under ~/.archon — point HOME at a temp
// dir BEFORE the module loads so the test never touches the operator's index.
const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'archon-meta-home-'));
process.env.HOME = fakeHome;
const metaMod = await import('./workflowMeta.js');
const { readMeta, writeMeta, updateMeta, setResolvedModelId, appendCliSession, touchLastActive } = metaMod;
type WorkflowMeta = import('./workflowMeta.js').WorkflowMeta;

const WFID = '11111111-2222-3333-4444-555555555555';
let cwd = '';

function seed(): WorkflowMeta {
  return {
    workflowId: WFID,
    name: 'meta test',
    cwd,
    // 'chat' skips the project session-index upsert side effect.
    kind: 'chat',
    createdAt: 1,
    lastActiveAt: 1,
    primaryProvider: 'claude',
    primaryModel: 'opus',
    primaryEffort: 'high',
    cliSessions: [],
    operator: 'operator',
    lastEventSeq: null,
    lastTranscriptSeq: null,
    compactedAt: null,
  } as WorkflowMeta;
}

before(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'archon-meta-'));
});

test('concurrent updateMeta calls each land (no lost update)', async () => {
  await writeMeta(cwd, seed());
  const N = 40;
  await Promise.all(Array.from({ length: N }, (_, i) =>
    updateMeta(cwd, WFID, async (meta) => {
      // Yield between read and write — without the lock every call would read
      // the same empty list and the last write would win with a single entry.
      await new Promise((r) => setTimeout(r, Math.random() * 3));
      meta.cliSessions.push({ provider: 'codex', sessionId: `s${i}`, createdAt: i });
    })));
  const meta = await readMeta(cwd, WFID);
  assert.ok(meta);
  assert.equal(meta.cliSessions.length, N);
  assert.deepEqual(new Set(meta.cliSessions.map((s) => s.sessionId)).size, N);
});

test('different-field helpers racing do not clobber each other', async () => {
  await writeMeta(cwd, seed());
  await Promise.all([
    setResolvedModelId(cwd, WFID, 'claude-opus-5-5'),
    appendCliSession(cwd, WFID, { provider: 'claude', sessionId: 'abc', createdAt: 5 }),
    updateMeta(cwd, WFID, (meta) => { meta.goal = 'ship it'; }),
    touchLastActive(cwd, WFID),
  ]);
  const meta = await readMeta(cwd, WFID);
  assert.ok(meta);
  assert.equal(meta.resolvedModelId, 'claude-opus-5-5');
  assert.equal(meta.cliSessions.length, 1);
  assert.equal(meta.goal, 'ship it');
});

test('returning false skips the write; missing meta → null without calling mutate', async () => {
  await writeMeta(cwd, seed());
  const before = await fs.stat(path.join(cwd, '.archon', 'workflows', WFID, 'meta.json'));
  const res = await updateMeta(cwd, WFID, () => false);
  assert.equal(res?.workflowId, WFID);
  const after = await fs.stat(path.join(cwd, '.archon', 'workflows', WFID, 'meta.json'));
  assert.equal(after.mtimeMs, before.mtimeMs);

  let called = false;
  const missing = await updateMeta(cwd, '99999999-0000-0000-0000-000000000000', () => { called = true; });
  assert.equal(missing, null);
  assert.equal(called, false);
});

test('a throwing mutator rejects without wedging the next update', async () => {
  await writeMeta(cwd, seed());
  await assert.rejects(updateMeta(cwd, WFID, () => { throw new Error('boom'); }), /boom/);
  await updateMeta(cwd, WFID, (meta) => { meta.name = 'after'; });
  assert.equal((await readMeta(cwd, WFID))?.name, 'after');
});
