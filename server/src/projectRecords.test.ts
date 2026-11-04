import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  applyOrganize, cleanDisplayName, parseOrganizePatch, parseRecords, readRecords, reconcile, recordsFor, relocateRecord, relocateStored,
  MAX_PREVIOUS_PATHS, type ProjectRecord,
} from './projectRecords.js';

const fixturePath = (value: string) => resolve(value);
const live = (...paths: string[]) => paths.map((p) => ({ path: p, exists: true }));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('parseRecords refuses unsafe stores rather than silently losing any entry or field', () => {
  const valid = { id: id(1), path: fixturePath('/projects/app'), displayName: 'Budget app', pinned: true, previousPaths: [fixturePath('/old/app')] };
  assert.deepEqual(parseRecords({ version: 1, records: [valid] }), [valid]);
  assert.equal(parseRecords({ version: 2, records: [] }), null);
  assert.equal(parseRecords({ version: 1 }), null);
  const invalid = [
    null, [], { id: 'not-a-uuid', path: fixturePath('/x') }, { id: id(2), path: 'relative' },
    { ...valid, displayName: 'x'.repeat(81) }, { ...valid, displayName: 7 },
    { ...valid, displayName: '  Budget app' }, { ...valid, pinned: 'yes' },
    { ...valid, archived: 1 }, { ...valid, previousPaths: 'old' },
    { ...valid, previousPaths: ['relative'] }, { ...valid, previousPaths: [fixturePath('/old'), fixturePath('/old')] },
    { ...valid, previousPaths: [fixturePath('/projects/app')] },
    { ...valid, previousPaths: Array.from({ length: MAX_PREVIOUS_PATHS + 1 }, (_, i) => `/old/${i}`) },
    { ...valid, pendingPath: 'relative' }, { ...valid, pendingPath: valid.path },
    { ...valid, unknownMetadata: 'keep me' },
  ];
  for (const bad of invalid) assert.equal(parseRecords({ version: 1, records: [bad] }), null);
  assert.equal(parseRecords({ version: 1, records: [valid, { id: id(2), path: fixturePath('/projects/app/') }] }), null);
  assert.equal(parseRecords({ version: 1, records: [valid, { id: id(1), path: fixturePath('/projects/other') }] }), null);
  assert.equal(parseRecords({ version: 1, records: [valid], future: true }), null);
  const many = Array.from({ length: 1001 }, (_, i) => ({ id: id(i), path: `/projects/${i}` }));
  assert.equal(parseRecords({ version: 1, records: many }), null);
});

test('reconcile mints one stable id per new path and keeps existing records', () => {
  let n = 10;
  const existing: ProjectRecord[] = [{ id: id(1), path: fixturePath('/projects/a'), pinned: true }];
  const first = reconcile(existing, live(fixturePath('/projects/a'), fixturePath('/projects/b')), true, () => id(n++));
  assert.equal(first.changed, true);
  assert.deepEqual(first.records, [{ id: id(1), path: fixturePath('/projects/a'), pinned: true }, { id: id(10), path: fixturePath('/projects/b') }]);
  const second = reconcile(first.records, live(fixturePath('/projects/b'), fixturePath('/projects/a')), true, () => id(n++));
  assert.equal(second.changed, false);
  assert.deepEqual(second.records, first.records);
  const unstorable = reconcile(existing, live(fixturePath('/projects/a'), fixturePath('/projects/c')), false, () => id(n++));
  assert.deepEqual([unstorable.records, unstorable.changed], [existing, false], 'no id is minted that cannot be stored');
});

test('reconcile finishes listed targets but only a fresh snapshot abandons an absent target', () => {
  const records: ProjectRecord[] = [
    { id: id(1), path: fixturePath('/old/a'), displayName: 'A', pinned: true, pendingPath: fixturePath('/new/a') },
    { id: id(2), path: fixturePath('/old/b'), displayName: 'B', pendingPath: fixturePath('/new/b') },
  ];
  const listed = [{ path: fixturePath('/new/a'), exists: true }, { path: fixturePath('/old/a'), exists: false }, { path: fixturePath('/old/b'), exists: false }];
  const stale = reconcile(records, listed, true, () => id(9));
  assert.equal(stale.records.find((r) => r.id === id(2))?.pendingPath, fixturePath('/new/b'), 'an older snapshot cannot abandon the move');
  const out = reconcile(records, listed, true, () => id(9), true);
  assert.equal(out.changed, true);
  assert.deepEqual(out.records, [
    { id: id(1), path: fixturePath('/new/a'), displayName: 'A', pinned: true, previousPaths: [fixturePath('/old/a')] },
    { id: id(2), path: fixturePath('/old/b'), displayName: 'B' },
  ]);
  assert.deepEqual(out.visible, [fixturePath('/new/a'), fixturePath('/old/b')], 'the folder a project moved away from is not listed again');
  assert.equal(parseRecords({ version: 1, records: [{ id: id(1), path: fixturePath('/a'), pendingPath: fixturePath('/a') }] }), null);
});

test('organization patches are validated and reversible', () => {
  assert.equal(cleanDisplayName('a\u0007b'), 'a b');
  assert.equal(cleanDisplayName(7), null);
  assert.equal(parseOrganizePatch({}), null);
  assert.equal(parseOrganizePatch({ pinned: 'true' }), null);
  assert.equal(parseOrganizePatch({ displayName: 'x'.repeat(81) }), null);
  const record: ProjectRecord = { id: id(1), path: fixturePath('/projects/a') };
  const named = applyOrganize(record, parseOrganizePatch({ displayName: 'Client site', pinned: true, archived: true })!);
  assert.deepEqual(named, { id: id(1), path: fixturePath('/projects/a'), displayName: 'Client site', pinned: true, archived: true });
  assert.deepEqual(applyOrganize(named, parseOrganizePatch({ displayName: '', pinned: false, archived: false })!), record);
});

test('relocation keeps the id and metadata and records the old path', () => {
  const records: ProjectRecord[] = [
    { id: id(1), path: fixturePath('/old/app'), displayName: 'App', pinned: true, previousPaths: [fixturePath('/older/app')] },
    { id: id(2), path: fixturePath('/projects/app') },
    { id: id(3), path: fixturePath('/projects/named'), displayName: 'Named' },
  ];
  const moved = relocateRecord(records, id(1), fixturePath('/projects/app'));
  assert.ok(!('error' in moved));
  assert.equal(moved.from, fixturePath('/old/app'));
  assert.deepEqual(moved.records, [
    { id: id(1), path: fixturePath('/projects/app'), displayName: 'App', pinned: true, previousPaths: [fixturePath('/old/app'), fixturePath('/older/app')] },
    { id: id(3), path: fixturePath('/projects/named'), displayName: 'Named' },
  ], 'a plain auto-created record at the target is replaced');
  assert.match((relocateRecord(records, id(1), fixturePath('/projects/named')) as { error: string }).error, /already a project/);
  assert.match((relocateRecord(records, id(9), fixturePath('/projects/x')) as { error: string }).error, /not found/);
  assert.match((relocateRecord(records, id(2), fixturePath('/projects/app')) as { error: string }).error, /already at/);
  let chain: ProjectRecord[] = [{ id: id(1), path: fixturePath('/p/0') }];
  for (let i = 1; i <= MAX_PREVIOUS_PATHS + 3; i++) chain = (relocateRecord(chain, id(1), `/p/${i}`) as { records: ProjectRecord[] }).records;
  assert.equal(chain[0].previousPaths?.length, MAX_PREVIOUS_PATHS);
  assert.equal(chain[0].previousPaths?.[0], `/p/${MAX_PREVIOUS_PATHS + 2}`);
});

test('the store is created atomically and a malformed store is never overwritten', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arco-records-'));
  const file = join(dir, 'projects.json');
  try {
    assert.deepEqual(await readRecords(file), { ok: true, records: [] });
    const first = await recordsFor(live(fixturePath('/projects/a'), fixturePath('/projects/b')), file);
    const again = await recordsFor(live(fixturePath('/projects/b'), fixturePath('/projects/a')), file);
    assert.equal(first.organization, true);
    assert.deepEqual(again.records, first.records, 'ids are stable across reads');
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).records, first.records);
    writeFileSync(file, '{"version":1,"records":');
    assert.deepEqual(await readRecords(file), { ok: false });
    assert.deepEqual(await recordsFor(live(fixturePath('/projects/c')), file), { records: [], visible: [fixturePath('/projects/c')], organization: false });
    assert.equal(readFileSync(file, 'utf8'), '{"version":1,"records":', 'unreadable store left for the operator to repair');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Permission bits do not bind root, so this only means something otherwise.
test('an unwritable store degrades the listing without inventing ids', { skip: (process.getuid?.() ?? 0) === 0 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arco-records-ro-'));
  const file = join(dir, 'projects.json');
  try {
    writeFileSync(file, JSON.stringify({ version: 1, records: [{ id: id(1), path: fixturePath('/projects/a'), pinned: true }] }));
    chmodSync(dir, 0o555);
    const out = await recordsFor(live(fixturePath('/projects/a'), fixturePath('/projects/new')), file);
    assert.deepEqual(out, { records: [{ id: id(1), path: fixturePath('/projects/a'), pinned: true }], visible: [fixturePath('/projects/a'), fixturePath('/projects/new')], organization: false });
    chmodSync(dir, 0o755);
    assert.deepEqual(readdirSync(dir), ['projects.json'], 'no temporary file is left behind');
  } finally {
    chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a relocation marks the record before registering and refuses a folder that exists again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arco-records-move-'));
  const file = join(dir, 'projects.json');
  const read = () => JSON.parse(readFileSync(file, 'utf8')).records as ProjectRecord[];
  try {
    writeFileSync(file, JSON.stringify({ version: 1, records: [{ id: id(1), path: fixturePath('/old/a'), displayName: 'A' }] }));
    const failed = await relocateStored(id(1), fixturePath('/new/a'), async () => true, async () => {
      assert.equal(read()[0].pendingPath, fixturePath('/new/a'), 'the move is recorded before the settings change');
      throw new Error('disk full');
    }, file);
    assert.deepEqual(failed, { ok: false, error: 'the project list could not be saved; nothing was moved', status: 503 });
    assert.deepEqual((await recordsFor(async () => [{ path: fixturePath('/old/a'), exists: false }], file)).records, [{ id: id(1), path: fixturePath('/old/a'), displayName: 'A' }], 'an unregistered target is dropped');
    let registered = 0;
    const done = await relocateStored(id(1), fixturePath('/new/a'), async () => true, async () => { registered++; }, file);
    assert.deepEqual([done, registered], [{ ok: true }, 1]);
    assert.deepEqual(read(), [{ id: id(1), path: fixturePath('/new/a'), displayName: 'A', previousPaths: [fixturePath('/old/a')] }]);
    const again = await relocateStored(id(1), fixturePath('/elsewhere'), async () => false, async () => { registered++; }, file);
    assert.deepEqual([again, registered], [{ ok: false, error: 'only a project whose folder is missing can be relocated', status: 400 }, 1]);
    assert.equal((await relocateStored(id(7), fixturePath('/x'), async () => true, async () => {}, file) as { status: number }).status, 404);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test('discovery does not persist folders, while keeping a folder gives it a stable record', async () => {
  const root = mkdtempSync(join(tmpdir(), 'arco-discovery-'));
  const file = join(root, 'projects.json');
  const folder = join(root, 'app');
  try {
    const discovered = await recordsFor([{ path: folder, exists: true, discovered: true }], file);
    assert.deepEqual(discovered.visible, [folder]);
    assert.deepEqual(discovered.records, []);
    assert.deepEqual(readdirSync(root), []);
    const kept = await recordsFor([{ path: folder, exists: true }], file);
    assert.equal(kept.records.length, 1);
    assert.equal((await recordsFor([{ path: folder, exists: true, discovered: true }], file)).records[0].id, kept.records[0].id);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
