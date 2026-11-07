import { installIsolatedTestHome } from './testSupport/isolatedHome.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as mailbox from './clusterMailbox.js';
import * as store from './clusterStore.js';
import { peerRead } from './clusterPeerOps.js';

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'arco-peer-artifacts-')));
  installIsolatedTestHome(root);
  const project = join(root, 'project');
  mkdirSync(project);
  const recipient = randomUUID();
  const sender = randomUUID();
  const state = await store.createCluster({ cwd: project, memberWorkflowIds: [sender, recipient] });
  const ctx = { workflowId: recipient, clusterId: state.clusterId, broadcastSender() {}, broadcastRecipient() {} };
  const dir = join(store.clusterDir(state.clusterId), 'mailbox', recipient);
  const message = (content: string, names = ['note.txt']): mailbox.PeerMessage => ({
    msgId: mailbox.mintMsgId(), fromWorkflowId: sender, fromDisplayName: 'Sender', toWorkflowId: recipient,
    content, createdAt: new Date().toISOString(), delivered: false,
    artifacts: names.map((name, i) => {
      const bytes = Buffer.from(`${content}-${i}`);
      return { name, contentBase64: bytes.toString('base64'), byteLength: bytes.length };
    }),
  });
  return { root, project, recipient, ctx, dir, message };
}

for (const names of [['report.md', 'report.md'], ['a?.md', 'a*.md'], ['.', '..']]) {
  test(`B132: colliding attachment names preserve both payloads (${names.join(', ')})`, async () => {
    const f = await fixture();
    try {
      const msg = f.message('payload', names);
      await mailbox.enqueue(f.recipient, msg);
      const delivered = await peerRead(f.ctx);
      const files = delivered[0].artifacts!;
      assert.equal(new Set(files.map((a) => a.path)).size, 2);
      assert.deepEqual(files.map((a) => readFileSync(a.path, 'utf8')), ['payload-0', 'payload-1']);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
}

for (const code of ['EIO', 'ENOSPC']) {
  test(`B131: ${code} while writing the second message preserves the entire batch for retry`, async (t) => {
    const f = await fixture();
    try {
      for (const text of ['first', 'second']) await mailbox.enqueue(f.recipient, f.message(text));
      const original = fs.writeFile;
      let failing = true;
      let writes = 0;
      t.mock.method(fs, 'writeFile', async (...args: any[]) => {
        if (String(args[0]).includes('peer-artifacts') && failing && ++writes === 2) {
          throw Object.assign(new Error('fixture attachment write failure'), { code });
        }
        return Reflect.apply(original, fs, args);
      });
      await assert.rejects(peerRead(f.ctx), { code });
      assert.equal(readdirSync(f.dir).filter((n) => n.endsWith('.json')).length, 2);
      const pending = await mailbox.peek(f.recipient);
      assert.equal(pending.length, 2);
      for (const msg of pending) {
        assert.deepEqual(readdirSync(join(f.project, '.arco', 'peer-artifacts', msg.msgId)), [], 'failed batch leaves no prepared copies');
      }
      failing = false;
      const retried = await peerRead(f.ctx);
      assert.deepEqual(retried.map((m) => m.content).sort(), ['first', 'second']);
      assert.deepEqual(retried.map((m) => readFileSync(m.artifacts![0].path, 'utf8')).sort(), ['first-0', 'second-0']);
      assert.deepEqual(await peerRead(f.ctx), []);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
}

test('B132: existing attachment files survive a later delivery of the same message', async () => {
  const f = await fixture();
  try {
    const msg = f.message('original');
    const first = await mailbox.materializeArtifacts(f.recipient, msg);
    writeFileSync(first[0].path, 'edited locally');
    const second = await mailbox.materializeArtifacts(f.recipient, { ...msg });
    assert.equal(readFileSync(first[0].path, 'utf8'), 'edited locally');
    assert.equal(readFileSync(second[0].path, 'utf8'), 'original-0');
    assert.notEqual(first[0].path, second[0].path);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

for (const artifacts of [null, [{ name: 42 }], [{ name: 'bad', contentBase64: '!invalid!', byteLength: 6 }], [{ name: 'bad', contentBase64: 'YQ==', byteLength: 2 }]]) {
  test(`B131: malformed attachment metadata is quarantined while valid mail continues (${JSON.stringify(artifacts)})`, async (t) => {
    const f = await fixture();
    try {
      const valid = f.message('valid');
      await mailbox.enqueue(f.recipient, valid);
      const bytes = JSON.stringify({ ...f.message('invalid'), artifacts });
      writeFileSync(join(f.dir, 'invalid.json'), bytes);
      const warn = t.mock.method(console, 'warn', () => {});
      const delivered = await peerRead(f.ctx);
      assert.deepEqual(delivered.map((m) => m.content), ['valid']);
      assert.equal(readFileSync(delivered[0].artifacts![0].path, 'utf8'), 'valid-0');
      const bad = readdirSync(f.dir).filter((n) => n.startsWith('invalid.json.bad-'));
      assert.equal(bad.length, 1);
      assert.equal(readFileSync(join(f.dir, bad[0]), 'utf8'), bytes);
      assert.deepEqual(await peerRead(f.ctx), []);
      assert.equal(warn.mock.callCount(), 1);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
}

test('B131: pre-turn delivery retries the original attachment after a temporary write error', async (t) => {
  const f = await fixture();
  try {
    const { drainPeerMailbox } = await import('./primitives/seedWorker.js');
    await mailbox.enqueue(f.recipient, f.message('pre-turn'));
    const original = fs.writeFile;
    let failing = true;
    t.mock.method(fs, 'writeFile', async (...args: any[]) => {
      if (failing && String(args[0]).includes('peer-artifacts')) throw Object.assign(new Error('fixture busy'), { code: 'EBUSY' });
      return Reflect.apply(original, fs, args);
    });
    const broadcasts: any[] = [];
    assert.equal(await drainPeerMailbox(f.recipient, (msg) => broadcasts.push(msg)), undefined);
    assert.equal(broadcasts.length, 0);
    assert.equal((await mailbox.peek(f.recipient)).length, 1);
    failing = false;
    const prologue = await drainPeerMailbox(f.recipient, (msg) => broadcasts.push(msg));
    assert.ok(prologue?.includes('note.txt'));
    assert.equal(broadcasts.length, 1);
    assert.ok(broadcasts[0].content.includes('[Artifacts materialized]'));
    assert.deepEqual(await mailbox.peek(f.recipient), []);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
