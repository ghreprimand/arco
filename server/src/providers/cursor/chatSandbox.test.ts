import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { access, mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHAT_DENY, CHAT_FLAGS, createChatSandbox, cleanupChatSandboxes, cleanupChatSandboxesOnStartup } from './chatSandbox.js';

for (const scenario of ['supported', 'unsupported-image', 'unsupported-controls', 'help-bypasses-parser'] as const) {
  test(`Cursor Chat attachment inputs: ${scenario}`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'arco-chat-input-'));
    const oldHome = process.env.ARCO_HOME;
    process.env.ARCO_HOME = join(root, 'state');
    const original = join(root, 'original.png');
    await writeFile(original, 'original must remain');
    const probes: string[][] = [];
    t.mock.method(childProcess, 'execFile', ((_command: string, args: string[], options: any, callback: any) => {
      probes.push(args);
      assert.equal(args.at(-1), 'help', 'capability checks never start model turns');
      assert.equal(options.timeout, 10_000);
      const rejected = scenario === 'unsupported-controls' || (scenario === 'unsupported-image' && args.includes('--image'));
      queueMicrotask(() => callback(scenario === 'help-bypasses-parser' ? null : Object.assign(new Error('probe'), { code: 1 }), '', rejected ? "error: unknown option '--unsupported'" : "error: unknown option '--arco-chat-capability-probe'"));
    }) as any);
    syncBuiltinESMExports();
    try {
      const prepared = { text: 'Current attached document: FIR-482', documents: [], images: [{ type: 'image' as const, mediaType: 'image/png' as const, name: original, width: 1, height: 1, data: Buffer.from('fitted image bytes').toString('base64') }] };
      if (scenario === 'supported') {
        const first = await createChatSandbox(prepared);
        const second = await createChatSandbox();
        assert.notEqual(first.cwd, second.cwd, 'each turn has a fresh folder');
        assert.equal(probes[0].includes('--exclude-workspace-context'), false, 'private cwd needs no privileged workspace-context flag');
        assert.deepEqual(probes[0], [...CHAT_FLAGS, '--arco-chat-capability-probe', 'help']);
        assert.ok(probes[1].includes('--image'));
        assert.equal(first.imagePaths.length, 1);
        assert.ok(first.imagePaths[0].startsWith(first.cwd));
        assert.equal(await readFile(first.imagePaths[0], 'utf8'), 'fitted image bytes');
        if (process.platform !== 'win32') assert.equal((await stat(first.imagePaths[0])).mode & 0o777, 0o600);
        assert.deepEqual(JSON.parse(await readFile(join(first.cwd, '.cursor', 'cli.json'), 'utf8')).permissions, { allow: [], deny: CHAT_DENY });
        await first.close();
        await assert.rejects(access(first.cwd));
        await access(second.cwd);
        await second.close();
      } else {
        await assert.rejects(createChatSandbox(prepared), scenario === 'unsupported-image' ? /cannot send images/ : /Chat is unavailable/);
        assert.deepEqual(await readdir(join(process.env.ARCO_HOME!, 'cursor-chat-turns')), [], 'failed capability checks remove the turn folder');
        assert.equal(probes.length, scenario === 'unsupported-image' ? 2 : 1);
      }
      assert.equal(await readFile(original, 'utf8'), 'original must remain');
    } finally {
      t.mock.restoreAll(); syncBuiltinESMExports();
      if (oldHome === undefined) delete process.env.ARCO_HOME; else process.env.ARCO_HOME = oldHome;
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('startup removes abandoned Chat folders without following links or touching other state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arco-chat-orphans-'));
  const oldHome = process.env.ARCO_HOME;
  process.env.ARCO_HOME = join(root, 'state');
  try {
    const managed = join(process.env.ARCO_HOME, 'cursor-chat-turns');
    const abandoned = join(managed, 'turn-abandoned');
    const outside = join(root, 'outside');
    await mkdir(abandoned, { recursive: true });
    await mkdir(outside);
    await writeFile(join(abandoned, 'image.png'), 'private image copy');
    await writeFile(join(outside, 'keep.txt'), 'must remain');
    await mkdir(join(managed, 'keep-other-state'));
    await symlink(outside, join(abandoned, 'linked-folder'), process.platform === 'win32' ? 'junction' : 'dir');
    await symlink(outside, join(managed, 'turn-linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await cleanupChatSandboxes();
    await assert.rejects(access(abandoned));
    await assert.rejects(access(join(managed, 'turn-linked')));
    assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'must remain');
    assert.deepEqual(await readdir(managed), ['keep-other-state']);
  } finally {
    if (oldHome === undefined) delete process.env.ARCO_HOME; else process.env.ARCO_HOME = oldHome;
    await rm(root, { recursive: true, force: true });
  }
});

test('startup ignores absent Chat storage and refuses a linked managed root', async t => {
  const root = await mkdtemp(join(tmpdir(), 'arco-chat-root-'));
  const oldHome = process.env.ARCO_HOME;
  process.env.ARCO_HOME = join(root, 'state');
  try {
    await cleanupChatSandboxes();
    await assert.rejects(access(process.env.ARCO_HOME));
    await mkdir(process.env.ARCO_HOME);
    const outside = join(root, 'outside');
    await mkdir(join(outside, 'turn-preserve'), { recursive: true });
    await symlink(outside, join(process.env.ARCO_HOME, 'cursor-chat-turns'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(cleanupChatSandboxes(), /real folder/);
    await access(join(outside, 'turn-preserve'));
    const warning = t.mock.method(console, 'warn', () => {});
    await assert.doesNotReject(cleanupChatSandboxesOnStartup);
    assert.equal(warning.mock.callCount(), 1);
    await assert.rejects(createChatSandbox(), /real folder/);
  } finally {
    if (oldHome === undefined) delete process.env.ARCO_HOME; else process.env.ARCO_HOME = oldHome;
    await rm(root, { recursive: true, force: true });
  }
});
