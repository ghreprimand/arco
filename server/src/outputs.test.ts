import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
const sandbox = realpathSync(mkdtempSync(path.join(tmpdir(), 'arco-outputs-')));
const home = path.join(sandbox, 'home'), project = path.join(sandbox, 'mounted-project'), copies = path.join(sandbox, 'copies');
const workflowId = '11111111-2222-4333-8444-555555555555';
const dir = path.join(project, '.arco', 'workflows', workflowId), artifacts = path.join(dir, 'artifacts');
for (const p of [path.join(home, '.arco'), artifacts, copies]) mkdirSync(p, { recursive: true });
process.env.HOME = home; process.env.USERPROFILE = home; process.env.ARCO_HOME = path.join(home, '.arco');
writeFileSync(path.join(home, '.arco', 'settings.json'), JSON.stringify({ projects: [project, copies], projectRoots: [] }));
writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ name: 'Fixture producer', cwd: project }));
const events = path.join(dir, 'events.jsonl');
writeFileSync(events, '');
after(() => rmSync(sandbox, { recursive: true, force: true }));
const outputs = await import('./outputs.js');
const store = await import('./outputStore.js');
const ctx = await outputs.outputContext(project, workflowId);

test('durable output projection joins artifact folders and exact events without changed-file guesses', async () => {
  for (const name of ['notes.md', 'song.wav', 'clip.mp4', 'package.bin']) writeFileSync(path.join(artifacts, name), 'synthetic');
  mkdirSync(path.join(artifacts, 'raw-tools')); writeFileSync(path.join(artifacts, 'raw-tools', 'spill.txt'), 'private spill');
  writeFileSync(path.join(project, 'generated.png'), 'synthetic image');
  writeFileSync(path.join(project, 'changed.txt'), 'not an output');
  writeFileSync(events, [
    { type: 'primary_artifact', kind: 'image', artifactId: 'image1', path: 'generated.png', title: 'Generated image', ts: 1 },
    { type: 'primary_artifact', kind: 'image', artifactId: 'image1', path: 'generated.png', title: 'Generated image', ts: 1 },
    { type: 'primary_artifact', kind: 'confirm', artifactId: 'ask', path: 'changed.txt', content: 'Confirm?' },
    { type: 'primary_artifact', kind: 'text', artifactId: 'inline', title: 'Inline notes', content: 'Inline only' },
  ].map(x => JSON.stringify(x)).join('\n') + '\n');
  const list = await outputs.listOutputs(ctx);
  assert.equal(list.length, 6); assert.equal(list.filter(x => x.title === 'Generated image').length, 1);
  assert.equal(list.find(x => x.name === 'song.wav')?.category, 'audio');
  assert.equal(list.find(x => x.name === 'clip.mp4')?.category, 'video');
  assert.equal(list.find(x => x.name === 'package.bin')?.category, 'other');
  assert.equal(list.find(x => x.title === 'Inline notes')?.path, undefined);
  assert.ok(!list.some(x => x.name === 'changed.txt' || x.name === 'spill.txt'));
  const again = await outputs.listOutputs(await outputs.outputContext(project, workflowId));
  assert.deepEqual(again.map(x => x.id), list.map(x => x.id));
});

test('copy retains source, move preserves identity and old links, collisions and index failures preserve source', async () => {
  const original = (await outputs.listOutputs(ctx)).find(x => x.name === 'generated.png')!;
  const copy = path.join(copies, 'saved.png');
  await outputs.transferOutput(ctx, original.id, copy, false);
  assert.ok(existsSync(path.join(project, 'generated.png')) && existsSync(copy));
  assert.equal((await outputs.listOutputs(ctx)).find(x => x.path === copy)?.derivedFrom, original.id);
  const moved = path.join(copies, 'moved.png');
  await outputs.transferOutput(ctx, original.id, moved, true);
  assert.equal(existsSync(path.join(project, 'generated.png')), false);
  assert.equal(await outputs.resolveTrackedOutput(project, workflowId, 'generated.png'), moved);
  const refreshed = await outputs.listOutputs(ctx);
  assert.equal(refreshed.find(x => x.id === original.id)?.path, moved);
  await assert.rejects(outputs.transferOutput(ctx, original.id, copy, true), /EEXIST/);
  assert.ok(existsSync(moved));
  const failed = path.join(copies, 'failed.png');
  await assert.rejects(outputs.transferOutput(ctx, original.id, failed, true, async () => { throw new Error('fixture index failure'); }), /source remains intact/);
  assert.ok(existsSync(moved)); assert.equal(existsSync(failed), false);
  assert.equal((await store.readOutputIndex(project, workflowId)).entries.find(x => x.id === original.id)?.path, moved);
});

test('missing outputs retain provenance and partial event tails reconcile exactly once', async () => {
  const list = await outputs.listOutputs(ctx), note = list.find(x => x.name === 'notes.md')!;
  unlinkSync(note.path!);
  assert.equal((await outputs.listOutputs(ctx)).find(x => x.id === note.id)?.missing, true);
  writeFileSync(path.join(project, 'later.txt'), 'later');
  appendFileSync(events, '{"type":"primary_artifact","kind":"text","path":"later.txt"');
  await outputs.listOutputs(ctx);
  appendFileSync(events, ',"title":"Later"}\n');
  assert.equal((await outputs.listOutputs(ctx)).filter(x => x.title === 'Later').length, 1);
  assert.equal((await outputs.listOutputs(ctx)).filter(x => x.title === 'Later').length, 1);
});

test('output paths remain confined, deny protected state and directory symlink escapes, and reject malformed indexes', async () => {
  const original = (await outputs.listOutputs(ctx)).find(x => x.name === 'saved.png')!;
  const outside = path.join(sandbox, 'outside'); mkdirSync(outside);
  await assert.rejects(outputs.transferOutput(ctx, original.id, path.join(outside, 'escape.png'), false));
  const key = path.join(home, '.codex'); mkdirSync(key); writeFileSync(path.join(key, 'auth.json'), 'synthetic credential');
  await assert.rejects(outputs.transferOutput(ctx, original.id, path.join(key, 'copied.png'), false));
  const link = path.join(copies, 'escape');
  symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(outputs.transferOutput(ctx, original.id, path.join(link, 'escape.png'), false));
  assert.equal(existsSync(path.join(outside, 'escape.png')), false);
  await assert.rejects(outputs.outputContext(project, '../invalid'));
  const privateId = '44444444-5555-4666-8777-888888888888';
  mkdirSync(path.join(project, '.arco', 'workflows', privateId, 'artifacts'), { recursive: true });
  await assert.rejects(outputs.outputContext(project, privateId), /metadata is unavailable/);
  const index = path.join(dir, 'outputs.json'), good = readFileSync(index, 'utf8');
  writeFileSync(index, '{broken');
  await assert.rejects(outputs.listOutputs(ctx), /index could not be read/);
  assert.equal(readFileSync(index, 'utf8'), '{broken');
  const badShape = JSON.parse(good); delete badShape.entries[0].category; writeFileSync(index, JSON.stringify(badShape));
  await assert.rejects(outputs.listOutputs(ctx), /index could not be read/);
  writeFileSync(index, good);
});

test('supported event exports outside cwd survive replay and foreign workflow stores remain excluded', async () => {
  const media = path.join(copies, 'export.wav'); writeFileSync(media, 'fixture audio');
  const otherId = '22222222-3333-4444-8555-666666666666';
  const other = path.join(project, '.arco', 'workflows', otherId, 'artifacts'); mkdirSync(other, { recursive: true });
  writeFileSync(path.join(other, 'unrelated.txt'), 'unrelated output');
  appendFileSync(events, [
    { type: 'media_op_result', ok: true, outputPath: media, op: 'convert', ts: 4 },
    { type: 'primary_artifact', kind: 'text', path: path.join(other, 'unrelated.txt'), ts: 5 },
    { type: 'primary_tool_use', status: 'failed', tool: 'Write', input: JSON.stringify({ file_path: 'failed.txt' }) },
  ].map(x => JSON.stringify(x)).join('\n') + '\n');
  const list = await outputs.listOutputs(ctx);
  assert.equal(list.find(x => x.path === media)?.category, 'audio');
  assert.ok(!list.some(x => x.name === 'unrelated.txt' || x.name === 'failed.txt'));
  const inline = list.find(x => x.inline)!;
  const exported = path.join(copies, 'inline.txt');
  await outputs.transferOutput(ctx, inline.id, exported, false);
  assert.equal(readFileSync(exported, 'utf8'), inline.inline?.content);
  assert.equal((await outputs.listOutputs(ctx)).find(x => x.path === exported)?.derivedFrom, inline.id);
  assert.ok((await outputs.listOutputs(ctx)).find(x => x.id === inline.id)?.inline);
});

test('output links and text edits retain producing context after a move to another approved project', async () => {
  const file = path.join(artifacts, 'draft.md'); writeFileSync(file, 'draft');
  const entry = (await outputs.listOutputs(ctx)).find(x => x.path === file)!;
  const target = path.join(copies, 'draft-moved.md');
  await outputs.transferOutput(ctx, entry.id, target, true);
  const { resolveBrowserRead, resolveWorkflowDocument } = await import('./http/readConfinement.js');
  assert.equal(await resolveBrowserRead(file, project, workflowId), target);
  assert.equal(await resolveWorkflowDocument(project, workflowId, 'artifacts', 'draft.md'), target);
  await outputs.saveOutputText(ctx, entry.id, 'edited');
  assert.equal(readFileSync(target, 'utf8'), 'edited');
  assert.equal(await outputs.resolveTrackedOutput(project, workflowId, path.join(home, '.codex', 'auth.json')), null);
});

test('editor variants retain an origin even when their input was never listed as a generated output', async () => {
  const source = path.join(project, 'operator-image.png'), variant = path.join(project, 'operator-image-edited.png');
  writeFileSync(source, 'fixture input'); writeFileSync(variant, 'fixture export');
  await outputs.trackEditorOutput(project, workflowId, variant, source);
  const row = (await outputs.listOutputs(ctx)).find(entry => entry.path === variant)!;
  assert.equal(row.inputPath, source);
  assert.ok(!(await outputs.listOutputs(ctx)).some(entry => entry.path === source), 'an editor input is not automatically a generated output');
});

test('a fresh server process recovers moved output links, missing provenance and editor origins from durable metadata', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const code = `const m=await import(${JSON.stringify(new URL('./outputs.ts', import.meta.url).href)}); const cwd=process.argv[1],id=process.argv[2];const rows=await m.listOutputs(await m.outputContext(cwd,id));const mapped=await m.resolveTrackedOutput(cwd,id,'generated.png'); process.stdout.write(JSON.stringify({rows,mapped}));`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--conditions', 'development', '--import', 'tsx', '--input-type=module', '-e', code, project, workflowId], { timeout: 15000, maxBuffer: 512 * 1024 });
  const restored = JSON.parse(stdout) as { rows: Array<{ path: string; missing: boolean; name: string; inputPath?: string }>; mapped: string };
  assert.equal(restored.mapped, path.join(copies, 'moved.png'));
  assert.equal(restored.rows.find(row => row.name === 'notes.md')?.missing, true);
  assert.equal(restored.rows.find(row => row.path === path.join(project, 'operator-image-edited.png'))?.inputPath, path.join(project, 'operator-image.png'));
});
