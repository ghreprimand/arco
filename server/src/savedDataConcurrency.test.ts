// Saved-data regressions: mailbox reads and concurrent store mutations.
import { installIsolatedTestHome } from './testSupport/isolatedHome.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

function sandbox(name: string): { root: string; project: string } {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), `arco-bug-${name}-`)));
  installIsolatedTestHome(root);
  const project = path.join(root, 'project');
  mkdirSync(project, { recursive: true });
  return { root, project };
}

test('B12: a mailbox drain keeps a message whose read fails', async () => {
  const { root, project } = sandbox('b12');
  try {
    const store = await import('./clusterStore.js');
    const mailbox = await import('./clusterMailbox.js');
    const recipient = randomUUID();
    const created = await store.createCluster({ cwd: project, memberWorkflowIds: [randomUUID(), recipient] });
    await mailbox.enqueue(recipient, {
      msgId: mailbox.mintMsgId(), fromWorkflowId: randomUUID(), fromDisplayName: 'Sender',
      toWorkflowId: recipient, content: 'accepted assignment', createdAt: new Date().toISOString(), delivered: false,
    });
    const dir = path.join(store.clusterDir(created.clusterId), 'mailbox', recipient);
    const abs = path.join(dir, readdirSync(dir)[0]);
    chmodSync(abs, 0o000);
    let drained: unknown[] = [];
    let failed = false;
    try { drained = await mailbox.drain(recipient); } catch { failed = true; }
    if (existsSync(abs)) chmodSync(abs, 0o600);
    assert.equal(existsSync(abs), true, 'unreadable pending mail must stay on disk');
    assert.ok(failed || drained.length === 0, 'drain must not report the unreadable message as delivered');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('B14: concurrent preset saves both remain', async () => {
  const { root } = sandbox('b14');
  try {
    const presets = await import('./clusterPresets.js');
    const member = (role: string) => ({ provider: 'claude' as const, model: 'm', role });
    const [a, b] = await Promise.all([
      presets.savePreset({ name: 'Alpha', members: [member('Director'), member('Builder')] }),
      presets.savePreset({ name: 'Beta', members: [member('Director'), member('Builder')] }),
    ]);
    const names = new Set((await presets.listPresets()).map((p) => p.name));
    assert.ok(names.has('Alpha') && names.has('Beta'), `both accepted presets remain, saw ${[...names].join(',')}`);
    void a;
    void b;
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('B14b: a preset save overlapping a delete keeps the save and the delete', async () => {
  const { root } = sandbox('b14b');
  try {
    const presets = await import('./clusterPresets.js');
    const member = (role: string) => ({ provider: 'claude' as const, model: 'm', role });
    const saved = await presets.savePreset({ name: 'Alpha', members: [member('Director'), member('Builder')] });
    await Promise.all([
      presets.savePreset({ name: 'Gamma', members: [member('Director'), member('Builder')] }),
      presets.deletePreset(saved.id),
    ]);
    const after = await presets.listPresets();
    assert.equal(after.some((p) => p.id === saved.id), false, 'a deleted preset must not come back');
    assert.equal(after.some((p) => p.name === 'Gamma'), true, 'a preset saved during a delete must remain');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('B30: concurrent article creates all remain listed', async () => {
  const { root, project } = sandbox('b30');
  try {
    const knowledge = await import('./knowledge/store.js');
    const made = await Promise.all([0, 1, 2, 3].map((n) => knowledge.createArticle(project, { title: `Article ${n}`, body: `body ${n}` })));
    const listed = await knowledge.listArticles(project);
    const titles = new Set(listed.map((a) => a.title));
    assert.equal(listed.length, made.length, `list returned ${[...titles].join(',')}`);
    for (const article of made) assert.equal((await knowledge.readArticle(project, article.id))?.body, article.body);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('B30: concurrent patches preserve disjoint article fields', async () => {
  const { root, project } = sandbox('b30-patches');
  try {
    const knowledge = await import('./knowledge/store.js');
    const article = await knowledge.createArticle(project, { title: 'Original', body: 'Original body' });
    await Promise.all([
      knowledge.updateArticle(project, article.id, { title: 'Changed title' }),
      knowledge.updateArticle(project, article.id, { body: 'Changed body' }),
    ]);
    const saved = await knowledge.readArticle(project, article.id);
    assert.equal(saved?.title, 'Changed title');
    assert.equal(saved?.body, 'Changed body');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('B12: malformed mailbox records stay pending and report failure', async () => {
  const { root, project } = sandbox('b12-malformed');
  try {
    const store = await import('./clusterStore.js');
    const mailbox = await import('./clusterMailbox.js');
    const recipient = randomUUID();
    const created = await store.createCluster({ cwd: project, memberWorkflowIds: [randomUUID(), recipient] });
    const dir = path.join(store.clusterDir(created.clusterId), 'mailbox', recipient);
    mkdirSync(dir, { recursive: true });
    const valid = path.join(dir, 'a-valid.json');
    writeFileSync(valid, JSON.stringify({ msgId: 'valid', toWorkflowId: recipient, content: 'keep', delivered: false }));
    const file = path.join(dir, 'z-invalid.json');
    writeFileSync(file, 'null');
    await assert.rejects(mailbox.drain(recipient), /Invalid mailbox record/);
    assert.equal(existsSync(file), true);
    assert.equal(existsSync(valid), true, 'a later error must preserve the earlier pending message');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('B16: a failed mailbox copy leaves every pending message on an indexed member', async () => {
  const { root, project } = sandbox('b16');
  try {
    const store = await import('./clusterStore.js');
    const mailbox = await import('./clusterMailbox.js');
    const oldId = randomUUID();
    const peer = randomUUID();
    const created = await store.createCluster({ cwd: project, memberWorkflowIds: [peer, oldId] });
    for (const content of ['first', 'second']) {
      await mailbox.enqueue(oldId, {
        msgId: mailbox.mintMsgId(), fromWorkflowId: peer, fromDisplayName: 'Sender',
        toWorkflowId: oldId, content, createdAt: new Date().toISOString(), delivered: false,
      });
    }
    const dir = path.join(store.clusterDir(created.clusterId), 'mailbox', oldId);
    const names = readdirSync(dir).filter((n) => n.endsWith('.json')).sort();
    assert.equal(names.length, 2);
    const blocked = path.join(dir, names[1]);
    chmodSync(blocked, 0o000);
    const replacement = randomUUID();
    await assert.rejects(store.replaceMember(created.clusterId, oldId, replacement));
    if (existsSync(blocked)) chmodSync(blocked, 0o600);
    const members = store.getMembers(created.clusterId) ?? [];
    const reachable = new Set<string>();
    for (const member of members) for (const msg of await mailbox.peek(member)) reachable.add(msg.content);
    assert.ok(reachable.has('first') && reachable.has('second'), `indexed members ${members.join(',')} can see ${[...reachable].join(',')}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('B28: two new image saves of one name cannot both succeed', async () => {
  const { root, project } = sandbox('b28');
  try {
    mkdirSync(process.env.ARCO_HOME!, { recursive: true });
    const { addProject } = await import('./projects.js');
    await addProject(project);
    const { tryHandleImageWriteRoutes } = await import('./http/imageWriteRoutes.js');
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    let both = 0;
    for (let i = 0; i < 8; i++) {
      const name = `shot-${i}.png`;
      const call = () => new Promise<boolean>((resolve) => {
        const req = Readable.from([JSON.stringify({ cwd: project, path: name, dataUrl: png })]);
        Object.assign(req, { method: 'POST', url: '/api/image/write' });
        const res = { writeHead() {}, end(body: string) { resolve(JSON.parse(body).ok === true); } };
        void tryHandleImageWriteRoutes(req as never, res as never);
      });
      const [a, b] = await Promise.all([call(), call()]);
      if (a && b) both += 1;
    }
    assert.equal(both, 0, `${both} of 8 pairs both reported a successful create`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('B32: a refused media export does not delete the other export', async () => {
  const { root, project } = sandbox('b32');
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
    writeFileSync(path.join(bin, 'ffmpeg'), `#!/bin/sh
if [ "$1" = "-version" ]; then exit 0; fi
out=""
for a in "$@"; do out="$a"; done
mark="$ARCO_FFMPEG_BARRIER"
printf '%s\\n' "$$" >> "$mark"
while [ "$(wc -l < "$mark")" -lt 2 ]; do sleep 0.01; done
set -C
printf 'made\\n' > "$out" || exit 1
`);
  execFileSync('chmod', ['+x', path.join(bin, 'ffmpeg')]);
  const saved = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${saved ?? ''}`;
  try {
    const media = await import('./media/ffmpeg.js');
    const barrier = path.join(root, 'barrier');
    writeFileSync(barrier, '');
    process.env.ARCO_FFMPEG_BARRIER = barrier;
    media.__resetFfmpegCache();
    writeFileSync(path.join(project, 'take.wav'), 'RIFF');
    const runs = await Promise.allSettled([
      media.runMediaOp(project, 'take.wav', { op: 'normalize' }),
      media.runMediaOp(project, 'take.wav', { op: 'normalize' }),
    ]);
    const fulfilled = runs.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{ outputPath: string }>[];
    const rejected = runs.filter((r) => r.status === 'rejected').map((r) => String((r as PromiseRejectedResult).reason));
    assert.ok(fulfilled.length >= 1, `one export can succeed (${rejected.join(' | ')})`);
    for (const run of fulfilled) {
      assert.equal(existsSync(run.value.outputPath), true, `${run.value.outputPath} was removed after success`);
      assert.equal(readFileSync(run.value.outputPath, 'utf8'), 'made\n');
    }
  } finally {
    process.env.PATH = saved;
    rmSync(root, { recursive: true, force: true });
  }
});
