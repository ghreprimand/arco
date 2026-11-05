import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';
import type { WorkflowState } from '../workflows/types.js';
import type { WebSocket } from 'ws';

const home = mkdtempSync(join(tmpdir(), 'arco-quick-auto-'));
installIsolatedTestHome(home);
after(() => rmSync(home, { recursive: true, force: true }));
const engine = await import('./turnEngine.js');
const { workflows } = await import('../server/state.js');
const { patchSettings } = await import('../settings.js');

test('automatic handoff defaults to quick and honors saved global and tab modes', async () => {
  const cwd = join(home, 'project'); mkdirSync(cwd);
  const ws = { readyState: 1, send: () => {} } as unknown as WebSocket;
  const wf = { busy: false, observers: new Set([ws]), config: { name: 'fixture', workingDirectory: cwd, claudeTransport: 'native' },
    primary: { provider: 'claude', model: 'sonnet', effort: 'high' },
    autoHandoff: { enabled: true, afterCompactions: 5, compactions: 5, fired: false },
  } as unknown as WorkflowState;
  const modes: string[] = [];
  engine.initTurnEngine({ previewAutoDetect: {} as never, handleCreateWorkflow: async () => {}, handleHandoffRequest: async (_ws, _session, msg) => { modes.push(msg.mode); } });
  workflows.set('fixture', wf);
  try {
    await engine.maybeAutoHandoff('fixture', wf, cwd);
    await patchSettings({ autoHandoffDefaults: { mode: 'fresh-summarizer' } });
    wf.autoHandoff.fired = false;
    await engine.maybeAutoHandoff('fixture', wf, cwd);
    wf.autoHandoff.fired = false; wf.autoHandoff.mode = 'original-worker';
    await engine.maybeAutoHandoff('fixture', wf, cwd);
    assert.deepEqual(modes, ['quick', 'fresh-summarizer', 'original-worker']);
  } finally { workflows.delete('fixture'); }
});
