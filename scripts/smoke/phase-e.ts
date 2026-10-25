// EFFICIENCY_PLAN.md Phase E — headless WS / REST smoke.
//
// Covers the protocol surfaces Phase E shipped:
//   1. workflow_created carries the operator-supplied efficiencySandbox='on'.
//   2. meta.json persists the toggle.
//   3. update_primary_config flips the toggle to 'off'; re-flips to 'on';
//      both transitions persist to meta.json.
//   4. POST /api/workflows/:wfId/sandbox/_test_insert lands a synthetic
//      chunk on disk (sandbox.db appears) and fires sandbox_chunk_added.
//   5. POST /api/workflows/:wfId/sandbox/clear empties the DB and fires
//      sandbox_db_cleared.
//   6. remove_workflow tears down sandbox.db (file gone on disk).
//
// Does NOT cover (real Anthropic-API spend required):
//   - The model spontaneously calling ctx_execute / ctx_search / ctx_fetch.
//   - The system-prompt nudge changing model behaviour.
//   - FTS5 BM25 ordering on real chunks (the unit-test-like behaviour is
//     manually verified in DEVLOG; see the manual recipe).
//
// Run with the dev server up:
//   npm run dev:server  &
//   npm run smoke:phase-e
//
// Exits 0 on all-pass, 1 on any failure.

import { connect, step, assert, assertEq, summary, type AnyMessage } from './lib.js';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface MetaShape {
  efficiencySandbox?: 'on' | 'off';
  workflowId: string;
  [k: string]: unknown;
}

function readMeta(cwd: string, workflowId: string): MetaShape {
  const path = join(cwd, '.archon', 'workflows', workflowId, 'meta.json');
  const raw = readFileSync(path, 'utf8');
  return JSON.parse(raw) as MetaShape;
}

async function waitForMeta(cwd: string, workflowId: string, predicate: (m: MetaShape) => boolean, timeoutMs = 3000): Promise<MetaShape> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const meta = readMeta(cwd, workflowId);
      if (predicate(meta)) return meta;
    } catch { /* meta not yet written */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`meta.json predicate not satisfied within ${timeoutMs}ms`);
}

const HTTP_BASE = process.env.ARCHON_SMOKE_HTTP_BASE || 'http://localhost:3001';

async function postJson(path: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const r = await fetch(`${HTTP_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* leave null */ }
  return { status: r.status, json };
}

async function getJson(path: string): Promise<{ status: number; json: unknown }> {
  const r = await fetch(`${HTTP_BASE}${path}`);
  const text = await r.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* leave null */ }
  return { status: r.status, json };
}

async function main() {
  const cwd = mkdtempSync(join(tmpdir(), 'archon-smoke-e-'));
  console.log(`Phase E smoke — cwd ${cwd}`);
  console.log('');

  const c = await connect();

  let wfid = '';
  const dbPath = () => join(cwd, '.archon', 'workflows', wfid, 'sandbox.db');

  await step('create Native workflow with efficiencySandbox="on"', async () => {
    c.send({
      type: 'create_workflow',
      config: {
        name: 'Smoke E',
        primaryProvider: 'claude',
        primaryModel: 'claude-opus-4-7',
        primaryEffort: 'normal',
        skipPermissions: true,
        workingDirectory: cwd,
        claudeTransport: 'native',
        efficiencySandbox: 'on',
      },
    });
    const m = await c.waitFor((x) => x.type === 'workflow_created', 8000, 'workflow_created') as AnyMessage & { config: { efficiencySandbox?: string } };
    wfid = m.workflowId as string;
    assert(typeof wfid === 'string' && wfid.length > 0, 'workflowId returned');
    assertEq(m.config.efficiencySandbox, 'on', 'config.efficiencySandbox echoed as "on"');
  });

  await step('meta.json persists efficiencySandbox="on"', async () => {
    const meta = await waitForMeta(cwd, wfid, (m) => m.efficiencySandbox === 'on');
    assertEq(meta.efficiencySandbox, 'on', 'meta.json efficiencySandbox="on"');
  });

  await step('update_primary_config flips toggle to "off"', async () => {
    c.send({
      type: 'update_primary_config',
      workflowId: wfid,
      efficiencySandbox: 'off',
    });
    const meta = await waitForMeta(cwd, wfid, (m) => m.efficiencySandbox === 'off');
    assertEq(meta.efficiencySandbox, 'off', 'meta.json reflects flip to "off"');
  });

  await step('update_primary_config re-flips toggle to "on"', async () => {
    c.send({
      type: 'update_primary_config',
      workflowId: wfid,
      efficiencySandbox: 'on',
    });
    const meta = await waitForMeta(cwd, wfid, (m) => m.efficiencySandbox === 'on');
    assertEq(meta.efficiencySandbox, 'on', 'meta.json reflects flip back to "on"');
  });

  await step('POST /sandbox/_test_insert lands chunk; sandbox.db appears; sandbox_chunk_added fires', async () => {
    // Pre-arm the waiter BEFORE the HTTP POST so the broadcast is captured
    // even if it lands before the response settles.
    const waiter = c.waitFor((m) => m.type === 'sandbox_chunk_added' && m.workflowId === wfid, 5000, 'sandbox_chunk_added');
    const { status, json } = await postJson(
      `/api/workflows/${encodeURIComponent(wfid)}/sandbox/_test_insert`,
      { language: 'shell', content: 'hello world from the sandbox smoke harness' },
    );
    assertEq(status, 200, 'POST /sandbox/_test_insert returns 200');
    assert(json !== null && typeof (json as { chunkId?: unknown }).chunkId === 'number', '_test_insert returns chunkId');
    const ev = await waiter as AnyMessage & { chunkId: number; byteLen: number; language: string };
    assertEq(ev.language, 'shell', 'sandbox_chunk_added carries language');
    assert(ev.byteLen > 0, 'sandbox_chunk_added carries non-zero byteLen');
    assert(existsSync(dbPath()), 'sandbox.db exists on disk');
  });

  await step('GET /sandbox/stats reflects chunkCount === 1', async () => {
    const { status, json } = await getJson(`/api/workflows/${encodeURIComponent(wfid)}/sandbox/stats`);
    assertEq(status, 200, 'GET /sandbox/stats returns 200');
    const s = json as { chunkCount: number; totalBytes: number; recent: unknown[] };
    assertEq(s.chunkCount, 1, 'stats.chunkCount === 1');
    assert(s.totalBytes > 0, 'stats.totalBytes > 0');
    assert(Array.isArray(s.recent) && s.recent.length === 1, 'stats.recent has the inserted row');
  });

  await step('POST /sandbox/clear empties the DB and fires sandbox_db_cleared', async () => {
    const waiter = c.waitFor((m) => m.type === 'sandbox_db_cleared' && m.workflowId === wfid, 5000, 'sandbox_db_cleared');
    const { status } = await postJson(`/api/workflows/${encodeURIComponent(wfid)}/sandbox/clear`, {});
    assertEq(status, 200, 'POST /sandbox/clear returns 200');
    await waiter;
    const { json } = await getJson(`/api/workflows/${encodeURIComponent(wfid)}/sandbox/stats`);
    const s = json as { chunkCount: number };
    assertEq(s.chunkCount, 0, 'stats.chunkCount === 0 after clear');
  });

  await step('remove_workflow tears down sandbox.db on disk', async () => {
    c.send({ type: 'remove_workflow', workflowId: wfid });
    // The handler runs synchronously inside the WS message dispatch; give it
    // a generous beat to flush the unlink + ack before checking the file.
    const t0 = Date.now();
    while (existsSync(dbPath()) && Date.now() - t0 < 3000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert(!existsSync(dbPath()), 'sandbox.db removed after remove_workflow');
  });

  await step('teardown: close ws + rm cwd', async () => {
    await c.close();
    rmSync(cwd, { recursive: true, force: true });
  });

  summary('Phase E smoke');
}

main().catch((err) => {
  console.error('Phase E smoke crashed:', err);
  process.exit(2);
});
