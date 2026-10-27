// Adversarial acceptance for project identity, organization and relocation: the
// real /api/projects routes on a throwaway HOME with synthetic folders, aimed at
// the persistence boundary (lazy record creation on GET, the settings-first
// relocation, the sidecar store) and at the claim that file access is unchanged.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'arco-project-adv-')));
const home = join(sandbox, 'home');
const arco = join(home, '.arco');
const scan = join(home, 'Projects');
const work = join(sandbox, 'work');
mkdirSync(arco, { recursive: true });
mkdirSync(scan, { recursive: true });
mkdirSync(work, { recursive: true });
process.env.HOME = home;
process.env.USERPROFILE = home;

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
// Permission bits do not bind root, so the read-only cases only mean something otherwise.
const unprivileged = process.platform !== 'win32' && (process.getuid?.() ?? 0) !== 0;

type Project = { path: string; name: string; source: string; exists: boolean; id?: string; derivedName?: string; displayName?: string; pinned?: boolean; archived?: boolean; previousPaths?: string[] };
type List = { projects: Project[]; scanFolder: string | null; organization?: boolean; error?: string };
let server: Server;
let base = '';

before(async () => {
  const { tryHandleProjectRoutes } = await import('./http/projectRoutes.js');
  server = createServer((req, res) => { void tryHandleProjectRoutes(req, res).then((handled) => { if (!handled) { res.writeHead(404); res.end(); } }); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  try { chmodSync(arco, 0o755); } catch { /* removed */ }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(sandbox, { recursive: true, force: true });
});

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: List }> {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
  const text = await res.text();
  let json: List;
  try { json = JSON.parse(text) as List; } catch { json = { projects: [], scanFolder: null, error: text }; }
  return { status: res.status, json };
}
const folder = (root: string, name: string) => { const p = join(root, name); mkdirSync(p, { recursive: true }); return p; };
const settingsFile = join(arco, 'settings.json');
const recordsFile = join(arco, 'projects.json');
const seed = (projects: string[], records?: unknown[]) => {
  for (const f of ['settings.json', 'projects.json', 'known-cwds.json']) rmSync(join(arco, f), { force: true });
  writeFileSync(settingsFile, JSON.stringify({ projects }));
  if (records) writeFileSync(recordsFile, JSON.stringify({ version: 1, records }));
};
const registered = () => (JSON.parse(readFileSync(settingsFile, 'utf8')).projects ?? []) as string[];
const stored = () => (JSON.parse(readFileSync(recordsFile, 'utf8')).records ?? []) as Array<{ id: string; path: string; displayName?: string; pinned?: boolean; previousPaths?: string[] }>;
const find = (l: List, p: string) => l.projects.find((x) => x.path === p);

test('listing never fails because the record store cannot be written', { skip: !unprivileged }, async () => {
  const one = folder(work, 'ro-one');
  seed([one]);
  chmodSync(arco, 0o555);
  try {
    const res = await call('GET', '/api/projects');
    assert.equal(res.status, 200, `a read-only runtime home must not take the project list down: ${res.json.error ?? ''}`);
    const listed = find(res.json, one);
    assert.ok(listed?.exists, 'the registered folder is still listed');
    assert.equal(res.json.organization, false, 'organization is reported unavailable, not an error');
    assert.equal(listed?.id, undefined, 'no id is invented that cannot be kept');
  } finally { chmodSync(arco, 0o755); }
  assert.equal(existsSync(recordsFile), false, 'nothing was written');
});

test('a failed organization write is a clean refusal that does not leak the runtime path', { skip: !unprivileged }, async () => {
  const one = folder(work, 'ro-two');
  seed([one]);
  const id = find((await call('GET', '/api/projects')).json, one)!.id!;
  chmodSync(arco, 0o555);
  try {
    const res = await call('PATCH', '/api/projects', { id, pinned: true });
    assert.equal(res.status, 503, 'the change is refused as unavailable, not reported as saved or as a crash');
    assert.ok(!JSON.stringify(res.json).includes(home), 'the error names no runtime-home file');
  } finally { chmodSync(arco, 0o755); }
  assert.equal(stored().find((r) => r.id === id)?.pinned, undefined, 'the stored record is unchanged');
});

test('an interrupted relocation never strands the name, pin and history the operator set', async () => {
  const gone = join(work, 'moved-away');
  const dest = folder(work, 'moved-to');
  // The state a crash or a full disk leaves after the settings write and before the record write.
  seed([gone], [{ id: ID_A, path: gone, displayName: 'Household budget', pinned: true }]);
  writeFileSync(settingsFile, JSON.stringify({ projects: [dest] }));
  const after = await call('GET', '/api/projects');
  const adopted = find(after.json, dest);
  const retry = await call('POST', '/api/projects/relocate', { id: ID_A, path: dest });
  const reachable = adopted?.displayName === 'Household budget' || retry.status === 200;
  assert.ok(reachable, `the named, pinned record must stay reachable (listing shows "${adopted?.name}", retry answered ${retry.status} ${retry.json.error ?? ''})`);
  const now = find(retry.status === 200 ? retry.json : after.json, dest);
  assert.equal(now?.displayName, 'Household budget');
  assert.equal(now?.pinned, true);
});

test('two relocations of the same missing project cannot both succeed', async () => {
  const gone = join(work, 'race-gone');
  const t1 = folder(work, 'race-one');
  const t2 = folder(work, 'race-two');
  seed([gone], [{ id: ID_A, path: gone, displayName: 'Race' }]);
  const [a, b] = await Promise.all([
    call('POST', '/api/projects/relocate', { id: ID_A, path: t1 }),
    call('POST', '/api/projects/relocate', { id: ID_A, path: t2 }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 400], 'only a project whose folder is missing can be relocated; after the first move it is not');
  const final = registered();
  assert.equal(final.length, 1, 'the registry holds a single folder for the one project');
  assert.ok(existsSync(t1) && existsSync(t2), 'neither folder was touched');
});

test('relocation keeps the id, writes settings and records consistently, and never touches files', async () => {
  const gone = join(work, 'plain-gone');
  const dest = folder(work, 'plain-dest');
  writeFileSync(join(dest, 'keep.txt'), 'synthetic');
  seed([gone, folder(work, 'bystander')], [{ id: ID_A, path: gone, displayName: 'Plain', archived: true, previousPaths: [join(work, 'older-place')] }]);
  const res = await call('POST', '/api/projects/relocate', { id: ID_A, path: dest });
  assert.equal(res.status, 200);
  const moved = find(res.json, dest)!;
  assert.deepEqual([moved.id, moved.name, moved.archived, moved.previousPaths], [ID_A, 'Plain', true, [gone, join(work, 'older-place')]]);
  assert.deepEqual(registered(), [dest, join(work, 'bystander')], 'the old registration is replaced in place, other entries keep their order');
  assert.equal(readFileSync(join(dest, 'keep.txt'), 'utf8'), 'synthetic');
  assert.equal(find(res.json, gone), undefined, 'the old location is represented by the project, not listed again');
  assert.equal(stored().filter((r) => r.id === ID_A).length, 1);
});

test('relocation refuses live projects, unusable targets and operator-owned occupants', async () => {
  const live = folder(work, 'refuse-live');
  const gone = join(work, 'refuse-gone');
  const other = folder(work, 'refuse-other');
  seed([live, gone, other], [
    { id: ID_A, path: gone, displayName: 'Gone' },
    { id: ID_B, path: other, pinned: true },
  ]);
  const liveId = find((await call('GET', '/api/projects')).json, live)!.id!;
  const file = join(work, 'refuse-file.txt'); writeFileSync(file, 'x');
  const cases: Array<[string, unknown]> = [
    ['a live project', { id: liveId, path: folder(work, 'refuse-target') }],
    ['an unknown id', { id: '33333333-3333-4333-8333-333333333333', path: other }],
    ['a pinned occupant', { id: ID_A, path: other }],
    ['a file', { id: ID_A, path: file }],
    ['a missing target', { id: ID_A, path: join(work, 'not-there') }],
    ['a relative path', { id: ID_A, path: 'relative/dir' }],
    ['a NUL path', { id: ID_A, path: `${other}\0x` }],
    ['the home folder', { id: ID_A, path: home }],
    ['the filesystem root', { id: ID_A, path: '/' }],
    ['a non-string path', { id: ID_A, path: 7 }],
    ['a missing id', { path: other }],
    ['the current folder', { id: ID_A, path: gone }],
  ];
  for (const [label, body] of cases) {
    const res = await call('POST', '/api/projects/relocate', body);
    assert.ok(res.status >= 400 && res.status < 500, `${label} -> ${res.status}`);
  }
  assert.deepEqual(registered(), [live, gone, other], 'no refused request changed the registry');
  assert.deepEqual(stored().map((r) => [r.id, r.path]).filter(([id]) => id === ID_A || id === ID_B), [[ID_A, gone], [ID_B, other]]);
});

test('records never widen or narrow file access', async () => {
  const { projectRoots, realpathWithinProjects, projectPaths } = await import('./projects.js');
  const live = folder(work, 'access-live');
  writeFileSync(join(live, 'in.txt'), 'x');
  const stray = folder(work, 'access-stray');
  writeFileSync(join(stray, 'out.txt'), 'x');
  const old = folder(work, 'access-old');
  writeFileSync(join(old, 'old.txt'), 'x');
  const gone = join(work, 'access-gone');
  seed([live, gone], [
    { id: ID_A, path: stray, displayName: 'Looks registered', pinned: true },
    { id: ID_B, path: gone, previousPaths: [old] },
  ]);
  await call('GET', '/api/projects');
  assert.ok(await realpathWithinProjects(join(live, 'in.txt')), 'a registered folder stays readable');
  assert.equal(await realpathWithinProjects(join(stray, 'out.txt')), null, 'a record alone grants nothing');
  assert.equal(await realpathWithinProjects(join(old, 'old.txt')), null, 'a previous location grants nothing');
  const listed = find((await call('GET', '/api/projects')).json, live)!;
  await call('PATCH', '/api/projects', { id: listed.id, archived: true, displayName: 'Hidden away' });
  assert.ok(await realpathWithinProjects(join(live, 'in.txt')), 'archiving and renaming leave access as it was');
  assert.deepEqual((await projectRoots()).filter((r) => r.startsWith(work)).sort(), [live], 'only existing registered folders are roots');
  assert.deepEqual((await projectPaths()).filter((r) => r.startsWith(work)), [live]);
  await call('DELETE', '/api/projects', { path: live });
  assert.equal(await realpathWithinProjects(join(live, 'in.txt')), null, 'removing from the list still revokes access');
  assert.ok(existsSync(join(live, 'in.txt')), 'and removes nothing from disk');
});

test('a whole-file problem is refused without touching the file, for every kind of change', async () => {
  const one = folder(work, 'refuse-store');
  const gone = join(work, 'refuse-store-gone');
  const dest = folder(work, 'refuse-store-dest');
  for (const bad of ['{not json', '[]', JSON.stringify({ version: 2, records: [] }), JSON.stringify({ version: 1, records: 'no' }), '']) {
    seed([one, gone]);
    writeFileSync(recordsFile, bad);
    const listed = await call('GET', '/api/projects');
    assert.equal(listed.status, 200);
    if (bad !== '') assert.equal(listed.json.organization, false, bad);
    for (const [method, path, body] of [
      ['PATCH', '/api/projects', { id: ID_A, pinned: true }],
      ['POST', '/api/projects/relocate', { id: ID_A, path: dest }],
    ] as const) {
      const res = await call(method, path, body);
      assert.ok(res.status >= 400, `${method} ${path} on ${JSON.stringify(bad)} -> ${res.status}`);
    }
    assert.equal(readFileSync(recordsFile, 'utf8'), bad, `the store ${JSON.stringify(bad)} is byte-identical afterwards`);
    assert.deepEqual(registered(), [one, gone], 'and the registry is unchanged');
  }
});

test('folder creation takes a plain name only, never follows a link and never reuses a folder', async () => {
  seed([]);
  writeFileSync(settingsFile, JSON.stringify({ defaultWorkingDirectory: scan }));
  const outside = folder(work, 'create-outside');
  symlinkSync(outside, join(scan, 'linked'));
  symlinkSync(join(work, 'nowhere'), join(scan, 'dangling'));
  writeFileSync(join(scan, 'plain-file'), 'x');
  folder(scan, 'taken');
  const refused = ['', ' ', '.', '..', '.hidden', 'a/b', 'a\\b', '../escape', '/abs', 'a\0b', 'x'.repeat(65), 'trailing.', 'taken', 'linked', 'dangling', 'plain-file', '\u00fcn\u00ef', 'a b'];
  for (const name of refused) {
    const res = await call('POST', '/api/projects/create', { name });
    assert.ok(res.status >= 400 && res.status < 500, `${JSON.stringify(name)} -> ${res.status}`);
  }
  assert.equal((await call('POST', '/api/projects/create', {})).status, 400);
  assert.equal((await call('POST', '/api/projects/create', { name: 7 })).status, 400);
  assert.deepEqual(readdirSync(outside), [], 'nothing was created through the link');
  assert.equal(existsSync(join(work, 'nowhere')), false, 'nothing was created through the dangling link');
  const made = await call('POST', '/api/projects/create', { name: 'fresh-project' });
  assert.equal(made.status, 200);
  assert.deepEqual(readdirSync(join(scan, 'fresh-project')), [], 'the new folder is empty');
  assert.ok(find(made.json, join(scan, 'fresh-project'))?.id);
  assert.equal((await call('POST', '/api/projects/create', { name: 'fresh-project' })).status, 400, 'creating twice is refused, not reused');
});

test('concurrent renames, listings and creations lose nothing and leave no temporary files', async () => {
  const dirs = Array.from({ length: 12 }, (_, i) => folder(work, `par-${i}`));
  seed(dirs);
  writeFileSync(settingsFile, JSON.stringify({ projects: dirs, defaultWorkingDirectory: scan }));
  const first = (await call('GET', '/api/projects')).json;
  const ids = dirs.map((d) => find(first, d)!.id!);
  await Promise.all([
    ...ids.map((id, i) => call('PATCH', '/api/projects', { id, displayName: `Name ${i}`, pinned: i % 2 === 0 })),
    ...ids.map(() => call('GET', '/api/projects')),
    ...[0, 1, 2].map((i) => call('POST', '/api/projects/create', { name: `par-new-${i}` })),
  ]);
  const last = (await call('GET', '/api/projects')).json;
  dirs.forEach((d, i) => {
    const p = find(last, d)!;
    assert.deepEqual([p.id, p.displayName, p.pinned === true], [ids[i], `Name ${i}`, i % 2 === 0], d);
  });
  for (const i of [0, 1, 2]) assert.ok(find(last, join(scan, `par-new-${i}`))?.id);
  assert.equal(new Set(stored().map((r) => r.id)).size, stored().length, 'ids are unique');
  assert.equal(new Set(stored().map((r) => r.path)).size, stored().length, 'a path has one record');
  assert.deepEqual(readdirSync(arco).filter((f) => f.endsWith('.tmp')), [], 'no temporary files are left behind');
  for (const n of ['par-new-0', 'par-new-1', 'par-new-2']) rmSync(join(scan, n), { recursive: true, force: true });
});

test('removing, re-adding and relocating keep one id for one project', async () => {
  const keep = folder(work, 'ident-keep');
  seed([keep]);
  const id = find((await call('GET', '/api/projects')).json, keep)!.id!;
  await call('PATCH', '/api/projects', { id, displayName: 'Named', pinned: true, archived: true });
  const removed = await call('DELETE', '/api/projects', { path: keep });
  assert.equal(find(removed.json, keep), undefined);
  const again = find((await call('POST', '/api/projects', { path: keep })).json, keep)!;
  assert.deepEqual([again.id, again.displayName, again.pinned, again.archived], [id, 'Named', true, true]);
  rmSync(keep, { recursive: true });
  const dest = folder(work, 'ident-dest');
  const moved = find((await call('POST', '/api/projects/relocate', { id, path: dest })).json, dest)!;
  assert.deepEqual([moved.id, moved.displayName, moved.previousPaths], [id, 'Named', [keep]]);
  await call('DELETE', '/api/projects', { path: dest });
  const readded = find((await call('POST', '/api/projects', { path: dest })).json, dest)!;
  assert.equal(readded.id, id, 'removing and re-adding the relocated folder still finds the project');
  assert.equal(stored().filter((r) => r.id === id).length, 1);
});

test('request bodies are bounded and validated before they reach the store', async () => {
  const one = folder(work, 'body-one');
  seed([one]);
  const id = find((await call('GET', '/api/projects')).json, one)!.id!;
  const big = JSON.stringify({ id, displayName: 'x'.repeat(70_000) });
  assert.equal((await call('PATCH', '/api/projects', big)).status, 400);
  for (const body of [
    { id, displayName: 'x'.repeat(81) },
    { id, displayName: 5 },
    { id, pinned: 'true' },
    { id, archived: 1 },
    { id: 7, pinned: true },
    { displayName: 'no id' },
    [id],
    'null',
  ]) assert.equal((await call('PATCH', '/api/projects', body)).status, 400, JSON.stringify(body));
  const name = await call('PATCH', '/api/projects', { id, displayName: '  Line\u0000one\n\ttwo  ' });
  assert.equal(find(name.json, one)?.displayName, 'Line one two', 'control characters and runs of space collapse');
  assert.equal((await call('PUT', '/api/projects/relocate', {})).status, 405);
  assert.equal((await call('GET', '/api/projects/create')).status, 405);
  assert.equal((await call('PUT', '/api/projects', {})).status, 405);
});

test('a relocation caught between its writes is finished or abandoned by the next listing, never stranded', async () => {
  const gone = join(work, 'pending-gone');
  const dest = folder(work, 'pending-dest');
  // Crash after the settings write: the target is registered, the record still points at the old folder.
  seed([dest], [{ id: ID_A, path: gone, displayName: 'Half moved', pinned: true, pendingPath: dest }]);
  const finished = await call('GET', '/api/projects');
  const moved = find(finished.json, dest)!;
  assert.deepEqual([moved.id, moved.displayName, moved.pinned, moved.previousPaths], [ID_A, 'Half moved', true, [gone]]);
  assert.equal(finished.json.projects.filter((p) => p.path.startsWith(work) && p.path !== dest).length, 0, 'no stray entry for the old or new folder');
  assert.equal(stored().filter((r) => r.path === dest).length, 1, 'no second record was minted for the new folder');
  assert.ok(stored().every((r) => !('pendingPath' in r)), 'the marker is cleared');

  // Crash before the settings write: the new folder was never registered.
  const dest2 = folder(work, 'pending-dest-two');
  seed([gone], [{ id: ID_A, path: gone, displayName: 'Never moved', pendingPath: dest2 }]);
  const abandoned = await call('GET', '/api/projects');
  const stay = find(abandoned.json, gone)!;
  assert.deepEqual([stay.id, stay.displayName, stay.exists], [ID_A, 'Never moved', false], 'the project stays where it was, still relocatable');
  assert.equal(find(abandoned.json, dest2), undefined, 'the unregistered folder is not adopted');
  assert.ok(stored().every((r) => !('pendingPath' in r)));
  const retry = await call('POST', '/api/projects/relocate', { id: ID_A, path: dest2 });
  assert.equal(retry.status, 200);
  assert.equal(find(retry.json, dest2)?.id, ID_A);
  assert.deepEqual(registered(), [dest2]);

  // A pending target that already belongs to a named project never takes it over.
  const other = folder(work, 'pending-other');
  seed([gone, other], [{ id: ID_A, path: gone, pendingPath: other }, { id: ID_B, path: other, displayName: 'Owned' }]);
  const refused = await call('GET', '/api/projects');
  assert.deepEqual([find(refused.json, other)?.id, find(refused.json, other)?.displayName, find(refused.json, gone)?.id], [ID_B, 'Owned', ID_A]);
  assert.ok(stored().every((r) => !('pendingPath' in r)));
});

test('a relocation that cannot write its first record changes nothing and says so', { skip: !unprivileged }, async () => {
  const gone = join(work, 'first-write-gone');
  const dest = folder(work, 'first-write-dest');
  seed([gone], [{ id: ID_A, path: gone, displayName: 'Held' }]);
  const before = readFileSync(recordsFile, 'utf8');
  chmodSync(arco, 0o555);
  try {
    const res = await call('POST', '/api/projects/relocate', { id: ID_A, path: dest });
    assert.equal(res.status, 503);
    assert.ok(!JSON.stringify(res.json).includes(home));
  } finally { chmodSync(arco, 0o755); }
  assert.equal(readFileSync(recordsFile, 'utf8'), before);
  assert.deepEqual(registered(), [gone]);
});

test('listings racing a relocation always show the project exactly once', async () => {
  for (let round = 0; round < 15; round++) {
    const gone = join(work, `storm-gone-${round}`);
    const dest = folder(work, `storm-dest-${round}`);
    seed([gone, folder(work, `storm-bystander-${round}`)], [{ id: ID_A, path: gone, displayName: 'Storm' }]);
    const results = await Promise.all([
      call('GET', '/api/projects'), call('GET', '/api/projects'),
      call('POST', '/api/projects/relocate', { id: ID_A, path: dest }),
      call('GET', '/api/projects'), call('GET', '/api/projects'), call('GET', '/api/projects'),
    ]);
    for (const r of results) {
      assert.equal(r.status, 200);
      const shown = r.json.projects.filter((p) => p.id === ID_A);
      assert.ok(shown.length <= 1, `round ${round}: a project is never listed twice`);
    }
    const last = (await call('GET', '/api/projects')).json;
    assert.equal(last.projects.filter((p) => p.id === ID_A).length, 1, `round ${round}: settled state lists it once`);
    assert.equal(find(last, dest)?.id, ID_A);
    assert.equal(stored().filter((r) => r.id === ID_A).length, 1);
    assert.ok(stored().every((r) => !('pendingPath' in r)));
  }
});

test('a settings write that fails after the first record write leaves a marker the next listing clears', { skip: !unprivileged }, async () => {
  const gone = join(work, 'marker-gone');
  const dest = folder(work, 'marker-dest');
  seed([gone], [{ id: ID_A, path: gone, displayName: 'Marked', pinned: true }]);
  rmSync(settingsFile);
  mkdirSync(settingsFile); // the settings write cannot replace a directory
  const res = await call('POST', '/api/projects/relocate', { id: ID_A, path: dest });
  assert.equal(res.status, 503);
  assert.match(res.json.error ?? '', /nothing was moved/);
  assert.ok(!JSON.stringify(res.json).includes(home));
  const mid = stored().find((r) => r.id === ID_A) as { path: string; pendingPath?: string };
  assert.deepEqual([mid.path, mid.pendingPath], [gone, dest], 'the record still points at the old folder and carries the in-flight marker');
  rmSync(settingsFile, { recursive: true });
  writeFileSync(settingsFile, JSON.stringify({ projects: [gone] }));
  const settled = await call('GET', '/api/projects');
  const again = find(settled.json, gone)!;
  assert.deepEqual([again.id, again.displayName, again.pinned, again.exists], [ID_A, 'Marked', true, false], 'the project is untouched and still relocatable');
  assert.equal(find(settled.json, dest), undefined);
  assert.ok(stored().every((r) => !('pendingPath' in r)), 'the marker is gone');
  assert.equal((await call('POST', '/api/projects/relocate', { id: ID_A, path: dest })).status, 200);
});

test('relocating onto a folder that is already registered leaves one registration', async () => {
  const gone = join(work, 'dup-gone');
  const dest = folder(work, 'dup-dest');
  seed([gone, dest], [{ id: ID_A, path: gone, displayName: 'Dup' }]);
  await call('GET', '/api/projects');
  const res = await call('POST', '/api/projects/relocate', { id: ID_A, path: dest });
  assert.equal(res.status, 200);
  assert.deepEqual(registered(), [dest]);
  assert.equal(res.json.projects.filter((p) => p.path === dest).length, 1);
  assert.equal(stored().filter((r) => r.path === dest).length, 1);
});

test('the record cap stops new ids without failing the listing or losing a record', async () => {
  const one = folder(work, 'cap-one');
  const records = Array.from({ length: 1000 }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, path: `/zz/cap-${i}`, ...(i === 7 ? { displayName: 'Seventh', pinned: true } : {}) }));
  seed([one], records);
  const res = await call('GET', '/api/projects');
  assert.equal(res.status, 200);
  assert.equal(res.json.organization, true);
  assert.equal(find(res.json, one)?.id, undefined, 'no id beyond the cap');
  const rows = stored();
  assert.equal(rows.length, 1000);
  assert.deepEqual(rows.find((r) => r.displayName === 'Seventh')?.pinned, true);
});

test('file access checks never read or write the record store', async () => {
  const { projectRoots, realpathWithinProjects, projectPaths } = await import('./projects.js');
  const live = folder(work, 'noread-live');
  writeFileSync(join(live, 'f.txt'), 'x');
  seed([live]);
  await projectRoots(); await projectPaths();
  assert.ok(await realpathWithinProjects(join(live, 'f.txt')));
  assert.equal(existsSync(recordsFile), false, 'a file access check does not create the store');
  writeFileSync(recordsFile, '{broken');
  assert.ok(await realpathWithinProjects(join(live, 'f.txt')), 'and does not depend on it');
  assert.equal(readFileSync(recordsFile, 'utf8'), '{broken');
});

test('a store with any invalid, duplicate or surplus record is refused like a malformed file: listed read-only, never rewritten', async () => {
  const keep = folder(work, 'mixed-keep');
  const extra = folder(work, 'mixed-extra');
  const gone = join(work, 'mixed-gone');
  const dest = folder(work, 'mixed-dest');
  const good = { id: ID_A, path: keep, displayName: 'Keeper', pinned: true, previousPaths: ['/older/keep'] };
  const goneRecord = { id: ID_B, path: gone, displayName: 'Gone' };
  const surplus = Array.from({ length: 1001 }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, path: `/zz/over-${i}` }));
  const variants: Array<[string, unknown[]]> = [
    ['an invalid id', [good, goneRecord, { id: 'NOT-AN-ID', path: '/somewhere/else', displayName: 'Broken' }]],
    ['an uppercase id', [good, goneRecord, { id: ID_A.toUpperCase().replace(/1/g, 'A'), path: '/somewhere/else' }]],
    ['a duplicate id', [good, goneRecord, { id: ID_A, path: '/second/place' }]],
    ['a duplicate path', [good, goneRecord, { id: '33333333-3333-4333-8333-333333333333', path: keep, displayName: 'Twin' }]],
    ['a non-object entry', [good, goneRecord, 5]],
    ['a null entry', [good, goneRecord, null]],
    ['a relative path', [good, goneRecord, { id: '44444444-4444-4444-8444-444444444444', path: 'relative/dir' }]],
    ['a missing path', [good, goneRecord, { id: '44444444-4444-4444-8444-444444444444' }]],
    ['more than the 1000-record cap', [good, goneRecord, ...surplus]],
  ];
  for (const [label, records] of variants) {
    seed([keep, gone], records);
    const bytes = readFileSync(recordsFile, 'utf8');
    const listed = await call('GET', '/api/projects');
    assert.equal(listed.status, 200, label);
    assert.equal(listed.json.organization, false, `${label}: organization is off while the store is not trustworthy`);
    assert.ok(listed.json.projects.every((p) => p.id === undefined), `${label}: no ids are shown from an untrustworthy store`);
    assert.ok(find(listed.json, keep)?.exists, `${label}: the folders are still listed`);
    const attempts: Array<[string, string, unknown]> = [
      ['PATCH', '/api/projects', { id: ID_A, pinned: false }],
      ['PATCH', '/api/projects', { id: ID_A, displayName: 'Changed' }],
      ['POST', '/api/projects/relocate', { id: ID_B, path: dest }],
      ['POST', '/api/projects', { path: extra }],
      ['DELETE', '/api/projects', { path: extra }],
      ['POST', '/api/projects/create', { name: `mixed-new-${records.length}` }],
    ];
    for (const [method, path, body] of attempts) {
      const res = await call(method, path, body);
      if (method === 'PATCH' || path.endsWith('relocate')) assert.ok(res.status >= 400 && res.status < 600, `${label}: ${method} ${path} -> ${res.status}`);
    }
    assert.equal(readFileSync(recordsFile, 'utf8'), bytes, `${label}: the store is byte-identical after every kind of change`);
    assert.ok(registered().includes(keep) && registered().includes(gone), `${label}: and the registry keeps its folders`);
    rmSync(join(scan, `mixed-new-${records.length}`), { recursive: true, force: true });
  }
  // The boundary itself is fine: exactly 1000 valid records stay trusted.
  seed([keep], [good, ...surplus.slice(0, 999)]);
  const edge = await call('GET', '/api/projects');
  assert.equal(edge.json.organization, true);
  assert.equal(find(edge.json, keep)?.id, ID_A);
});

test('a failed final write plus a listing that predates the settings write never strands a relocating project', { skip: !unprivileged }, async () => {
  const { relocateStored, recordsFor } = await import('./projectRecords.js');
  for (const unwritableDuringStaleListing of [false, true]) {
    const gone = join(work, `stale-gone-${unwritableDuringStaleListing}`);
    const dest = folder(work, `stale-dest-${unwritableDuringStaleListing}`);
    const dir = mkdtempSync(join(sandbox, 'stale-store-'));
    const file = join(dir, 'projects.json');
    writeFileSync(file, JSON.stringify({ version: 1, records: [{ id: ID_A, path: gone, displayName: 'Stale', pinned: true }] }));
    // The marker write succeeds, the settings write "succeeds", and the directory turns read-only
    // before the final record write, which therefore fails.
    const out = await relocateStored(ID_A, dest, async () => true, async () => { chmodSync(dir, 0o555); }, file);
    assert.deepEqual(out, { ok: true });
    if (!unwritableDuringStaleListing) chmodSync(dir, 0o755);
    // A listing computed before the settings write still lists only the old folder.
    const stale = await recordsFor([{ path: gone, exists: false }], file);
    chmodSync(dir, 0o755);
    const seen = stale.records.find((r) => r.id === ID_A);
    assert.ok(seen && stale.visible.includes(seen.path), `the project stays listed through a stale listing (writable=${!unwritableDuringStaleListing})`);
    assert.equal(seen?.displayName, 'Stale');
    // The next listing, after the settings write, completes the move.
    const settled = await recordsFor([{ path: dest, exists: true }], file);
    const rec = settled.records.find((r) => r.id === ID_A);
    assert.deepEqual([rec?.path, rec?.displayName, rec?.pinned, rec?.previousPaths, rec?.pendingPath], [dest, 'Stale', true, [gone], undefined]);
    assert.deepEqual(settled.visible, [dest]);
    assert.equal(settled.records.filter((r) => r.path === dest).length, 1, 'no second record was minted for the new folder');
    const onDisk = JSON.parse(readFileSync(file, 'utf8')).records as Array<{ id: string; path: string; pendingPath?: string }>;
    assert.deepEqual(onDisk.map((r) => [r.id, r.path, r.pendingPath]), [[ID_A, dest, undefined]], 'and the store on disk is settled');
  }
});
