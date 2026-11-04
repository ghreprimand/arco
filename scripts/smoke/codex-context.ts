// Codex per-tab context-policy protocol smoke. Run with an Arco server up.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, step, assertEq, summary, type AnyMessage } from './lib.js';

interface Meta { codexContextPolicy?: 'max' | 'standard' }

async function waitForPolicy(cwd: string, workflowId: string, policy: Meta['codexContextPolicy']): Promise<void> {
  const path = join(cwd, '.arco', 'workflows', workflowId, 'meta.json');
  const started = Date.now();
  while (Date.now() - started < 3_000) {
    try {
      const meta = JSON.parse(readFileSync(path, 'utf8')) as Meta;
      if (meta.codexContextPolicy === policy) return;
    } catch { /* persistence may still be settling */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`meta.json did not persist codexContextPolicy=${policy}`);
}

async function main(): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), 'arco-smoke-codex-context-'));
  const client = await connect();
  let workflowId = '';

  await step('create Codex workflow with explicit STANDARD policy', async () => {
    client.send({
      type: 'create_workflow',
      config: {
        name: 'Codex context smoke',
        primaryProvider: 'codex',
        primaryModel: 'gpt-6-astra',
        primaryEffort: 'medium',
        skipPermissions: true,
        workingDirectory: cwd,
        codexContextPolicy: 'standard',
      },
    });
    const created = await client.waitFor((message) => message.type === 'workflow_created', 8_000, 'workflow_created') as AnyMessage & { config: Meta };
    workflowId = String(created.workflowId);
    assertEq(created.config.codexContextPolicy, 'standard', 'created config echoes STANDARD');
    await waitForPolicy(cwd, workflowId, 'standard');
  });

  await step('update_primary_config persists MAX', async () => {
    client.send({ type: 'update_primary_config', workflowId, codexContextPolicy: 'max' });
    await waitForPolicy(cwd, workflowId, 'max');
  });

  await step('teardown', async () => {
    client.send({ type: 'remove_workflow', workflowId });
    await client.close();
    rmSync(cwd, { recursive: true, force: true });
  });

  summary('Codex context policy');
}

main().catch((error) => {
  console.error('Codex context smoke crashed:', error);
  process.exit(2);
});
