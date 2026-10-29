import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
const sandbox = realpathSync(mkdtempSync(path.join(tmpdir(), 'arco-output-http-')));
const home = path.join(sandbox, 'home'), project = path.join(sandbox, 'project'), otherProject = path.join(sandbox, 'other');
const ids = ['11111111-2222-4333-8444-555555555555', '22222222-3333-4444-8555-666666666666', '33333333-4444-4555-8666-777777777777'];
for (const folder of [path.join(home, '.arco'), project, otherProject]) mkdirSync(folder, { recursive: true });
process.env.HOME = home; process.env.USERPROFILE = home; process.env.ARCO_HOME = path.join(home, '.arco');
writeFileSync(path.join(home, '.arco', 'settings.json'), JSON.stringify({ projects: [project, otherProject] }));
for (const [i, id] of ids.entries()) {
  const root = path.join(i === 1 ? otherProject : project, '.arco', 'workflows', id);
  mkdirSync(path.join(root, 'artifacts'), { recursive: true });
  writeFileSync(path.join(root, 'meta.json'), JSON.stringify({ name: `Producer ${i}` }));
  writeFileSync(path.join(root, 'artifacts', `output-${i}.txt`), `Synthetic ${i}`);
}
const { tryHandleOutputRoutes } = await import('./outputRoutes.js');
const { createCluster } = await import('../clusterStore.js');
const { workflows, workflowCwds } = await import('../server/state.js');
const { tryHandleImageWriteRoutes } = await import('./imageWriteRoutes.js');
const server = createServer((req, res) => { void (async () => { if (await tryHandleOutputRoutes(req, res)) return; if (await tryHandleImageWriteRoutes(req, res)) return; res.writeHead(404); res.end(); })(); });
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(sandbox, { recursive: true, force: true }); });
const query = (id: string, cwd = project) => new URLSearchParams({ workflowId: id, cwd });

test('cluster outputs include only its members, retain producer context across projects and exclude Incognito', async () => {
  const cluster = await createCluster({ cwd: project, memberWorkflowIds: ids.slice(0, 2) });
  let res = await fetch(`${base}/api/outputs?clusterId=${cluster.clusterId}`);
  assert.equal(res.status, 200);
  const list = await res.json() as { outputs: Array<{ workflowId: string; cwd: string; producer: string }> };
  assert.deepEqual(new Set(list.outputs.map(o => o.workflowId)), new Set(ids.slice(0, 2)));
  assert.equal(list.outputs.find(o => o.workflowId === ids[1])?.cwd, otherProject);
  assert.ok(list.outputs.every(o => o.producer.length > 0));
  workflows.set(ids[1], { config: { incognito: true } } as never);
  res = await fetch(`${base}/api/outputs?clusterId=${cluster.clusterId}`);
  const privateList = await res.json() as { outputs: Array<{ workflowId: string }> };
  assert.deepEqual(privateList.outputs.map(o => o.workflowId), [ids[0]]);
  assert.equal((await fetch(`${base}/api/outputs?${query(ids[1], otherProject)}`)).status, 400);
  workflows.delete(ids[1]);
});

test('content/download endpoints use indexed identity, safe headers, range and explicit no-clobber transfer', async () => {
  const list = await (await fetch(`${base}/api/outputs?${query(ids[0])}`)).json() as { outputs: Array<{ id: string }> };
  const id = list.outputs[0].id;
  let res = await fetch(`${base}/api/outputs/content?${query(ids[0])}&id=${id}`);
  assert.deepEqual(await res.json(), { type: 'text', content: 'Synthetic 0', size: 11 });
  res = await fetch(`${base}/api/outputs/file?${query(ids[0])}&id=${id}`);
  assert.match(res.headers.get('content-disposition') || '', /^attachment/);
  assert.match(res.headers.get('content-security-policy') || '', /sandbox/);
  assert.equal(await res.text(), 'Synthetic 0');
  res = await fetch(`${base}/api/outputs/file?${query(ids[0])}&id=${id}`, { headers: { Range: 'bytes=0-3' } });
  assert.equal(res.status, 206); assert.equal(await res.text(), 'Synt');
  assert.equal((await fetch(`${base}/api/outputs/content?${query(ids[2])}&id=${id}`)).status, 400);
  const destination = path.join(otherProject, 'moved.txt');
  const move = () => fetch(`${base}/api/outputs/transfer`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd: project, workflowId: ids[0], id, destination, action: 'move' }) });
  assert.equal((await move()).status, 200);
  assert.equal(await (await fetch(`${base}/api/outputs/file?${query(ids[0])}&id=${id}`)).text(), 'Synthetic 0');
  writeFileSync(path.join(otherProject, 'collision.txt'), 'existing');
  res = await fetch(`${base}/api/outputs/transfer`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd: project, workflowId: ids[0], id, destination: path.join(otherProject, 'collision.txt'), action: 'move' }) });
  assert.equal(res.status, 409); assert.equal(readFileSync(destination, 'utf8'), 'Synthetic 0');
});

test('inline artifacts are fetched explicitly and incomplete text-write requests never erase files', async () => {
  const dir = path.join(project, '.arco', 'workflows', ids[0]);
  writeFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({ type: 'primary_artifact', kind: 'text', artifactId: 'inline-http', title: 'Inline HTTP', content: 'Explicit inline fixture' }) + '\n');
  const body = await (await fetch(`${base}/api/outputs?${query(ids[0])}`)).json() as { outputs: Array<{ id: string; inline?: { content: string } }> };
  const inline = body.outputs.find(row => row.inline)!;
  assert.equal(inline.inline?.content, '');
  const preview = await (await fetch(`${base}/api/outputs/content?${query(ids[0])}&id=${inline.id}`)).json() as { content: string };
  assert.equal(preview.content, 'Explicit inline fixture');
  const file = body.outputs.find(row => !row.inline)!;
  const missing = await fetch(`${base}/api/outputs/text`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd: project, workflowId: ids[0], id: file.id }) });
  assert.equal(missing.status, 400);
  assert.equal(readFileSync(path.join(otherProject, 'moved.txt'), 'utf8'), 'Synthetic 0');
});

test('existing image editor writes index variants after moving outside the producing cwd without authorizing unrelated destinations', async () => {
  const source = path.join(project, '.arco', 'workflows', ids[0], 'artifacts', 'image.png');
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  writeFileSync(source, Buffer.from(png, 'base64'));
  const rows = await (await fetch(`${base}/api/outputs?${query(ids[0])}`)).json() as { outputs: Array<{ id: string; path: string }> };
  const original = rows.outputs.find(row => row.path === source)!;
  const moved = path.join(otherProject, 'image-moved.png');
  const move = await fetch(`${base}/api/outputs/transfer`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd: project, workflowId: ids[0], id: original.id, destination: moved, action: 'move' }) });
  assert.equal(move.status, 200);
  workflowCwds.set(ids[0], project);
  try {
    const variant = path.join(otherProject, 'edited.png');
    const response = await fetch(`${base}/api/image/write`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd: '/wrong-active-tab', workflowId: ids[0], sourcePath: moved, path: variant, dataUrl: `data:image/png;base64,${png}` }) });
    assert.equal((await response.json() as { ok: boolean }).ok, true);
    const updated = await (await fetch(`${base}/api/outputs?${query(ids[0])}`)).json() as { outputs: Array<{ id: string; path: string; workflowId: string; derivedFrom?: string; inputPath?: string }> };
    const exported = updated.outputs.find(row => row.path === variant)!;
    assert.equal(exported.workflowId, ids[0]); assert.equal(exported.derivedFrom, original.id); assert.equal(exported.inputPath, moved);
    const outside = path.join(sandbox, 'unapproved.png');
    const denied = await fetch(`${base}/api/image/write`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workflowId: ids[0], sourcePath: moved, path: outside, dataUrl: `data:image/png;base64,${png}` }) });
    assert.equal((await denied.json() as { ok: boolean }).ok, false);
  } finally { workflowCwds.delete(ids[0]); }
});

test('large cluster collections still include outputs from the last producing member', async () => {
  const members = Array.from({ length: 65 }, (_, i) => `50000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
  for (const [i, id] of members.entries()) {
    const root = path.join(project, '.arco', 'workflows', id);
    mkdirSync(path.join(root, 'artifacts'), { recursive: true });
    writeFileSync(path.join(root, 'meta.json'), JSON.stringify({ name: `Member ${i}` }));
    if (i === 64) writeFileSync(path.join(root, 'artifacts', 'last-member.txt'), 'last member output');
  }
  const cluster = await createCluster({ cwd: project, memberWorkflowIds: members });
  const response = await fetch(`${base}/api/outputs?clusterId=${cluster.clusterId}`);
  assert.equal(response.status, 200);
  const body = await response.json() as { outputs: Array<{ workflowId: string; name: string }> };
  assert.deepEqual(body.outputs.map(row => [row.workflowId, row.name]), [[members[64], 'last-member.txt']]);
});
