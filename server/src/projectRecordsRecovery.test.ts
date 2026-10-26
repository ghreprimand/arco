// Adversarial acceptance for project identity, organization and relocation: the
// real /api/projects routes on a throwaway HOME with synthetic folders, aimed at
// the persistence boundary (lazy record creation on GET, the settings-first
// relocation, the sidecar store) and at the claim that file access is unchanged.
import assert from 'node:assert/strict';
import { promises as fs, chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test, mock } from 'node:test';

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

test('queued listing and failed final relocation write preserve reachable identity and metadata', { timeout: 10000 }, async () => {
  const gone = join(work, 'stale-gone');
  const dest = folder(work, 'stale-dest');
  seed([gone], [{ id: ID_A, path: gone, displayName: 'Still reachable', pinned: true, archived: true }]);
  const realRename = fs.rename.bind(fs);
  const realRead = fs.readFile.bind(fs);
  let settingsEntered!: () => void;
  const entered = new Promise<void>((resolve) => { settingsEntered = resolve; });
  let releaseSettings!: () => void;
  const proceed = new Promise<void>((resolve) => { releaseSettings = resolve; });
  let recordWrites = 0;
  let queued = false;
  let settingsReadsWhileQueued = 0;
  const renameMock = mock.method(fs, 'rename', async (from: Parameters<typeof fs.rename>[0], to: Parameters<typeof fs.rename>[1]) => {
    if (to === settingsFile) {
      settingsEntered();
      await proceed;
    }
    if (to === recordsFile && ++recordWrites === 2) throw Object.assign(new Error('synthetic disk failure'), { code: 'ENOSPC' });
    return realRename(from, to);
  });
  // fs.readFile has overloads; retain its public signature while tracking only settings reads.
  const readMock = mock.method(fs, 'readFile', ((...args: Parameters<typeof fs.readFile>) => {
    if (args[0] === settingsFile && queued) settingsReadsWhileQueued++;
    return realRead(...args);
  }) as typeof fs.readFile);
  let move: ReturnType<typeof call> | undefined;
  let listing: ReturnType<typeof call> | undefined;
  try {
    move = call('POST', '/api/projects/relocate', { id: ID_A, path: dest });
    await entered;
    queued = true;
    // Direct route invocation makes the GET enter synchronously, avoiding network timing.
    const { listProjects } = await import('./projects.js');
    const get = listProjects();
    // Let a pre-lock folder/settings read complete if the implementation starts one.
    await new Promise((resolve) => setTimeout(resolve, 50));
    queued = false;
    releaseSettings();
    const snapshot = await get;
    const moved = await move;
    assert.equal(moved.status, 200);
    assert.equal(recordWrites >= 3, true, 'the failed final write is followed by recovery');
    assert.equal(settingsReadsWhileQueued, 0, 'a queued listing cannot sample stale pre-move settings');
    const project = find(snapshot, dest);
    assert.deepEqual([project?.id, project?.displayName, project?.pinned, project?.archived, project?.previousPaths], [ID_A, 'Still reachable', true, true, [gone]]);
    listing = call('GET', '/api/projects');
    const settled = await listing;
    assert.equal(settled.json.projects.filter((p) => p.id === ID_A).length, 1);
    assert.equal(find(settled.json, dest)?.id, ID_A, 'the UI still has a manageable project');
    assert.deepEqual(registered(), [dest]);
    assert.ok(stored().every((r) => !('pendingPath' in r)));
    assert.equal((await call('PATCH', '/api/projects', { id: ID_A, archived: false })).status, 200, 'organization remains reachable by the same id');
  } finally {
    releaseSettings();
    await Promise.allSettled([move, listing].filter(Boolean));
    renameMock.mock.restore();
    readMock.mock.restore();
  }
});
