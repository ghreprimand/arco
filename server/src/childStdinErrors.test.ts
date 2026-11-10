import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installIsolatedTestHome } from './testSupport/isolatedHome.js';
const home = await mkdtemp(join(tmpdir(), 'arco-stdin-errors-'));
installIsolatedTestHome(home);
test.after(() => rm(home, { recursive: true, force: true }));
const { ClaudeProvider } = await import('./providers/claude.js');
const { CodexProvider } = await import('./providers/codex.js');
const { CursorPrintProvider } = await import('./providers/cursor/print.js');
const { startLoginSession, submitLoginCode, cancelLoginSession } = await import('./authLoginSession.js');
const { probeServer, connectServer } = await import('./mcp/client.js');
const { lspManager } = await import('./lsp/client.js');
const { _clearDetectCache } = await import('./lsp/servers.js');

function fakeChild() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
  child.stdin.resume();
  return child;
}
function closedInput(child: ReturnType<typeof fakeChild>) {
  for (const code of ['EPIPE', 'ECONNRESET']) {
    assert.doesNotThrow(() => child.stdin.emit('error', Object.assign(new Error('child closed input'), { code })));
  }
}
for (const [name, provider] of [['Claude CLI', ClaudeProvider], ['Codex CLI', CodexProvider], ['Cursor print', CursorPrintProvider]] as const) {
  test(`${name} handles asynchronous stdin errors and retains exit reporting`, async t => {
    const child = fakeChild();
    let started!: () => void;
    const spawned = new Promise<void>(resolve => { started = resolve; });
    t.mock.method(childProcess, 'spawn', (() => { started(); return child; }) as any);
    syncBuiltinESMExports();
    const worker = provider.create('fixture', { cwd: home, model: 'fixture', effort: 'low', tools: [] } as any);
    const failures: string[] = []; worker.on('error', value => failures.push(value));
    try {
      worker.spawn('fixture'); await spawned; await new Promise(resolve => setImmediate(resolve));
      closedInput(child);
      child.emit('exit', 1, null); child.emit('close', 1, null);
      assert.equal(worker.status, 'failed'); assert.ok(failures.length > 0);
    } finally { child.emit('exit', 1, null); child.emit('close', 1, null); t.mock.restoreAll(); syncBuiltinESMExports(); }
  });
}
test('login code submission handles asynchronous stdin errors', t => {
  const child = fakeChild();
  t.mock.method(childProcess, 'spawn', (() => child) as any); syncBuiltinESMExports();
  try {
    startLoginSession('claude', 'fixture');
    assert.equal(submitLoginCode('claude', 'fixture-code').ok, true);
    closedInput(child); child.emit('exit', 1);
  } finally { cancelLoginSession('claude'); t.mock.restoreAll(); syncBuiltinESMExports(); }
});
for (const [name, connect] of [['probe', probeServer], ['session', connectServer]] as const) {
  test(`MCP ${name} handles stdin errors while initializing and settles on exit`, async t => {
    const child = fakeChild();
    t.mock.method(childProcess, 'spawn', (() => child) as any); syncBuiltinESMExports();
    let pending: Promise<any> | undefined;
    try {
      pending = connect({ command: 'fixture', args: [] } as any);
      closedInput(child); child.emit('exit', 1, null);
      const result = await pending;
      if ('ok' in result) assert.equal(result.ok, false);
      else assert.equal((await result.callTool('fixture', {})).isError, true);
    } finally { child.emit('exit', 1, null); await pending; t.mock.restoreAll(); syncBuiltinESMExports(); }
  });
}
test('LSP initialize handles stdin errors and settles on exit', async t => {
  const child = fakeChild(), previousPath = process.env.PATH;
  await writeFile(join(home, 'typescript-language-server'), '', { mode: 0o700 });
  process.env.PATH = home; _clearDetectCache();
  let started!: () => void;
  const spawned = new Promise<void>(resolve => { started = resolve; });
  t.mock.method(childProcess, 'spawn', (() => { started(); return child; }) as any); syncBuiltinESMExports();
  let pending: Promise<any> | undefined;
  try {
    pending = (lspManager as any).doSpawn('fixture', home, 'typescript');
    await spawned; await new Promise(resolve => setImmediate(resolve));
    closedInput(child); child.emit('exit', 1, null);
    assert.equal(await pending, null);
  } finally {
    child.emit('exit', 1, null); await pending;
    process.env.PATH = previousPath; _clearDetectCache();
    t.mock.restoreAll(); syncBuiltinESMExports();
  }
});
