import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, rm, readFile, access, writeFile, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CursorPrintProvider } from './print.js';
import { FILE_READ_GUIDANCE } from '../providerFileContent.js';

test('Cursor print attaches the project reader to Agent turns and never Chat', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'arco-cursor-boundary-'));
  const previousHome = process.env.ARCO_HOME;
  process.env.ARCO_HOME = join(cwd, 'state');
  try {
    for (const interactionMode of ['agent', 'chat'] as const) {
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
      let args: string[] = [], input = '';
      let spawnedCwd: string | undefined;
      child.stdin.on('data', data => { input += String(data); });
      t.mock.method(childProcess, 'spawn', ((_command: string, argv: string[], options: any) => { args = argv; spawnedCwd = options.cwd; return child; }) as any);
      t.mock.method(childProcess, 'execFile', ((_command: string, _args: string[], _options: any, callback: any) => { queueMicrotask(() => callback(Object.assign(new Error('probe'), {code: 1}), '', "error: unknown option '--arco-chat-capability-probe'")); return child; }) as any);
      syncBuiltinESMExports();
      try {
        const worker = CursorPrintProvider.create('fixture', { provider: 'cursor', model: 'fixture', effort: 'medium', interactionMode, cwd, workflowId: 'fixture', chatWebAccess: false });
        worker.on('error', () => {});
        worker.spawn('Answer briefly');
        for (let i = 0; i < 200 && !args.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
        assert.ok(args.length);
        assert.equal(args[args.indexOf('--output-format') + 1], 'text');
        assert.equal(args.includes('--stream-partial-output'), false, 'text output must not request stream-json-only partial deltas');
        assert.equal(args.includes('--plugin-dir'), interactionMode === 'agent');
        assert.equal(input.includes(FILE_READ_GUIDANCE), interactionMode === 'agent');
        if (interactionMode === 'chat') {
          assert.notEqual(spawnedCwd, cwd, 'Chat must not run inside its conversation or project folder');
          assert.ok(spawnedCwd?.startsWith(await realpath(process.env.ARCO_HOME!)));
          assert.equal(args.includes('--force'), false);
          assert.equal(args.includes('--add-dir'), false);
          const config = JSON.parse(await readFile(join(spawnedCwd!, '.cursor', 'cli.json'), 'utf8'));
          assert.deepEqual(config.permissions.allow, []);
          for (const deny of ['Read(**)', 'Read(/**)', 'Write(**)', 'Write(/**)', 'Shell(*)', 'WebFetch(*)', 'Mcp(*:*)']) assert.ok(config.permissions.deny.includes(deny));
          assert.ok(args.includes('--disable-codebase-ref'));
          assert.ok(args.includes('--disable-indexing'));
        } else {
          assert.equal(spawnedCwd, cwd);
          assert.ok(args.includes('--force'));
          assert.equal(args.includes('--disable-codebase-ref'), false);
        }
        child.emit('close', 0, null);
        if (interactionMode === 'chat') {
          for (let i = 0; i < 100; i++) {
            if (await access(spawnedCwd!).then(() => false, () => true)) break;
            await new Promise(resolve => setTimeout(resolve, 5));
          }
          await assert.rejects(access(spawnedCwd!));
        }
      } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
    }
  } finally { if (previousHome === undefined) delete process.env.ARCO_HOME; else process.env.ARCO_HOME = previousHome; await rm(cwd, { recursive: true, force: true }); }
});

for (const scenario of ['image-refused', 'cancelled-probe'] as const) {
  test(`Cursor Chat never falls back to a file reader: ${scenario}`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'arco-cursor-refusal-'));
    const oldHome = process.env.ARCO_HOME;
    process.env.ARCO_HOME = join(root, 'state');
    const image = join(root, 'image.png');
    await writeFile(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64'));
    let spawned = false, release: (() => void) | undefined;
    t.mock.method(childProcess, 'spawn', (() => { spawned = true; throw new Error('a refused turn must not start'); }) as any);
    t.mock.method(childProcess, 'execFile', ((_command: string, args: string[], _options: any, callback: any) => {
      const complete = () => callback(Object.assign(new Error('probe'), {code: 1}), '', args.includes('--image') ? "error: unknown option '--image'" : "error: unknown option '--arco-chat-capability-probe'");
      if (scenario === 'cancelled-probe') release = complete;
      else queueMicrotask(complete);
    }) as any);
    syncBuiltinESMExports();
    try {
      const worker = CursorPrintProvider.create('fixture', { provider: 'cursor', model: 'fixture', effort: 'low', interactionMode: 'chat', cwd: root, attachments: [image] });
      let error = '';
      worker.on('error', value => { error = String(value); });
      worker.spawn('Describe the attachment');
      for (let i = 0; i < 200 && !(scenario === 'cancelled-probe' ? release : error); i++) await new Promise(resolve => setTimeout(resolve, 5));
      if (scenario === 'cancelled-probe') { assert.ok(release); worker.kill(); release(); }
      else assert.match(error, /cannot send images/);
      for (let i = 0; i < 200; i++) {
        if ((await readdir(join(process.env.ARCO_HOME!, 'cursor-chat-turns'))).length === 0) break;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.equal(spawned, false);
      assert.deepEqual(await readdir(join(process.env.ARCO_HOME!, 'cursor-chat-turns')), []);
      await access(image);
    } finally {
      t.mock.restoreAll(); syncBuiltinESMExports();
      if (oldHome === undefined) delete process.env.ARCO_HOME; else process.env.ARCO_HOME = oldHome;
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('Cursor backend Chat refusals become one plain sentence without changing reviewer errors', async t => {
  const root = await mkdtemp(join(tmpdir(), 'arco-cursor-refusal-message-'));
  const oldHome = process.env.ARCO_HOME;
  process.env.ARCO_HOME = join(root, 'state');
  try {
    for (const interactionMode of ['chat', 'agent'] as const) {
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
      let spawned = false, error = '';
      t.mock.method(childProcess, 'spawn', (() => { spawned = true; return child; }) as any);
      t.mock.method(childProcess, 'execFile', ((_command: string, _args: string[], _options: any, callback: any) => { queueMicrotask(() => callback(Object.assign(new Error('probe'), { code: 1 }), '', "error: unknown option '--arco-chat-capability-probe'")); }) as any);
      syncBuiltinESMExports();
      const worker = CursorPrintProvider.create('fixture', { provider: 'cursor', model: 'fixture', effort: 'low', interactionMode });
      worker.on('error', value => { error = String(value); });
      worker.spawn('Fixture');
      for (let i = 0; i < 200 && !spawned; i++) await new Promise(resolve => setTimeout(resolve, 5));
      assert.ok(spawned);
      child.stderr.write('Retry attempt 3...\nRetriableError: [invalid_argument] Workspace context exclusion is not allowed for this user, team, or selected model\n');
      child.emit('close', 1, null);
      if (interactionMode === 'chat') assert.equal(error, 'Cursor refused this Chat request: Workspace context exclusion is not allowed for this user, team, or selected model.');
      else assert.match(error, /cursor-agent -p exited 1:.*Retry attempt/s);
      t.mock.restoreAll(); syncBuiltinESMExports();
    }
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports();
    if (oldHome === undefined) delete process.env.ARCO_HOME; else process.env.ARCO_HOME = oldHome;
    await rm(root, { recursive: true, force: true });
  }
});
