import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkflowState } from './workflows/types.js';
import { installIsolatedTestHome } from './testSupport/isolatedHome.js';

const home = mkdtempSync(join(tmpdir(), 'arco-toolbox-workflow-'));
installIsolatedTestHome(home);
after(() => rmSync(home, { recursive: true, force: true }));
const { toolboxWorkflowRuntime } = await import('./toolboxWorkflow.js');
const { writeTrustDecision } = await import('./projectTrust.js');

test('native skill discovery follows the actual workflow transport and project trust', async () => {
  const cwd = join(home, 'project'); mkdirSync(join(cwd, '.arco'), { recursive: true });
  writeFileSync(join(cwd, '.arco', 'settings.json'), JSON.stringify({ claude: { transport: 'cli' } }));
  const wf = { config: { workingDirectory: cwd, name: 'fixture' }, primary: { provider: 'claude', model: 'sonnet', effort: 'medium' } } as unknown as WorkflowState;
  assert.equal((await toolboxWorkflowRuntime('fixture', wf)).transport, 'native', 'untrusted project transport is ignored');
  await writeTrustDecision(cwd, 'always', Date.now());
  assert.equal((await toolboxWorkflowRuntime('fixture', wf)).transport, 'cli', 'trusted project transport applies');
  wf.config.claudeTransport = 'native';
  assert.equal((await toolboxWorkflowRuntime('fixture', wf)).transport, 'native', 'tab override wins');
  wf.config.ultracode = true;
  assert.equal((await toolboxWorkflowRuntime('fixture', wf)).transport, 'cli', 'ultracode runs the CLI');
  wf.config.kind = 'chat';
  assert.equal((await toolboxWorkflowRuntime('fixture', wf)).provider, '', 'Chat has no native skill runtime');
  wf.config.kind = 'workflow'; wf.primary.provider = 'codex';
  assert.equal((await toolboxWorkflowRuntime('fixture', wf)).provider, 'codex');
  wf.config.codexTransport = 'exec';
  assert.equal((await toolboxWorkflowRuntime('fixture', wf)).transport, 'exec', 'Codex tab transport is preserved');
});
