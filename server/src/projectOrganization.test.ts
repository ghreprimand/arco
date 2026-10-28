// Project identity, organization, creation, removal and folder recovery through
// the real /api/projects routes, on a throwaway HOME with synthetic folders.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'arco-project-org-')));
const home = join(sandbox, 'home');
const scan = join(home, 'Projects');
const outside = join(sandbox, 'work');
mkdirSync(join(scan, 'alpha'), { recursive: true });
mkdirSync(join(scan, 'beta'));
mkdirSync(join(outside, 'client-site'), { recursive: true });
writeFileSync(join(outside, 'client-site', 'notes.txt'), 'synthetic');
mkdirSync(join(home, '.arco'), { recursive: true });
// Module-level paths (settings, recent-cwd registry) read HOME at import.
process.env.HOME = home;
process.env.USERPROFILE = home;

type Project = { path: string; name: string; source: string; exists: boolean; id?: string; derivedName?: string; displayName?: string; pinned?: boolean; archived?: boolean; previousPaths?: string[] };
type List = { projects: Project[]; scanFolder: string | null; organization?: boolean };
let server: Server;
let base = '';

before(async () => {
  const { tryHandleProjectRoutes } = await import('./http/projectRoutes.js');
  server = createServer((req, res) => { void tryHandleProjectRoutes(req, res).then((handled) => { if (!handled) { res.writeHead(404); res.end(); } }); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(sandbox, { recursive: true, force: true });
});

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: List & { error?: string } }> {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
  return { status: res.status, json: await res.json() as List & { error?: string } };
}
const list = async () => (await call('GET', '/api/projects')).json;
const find = (l: List, p: string) => l.projects.find((x) => x.path === p);
const settingsProjects = () => JSON.parse(readFileSync(join(home, '.arco', 'settings.json'), 'utf8')).projects as string[] | undefined;

test('scanned folders stay transient until explicitly kept, then retain stable identity', async () => {
  const { patchSettings } = await import('./settings.js');
  await patchSettings({ defaultWorkingDirectory: scan });
  const discovered = await list();
  assert.equal(find(discovered, join(scan, 'alpha'))?.id, undefined);
  assert.equal(existsSync(join(home, '.arco', 'projects.json')), false);
  await call('POST', '/api/projects', { path: join(scan, 'alpha') });
  const first = await list();
  assert.equal(first.organization, true);
  assert.equal(first.scanFolder, scan);
  const alpha = find(first, join(scan, 'alpha'));
  assert.ok(alpha?.id && alpha.source === 'registered' && alpha.exists && alpha.name === 'alpha' && alpha.derivedName === 'alpha');
  const second = await list();
  assert.deepEqual(second.projects.map((p) => [p.path, p.id]), first.projects.map((p) => [p.path, p.id]));
  const store = JSON.parse(readFileSync(join(home, '.arco', 'projects.json'), 'utf8'));
  assert.equal(store.version, 1);
  assert.equal(store.records.length, 1);
});

test('rename, pin and archive change only metadata and can be undone', async () => {
  const alpha = find(await list(), join(scan, 'alpha'))!;
  const changed = await call('PATCH', '/api/projects', { id: alpha.id, displayName: 'Budget tracker', pinned: true, archived: true });
  assert.equal(changed.status, 200);
  const now = find(changed.json, alpha.path)!;
  assert.deepEqual([now.id, now.name, now.derivedName, now.displayName, now.pinned, now.archived], [alpha.id, 'Budget tracker', 'alpha', 'Budget tracker', true, true]);
  const reset = find((await call('PATCH', '/api/projects', { id: alpha.id, displayName: '', pinned: false, archived: false })).json, alpha.path)!;
  assert.deepEqual([reset.name, reset.displayName, reset.pinned, reset.archived], ['alpha', undefined, undefined, undefined]);
  assert.deepEqual(readdirSync(join(scan, 'alpha')), [], 'the folder is untouched');
  assert.equal((await call('PATCH', '/api/projects', { id: alpha.id, pinned: 'yes' })).status, 400);
  assert.equal((await call('PATCH', '/api/projects', { id: alpha.id })).status, 400);
  assert.equal((await call('PATCH', '/api/projects', { id: '00000000-0000-4000-8000-000000000000', pinned: true })).status, 404);
  assert.equal((await call('PATCH', '/api/projects', '{not json')).status, 400);
});

test('the filesystem root, the home folder and chat storage cannot become projects', async () => {
  for (const path of ['/', home, join(home, '.arco', 'chats')]) {
    if (path.includes('chats')) mkdirSync(path, { recursive: true });
    const res = await call('POST', '/api/projects', { path });
    assert.equal(res.status, 400, path);
  }
  assert.match((await call('POST', '/api/projects', { path: home })).json.error ?? '', /home folder cannot be projects/);
});

test('create makes one new empty folder in the scan folder and registers it; it never reuses one', async () => {
  const created = await call('POST', '/api/projects/create', { name: 'gamma' });
  assert.equal(created.status, 200);
  const gamma = find(created.json, join(scan, 'gamma'));
  assert.ok(gamma?.id && gamma.source === 'registered' && gamma.exists);
  assert.deepEqual(readdirSync(join(scan, 'gamma')), []);
  assert.ok(settingsProjects()?.includes(join(scan, 'gamma')));
  assert.match((await call('POST', '/api/projects/create', { name: 'gamma' })).json.error ?? '', /already exists/);
  for (const name of ['../escape', '.hidden', 'a/b', '', 'x'.repeat(65), 'trailing.']) {
    assert.equal((await call('POST', '/api/projects/create', { name })).status, 400, JSON.stringify(name));
  }
  assert.equal(existsSync(join(home, 'escape')), false);
  assert.equal((await call('GET', '/api/projects/create')).status, 405);
});

test('remove from list forgets the registration only; re-adding keeps the same identity', async () => {
  const gamma = find(await list(), join(scan, 'gamma'))!;
  await call('PATCH', '/api/projects', { id: gamma.id, displayName: 'Gamma notes' });
  const removed = await call('DELETE', '/api/projects', { path: gamma.path });
  assert.equal(removed.status, 200);
  assert.equal(find(removed.json, gamma.path)?.source, 'scanned', 'still in the scan folder, no longer registered');
  assert.ok(existsSync(gamma.path), 'files are not touched');
  assert.equal(settingsProjects()?.includes(gamma.path) ?? false, false);
  const readded = find((await call('POST', '/api/projects', { path: gamma.path })).json, gamma.path)!;
  assert.deepEqual([readded.id, readded.name, readded.source], [gamma.id, 'Gamma notes', 'registered']);
});

test('a moved folder shows as missing and relocation keeps identity, metadata and the old path', async () => {
  const oldPath = join(outside, 'client-site');
  const newPath = join(outside, 'client-site-2026');
  const added = find((await call('POST', '/api/projects', { path: oldPath })).json, oldPath)!;
  await call('PATCH', '/api/projects', { id: added.id, displayName: 'Client site', pinned: true });
  const order = settingsProjects()!;
  assert.equal((await call('POST', '/api/projects/relocate', { id: added.id, path: newPath })).status, 400, 'an existing folder is not relocated');
  renameSync(oldPath, newPath);
  const missing = find(await list(), oldPath)!;
  assert.deepEqual([missing.id, missing.exists, missing.name, missing.pinned], [added.id, false, 'Client site', true]);
  // Refusals leave everything as it was.
  assert.equal((await call('POST', '/api/projects/relocate', { id: added.id, path: join(outside, 'nowhere') })).status, 400);
  assert.equal((await call('POST', '/api/projects/relocate', { id: added.id, path: '/' })).status, 400);
  const alpha = find(await list(), join(scan, 'alpha'))!;
  await call('PATCH', '/api/projects', { id: alpha.id, pinned: true });
  assert.match((await call('POST', '/api/projects/relocate', { id: added.id, path: alpha.path })).json.error ?? '', /already a project/);
  await call('PATCH', '/api/projects', { id: alpha.id, pinned: false });
  const moved = await call('POST', '/api/projects/relocate', { id: added.id, path: newPath });
  assert.equal(moved.status, 200, moved.json.error);
  const now = find(moved.json, newPath)!;
  assert.deepEqual([now.id, now.name, now.pinned, now.exists, now.source, now.previousPaths], [added.id, 'Client site', true, true, 'registered', [oldPath]]);
  assert.equal(find(moved.json, oldPath), undefined, 'the old location is represented by the moved project');
  assert.deepEqual(settingsProjects(), order.map((p) => (p === oldPath ? newPath : p)), 'registration replaced in place');
  assert.equal(readFileSync(join(newPath, 'notes.txt'), 'utf8'), 'synthetic');
});

test('a recently used folder that moved can be relocated without a duplicate entry', async () => {
  const oldPath = join(outside, 'scratchpad');
  const newPath = join(outside, 'scratchpad-moved');
  mkdirSync(oldPath);
  writeFileSync(join(home, '.arco', 'known-cwds.json'), JSON.stringify([oldPath]));
  const recent = find(await list(), oldPath)!;
  assert.equal(recent.source, 'recent');
  renameSync(oldPath, newPath);
  const moved = await call('POST', '/api/projects/relocate', { id: recent.id, path: newPath });
  assert.equal(moved.status, 200, moved.json.error);
  assert.deepEqual([find(moved.json, newPath)?.id, find(moved.json, newPath)?.source], [recent.id, 'registered']);
  assert.equal(find(moved.json, oldPath), undefined);
  assert.deepEqual(JSON.parse(readFileSync(join(home, '.arco', 'known-cwds.json'), 'utf8')), [oldPath], 'the recent-cwd registry is not rewritten');
});

test('an unreadable record store is left alone: projects still list, organizing is refused', async () => {
  const file = join(home, '.arco', 'projects.json');
  const good = readFileSync(file, 'utf8');
  writeFileSync(file, '{"version":1,"records":[');
  try {
    const l = await list();
    assert.equal(l.organization, false);
    assert.ok(l.projects.length > 0 && l.projects.every((p) => p.id === undefined));
    const alpha = JSON.parse(good).records.find((r: { path: string }) => r.path === join(scan, 'alpha'));
    const refused = await call('PATCH', '/api/projects', { id: alpha.id, pinned: true });
    assert.equal(refused.status, 404, 'no listed project carries that id while the store is unreadable');
    assert.equal(readFileSync(file, 'utf8'), '{"version":1,"records":[');
    assert.equal((await call('POST', '/api/projects/create', { name: 'delta' })).status, 200, 'registration does not depend on the record store');
  } finally {
    writeFileSync(file, good);
  }
});

test('an explicit new folder path works outside the scan folder without reusing an existing directory', async () => {
  const target = join(sandbox, 'explicit-project');
  const created = await call('POST', '/api/projects/create', { path: target });
  assert.equal(created.status, 200);
  assert.ok(find(created.json, target)?.id);
  assert.deepEqual(readdirSync(target), []);
  assert.equal((await call('POST', '/api/projects/create', { path: target })).status, 400);
  assert.equal((await call('POST', '/api/projects/create', { path: join(sandbox, 'absent-parent', 'project') })).status, 400);
  assert.equal((await call('POST', '/api/projects/create', { path: join(home, '.codex', 'project') })).status, 400);
});
