import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, truncate, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { brotliCompressSync } from 'node:zlib';
import path from 'node:path';
import { scanStorage, STORAGE_BUCKETS } from './storageReport.js';

function bucketTotal(report: Awaited<ReturnType<typeof scanStorage>>): number {
  return STORAGE_BUCKETS.reduce((sum, name) => sum + report.buckets[name].bytes, 0);
}

test('storage report measures event types and files without following links', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'arco-storage-'));
  try {
    const wf = path.join(root, 'state', 'workflows', 'a-1');
    await mkdir(path.join(wf, 'artifacts'), { recursive: true });
    await mkdir(path.join(wf, 'handoffs'));
    const log = '{"type":"primary_text","content":"é"}\n{"type":"task_ledger_snapshot"}\n{"type":"__proto__"}\npartial';
    await writeFile(path.join(wf, 'events.jsonl'), log);
    await writeFile(path.join(wf, 'artifacts', 'sample'), '12345');
    await writeFile(path.join(wf, 'handoffs', 'handoff'), '123');
    const big = path.join(wf, 'artifacts', 'large');
    await writeFile(big, ''); await truncate(big, 500 * 1024 * 1024);
    if (process.platform !== 'win32') await symlink(root, path.join(wf, 'artifacts', 'link'));
    const result = await scanStorage(path.join(root, 'state'), path.join(root, 'missing'), ['a-1']);
    assert.equal(result.workflows.length, 1);
    const item = result.workflows[0];
    assert.equal(item.open, true); assert.equal(item.artifactBytes, 5 + 500 * 1024 * 1024);
    assert.equal(result.largeFiles.length, 1); assert.equal(item.largeFiles.length, 1); assert.equal(item.handoffBytes, 3);
    assert.equal(item.eventBytes, Buffer.byteLength(log));
    assert.ok(item.eventTypes['__proto__'] > 0); assert.equal(item.eventTypes['(unreadable)'], 7);
    assert.equal(Object.values(item.eventTypes).reduce((a, b) => a + b, 0), item.eventBytes);
    assert.ok(item.lastActive > 0); assert.equal(result.errors, 0);
    // A sparse file reports its logical size; allocation can be far smaller.
    assert.ok(result.allocatedBytes < result.stateBytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('every project byte lands in one bucket; hard links count once; nested state is skipped', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'arco-storage-'));
  try {
    const state = path.join(root, '.state');
    const wf = path.join(state, 'workflows', 'w-1');
    await mkdir(path.join(wf, 'artifacts'), { recursive: true });
    await mkdir(path.join(wf, 'checkpoints'));
    await mkdir(path.join(wf, 'scratch'));
    await mkdir(path.join(state, 'plans', '.history'), { recursive: true });
    await mkdir(path.join(state, 'project'));
    await mkdir(path.join(state, 'worktrees', 'copy', 'build'), { recursive: true });
    await mkdir(path.join(state, 'audit'));
    await mkdir(path.join(state, 'worktrees', 'copy', '.state', 'workflows'), { recursive: true });
    const live = '{"seq":3,"type":"primary_text"}\n';
    const sealed = brotliCompressSync('{"seq":1,"type":"workflow_created"}\n{"seq":2,"type":"primary_text"}\n');
    await writeFile(path.join(wf, 'events.jsonl'), live);
    await writeFile(path.join(wf, 'events.000000000001-000000000002.jsonl.br'), sealed);
    await writeFile(path.join(wf, 'meta.json'), '{}');
    await writeFile(path.join(wf, 'artifacts', 'a'), 'aaaa');
    await writeFile(path.join(wf, 'checkpoints', 'c'), 'cc');
    await writeFile(path.join(wf, 'scratch', 's'), 'sss');
    await writeFile(path.join(state, 'plans', 'p.md'), 'plan');
    await writeFile(path.join(state, 'plans', '.history', 'h.md'), 'old');
    await writeFile(path.join(state, 'project', 'tasks.json'), '[]');
    await writeFile(path.join(state, 'worktrees', 'copy', 'build', 'out.bin'), '0123456789');
    await writeFile(path.join(state, 'audit', 'report.txt'), 'xy');
    await writeFile(path.join(state, 'worktrees', 'copy', '.state', 'workflows', 'skip'), 'not counted');
    await link(path.join(state, 'worktrees', 'copy', 'build', 'out.bin'), path.join(state, 'worktrees', 'copy', 'build', 'out-link.bin'));
    const r = await scanStorage(state, null, { stateName: '.state' });
    assert.equal(r.nestedFolders, 1);
    assert.equal(r.hardLinkBytes, 10);
    assert.equal(bucketTotal(r), r.stateBytes);
    assert.equal(r.buckets.events.bytes, live.length + sealed.length);
    assert.equal(r.buckets.artifacts.bytes, 4);
    assert.equal(r.buckets.checkpoints.bytes, 2);
    assert.equal(r.buckets.scratch.bytes, 3);
    assert.equal(r.buckets.conversationFiles.bytes, 2);
    assert.equal(r.buckets.plans.bytes, 7);
    assert.equal(r.buckets.boards.bytes, 2);
    assert.equal(r.buckets.worktrees.bytes, 10);
    assert.equal(r.buckets.other.bytes, 2);
    const w = r.workflows[0];
    assert.equal(w.eventBytes, live.length + sealed.length);
    assert.equal(w.scratchBytes, 3); assert.equal(w.otherBytes, 2);
    // Sealed segments are counted by type after decompression.
    assert.equal(w.eventTypes.primary_text, 2 * '{"seq":2,"type":"primary_text"}\n'.length);
    assert.ok(w.eventTypes.workflow_created > 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('home scope sorts models, caches, provider data and copies into named buckets', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'arco-storage-'));
  try {
    const home = path.join(root, '.home');
    const files: Array<[string, number]> = [
      ['voice/env/lib.so', 5], ['models/m.gguf', 6], ['camoufox-profile/cache2/x', 7], ['browser-profile/y', 1],
      ['provider-accounts/codex-a/sessions/s.jsonl', 8], ['checkpoints/abc/objects/o', 3], ['worktrees/h/t/f', 2],
      ['clusters/c1/isolates/w/workspace/f', 4], ['clusters/c1/meta.json', 1], ['cluster-snapshots/s/b', 9],
      ['media-scratch/tmp', 2], ['logs/arco.log', 3], ['settings.json', 1], ['chats/x/.home/workflows/w/events.jsonl', 50],
    ];
    for (const [rel, size] of files) {
      await mkdir(path.dirname(path.join(home, rel)), { recursive: true });
      await writeFile(path.join(home, rel), 'z'.repeat(size));
    }
    const r = await scanStorage(home, null, { scope: 'home', stateName: '.home' });
    assert.equal(r.nestedFolders, 1);
    assert.equal(bucketTotal(r), r.stateBytes);
    assert.equal(r.stateBytes, files.reduce((s, [, n]) => s + n, 0) - 50);
    assert.equal(r.buckets.voiceAndModels.bytes, 11);
    assert.equal(r.buckets.caches.bytes, 8);
    assert.equal(r.buckets.providerData.bytes, 8);
    assert.equal(r.buckets.checkpoints.bytes, 3);
    assert.equal(r.buckets.worktrees.bytes, 6);
    assert.equal(r.buckets.savedClusters.bytes, 9);
    assert.equal(r.buckets.scratch.bytes, 2);
    assert.equal(r.buckets.logs.bytes, 3);
    assert.equal(r.buckets.other.bytes, 2);
    assert.equal(r.workflows.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
