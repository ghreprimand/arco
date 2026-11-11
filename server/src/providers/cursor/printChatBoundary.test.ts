import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CursorPrintProvider } from './print.js';
import { FILE_READ_GUIDANCE } from '../providerFileContent.js';

test('Cursor print attaches the project reader to Agent turns and never Chat', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'arco-cursor-boundary-'));
  try {
    for (const interactionMode of ['agent', 'chat'] as const) {
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
      let args: string[] = [], input = '';
      child.stdin.on('data', data => { input += String(data); });
      t.mock.method(childProcess, 'spawn', ((_command: string, argv: string[]) => { args = argv; return child; }) as any);
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
        child.emit('close', 0, null);
      } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
    }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
