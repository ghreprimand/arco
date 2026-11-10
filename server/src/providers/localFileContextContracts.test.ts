import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, access, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';
const home = await mkdtemp(join(tmpdir(), 'arco-context-contract-')); installIsolatedTestHome(home);
test.after(() => rm(home, { recursive: true, force: true }));
const { initWorkflowStore, forgetWorkflowBuffer } = await import('../workflowStore.js');
const { rememberLocalToolMedia, prepareLocalFileContext, resolveLocalContextRead, clearLocalFileMedia } = await import('./localFileMedia.js');
const { projectLocalFileReferences } = await import('../primitives/localFileContext.js');
const { renderTranscript } = await import('../primitives/exportContext.js');
const { buildMessagesFromReplayEvents, summarizeClaudeNativePriorTurns } = await import('./claude-native/resumeSummary.js');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
const image = { type: 'image' as const, name: 'screenshot.png', mediaType: 'image/png', width: 1, height: 1, data: png };
function events(workflowId: string, snapshot: any) { return [{ type: 'user_message_echo', workflowId, content: 'Inspect media' }, { ...snapshot, type: 'file_context', workflowId }, { type: 'primary_text', workflowId, phase: 'passthrough', text: 'Done' }, { type: 'primary_complete', workflowId, phase: 'passthrough' }] as any; }

test('Incognito context stays in memory, is owner-scoped and clears on reset', async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'arco-private-context-'))), workflowId = 'wf-private-media';
  try {
    let snapshot: any;
    const config = { cwd, workflowId, incognito: true, priorFiles: [] } as any;
    await rememberLocalToolMedia(config, 'WebFetch', { url: 'https://example.com/image.png' }, 'one', [image], [{ name: 'note', text: 'Private document fact' }], value => { snapshot = value; }, () => {});
    await assert.rejects(access(join(cwd, '.arco')), { code: 'ENOENT' });
    const history = events(workflowId, snapshot), refs = projectLocalFileReferences(history, cwd);
    const restored = await prepareLocalFileContext({ ...config, priorFiles: refs }, true);
    assert.equal(restored.images.length, 1); assert.match(restored.text, /Private document fact/);
    assert.ok(!JSON.stringify(history).includes(png));
    const foreign = await prepareLocalFileContext({ ...config, workflowId: 'wf-other', priorFiles: refs }, true);
    assert.equal(foreign.images.length, 0); assert.match(foreign.text, /Earlier file unavailable/);
    clearLocalFileMedia(workflowId);
    const cleared = await prepareLocalFileContext({ ...config, priorFiles: refs }, true);
    assert.equal(cleared.images.length, 0); assert.match(cleared.text, /Earlier file unavailable/);
  } finally { clearLocalFileMedia(workflowId); await rm(cwd, { recursive: true, force: true }); }
});

test('isolated local Read reopens exact cached files without granting parent-folder access', async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'arco-context-read-'))), workflowId = 'wf-cached-read';
  const execution = join(cwd, 'isolated'); await mkdir(execution);
  try {
    await initWorkflowStore(cwd, workflowId);
    const config = { cwd: execution, fileContextCwd: cwd, workflowId, priorFiles: [] } as any;
    await rememberLocalToolMedia(config, 'mcp__reg-fixture__screenshot', { page: 'fixture' }, 'one', [image], [], () => {}, () => {});
    const ref = config.priorFiles.find((value: any) => value.kind === 'cached' && value.media === 'image'); assert.ok(ref);
    const expected = join(cwd, '.arco', 'workflows', workflowId, 'file-context', ref.cacheName);
    assert.equal(await resolveLocalContextRead(config, relative(cwd, expected)), expected);
    assert.deepEqual(await readFile(expected), Buffer.from(png, 'base64'));
    const unrelated = join(cwd, 'unrelated.txt'); await writeFile(unrelated, 'MUST_NOT_READ');
    await assert.rejects(resolveLocalContextRead(config, unrelated), /outside/);
    const unsafe = { kind: 'cached', name: 'bad', ownerWorkflowId: workflowId, cacheName: '../meta.json', media: 'text' };
    const rejected = await prepareLocalFileContext({ ...config, priorFiles: [unsafe] }, true);
    assert.match(rejected.text, /Earlier file unavailable/);
  } finally { forgetWorkflowBuffer(cwd, workflowId); await rm(cwd, { recursive: true, force: true }); }
});

test('retained source links cannot escape their original project', { skip: process.platform === 'win32' }, async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'arco-context-link-'))), outside = await realpath(await mkdtemp(join(tmpdir(), 'arco-outside-')));
  try {
    const target = join(outside, 'outside.txt'); await writeFile(target, 'MUST_NOT_READ');
    const link = join(cwd, 'link.txt'); await symlink(target, link);
    const config = { cwd, workflowId: 'wf-link', priorFiles: [{ kind: 'source', path: link, name: 'link.txt' }] } as any;
    const result = await prepareLocalFileContext(config, true);
    assert.match(result.text, /Earlier file unavailable/); assert.ok(!result.text.includes('MUST_NOT_READ'));
    await assert.rejects(resolveLocalContextRead(config, link));
  } finally { await rm(cwd, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test('pending file metadata is excluded and handoff starts a new file window', () => {
  const workflowId = 'wf-visible';
  const file = { kind: 'source', path: '/fixture/private.txt', name: 'private.txt' };
  const pending = [{ type: 'user_message_echo', workflowId, content: 'pending', clientMessageId: 'pending', deliveryTracked: true, attachments: ['/fixture/private.txt'] }, { type: 'file_context', workflowId, origin: 'tool', receipt: 'HIDDEN_FILE', inputClientMessageIds: ['pending'], files: [file] }] as any;
  assert.deepEqual(projectLocalFileReferences(pending, '/fixture'), []); assert.ok(!renderTranscript(pending).includes('HIDDEN_FILE'));
  const nativePending = [...events(workflowId, { origin: 'tool', receipt: 'VISIBLE', files: [] }), ...pending];
  assert.ok(!summarizeClaudeNativePriorTurns(nativePending).summary.includes('HIDDEN_FILE'));
  const earlier = events(workflowId, { origin: 'tool', receipt: 'OLD_FILE', files: [file] });
  earlier.push({ type: 'handoff_artifact_ready', workflowId, handoffId: 'handoff' }, { type: 'handoff_complete', workflowId, handoffId: 'handoff' });
  assert.deepEqual(projectLocalFileReferences(earlier, '/fixture'), []); assert.ok(!renderTranscript(earlier).includes('OLD_FILE'));
});

test('file receipts are bounded, deduplicated and readable by Native replay and summaries', () => {
  const workflowId = 'wf-receipts';
  const snapshot = { origin: 'tool', tool: 'mcp__reg-fixture__screenshot', toolInput: '{"page":"fixture"}', receipt: 'SAVED_UNIQUE screenshot.png; Read .arco/workflows/wf-receipts/file-context/saved.png', files: [] };
  const history = events(workflowId, snapshot);
  history.splice(2, 0, { type: 'primary_tool_use', workflowId, tool: snapshot.tool, input: snapshot.toolInput, status: 'completed', mediaReceipt: snapshot.receipt });
  assert.equal(renderTranscript(history).split('SAVED_UNIQUE').length - 1, 1);
  assert.equal(JSON.stringify(buildMessagesFromReplayEvents(history)).split('SAVED_UNIQUE').length - 1, 1);
  assert.match(summarizeClaudeNativePriorTurns(history).summary, /SAVED_UNIQUE/);
  const long = [{ type: 'user_message_echo', workflowId, content: 'Original request' }, ...Array.from({ length: 30 }, (_, index) => ({ type: 'file_context', workflowId, origin: 'tool', receipt: `FILE_${index}:` + 'x'.repeat(4000), files: [] })), { type: 'primary_complete', workflowId }] as any;
  const rendered = renderTranscript(long);
  assert.ok(Buffer.byteLength(rendered) < 17 * 1024); assert.match(rendered, /FILE_29/); assert.match(rendered, /Original request/);
});


test('explicit Read media metadata does not also add the legacy receipt', () => {
  const workflowId = 'wf-read-receipt';
  const receipt = 'Saved input snapshot.png';
  const history = events(workflowId, { origin: 'tool', receipt, files: [] });
  history.splice(2, 0, { type: 'primary_tool_use', workflowId, tool: 'Read', input: '{}', status: 'completed', mediaReceipt: receipt, output: 'image: snapshot.png, 1x1' });
  const native = JSON.stringify(buildMessagesFromReplayEvents(history));
  assert.equal(native.split(receipt).length - 1, 1);
  assert.ok(!native.includes('Read image receipt'));
});


test('saved file-context bytes are measured and survive operator archive/restore', async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'arco-context-archive-'))), workflowId = 'wf-context-archive';
  try {
    await initWorkflowStore(cwd, workflowId);
    const config = { cwd, workflowId, priorFiles: [] } as any;
    let snapshot: any;
    await rememberLocalToolMedia(config, 'fixture_media', {}, 'one', [image], [{ name: 'document', text: 'Archived document fact' }], event => { snapshot = event; }, () => {});
    const { persistAndStampSeq, flushWorkflowBuffer, replayEvents } = await import('../workflowStore.js');
    for (const event of events(workflowId, snapshot)) persistAndStampSeq(cwd, workflowId, event);
    await flushWorkflowBuffer(cwd, workflowId); forgetWorkflowBuffer(cwd, workflowId);
    await writeFile(join(cwd, '.arco', 'workflows', workflowId, 'meta.json'), JSON.stringify({ workflowId }));
    const { scanStorage } = await import('../storageReport.js');
    const report = await scanStorage(join(cwd, '.arco'), null);
    assert.ok(report.buckets.conversationFiles.bytes > png.length);
    const { archiveConversation, restoreConversation } = await import('../storageArchive.js');
    await archiveConversation(cwd, workflowId, { open: false, busy: false, by: 'operator' });
    await restoreConversation(cwd, workflowId);
    const history = await replayEvents(cwd, workflowId, 0);
    const restored = await prepareLocalFileContext({ ...config, priorFiles: projectLocalFileReferences(history, cwd) }, true);
    assert.equal(restored.images.length, 1); assert.match(restored.text, /Archived document fact/);
  } finally { forgetWorkflowBuffer(cwd, workflowId); await rm(cwd, { recursive: true, force: true }); }
});


test('only two recent visuals are restored while earlier snapshots remain on disk', async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'arco-context-bound-'))), workflowId = 'wf-context-bound';
  try {
    await initWorkflowStore(cwd, workflowId);
    const config = { cwd, workflowId, priorFiles: [] } as any;
    for (let index = 0; index < 4; index++) await rememberLocalToolMedia(config, 'fixture_media', { index }, String(index), [{ ...image, name: `image-${index}.png` }], [], () => {}, () => {});
    const all = [...config.priorFiles];
    const restored = await prepareLocalFileContext(config, true);
    assert.deepEqual(restored.images.map(value => value.name), ['image-2.png', 'image-3.png']);
    assert.equal(all.length, 4);
    for (const ref of all) await access(join(cwd, '.arco', 'workflows', workflowId, 'file-context', ref.cacheName));
    assert.equal(await resolveLocalContextRead(config, join('.arco', 'workflows', workflowId, 'file-context', all[0].cacheName)), join(cwd, '.arco', 'workflows', workflowId, 'file-context', all[0].cacheName));
  } finally { forgetWorkflowBuffer(cwd, workflowId); await rm(cwd, { recursive: true, force: true }); }
});
