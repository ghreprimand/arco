// Server-authoritative workspace (server/src/workspace.ts) — headless WS smoke.
//
// Two sockets stand in for two browsers (workstation + the MacBook). Covers:
// workspace_sync → workspace_snapshot, a tab opened on A shows up on B via
// workspace_changed, a CONFIG edit on A reaches B as workflow_config_synced,
// a tab closed on B disappears from A, and a fresh socket's snapshot reflects
// the result. No model turn runs.
//
// Run against a NON-prod port (the smoke server writes workspace-3099.json,
// never prod's workspace.json):
//   ARCHON_WS_AUTH=off ARCHON_PORT=3099 npm run dev:server &
//   ARCHON_SMOKE_WS_URL=ws://localhost:3099/ws npm run smoke:workspace-mirror

import { connect, step, assert, summary, type AnyMessage } from './lib.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Snap = { workflows: Array<{ workflowId: string; config: { name: string; primaryEffort?: string } }>; clusters: unknown[] };
const has = (m: AnyMessage, id: string) => ((m.workspace as Snap).workflows ?? []).some((w) => w.workflowId === id);

async function main() {
  const cwd = mkdtempSync(join(tmpdir(), 'archon-smoke-workspace-'));
  console.log(`workspace-mirror smoke — cwd ${cwd}\n`);
  const a = await connect();
  const b = await connect();
  let wfid = '';

  await step('both sockets sync and get a snapshot', async () => {
    for (const c of [a, b]) {
      c.send({ type: 'workspace_sync', adopt: false, workflows: [], clusterIds: [] });
      const m = await c.waitFor((x) => x.type === 'workspace_snapshot', 5000, 'workspace_snapshot');
      assert(Array.isArray((m.workspace as Snap).workflows), 'snapshot carries a workflows array');
    }
  });

  await step('tab opened on A appears on B', async () => {
    a.send({
      type: 'create_workflow',
      config: {
        name: 'Smoke Workspace Mirror',
        primaryProvider: 'claude',
        primaryModel: 'claude-opus-4-7',
        primaryEffort: 'normal',
        skipPermissions: true,
        workingDirectory: cwd,
        claudeTransport: 'native',
      },
    });
    const created = await a.waitFor((x) => x.type === 'workflow_created', 8000, 'workflow_created');
    wfid = created.workflowId as string;
    await b.waitFor((x) => x.type === 'workspace_changed' && has(x, wfid), 5000, 'workspace_changed (open) on B');
  });

  await step('B rehydrates the mirrored tab and sees A\'s CONFIG edit', async () => {
    b.send({ type: 'rehydrate_workflows', workflows: [{ workflowId: wfid, config: { name: 'Smoke Workspace Mirror', workingDirectory: cwd }, currentSessionId: wfid, lastSeq: 0 }] });
    await new Promise((r) => setTimeout(r, 300));
    a.send({ type: 'update_primary_config', workflowId: wfid, effort: 'high' });
    const synced = await b.waitFor((x) => x.type === 'workflow_config_synced' && x.workflowId === wfid, 5000, 'workflow_config_synced on B');
    assert((synced.config as { primaryEffort?: string }).primaryEffort === 'high', 'B received the new effort');
  });

  await step('tab closed on B disappears from A', async () => {
    b.send({ type: 'remove_workflow', workflowId: wfid });
    await a.waitFor((x) => x.type === 'workspace_changed' && !has(x, wfid), 5000, 'workspace_changed (close) on A');
  });

  await step('a fresh socket\'s snapshot no longer lists it', async () => {
    const c = await connect();
    c.send({ type: 'workspace_sync', adopt: false, workflows: [], clusterIds: [] });
    const m = await c.waitFor((x) => x.type === 'workspace_snapshot', 5000, 'workspace_snapshot');
    assert(!has(m, wfid), 'closed tab absent');
    await c.close();
  });

  await a.close();
  await b.close();
  rmSync(cwd, { recursive: true, force: true });
  summary('workspace-mirror');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
