// EFFICIENCY_PLAN.md Phase F + F9 — headless WS smoke for the
// codebase-memory-mcp integration. Covers the operator-facing surface
// (Phase F) plus the spawn-wiring landing (F9):
//
//   1. attach_codebase_memory → codebase_memory_state{attached:true}
//   2. meta.json on disk carries codebaseMemory.attached=true
//   3. F9: .arco/<wfid>/mcp-config.json materializes on attach with the
//      codebase-memory entry pointing at the operator-supplied indexPath
//   4. detach_codebase_memory → codebase_memory_state{attached:false}
//   5. F9: .arco/<wfid>/mcp-config.json is gone after detach (no other
//      MCP wiring applies to this workflow)
//   6. POST /api/workflows/:wfId/codebase-memory/reindex returns 200 or 503
//      (either is acceptable — binary may or may not be installed)
//
// Run with the dev server up:
//   npm run dev:server &
//   npm run smoke:phase-f

import { connect, step, assert, assertEq, summary, type AnyMessage } from './lib.js';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HTTP_BASE = process.env.ARCO_SMOKE_HTTP_URL || 'http://localhost:3001';

async function main() {
  const cwd = mkdtempSync(join(tmpdir(), 'arco-smoke-phase-f-'));
  console.log(`Phase F smoke — cwd ${cwd}`);
  console.log('');

  const c = await connect();
  let wfid = '';

  await step('connect + create Native workflow', async () => {
    c.send({
      type: 'create_workflow',
      config: {
        name: 'Smoke Phase F',
        primaryProvider: 'claude',
        primaryModel: 'claude-opus-4-7',
        primaryEffort: 'normal',
        skipPermissions: true,
        workingDirectory: cwd,
        claudeTransport: 'native',
      },
    });
    const m = await c.waitFor((x) => x.type === 'workflow_created', 8000, 'workflow_created');
    wfid = m.workflowId as string;
    assert(wfid.length > 0, 'workflowId returned');
  });

  const customIndexPath = '/tmp/arco-smoke-phase-f-index';

  await step('attach_codebase_memory: state propagates with indexPath', async () => {
    c.send({ type: 'attach_codebase_memory', workflowId: wfid, indexPath: customIndexPath });
    const m = await c.waitFor(
      (x) => x.type === 'codebase_memory_state' && (x as { workflowId?: string }).workflowId === wfid,
      3000,
      'codebase_memory_state attached=true',
    ) as AnyMessage & { attached: boolean; indexPath?: string };
    assertEq(m.attached, true, 'attached=true');
    assertEq(m.indexPath, customIndexPath, 'indexPath echoes operator pick');
  });

  await step('meta.json reflects codebaseMemory.attached=true', async () => {
    // Read meta.json directly from disk. The path follows the same shape
    // every persisted workflow uses: <cwd>/.arco/workflows/<wfid>/meta.json.
    const metaPath = join(cwd, '.arco', 'workflows', wfid, 'meta.json');
    let raw: string;
    try {
      raw = readFileSync(metaPath, 'utf8');
    } catch (err) {
      throw new Error(`meta.json not at ${metaPath}: ${(err as Error).message}`);
    }
    const meta = JSON.parse(raw) as { codebaseMemory?: { attached?: boolean; indexPath?: string } };
    assert(meta.codebaseMemory, 'codebaseMemory present');
    assertEq(meta.codebaseMemory.attached, true, 'meta.codebaseMemory.attached=true');
    assertEq(meta.codebaseMemory.indexPath, customIndexPath, 'meta.codebaseMemory.indexPath persisted');
  });

  // F9 — attach syncs `.arco/<wfid>/mcp-config.json` eagerly so the
  // next CLI Claude spawn (or operator inspection) sees the entry.
  await step('F9: mcp-config.json carries codebase-memory entry on attach', async () => {
    const cfgPath = join(cwd, '.arco', wfid, 'mcp-config.json');
    assert(existsSync(cfgPath), `mcp-config.json present at ${cfgPath}`);
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as {
      mcpServers?: Record<string, { command?: string; args?: string[] }>;
    };
    assert(cfg.mcpServers, 'mcpServers root present');
    const entry = cfg.mcpServers!['codebase-memory'];
    assert(entry, 'codebase-memory entry present');
    assertEq(entry.command, 'codebase-memory-mcp', 'command matches operator-installed binary');
    assert(Array.isArray(entry.args), 'args is array');
    assertEq(entry.args![0], 'serve', 'args[0]=serve');
    assertEq(entry.args![1], '--path', 'args[1]=--path');
    assertEq(entry.args![2], customIndexPath, 'args[2] is operator-supplied indexPath');
    assertEq(entry.args![3], '--skip-config', 'args[3]=--skip-config (load-bearing)');
    // No cluster wiring applies to this lone Native workflow → only the
    // codebase-memory entry should be present.
    assert(!cfg.mcpServers!['arco-cluster'], 'no arco-cluster entry (workflow is not in a cluster)');
  });

  await step('detach_codebase_memory: attached flips to false', async () => {
    c.send({ type: 'detach_codebase_memory', workflowId: wfid });
    const m = await c.waitFor(
      (x) => x.type === 'codebase_memory_state' && (x as { workflowId?: string; attached?: boolean }).workflowId === wfid && (x as { attached?: boolean }).attached === false,
      3000,
      'codebase_memory_state attached=false',
    ) as AnyMessage & { attached: boolean; indexPath?: string };
    assertEq(m.attached, false, 'attached=false');
    // Operator's last indexPath stays so re-attaching is one click.
    assertEq(m.indexPath, customIndexPath, 'indexPath retained on detach');
  });

  // F9 — detach syncs the file too: with no cluster wiring and codebase-
  // memory off, the writer unlinks the file outright.
  await step('F9: mcp-config.json is gone after detach', async () => {
    const cfgPath = join(cwd, '.arco', wfid, 'mcp-config.json');
    assert(!existsSync(cfgPath), `mcp-config.json absent at ${cfgPath}`);
  });

  await step('POST /codebase-memory/reindex returns 200 or 503', async () => {
    const resp = await fetch(`${HTTP_BASE}/api/workflows/${encodeURIComponent(wfid)}/codebase-memory/reindex`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ indexPath: customIndexPath }),
    });
    // Either branch is acceptable: 200 when codebase-memory-mcp is on PATH,
    // 503 when it isn't. The smoke just asserts the endpoint responds with
    // one of the two — never 404 / 500 / no-response.
    const ok = resp.status === 200 || resp.status === 503;
    assert(ok, `reindex responded ${resp.status} (expected 200 or 503)`);
    if (resp.status === 503) {
      const body = await resp.json() as { error?: string };
      assertEq(body.error, 'binary_not_installed', 'error code matches docs');
    }
    if (resp.status === 200) {
      // When the binary is installed, the server pushes a fresh
      // codebase_memory_state with lastIndexedAt. Don't fail the smoke if
      // the broadcast lags — the HTTP 200 is the contract.
    }
  });

  await step('teardown: remove_workflow + rm cwd', async () => {
    c.send({ type: 'remove_workflow', workflowId: wfid });
    await c.close();
    rmSync(cwd, { recursive: true, force: true });
  });

  summary('Phase F smoke');
}

main().catch((err) => {
  console.error('Phase F smoke crashed:', err);
  process.exit(2);
});
