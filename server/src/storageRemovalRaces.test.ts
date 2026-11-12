import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { promises as fs, mkdirSync, mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { installIsolatedTestHome } from './testSupport/isolatedHome.js';

const homeRoot = realpathSync(mkdtempSync(join(tmpdir(), 'arco-removal-home-')));
installIsolatedTestHome(homeRoot);
after(async () => {
  await (await import('./workflowMeta.js')).settleMetaSideEffects();
  (await import('./recall/index.js')).getRecallIndex().close();
  rmSync(homeRoot, { recursive: true, force: true });
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'arco-removal-race-')));

  const project = join(root, 'project'), id = randomUUID();
  const dir = join(project, '.arco', 'workflows', id);
  mkdirSync(join(dir, 'artifacts'), { recursive: true });
  mkdirSync(process.env.ARCO_HOME!, { recursive: true });
  writeFileSync(join(process.env.ARCO_HOME!, 'settings.json'), JSON.stringify({ projects: [project], projectRoots: [] }));
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ workflowId: id, name: 'Fixture', cwd: project }));
  writeFileSync(join(dir, 'events.jsonl'), '');
  return { root, project, dir, id };
}

for (const edit of ['replace', 'append', 'same-size']) {
  test(`B13: MOVE preserves source bytes changed after copying (${edit})`, async () => {
    const f = fixture();
    try {
      const { addProject } = await import('./projects.js');
      await addProject(f.project);
      const outputs = await import('./outputs.js');
      const { writeOutputIndex, readOutputIndex } = await import('./outputStore.js');
      const source = join(f.dir, 'artifacts', 'note.txt'), target = join(f.project, 'moved.txt');
      writeFileSync(source, 'OLD');
      const ctx = await outputs.outputContext(f.project, f.id);
      await outputs.trackOutputFile(ctx, source);
      const entry = (await outputs.listOutputs(ctx)).find((item) => item.path === source)!;
      let changed = false;
      const newer = edit === 'append' ? 'OLD APPENDED' : edit === 'same-size' ? 'NEW' : 'REPLACED';
      await assert.rejects(outputs.transferOutput(ctx, entry.id, target, true, async (...args) => {
        await writeOutputIndex(...args);
        if (!changed) {
          changed = true;
          if (edit === 'replace') { await fs.unlink(source); }
          writeFileSync(source, newer);
        }
      }), /changed|edited/i);
      assert.equal(readFileSync(source, 'utf8'), newer);
      assert.equal(readFileSync(target, 'utf8'), 'OLD');
      assert.equal((await readOutputIndex(f.project, f.id)).entries.find((item) => item.id === entry.id)?.path, source);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
}

for (const action of ['append', 'reopen', 'queued-event', 'metadata']) {
  test(`B15: archive refuses source removal after ${action}`, async (t) => {
    const f = fixture();
    const events = join(f.dir, 'events.jsonl');
    const logs = await import('./workflowStore.js');
    const workspace = await import('./workspace.js');
    try {
      await logs.initWorkflowStore(f.project, f.id);
      const archive = await import('./storageArchive.js');
      const target = archive.archivePath(f.project, f.id);
      const original = fs.rename;
      t.mock.method(fs, 'rename', async (...args: any[]) => {
        const value = await Reflect.apply(original, fs, args);
        if (args[1] === target) {
          if (action === 'append') writeFileSync(events, 'LATE\n');
          if (action === 'reopen') workspace.workspaceOpenWorkflow(f.id, { name: 'Fixture', workingDirectory: f.project } as never);
          if (action === 'metadata') {
            const { writeMeta, settleMetaSideEffects } = await import('./workflowMeta.js');
            await writeMeta(f.project, { workflowId: f.id, cwd: f.project, name: 'LATE', createdAt: 1, lastActiveAt: 2, primaryProvider: 'claude', primaryModel: 'fixture', primaryEffort: 'medium', cliSessions: [], operator: 'fixture', lastEventSeq: null, lastTranscriptSeq: null, compactedAt: null } as never);
            await settleMetaSideEffects();
          }
          if (action === 'queued-event') logs.persistAndStampSeq(f.project, f.id, { type: 'primary_text', workflowId: f.id, text: 'LATE' } as never);
        }
        return value;
      });
      await assert.rejects(archive.archiveConversation(f.project, f.id, { open: false, busy: false, by: 'policy' }), /changed|open|active|written/i);
      assert.ok(existsSync(join(f.dir, 'meta.json')));
      assert.ok(existsSync(events));
      assert.equal(existsSync(target), false, 'a refused archive must not block another attempt');
      if (action === 'metadata') assert.match(readFileSync(join(f.dir, 'meta.json'), 'utf8'), /LATE/);
      if (action === 'append') assert.match(readFileSync(events, 'utf8'), /LATE/);
      if (action === 'queued-event') {
        await logs.flushWorkflowBuffer(f.project, f.id);
        assert.match(readFileSync(events, 'utf8'), /LATE/);
      }
    } finally {
      workspace.workspaceCloseWorkflow(f.id);
      await logs.flushWorkflowBuffer(f.project, f.id);
      logs.forgetWorkflowBuffer(f.project, f.id);
      await workspace.settleWorkspaceWrites();
      rmSync(f.root, { recursive: true, force: true });
    }
  });
}

test('B15: an in-flight metadata write prevents archive admission', async (t) => {
  const f = fixture();
  const { writeMeta, settleMetaSideEffects } = await import('./workflowMeta.js');
  const { archiveConversation } = await import('./storageArchive.js');
  const original = fs.rename;
  let unblock!: () => void, entered!: () => void;
  const blocked = new Promise<void>((resolve) => { unblock = resolve; });
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  t.mock.method(fs, 'rename', async (...args: any[]) => {
    if (args[1] === join(f.dir, 'meta.json')) { entered(); await blocked; }
    return Reflect.apply(original, fs, args);
  });
  const writing = writeMeta(f.project, { workflowId: f.id, cwd: f.project, name: 'PENDING', createdAt: 1, lastActiveAt: 2, primaryProvider: 'claude', primaryModel: 'fixture', primaryEffort: 'medium', cliSessions: [], operator: 'fixture', lastEventSeq: null, lastTranscriptSeq: null, compactedAt: null } as never);
  try {
    await reached;
    await assert.rejects(archiveConversation(f.project, f.id, { open: false, busy: false, by: 'operator' }), /close|active|written/i);
  } finally {
    unblock(); await writing; await settleMetaSideEffects();
    assert.match(readFileSync(join(f.dir, 'meta.json'), 'utf8'), /PENDING/);
    rmSync(f.root, { recursive: true, force: true });
  }
});
