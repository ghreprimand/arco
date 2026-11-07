import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';
import type { WorkflowState, Session } from '../workflows/types.js';
import type { WebSocket } from 'ws';

const root = await mkdtemp(path.join(tmpdir(), 'arco-tuneup-safety-'));
installIsolatedTestHome(root);
after(async () => { await (await import('../testSupport/projectWrites.js')).settleProjectWrites(); await rm(root, { recursive: true, force: true }); });
const { backupAndWriteInstructionFile, discoverInstructionFiles, discoverInstructionFilesWithLinks, instructionMetrics } = await import('./runMdTuneup.js');
const { rememberTuneupUndo, undoTuneup } = await import('./mdTuneupUndo.js');

test('candidate analysis reports lines, a byte-based token estimate and deterministic hints', async () => {
  const repeated = 'Always run the fixture checks.';
  const text = `# Session 2026-01-01\n${repeated}\n${repeated}\n`;
  const metrics = instructionMetrics(text, Buffer.byteLength(text));
  assert.equal(metrics.lines, 3);
  assert.equal(metrics.approximateTokens, Math.ceil(Buffer.byteLength(text) / 4));
  assert.ok(metrics.hints?.some((hint) => hint.includes('session-log')));
  assert.ok(metrics.hints?.some((hint) => hint.includes('Repeated')));
  assert.ok(instructionMetrics('long line\n'.repeat(201), 2010).hints?.some((hint) => hint.includes('Long file')));
  const cwd = path.join(root, 'metrics'); await mkdir(cwd); await writeFile(path.join(cwd, 'AGENTS.md'), text);
  const candidates = await discoverInstructionFiles(cwd);
  assert.equal(candidates[0]?.lines, 3);
  assert.equal(candidates[0]?.approximateTokens, metrics.approximateTokens);
});

test('discovery reports instruction links without ever treating them as write targets', async (t) => {
  const cwd = path.join(root, 'linked-candidates'); await mkdir(cwd);
  await mkdir(path.join(cwd, 'nested'));
  await writeFile(path.join(cwd, 'CLAUDE.md'), 'candidate');
  await writeFile(path.join(cwd, 'other.md'), 'not a candidate');
  const outside = path.join(root, 'external-instruction'); await writeFile(outside, 'outside');
  try {
    await symlink('CLAUDE.md', path.join(cwd, 'AGENTS.md'));
    await symlink('../other.md', path.join(cwd, 'nested', 'CLAUDE.md'));
    await symlink(outside, path.join(cwd, 'CLAUDE.local.md'));
    await symlink('missing', path.join(cwd, 'nested', 'AGENTS.md'));
  } catch (error) { if (['EPERM', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) return t.skip('symlinks unavailable'); throw error; }
  const result = await discoverInstructionFilesWithLinks(cwd);
  assert.deepEqual(result.candidates.map((item) => item.path), ['CLAUDE.md']);
  assert.deepEqual(result.candidates[0]?.alsoReadAs, ['AGENTS.md']);
  assert.deepEqual(result.skippedLinks.map((item) => item.path).sort(), ['CLAUDE.local.md', path.join('nested', 'CLAUDE.md'), path.join('nested', 'AGENTS.md')].sort());
  assert.match(result.skippedLinks.find((item) => item.path === 'CLAUDE.local.md')!.reason, /outside/);
  assert.match(result.skippedLinks.find((item) => item.path === path.join('nested', 'CLAUDE.md'))!.reason, /not a discovered/);
  assert.match(result.skippedLinks.find((item) => item.path === path.join('nested', 'AGENTS.md'))!.reason, /cannot be resolved/);
  await assert.rejects(backupAndWriteInstructionFile(cwd, 'AGENTS.md', 'replacement', Date.now()));
  assert.equal(await readFile(path.join(cwd, 'CLAUDE.md'), 'utf8'), 'candidate');
});

test('accept refuses a symlink that leaves the project', async (t) => {
  const cwd = path.join(root, 'project'), outside = path.join(root, 'outside.md');
  await mkdir(cwd); await writeFile(outside, 'outside');
  try { await symlink(outside, path.join(cwd, 'AGENTS.md')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') return t.skip('symlinks unavailable'); throw error; }
  await assert.rejects(backupAndWriteInstructionFile(cwd, 'AGENTS.md', 'replacement', Date.now()));
  assert.equal(await readFile(outside, 'utf8'), 'outside');
});

test('same-name backups created in the same millisecond do not overwrite one another', async () => {
  const cwd = path.join(root, 'two-files'); await mkdir(path.join(cwd, 'one'), { recursive: true }); await mkdir(path.join(cwd, 'two'));
  await writeFile(path.join(cwd, 'one', 'AGENTS.md'), 'first original');
  await writeFile(path.join(cwd, 'two', 'AGENTS.md'), 'second original');
  const ts = Date.now();
  const a = await backupAndWriteInstructionFile(cwd, 'one/AGENTS.md', 'first tuned', ts);
  const b = await backupAndWriteInstructionFile(cwd, 'two/AGENTS.md', 'second tuned', ts);
  assert.notEqual(a.backupPath, b.backupPath);
  assert.equal(await readFile(a.backupPath, 'utf8'), 'first original');
  assert.equal(await readFile(b.backupPath, 'utf8'), 'second original');
});

test('accept refuses invalid UTF-8 without changing the instruction file', async () => {
  const cwd = path.join(root, 'invalid-text'); await mkdir(cwd); const target = path.join(cwd, 'AGENTS.md');
  const raw = Buffer.from([0xff, 0xfe, 0x61]); await writeFile(target, raw);
  await assert.rejects(backupAndWriteInstructionFile(cwd, target, 'replacement', Date.now()), /valid UTF-8/);
  assert.deepEqual(await readFile(target), raw);
});

test('accept refuses a hard-linked instruction file', async (t) => {
  const cwd = path.join(root, 'hard-link'); await mkdir(cwd); const target = path.join(cwd, 'AGENTS.md');
  const outside = path.join(root, 'hard-link-outside.md'); await writeFile(outside, 'outside');
  try { await link(outside, target); }
  catch (error) { if (['EPERM', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) return t.skip('hard links unavailable'); throw error; }
  await assert.rejects(backupAndWriteInstructionFile(cwd, target, 'replacement', Date.now()));
  assert.equal(await readFile(outside, 'utf8'), 'outside');
});

test('accept refuses a state directory redirected outside the project', async (t) => {
  const cwd = path.join(root, 'redirected-state'), outside = path.join(root, 'state-outside');
  await mkdir(cwd); await mkdir(outside); const target = path.join(cwd, 'AGENTS.md'); await writeFile(target, 'original');
  try { await symlink(outside, path.join(cwd, '.arco'), 'dir'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') return t.skip('symlinks unavailable'); throw error; }
  await assert.rejects(backupAndWriteInstructionFile(cwd, target, 'replacement', Date.now()), /escapes/);
  assert.equal(await readFile(target, 'utf8'), 'original');
  await assert.rejects(readFile(path.join(outside, '.gitignore')));
});

test('undo restores the original and preserves the replaced tuned text in a safety backup', async () => {
  const cwd = path.join(root, 'normal'); await mkdir(cwd); const target = path.join(cwd, 'AGENTS.md');
  await writeFile(target, 'original');
  const saved = await backupAndWriteInstructionFile(cwd, target, 'tuned', Date.now());
  const undoId = rememberTuneupUndo({ workflowId: 'fixture', cwd, filePath: target, ...saved, proposed: 'tuned' });
  const result = await undoTuneup('fixture', cwd, undoId);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(await readFile(target, 'utf8'), 'original');
  assert.equal(await readFile(result.safetyBackupPath, 'utf8'), 'tuned');
  await assert.rejects(undoTuneup('fixture', cwd, undoId), /unavailable/);
});

test('undo requires confirmation for changed text and rechecks after confirmation', async () => {
  const cwd = path.join(root, 'changed'); await mkdir(cwd); const target = path.join(cwd, 'AGENTS.md');
  await writeFile(target, 'original');
  const saved = await backupAndWriteInstructionFile(cwd, target, 'tuned', Date.now());
  const undoId = rememberTuneupUndo({ workflowId: 'fixture', cwd, filePath: target, ...saved, proposed: 'tuned' });
  await writeFile(target, 'newer');
  const first = await undoTuneup('fixture', cwd, undoId);
  assert.equal(first.ok, false); if (first.ok) return;
  assert.equal(await readFile(target, 'utf8'), 'newer');
  await writeFile(target, 'newest');
  const second = await undoTuneup('fixture', cwd, undoId, first.conflictHash);
  assert.equal(second.ok, false); if (second.ok) return;
  assert.notEqual(second.conflictHash, first.conflictHash);
  const final = await undoTuneup('fixture', cwd, undoId, second.conflictHash);
  assert.equal(final.ok, true); if (!final.ok) return;
  assert.equal(await readFile(target, 'utf8'), 'original');
  assert.equal(await readFile(final.safetyBackupPath, 'utf8'), 'newest');
});

test('undo rejects tampered backups and symlink-swapped targets', async (t) => {
  const cwd = path.join(root, 'tampered'); await mkdir(cwd); const target = path.join(cwd, 'AGENTS.md');
  await writeFile(target, 'original');
  const saved = await backupAndWriteInstructionFile(cwd, target, 'tuned', Date.now());
  const undoId = rememberTuneupUndo({ workflowId: 'fixture', cwd, filePath: target, ...saved, proposed: 'tuned' });
  await assert.rejects(undoTuneup('other', cwd, undoId), /unavailable/);
  await writeFile(saved.backupPath, 'tampered');
  await assert.rejects(undoTuneup('fixture', cwd, undoId), /Backup changed/);
  await writeFile(saved.backupPath, 'original');
  const outside = path.join(root, 'undo-outside.md'); await writeFile(outside, 'outside');
  await rm(target);
  try { await symlink(outside, target); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') return t.skip('symlinks unavailable'); throw error; }
  await assert.rejects(undoTuneup('fixture', cwd, undoId));
  assert.equal(await readFile(outside, 'utf8'), 'outside');
});

test('accept and undo handlers report conflicts and restore only after confirmation', async () => {
  const cwd = path.join(root, 'handlers'); await mkdir(cwd); const target = path.join(cwd, 'AGENTS.md');
  await writeFile(target, 'original');
  const sent: Array<Record<string, unknown>> = [];
  const ws = { readyState: 1, send: (body: string) => sent.push(JSON.parse(body)) } as unknown as WebSocket;
  const { workflows, workflowCwds } = await import('../server/state.js');
  const { initWorkflowStore, flushWorkflowBuffer, forgetWorkflowBuffer } = await import('../workflowStore.js');
  const { handleMdTuneupAccept, handleMdTuneupUndo } = await import('../ws/workflowHandlers.js');
  const id = 'tuneup-fixture';
  const wf = { config: { name: 'fixture', workingDirectory: cwd }, primary: { provider: 'claude', model: 'sonnet', effort: 'medium' }, busy: false, observers: new Set([ws]), manager: { workerCount: 0 } } as unknown as WorkflowState;
  workflows.set(id, wf);
  workflowCwds.set(id, cwd); await initWorkflowStore(cwd, id);
  try {
    await handleMdTuneupAccept(ws, {} as Session, { type: 'md_tuneup_accept', workflowId: id, tuneupId: 'fixture', filePath: target, proposed: 'tuned', original: 'original' });
    const applied = sent.find((message) => message.type === 'md_tuneup_applied');
    assert.equal(applied?.ok, true); const undoId = String(applied?.undoId);
    wf.busy = true;
    await handleMdTuneupUndo(ws, {} as Session, { type: 'md_tuneup_undo', workflowId: id, undoId });
    assert.equal(sent.filter((message) => message.type === 'md_tuneup_undone').at(-1)?.ok, false);
    assert.equal(await readFile(target, 'utf8'), 'tuned'); wf.busy = false;
    await writeFile(target, 'later edit');
    await handleMdTuneupUndo(ws, {} as Session, { type: 'md_tuneup_undo', workflowId: id, undoId });
    const conflict = sent.filter((message) => message.type === 'md_tuneup_undone').at(-1);
    assert.equal(conflict?.ok, false); assert.equal(await readFile(target, 'utf8'), 'later edit');
    await handleMdTuneupUndo(ws, {} as Session, { type: 'md_tuneup_undo', workflowId: id, undoId, confirmedHash: String(conflict?.conflictHash) });
    assert.equal(sent.filter((message) => message.type === 'md_tuneup_undone').at(-1)?.ok, true);
    assert.equal(await readFile(target, 'utf8'), 'original');
  } finally {
    await flushWorkflowBuffer(cwd, id);
    forgetWorkflowBuffer(cwd, id);
    workflows.delete(id); workflowCwds.delete(id);
  }
});
