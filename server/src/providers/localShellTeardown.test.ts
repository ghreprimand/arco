import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeOllamaTool } from './ollamaTools.js';

test('tab disposal ends an active local shell and waits for its result', { skip: process.platform === 'win32' ? 'POSIX shell fixture' : false }, async () => {
  const { disposeProviderResources } = await import('./index.js');
  const cwd = mkdtempSync(join(tmpdir(), 'arco-local-close-'));
  const workflowId = 'local-close';
  const controller = new AbortController();
  try {
    let settled = false;
    const result = executeOllamaTool('Bash', {
      command: 'echo ready > ready.txt; (sleep 1; echo alive > late.txt) & wait',
    }, { cwd, workflowId, abortSignal: controller.signal }).then(value => { settled = true; return value; });
    for (let n = 0; !existsSync(join(cwd, 'ready.txt')) && n < 100; n++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(existsSync(join(cwd, 'ready.txt')), 'shell started');
    await disposeProviderResources(workflowId);
    assert.equal(settled, true, 'disposal waits for shell result and pipe closure');
    assert.match(await result, /exit signal: SIGKILL/);
    await new Promise(resolve => setTimeout(resolve, 1_200));
    assert.equal(existsSync(join(cwd, 'late.txt')), false);
  } finally { controller.abort(); await disposeProviderResources(workflowId); rmSync(cwd, { recursive: true, force: true }); }
});

test('disposal waits for platform tree cleanup and pipe closure, scoped to the tab', async () => {
  const { trackLocalShell, disposeLocalShells } = await import('./localShellLifecycle.js');
  let stopFinished!: () => void;
  let pipesClosed!: () => void;
  let otherStopped = false;
  const stop = new Promise<void>(resolve => { stopFinished = resolve; });
  const ended = new Promise<void>(resolve => { pipesClosed = resolve; });
  const untrack = trackLocalShell('wait-owner', { stop: () => stop, ended });
  const untrackOther = trackLocalShell('other-owner', { stop: async () => { otherStopped = true; }, ended: Promise.resolve() });
  try {
    let disposed = false;
    const disposal = disposeLocalShells('wait-owner').then(() => { disposed = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(disposed, false);
    stopFinished();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(disposed, false, 'tree signaling alone does not establish pipe closure');
    pipesClosed();
    await disposal;
    assert.equal(disposed, true);
    assert.equal(otherStopped, false);
  } finally { stopFinished(); pipesClosed(); untrack(); untrackOther(); }
});

test('a missing shell binary resolves its error result and leaves no tracked shell', { timeout: 5_000 }, async t => {
  const { _setCommandShellForTest } = await import('../commandShell.js');
  const { disposeLocalShells } = await import('./localShellLifecycle.js');
  const { default: childProcess } = await import('node:child_process');
  const { syncBuiltinESMExports } = await import('node:module');
  const cwd = mkdtempSync(join(tmpdir(), 'arco-local-spawn-error-'));
  const missing = join(cwd, 'nonexistent-shell');
  const originalSpawn = childProcess.spawn;
  let failedChild: import('node:child_process').ChildProcess | undefined;
  t.mock.method(childProcess, 'spawn', (...args: Parameters<typeof childProcess.spawn>) => {
    const child = Reflect.apply(originalSpawn, childProcess, args) as import('node:child_process').ChildProcess;
    if (args[0] === missing) failedChild = child;
    return child;
  });
  syncBuiltinESMExports();
  _setCommandShellForTest({ ok: true, file: missing, kind: 'sh' });
  try {
    const result = await executeOllamaTool('Bash', { command: 'echo unused' }, { cwd, workflowId: 'failed-local-shell' });
    assert.match(result, /^\[error\] failed to spawn shell: .*ENOENT/);
    assert.ok(failedChild);
    const kill = t.mock.method(failedChild, 'kill');
    await disposeLocalShells('failed-local-shell');
    assert.equal(kill.mock.callCount(), 0, 'failed shell was untracked before the tool result resolved');
  } finally {
    _setCommandShellForTest(null);
    t.mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(cwd, { recursive: true, force: true });
  }
});
