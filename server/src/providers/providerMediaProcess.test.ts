import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import type { WorkerConfig } from '@arco/shared';
import { CodexAppServerWorker } from './codex-appserver/worker.js';
import { CursorAcpWorker } from './cursor/worker.js';
const realSpawn = childProcess.spawn;
const peer = fileURLToPath(new URL('./fixtures/media-peer.mjs', import.meta.url));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
const records = async (path: string) => (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));

for (const kind of ['codex', 'cursor'] as const) {
  for (const vision of kind === 'cursor' ? [true, false] : [true]) {
    test(`${kind} process transports prepared images ${vision ? 'visually' : 'as a capability note'}`, async t => {
      const cwd = await mkdtemp(join(tmpdir(), 'arco-media-peer-'));
      const log = join(cwd, 'requests.jsonl');
      const image = join(cwd, 'figure.data');
      const children: childProcess.ChildProcess[] = [];
      t.mock.method(childProcess, 'spawn', ((command: string, args: string[], options: childProcess.SpawnOptions) => {
        assert.equal(command, kind === 'codex' ? 'codex' : 'cursor-agent');
        const catalog = kind === 'cursor' && args.includes('models');
        assert.ok(catalog || args.includes(kind === 'codex' ? 'app-server' : 'acp'));
        const child = realSpawn(process.execPath, [peer, catalog ? 'catalog' : kind, log, String(vision)], options);
        children.push(child);
        return child;
      }) as typeof childProcess.spawn);
      syncBuiltinESMExports();
      let worker: CodexAppServerWorker | CursorAcpWorker | undefined;
      try {
        await writeFile(image, png);
        const config = { cwd, provider: kind, model: kind === 'cursor' ? 'auto' : 'fixture', effort: 'medium', interactionMode: 'chat', sandbox: 'read-only' } as WorkerConfig;
        worker = kind === 'codex' ? new CodexAppServerWorker('fixture', config, undefined) : new CursorAcpWorker('fixture', { ...config, attachments: [image] }, undefined);
        await worker.ensureStarted();
        await worker.beginTurn('Inspect the figure', undefined);
        if (kind === 'codex') {
          let delivered = 0;
          worker.updateConfig({ ...config, onSteerDelivered: () => { delivered++; } });
          await (worker as any).dispatchSteer([{ content: 'Inspect this steered image', attachments: [image], clientMessageId: 'image-steer' }]);
          const sent = (await records(log)).find(frame => frame.method === 'turn/steer').params;
          assert.equal(sent.threadId, 'thread-fixture');
          assert.equal(sent.expectedTurnId, 'turn-fixture');
          assert.equal(delivered, 1);
          const fitted = sent.input.find((item: any) => item.type === 'localImage');
          assert.ok(fitted, 'steer must contain a localImage, not only a filename');
          assert.notEqual(fitted.path, image);
          assert.deepEqual((await readFile(fitted.path)).subarray(0, 8), png.subarray(0, 8));
          assert.match(sent.input.find((item: any) => item.type === 'text').text, /Inspect this steered image/);
          assert.match(sent.input.find((item: any) => item.type === 'text').text, /figure.data/);
        } else {
          const frames = await records(log);
          const init = frames.find(frame => frame.method === 'initialize');
          assert.equal(init.params.protocolVersion, 1);
          const session = frames.find(frame => frame.method === 'session/new');
          assert.equal(session.params.cwd, cwd);
          assert.ok(session.params.mcpServers.some((server: any) => server.type === 'http'));
          const blocks = frames.find(frame => frame.method === 'session/prompt').params.prompt;
          const media = blocks.filter((block: any) => block.type === 'image');
          assert.equal(media.length, vision ? 1 : 0);
          if (vision) {
            assert.equal(media[0].mimeType, 'image/png');
            assert.deepEqual(Buffer.from(media[0].data, 'base64').subarray(0, 8), png.subarray(0, 8));
          }
          const text = blocks.find((block: any) => block.type === 'text').text;
          assert.match(text, /Inspect the figure/);
          assert.match(text, /figure.data/);
          assert.doesNotMatch(text, /IHDR|\ufffd/);
          if (!vision) assert.match(text, /image|visual/i);
        }
        assert.deepEqual(await readFile(image), png, 'preparation preserves the source');
      } finally {
        await worker?.dispose();
        for (const child of children) {
          if (child.exitCode === null && child.signalCode === null) await new Promise<void>(resolve => child.once('exit', () => resolve()));
        }
        t.mock.restoreAll(); syncBuiltinESMExports();
        await rm(cwd, { recursive: true, force: true });
      }
    });
  }
}
