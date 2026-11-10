import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildPreviewCaptureReviewContent } from './reviewContent.js';
import { runReviewer } from './runReviewer.js';
import { artifactsDir } from '../workers/limits.js';

test('preview review attaches its own captured image to the reviewer', async () => {
  const cwd = await fs.mkdtemp(path.join(tmpdir(), 'arco-review-capture-'));
  const workflowId = 'fixture';
  try {
    const dir = artifactsDir(cwd, workflowId);
    await fs.mkdir(dir, {recursive: true});
    const image = path.join(dir, 'preview-capture-123.jpg');
    await fs.writeFile(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64'));
    await fs.writeFile(path.join(dir, 'preview-capture-123.md'), 'Screenshot saved as `preview-capture-123.jpg`.');
    const built = await buildPreviewCaptureReviewContent(cwd, workflowId, 'preview-capture-123.md') as any;
    assert.equal(built.attachments.length, 1);
    assert.notEqual(built.attachments[0], image);
    const snapshot = await fs.readFile(built.attachments[0]);
    assert.deepEqual([...snapshot.subarray(0, 8)], [137,80,78,71,13,10,26,10]);
    await fs.writeFile(image, 'changed after capture');
    assert.doesNotMatch(built.content, /cannot see the image/);
    let received: any;
    const manager = { spawn: async (_spec: unknown, _event: unknown, options: unknown) => { received = options; return {text: 'Verdict\nPASS'}; } };
    const handle = runReviewer({cwd, workflowId, manager: manager as any, broadcast: () => {}}, {
      reviewer: {provider:'claude', model:'fixture', effort:'medium'} as any,
      primary: {provider:'claude', model:'fixture', effort:'medium'} as any,
      contextRef: {kind:'preview-capture', reportName:'preview-capture-123.md'},
      contextLabel: built.label, content: built.content, attachments: built.attachments,
    } as any);
    await handle.settled;
    assert.deepEqual(received.attachments, built.attachments);
    assert.deepEqual(await fs.readFile(received.attachments[0]), snapshot);
    await built.cleanup();
    await assert.rejects(fs.stat(received.attachments[0]), {code:'ENOENT'});
  } finally { await fs.rm(cwd, {recursive: true, force: true}); }
});

test('preview review does not attach a missing or linked screenshot', async () => {
  const cwd = await fs.mkdtemp(path.join(tmpdir(), 'arco-review-capture-'));
  try {
    const dir = artifactsDir(cwd, 'fixture');
    await fs.mkdir(dir, {recursive:true});
    const report = 'preview-capture-456.md';
    await fs.writeFile(path.join(dir, report), 'Screenshot saved as `preview-capture-456.jpg`.');
    const missing = await buildPreviewCaptureReviewContent(cwd, 'fixture', report);
    assert.equal(missing.attachments, undefined);
    assert.match(missing.content, /No screenshot is attached/);
    if (process.platform !== 'win32') {
      const target = path.join(cwd, 'elsewhere.jpg');
      await fs.writeFile(target, 'outside');
      await fs.symlink(target, path.join(dir, 'preview-capture-456.jpg'));
      const linked = await buildPreviewCaptureReviewContent(cwd, 'fixture', report);
      assert.equal(linked.attachments, undefined);
    }
  } finally { await fs.rm(cwd, {recursive:true, force:true}); }
});

test('preview review rejects a report symlink outside its artifacts', {skip:process.platform === 'win32'}, async () => {
  const cwd = await fs.mkdtemp(path.join(tmpdir(), 'arco-review-capture-'));
  try {
    const dir = artifactsDir(cwd, 'fixture');
    await fs.mkdir(dir, {recursive:true});
    const outside = path.join(cwd,'outside.txt');
    await fs.writeFile(outside, 'private fixture');
    await fs.symlink(outside, path.join(dir,'preview-capture-789.md'));
    const built = await buildPreviewCaptureReviewContent(cwd, 'fixture', 'preview-capture-789.md');
    assert.ok(built.rejectReason);
    assert.doesNotMatch(built.content, /private fixture/);
  } finally { await fs.rm(cwd,{recursive:true,force:true}); }
});
