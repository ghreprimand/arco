import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkerConfig } from '@archon/shared';
import { EventEmitter } from 'node:events';
import { CursorAcpTurn, isCursorAuthRequiredPrefix, isCursorAuthRequiredText } from './index.js';
import { CursorAcpWorker, resolveCursorCompressCommand } from './worker.js';

class FakeCursorWorker extends EventEmitter {
  readonly pid = 1234;
  disposed = false;

  constructor(private readonly chunks: string[]) { super(); }
  updateConfig(_config: WorkerConfig): void {}
  async ensureStarted(): Promise<void> {}
  async beginTurn(): Promise<void> {
    this.emit('init', { model: 'auto', sessionId: 'session-test' });
    for (const chunk of this.chunks) this.emit('text', chunk);
    this.emit('turn_settled', {
      result: { text: this.chunks.join(''), costUsd: 0, durationMs: 1 },
    });
  }
  async cancelCurrentTurn(): Promise<void> {}
  async dispose(): Promise<void> { this.disposed = true; }
}

function cursorTestConfig(): WorkerConfig {
  return {
    provider: 'cursor',
    model: 'auto',
    effort: 'high',
    tools: [],
    cwd: '/tmp',
    workflowId: 'wf-cursor-auth-test',
  } as WorkerConfig;
}

test('Cursor ACP auth text is recognized narrowly', () => {
  assert.equal(isCursorAuthRequiredText('Please sign in to continue'), true);
  assert.equal(isCursorAuthRequiredText('\nPlease sign in to continue.\n'), true);
  assert.equal(isCursorAuthRequiredText('PLEASE LOG IN TO CONTINUE'), true);
  assert.equal(isCursorAuthRequiredText('Please sign in to continue with the review'), false);
  assert.equal(isCursorAuthRequiredText('You may need to sign in.'), false);
});

test('Cursor ACP auth prefix buffering releases divergent assistant text', () => {
  assert.equal(isCursorAuthRequiredPrefix('Please sign'), true);
  assert.equal(isCursorAuthRequiredPrefix('Please sign in to continue'), true);
  assert.equal(isCursorAuthRequiredPrefix('Please sign in to continue with'), false);
  assert.equal(isCursorAuthRequiredPrefix('Here is the answer'), false);
});

test('Cursor ACP auth response becomes a re-login notice and retires the stale worker', async () => {
  const fake = new FakeCursorWorker(['Please sign in', ' to continue']);
  const turn = new CursorAcpTurn(
    'worker-auth-test',
    fake as unknown as CursorAcpWorker,
    cursorTestConfig(),
    undefined,
    'wf-cursor-auth-test',
  );
  const streamed: string[] = [];
  const notices: string[] = [];
  turn.on('text', (text: string) => streamed.push(text));
  turn.on('system_notice', (notice: string) => notices.push(notice));
  const result = new Promise<{ text: string }>((resolve) => turn.once('result', resolve));

  turn.spawn('hello');

  assert.deepEqual(await result, { text: '', costUsd: 0, durationMs: 1, thinkingBytes: 0, toolResultBytes: -1, toolResultBytesRaw: -1 });
  assert.deepEqual(streamed, []);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /^\[AUTH:cursor\]/);
  assert.equal(fake.disposed, true);
});

test('Cursor ACP releases an auth-like prefix as soon as normal text diverges', async () => {
  const fake = new FakeCursorWorker(['Please sign in', ' to continue with the review']);
  const turn = new CursorAcpTurn(
    'worker-normal-test',
    fake as unknown as CursorAcpWorker,
    cursorTestConfig(),
    undefined,
    'wf-cursor-normal-test',
  );
  const streamed: string[] = [];
  turn.on('text', (text: string) => streamed.push(text));
  const result = new Promise<{ text: string }>((resolve) => turn.once('result', resolve));

  turn.spawn('hello');

  assert.equal((await result).text, 'Please sign in to continue with the review');
  assert.deepEqual(streamed, ['Please sign in to continue with the review']);
  assert.equal(fake.disposed, false);
});

test('resolveCursorCompressCommand trusts the advertised ACP command snapshot', () => {
  assert.equal(resolveCursorCompressCommand(false, []), '/compress');
  assert.equal(resolveCursorCompressCommand(true, [{ name: 'compress' }]), '/compress');
  assert.equal(resolveCursorCompressCommand(true, [{ name: 'review' }]), null);
});

test('compressConversation sends /compress as the entire unprefixed ACP prompt', async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const rpc = {
    request: async (method: string, params: unknown) => {
      calls.push({ method, params });
      return { stopReason: 'end_turn' };
    },
  };
  const worker = new CursorAcpWorker('wf-cursor-test', {
    provider: 'cursor',
    model: 'auto',
    effort: 'high',
    tools: [],
    cwd: '/tmp',
    workflowId: 'wf-cursor-test',
    goal: 'This must never prefix a native command.',
    clusterId: 'cluster-test',
  } as WorkerConfig, 'session-test');

  // Avoid a live child: install the post-handshake state directly. The test is
  // about the exact ACP request boundary, not process bootstrap.
  Object.assign(worker as unknown as Record<string, unknown>, {
    rpc,
    sessionId: 'session-test',
    bootstrapped: true,
    appliedModel: 'auto',
  });
  // This notification normally arrives immediately after session/new|load,
  // while turnActive is false. It still has to be captured.
  (worker as unknown as { onNotification: (notification: unknown) => void }).onNotification({
    method: 'session/update',
    params: {
      sessionId: 'session-test',
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: [{ name: 'compress', description: 'Free context space' }],
      },
    },
  });

  const result = await worker.compressConversation();
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, [{
    method: 'session/prompt',
    params: {
      sessionId: 'session-test',
      prompt: [{ type: 'text', text: '/compress' }],
    },
  }]);
});

test('compressConversation refuses when an authoritative snapshot omits compress', async () => {
  const worker = new CursorAcpWorker('wf-cursor-test', {} as WorkerConfig, 'session-test');
  Object.assign(worker as unknown as Record<string, unknown>, {
    rpc: { request: async () => ({ stopReason: 'end_turn' }) },
    sessionId: 'session-test',
    bootstrapped: true,
    availableCommandsSeen: true,
    availableCommands: [{ name: 'review' }],
  });

  const result = await worker.compressConversation();
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /does not advertise/i);
});
