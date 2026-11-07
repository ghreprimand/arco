import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import childProcess from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { WorkflowState } from '../workflows/types.js';
const home = mkdtempSync(join(tmpdir(), 'arco-calibration-race-'));
installIsolatedTestHome(home);
const engine = await import('./turnEngine.js');
const { workflows } = await import('../server/state.js');
const { runCalibration } = await import('../contextCalibrator.js');
const { resolveSessionJsonlPath } = await import('../sessionJsonl.js');
after(async () => { await fs.rm(home, { recursive: true, force: true }); });

test('B120: calibration cannot enter after a newer turn claims the session', async (t) => {
  const cwd = join(home, 'project'), id = 'calibration-fixture';
  const file = resolveSessionJsonlPath(cwd, 'fixture');
  await fs.mkdir(dirname(file), { recursive: true });
  await fs.writeFile(file, 'x'.repeat(200_000));
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  const held = new Promise<void>(r => { release = r; });
  const stat = fs.stat;
  t.mock.method(fs, 'stat', async (...args: Parameters<typeof fs.stat>) => { if (String(args[0]) === file) { entered(); await held; } return stat(...args); });
  let spawned = 0;
  t.mock.method(childProcess, 'spawn', () => { spawned++; throw new Error('fixture must never launch a provider'); });
  syncBuiltinESMExports();
  const wf = { config: { workingDirectory: cwd, claudeTransport: 'cli' }, primary: { provider: 'claude', model: 'haiku' }, primarySessionId: 'fixture', busy: false, observers: new Set() } as unknown as WorkflowState;
  workflows.set(id, wf);
  try {
    const pending = engine.maybeCalibrate(id, wf, cwd);
    await started;
    const token = engine.claimBusy(wf);
    release(); await pending;
    engine.releaseBusy(wf, token);
    assert.equal(spawned, 0);
  } finally { release(); workflows.delete(id); t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test('B120: cancellation during calibration admission prevents subprocess creation', async (t) => {
  let spawned = 0;
  t.mock.method(childProcess, 'spawn', () => { spawned++; throw new Error('fixture must never launch a provider'); });
  syncBuiltinESMExports();
  try {
    assert.equal(await runCalibration('fixture', 'haiku', home, 10, cancel => cancel()), null);
    assert.equal(spawned, 0);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});
