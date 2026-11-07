import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { WorkflowState } from '../workflows/types.js';
import type { WebSocket } from 'ws';
const home = mkdtempSync(join(tmpdir(), 'arco-watcher-race-'));
installIsolatedTestHome(home);
const { startSessionWatcher } = await import('./turnEngine.js');
const { workflows } = await import('../server/state.js');
const { resolveSessionJsonlPath } = await import('../sessionJsonl.js');

test('B119: an older session load cannot replace the newer watcher or replay its rows', async (t) => {
  const cwd = join(home, 'project'), id = 'watcher-fixture';
  const oldPath = resolveSessionJsonlPath(cwd, 'older');
  const newPath = resolveSessionJsonlPath(cwd, 'newer');
  await fs.mkdir(dirname(oldPath), { recursive: true });
  for (const [file, text] of [[oldPath, 'old row'], [newPath, 'new row']]) await fs.writeFile(file, JSON.stringify({ type: 'user', message: { content: text }, uuid: text, timestamp: new Date().toISOString() })+'\n');
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  const held = new Promise<void>(r => { release = r; });
  const read = fs.readFile;
  t.mock.method(fs, 'readFile', async (...args: Parameters<typeof fs.readFile>) => {
    if (String(args[0]) === oldPath) { entered(); await held; }
    return read(...args);
  });
  syncBuiltinESMExports();
  const messages: string[] = [];
  const ws = { readyState: 1, send: (raw: string) => messages.push(raw) } as unknown as WebSocket;
  const wf = { config: { claudeTransport: 'cli' }, primary: { provider: 'claude' }, primarySessionId: 'older', observers: new Set([ws]) } as unknown as WorkflowState;
  workflows.set(id, wf);
  let newest: (() => void) | null | undefined;
  try {
    startSessionWatcher(id, wf, cwd, ws);
    await started;
    wf.primarySessionId = 'newer';
    startSessionWatcher(id, wf, cwd, ws);
    for (let i = 0; i < 100 && !wf.sessionWatcher; i++) await new Promise(r => setTimeout(r, 5));
    newest = wf.sessionWatcher;
    assert.ok(newest);
    release();
    await new Promise(r => setTimeout(r, 30));
    assert.equal(wf.sessionWatcher, newest);
    assert.ok(messages.some(m => m.includes('new row')));
    assert.equal(messages.some(m => m.includes('old row')), false);
  } finally {
    release(); newest?.(); wf.sessionWatcher?.(); workflows.delete(id);
    t.mock.restoreAll(); syncBuiltinESMExports();
    await fs.rm(home, { recursive: true, force: true });
  }
});
