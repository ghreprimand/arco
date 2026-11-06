import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync, existsSync, appendFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { randomUUID } from 'node:crypto';
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
  assert.equal(list.find(x => x.name === 'notes.md')?.primary, true, 'a top-level document is primary');
  assert.equal(list.find(x => x.name === 'song.wav')?.primary, true);
  assert.equal(list.find(x => x.name === 'package.bin')?.primary, false, 'an unknown binary is a working file');
  assert.equal(list.find(x => x.title === 'Generated image')?.primary, true, 'a generated image reported by an artifact event');
  assert.equal(list.find(x => x.title === 'Inline notes')?.primary, true);
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
  const homeCopies = path.join(home, 'documents'); mkdirSync(homeCopies);
  const exported = path.join(homeCopies, 'inline.txt');
  await outputs.transferOutput(ctx, inline.id, exported, false);
  assert.equal(readFileSync(exported, 'utf8'), inline.inline?.content);
  if (process.platform !== 'win32') assert.equal(statSync(exported).mode & 0o077, 0, 'inline copies are private');
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

test('primary outputs: media, top-level documents, reports and exports; code and subfolder files are working files', () => {
  const root = path.join('/p', '.arco', 'workflows', 'w', 'artifacts');
  const e = (name: string, rel: string, source = 'workflow artifacts', extra: Record<string, unknown> = {}) => ({ source, name, path: path.join(root, rel), category: outputs.outputCategory(name), ...extra });
  assert.equal(outputs.isPrimaryOutput(e('report.md', 'report.md'), root), true);
  assert.equal(outputs.isPrimaryOutput(e('photo.png', 'photo.png'), root), true);
  assert.equal(outputs.isPrimaryOutput(e('notes.md', 'sub/notes.md'), root), false, 'subfolder file');
  assert.equal(outputs.isPrimaryOutput(e('tool.py', 'tool.py'), root), false, 'code');
  assert.equal(outputs.isPrimaryOutput(e('bundle.zip', 'bundle.zip'), root), false);
  assert.equal(outputs.isPrimaryOutput(e('mix.wav', 'sub/mix.wav', 'media export'), root), true, 'explicit export');
  assert.equal(outputs.isPrimaryOutput(e('image.png', '../../../../elsewhere/image.png', 'artifact event'), root), true, 'generated image');
  assert.equal(outputs.isPrimaryOutput(e('main.ts', '', 'artifact event', { path: '/p/src/main.ts' }), root), false, 'code edit');
  assert.equal(outputs.isPrimaryOutput({ source: 'artifact event', name: 'Inline', category: 'documents', inline: { language: 'ts' } }, root), false);
  assert.equal(outputs.isPrimaryOutput({ source: 'artifact event', name: 'Inline', category: 'documents', inline: {} }, root), true);
});

test('outputs reported in records that were sealed into compressed segments are still found', async () => {
  const { sealLiveLog } = await import('./eventLog.js');
  const id = '11111111-2222-4333-8444-666666666666';
  const wfDir = path.join(project, '.arco', 'workflows', id);
  mkdirSync(path.join(wfDir, 'artifacts'), { recursive: true });
  writeFileSync(path.join(wfDir, 'meta.json'), JSON.stringify({ name: 'Sealed producer', cwd: project }));
  const log = path.join(wfDir, 'events.jsonl');
  const line = (seq: number, name: string) => JSON.stringify({ seq, type: 'primary_artifact', kind: 'text', path: name, title: name, ts: seq }) + '\n';
  for (const name of ['sealed-a.txt', 'sealed-b.txt', 'sealed-c.txt']) writeFileSync(path.join(project, name), 'synthetic');
  writeFileSync(log, line(1, 'sealed-a.txt'));
  const sealedCtx = await outputs.outputContext(project, id);
  assert.deepEqual((await outputs.listOutputs(sealedCtx)).map(x => x.title).sort(), ['sealed-a.txt']);
  // Written and sealed before the next refresh: the live file now holds only
  // the copied newest record.
  appendFileSync(log, line(2, 'sealed-b.txt'));
  assert.ok(await sealLiveLog(wfDir, 64));
  appendFileSync(log, line(3, 'sealed-c.txt'));
  assert.deepEqual((await outputs.listOutputs(sealedCtx)).map(x => x.title).sort(), ['sealed-a.txt', 'sealed-b.txt', 'sealed-c.txt']);
  assert.equal((await outputs.listOutputs(sealedCtx)).length, 3);
});

// Each destination scenario gets its own workflow and destination folder.
// The synthetic HOME is process-wide; grant records are scoped by workflow.
async function destinationFixture() {
  const id = randomUUID();
  const wf = path.join(project, '.arco', 'workflows', id);
  mkdirSync(path.join(wf, 'artifacts'), { recursive: true });
  writeFileSync(path.join(wf, 'meta.json'), JSON.stringify({ name: 'Destination fixture', cwd: project }));
  writeFileSync(path.join(wf, 'events.jsonl'), JSON.stringify({ type: 'primary_artifact', kind: 'text', artifactId: 'inline', title: 'Inline', content: 'Inline fixture' }) + '\n');
  const folder = mkdtempSync(path.join(home, 'destination-'));
  const context = await outputs.outputContext(project, id);
  const source = path.join(project, `destination-${id}.txt`);
  writeFileSync(source, 'synthetic output');
  await outputs.trackOutputFile(context, source);
  const entry = (await outputs.listOutputs(context)).find(row => row.path === source)!;
  return { id, folder, context, source, entry };
}

async function movedDestinationFixture() {
  const fixture = await destinationFixture();
  const moved = path.join(fixture.folder, 'moved.txt');
  await outputs.transferOutput(fixture.context, fixture.entry.id, moved, true);
  return { ...fixture, moved };
}

test('operator can copy and move output to ordinary folders inside home while protected state stays refused', async () => {
  // Reproduce the earlier fixture collision on any filesystem: an unrelated
  // home folder already exists before this scenario starts.
  mkdirSync(path.join(home, 'Documents'), { recursive: true });
  const { folder: documents, source, entry, context: ctx, id: workflowId } = await destinationFixture();
  const copied = path.join(documents, 'copy.txt');
  await outputs.transferOutput(ctx, entry.id, copied, false);
  assert.equal(readFileSync(copied, 'utf8'), 'synthetic output');
  assert.ok(existsSync(source));
  const moved = path.join(documents, 'moved.txt');
  await outputs.transferOutput(ctx, entry.id, moved, true);
  assert.equal(existsSync(source), false);
  assert.equal(await outputs.resolveTrackedOutput(project, workflowId, source), moved);
  const listed = await outputs.listOutputs(ctx);
  assert.ok(listed.some(x => x.path === copied && !x.missing));
  assert.ok(listed.some(x => x.path === moved && !x.missing));
  const copyEntry = listed.find(x => x.path === copied)!;
  const secret = path.join(documents, 'unrelated.txt'); writeFileSync(secret, 'unrelated fixture');
  unlinkSync(copied); symlinkSync(secret, copied);
  await assert.rejects(outputs.readOutput(ctx, copyEntry.id), /link/i);
  unlinkSync(copied); writeFileSync(copied, 'synthetic output');
  const blocked = path.join(documents, '.arco'); mkdirSync(blocked);
  await assert.rejects(outputs.transferOutput(ctx, entry.id, path.join(blocked, 'refused.txt'), false), /protected/i);
  assert.equal(existsSync(path.join(blocked, 'refused.txt')), false);
  const git = path.join(documents, '.git'); mkdirSync(git);
  await assert.rejects(outputs.transferOutput(ctx, entry.id, path.join(git, 'refused.txt'), false), /protected/i);
  const outside = path.join(sandbox, 'outside-home'); mkdirSync(outside);
  const link = path.join(documents, 'outside-link'); symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(outputs.transferOutput(ctx, entry.id, path.join(link, 'refused.txt'), false));
  assert.equal(existsSync(path.join(outside, 'refused.txt')), false);
});

test('a modified project output index cannot grant access to an unchosen home file', async () => {
  const { folder, moved, context: ctx, id: workflowId } = await movedDestinationFixture();
  const target = path.join(folder, 'not-chosen.txt'); writeFileSync(target, 'synthetic private content');
  const index = await store.readOutputIndex(project, workflowId);
  const original = index.entries.find(entry => entry.path === moved)!;
  const forged = { ...original, id: 'e'.repeat(32), path: target, originPath: target, aliases: [], name: 'not-chosen.txt' };
  index.entries.push(forged); await store.writeOutputIndex(project, workflowId, index);
  assert.equal((await outputs.listOutputs(ctx)).some(row => row.id === forged.id), false);
  await assert.rejects(outputs.readOutput(ctx, forged.id));
});

test('a home destination grant survives a server restart', async () => {
  const { id: workflowId, moved, source } = await movedDestinationFixture();
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const code = `const m=await import(${JSON.stringify(new URL('./outputs.ts', import.meta.url).href)}); const cwd=process.argv[1],id=process.argv[2]; process.stdout.write(await m.resolveTrackedOutput(cwd,id,process.argv[3]));`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--conditions', 'development', '--import', 'tsx', '--input-type=module', '-e', code, project, workflowId, source], { timeout: 15000 });
  assert.equal(stdout, moved);
});

test('a linked destination grant store is refused without losing the source', async () => {
  const { folder, moved, context: ctx, id: workflowId } = await movedDestinationFixture();
  const grants = path.join(home, '.arco', 'output-destinations'), backup = grants + '.backup';
  const victimDir = path.join(sandbox, 'grant-victim'); mkdirSync(victimDir);
  const victim = path.join(victimDir, 'fixture.json'); writeFileSync(victim, 'fixture');
  renameSync(grants, backup); symlinkSync(victimDir, grants, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    const entry = (await store.readOutputIndex(project, workflowId)).entries.find(row => row.path === moved)!;
    const destination = path.join(folder, 'blocked-copy.txt');
    await assert.rejects(outputs.transferOutput(ctx, entry.id, destination, false));
    assert.equal(existsSync(entry.path!), true); assert.equal(existsSync(destination), false);
    assert.equal(readFileSync(victim, 'utf8'), 'fixture');
  } finally { unlinkSync(grants); renameSync(backup, grants); }
});

test('separate processes retain independently chosen destinations', async () => {
  const { folder, id: workflowId } = await destinationFixture();
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const grants = await import('./outputGrants.js');
  const code = `const m=await import(${JSON.stringify(new URL('./outputGrants.ts', import.meta.url).href)}); await m.addOutputGrant({cwd:process.argv[1],workflowId:process.argv[2],file:process.argv[3]});`;
  const paths = ['one.txt', 'two.txt'].map(name => path.join(folder, name));
  await Promise.all(paths.map(file => promisify(execFile)(process.execPath, ['--conditions', 'development', '--import', 'tsx', '--input-type=module', '-e', code, project, workflowId, file], { timeout: 15000 })));
  for (const file of paths) assert.equal(await grants.hasOutputGrant({ cwd: project, workflowId, file }), true);
});

test('inline text saves and file copies are owner-only under umask 022', async () => {
  if (process.platform === 'win32') return;
  const { folder, context: ctx } = await destinationFixture();
  const inline = (await outputs.listOutputs(ctx)).find(x => x.inline)!;
  const loose = path.join(project, `world-readable-${randomUUID()}.txt`);
  writeFileSync(loose, 'visible source'); chmodSync(loose, 0o666);
  await outputs.trackOutputFile(ctx, loose);
  const entry = (await outputs.listOutputs(ctx)).find(x => x.path === loose)!;
  const previous = process.umask(0o022);
  try {
    const text = path.join(folder, 'umask-inline.txt');
    await outputs.transferOutput(ctx, inline.id, text, false);
    assert.equal(readFileSync(text, 'utf8'), inline.inline?.content);
    assert.equal(statSync(text).mode & 0o777, 0o600, 'an inline save is 0600 when umask would otherwise leave it group-readable');
    assert.ok((await outputs.listOutputs(ctx)).find(x => x.id === inline.id)?.inline, 'the inline source stays inline');

    const copied = path.join(folder, 'umask-file.txt');
    await outputs.transferOutput(ctx, entry.id, copied, false);
    assert.equal(readFileSync(copied, 'utf8'), 'visible source');
    assert.equal(statSync(copied).mode & 0o777, 0o600, 'a file copy does not keep the source mode');
    assert.equal(statSync(loose).mode & 0o777, 0o666, 'the source file is left unchanged');
    assert.ok(existsSync(loose));

    process.umask(0);
    const wide = path.join(folder, 'umask-zero.txt');
    await outputs.transferOutput(ctx, inline.id, wide, false);
    assert.equal(statSync(wide).mode & 0o777, 0o600, 'umask 000 does not widen an inline save');
    const wideFile = path.join(folder, 'umask-zero-file.txt');
    await outputs.transferOutput(ctx, entry.id, wideFile, false);
    assert.equal(statSync(wideFile).mode & 0o777, 0o600, 'umask 000 does not widen a file copy');

    await assert.rejects(outputs.transferOutput(ctx, inline.id, text, false), /EEXIST/);
    assert.equal(readFileSync(text, 'utf8'), inline.inline?.content);
  } finally {
    process.umask(previous);
  }
});
