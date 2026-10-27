// docs/PROTOCOL_CLUSTER.md - headless WS+REST smoke for Codex transports.
//
// Phase 3 wired CLI Claude into clusters via the arco-cluster MCP stdio
// child. Phase 4 lifts the fence further so the same substrate accepts
// Codex (`exec` and `app-server` transports). The peer.* protocol is
// provider-agnostic — every check below is identical to Phase 3's, just
// run against Codex-shaped workflows. Mixed-provider clusters (Native
// Claude + Codex exec) round out the coverage.
//
// Skips (manual-only):
//   - Real `codex exec` / `codex app-server` invocation. Costs Codex API
//     budget; the 6-step manual recipe in DEVLOG documents the round-trip
//     against real Codex CLI binaries.
//   - UI affordances (TabContextMenu, SpawnDialog cluster checkbox) —
//     covered by the existing operator pass for Cluster 2.5.1.
//
// Run with the dev server up:
//   npm run dev:server &
//   npm run smoke:cluster-4
//
// Exits 0 on all-pass, 1 on any failure.

import { connect, step, assert, assertEq, summary, type AnyMessage } from './lib.js';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_CONTENT_BYTES } from '../../server/src/clusterMailbox.js';

const PORT = parseInt(process.env.ARCO_PORT || '3001', 10);
const REST_BASE = `http://127.0.0.1:${PORT}`;

async function main(): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), 'arco-smoke-4-'));
  console.log(`Phase 4 smoke — cwd ${cwd}`);
  console.log('');

  const c = await connect();

  // ── Path A: Codex `exec` cluster (source + 1 fresh sibling) ─────────────

  let execSourceWfid = '';
  let execClusterId = '';
  let execMembers: string[] = [];

  await step('A1: create Codex exec source workflow', async () => {
    c.send({
      type: 'create_workflow',
      config: {
        name: 'Smoke 4 Codex Exec Source',
        primaryProvider: 'codex',
        primaryModel: 'gpt-5-codex',
        primaryEffort: 'medium',
        skipPermissions: true,
        workingDirectory: cwd,
        codexTransport: 'exec',
      },
    });
    const m = await c.waitFor(
      (x) => x.type === 'workflow_created' && (x.config as { name?: string }).name === 'Smoke 4 Codex Exec Source',
      8000,
      'workflow_created (A1)',
    );
    execSourceWfid = m.workflowId as string;
    assert(execSourceWfid.length > 0, 'workflowId returned');
  });

  await step('A2: cluster_create_with_fresh_workers (+1 Codex exec sibling)', async () => {
    c.send({
      type: 'cluster_create_with_fresh_workers',
      sourceWorkflowId: execSourceWfid,
      additionalCount: 1,
      name: 'Smoke 4 Codex Cluster',
    });
    const m = await c.waitFor(
      (x) => x.type === 'cluster_created' &&
        ((x.state as { members: Array<{ workflowId: string }> }).members.some((mem) => mem.workflowId === execSourceWfid)),
      8000,
      'cluster_created (A2)',
    );
    execClusterId = m.clusterId as string;
    const state = m.state as { members: Array<{ workflowId: string }> };
    execMembers = state.members.map((mem) => mem.workflowId);
    assert(execClusterId.length > 0, 'clusterId returned');
    assertEq(execMembers.length, 2, 'cluster has 2 Codex members (source + 1 fresh)');
    assertEq(execMembers[0], execSourceWfid, 'source is first member');
  });

  const planBody = '# Smoke 4 plan\n\nDirector: source\nWorker: sibling\n';
  await step('A3: cluster_plan_set propagates via cluster_plan_changed', async () => {
    c.send({ type: 'cluster_plan_set', clusterId: execClusterId, body: planBody });
    const changed = await c.waitFor(
      (x) => x.type === 'cluster_plan_changed' && x.clusterId === execClusterId,
      3000,
      'cluster_plan_changed (A3)',
    ) as AnyMessage & { body: string };
    assertEq(changed.body, planBody, 'cluster_plan_changed.body matches');
  });

  await step('A4: cluster_member_role_set propagates via cluster_state', async () => {
    c.send({ type: 'cluster_member_role_set', clusterId: execClusterId, workflowId: execSourceWfid, role: 'Codex Coordinator' });
    await c.waitFor(
      (x) => {
        if (x.type !== 'cluster_state') return false;
        if (x.clusterId !== execClusterId) return false;
        const members = (x.state as { members: Array<{ workflowId: string; role?: string }> }).members;
        return members.find((m) => m.workflowId === execSourceWfid)?.role === 'Codex Coordinator';
      },
      3000,
      'cluster_state with role applied (A4)',
    );
  });

  await step('A5: subscribe both members for event capture', async () => {
    for (const wfid of execMembers) c.send({ type: 'subscribe', workflowId: wfid });
    await new Promise((r) => setTimeout(r, 100));
  });

  await step('A6: REST peer/send fires peer_message_sent broadcast', async () => {
    const sendP = c.waitFor(
      (x) => x.type === 'peer_message_sent' && (x as { from?: string }).from === execSourceWfid,
      3000,
      'peer_message_sent',
    );
    const r = await fetch(`${REST_BASE}/api/clusters/${execClusterId}/peer/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: execSourceWfid, to: execMembers[1], content: 'hello from Codex peer.send' }),
    });
    assertEq(r.status, 200, `REST peer/send returned 200 (got ${r.status})`);
    const body = await r.json() as { msgId: string; to: string };
    assertEq(body.to, execMembers[1], 'recipient matches');
    const ev = await sendP;
    assertEq((ev as { to: string }).to, execMembers[1], 'peer_message_sent.to matches');
  });

  await step('A7: REST peer/read returns drained + fires peer_message_received', async () => {
    const recvP = c.waitFor(
      (x) => x.type === 'peer_message_received' && (x as { workflowId?: string }).workflowId === execMembers[1],
      3000,
      'peer_message_received',
    );
    const r = await fetch(`${REST_BASE}/api/clusters/${execClusterId}/peer/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowId: execMembers[1] }),
    });
    assertEq(r.status, 200, `REST peer/read returned 200 (got ${r.status})`);
    const body = await r.json() as Array<{ content: string }>;
    assertEq(body.length, 1, 'one message drained');
    assertEq(body[0].content, 'hello from Codex peer.send', 'content matches');
    await recvP;
  });

  // Sized off the real cap — see the matching note in phase-3.ts.
  await step('A8: REST peer/send rejects over-cap content (Codex member)', async () => {
    const r = await fetch(`${REST_BASE}/api/clusters/${execClusterId}/peer/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: execSourceWfid, to: execMembers[1], content: 'x'.repeat(MAX_CONTENT_BYTES + 1024) }),
    });
    assertEq(r.status, 400, `REST peer/send returned 400 (got ${r.status})`);
    const body = await r.json() as { error: string };
    assert(body.error === 'content_too_large' || body.error === 'enqueue_failed', `error code (got ${body.error})`);
  });

  await step('A9: teardown Codex exec cluster', async () => {
    c.send({ type: 'cluster_delete', clusterId: execClusterId });
    await c.waitFor(
      (x) => x.type === 'cluster_deleted' && x.clusterId === execClusterId,
      3000,
      'cluster_deleted (A9)',
    );
    for (const id of execMembers) c.send({ type: 'remove_workflow', workflowId: id });
    // mcp-config.json should NOT exist for Codex members — Phase 4 wires
    // MCP via `-c` TOML overrides instead of a JSON config file. The path
    // `mcpConfigWriter.writeFor` writes is Claude-CLI-only; if a Codex
    // cluster member ever produced one it'd be a regression.
    for (const id of execMembers) {
      const cfgPath = join(cwd, '.arco', id, 'mcp-config.json');
      assert(!existsSync(cfgPath), `mcp-config.json absent for Codex member ${id.slice(0, 8)}`);
    }
  });

  // ── Path B: Codex `app-server` cluster ──────────────────────────────────

  let asSourceWfid = '';
  let asClusterId = '';
  let asMembers: string[] = [];

  // Brief settle window between paths — prior cluster_delete handler is
  // async (writes meta.json, walks sessions). Let it land before we move on.
  await new Promise((r) => setTimeout(r, 200));

  await step('B1: create Codex appserver source workflow', async () => {
    c.send({
      type: 'create_workflow',
      config: {
        name: 'Smoke 4 Codex Appserver Source',
        primaryProvider: 'codex',
        primaryModel: 'gpt-5-codex',
        primaryEffort: 'medium',
        skipPermissions: true,
        workingDirectory: cwd,
        codexTransport: 'appserver',
      },
    });
    const m = await c.waitFor(
      (x) => x.type === 'workflow_created' && (x.config as { name?: string }).name === 'Smoke 4 Codex Appserver Source',
      8000,
      'workflow_created (B1)',
    );
    asSourceWfid = m.workflowId as string;
    assert(asSourceWfid.length > 0, 'workflowId returned');
  });

  await step('B2: cluster_create_with_fresh_workers (+1 Codex appserver sibling)', async () => {
    c.send({
      type: 'cluster_create_with_fresh_workers',
      sourceWorkflowId: asSourceWfid,
      additionalCount: 1,
      name: 'Smoke 4 Appserver Cluster',
    });
    const m = await c.waitFor(
      (x) => x.type === 'cluster_created' &&
        ((x.state as { members: Array<{ workflowId: string }> }).members.some((mem) => mem.workflowId === asSourceWfid)),
      8000,
      'cluster_created (B)',
    );
    asClusterId = m.clusterId as string;
    const state = m.state as { members: Array<{ workflowId: string }> };
    asMembers = state.members.map((mem) => mem.workflowId);
    assertEq(asMembers.length, 2, 'cluster has 2 Codex appserver members');
  });

  await step('B3: plan + role propagate over WS', async () => {
    c.send({ type: 'cluster_plan_set', clusterId: asClusterId, body: '# AS plan\n' });
    await c.waitFor(
      (x) => x.type === 'cluster_plan_changed' && x.clusterId === asClusterId,
      3000,
      'cluster_plan_changed (B3)',
    );
    c.send({ type: 'cluster_member_role_set', clusterId: asClusterId, workflowId: asSourceWfid, role: 'AS Director' });
    await c.waitFor(
      (x) => x.type === 'cluster_state' && x.clusterId === asClusterId &&
        ((x.state as { members: Array<{ workflowId: string; role?: string }> }).members.find((m) => m.workflowId === asSourceWfid)?.role === 'AS Director'),
      3000,
      'cluster_state with role applied (B3)',
    );
  });

  await step('B4: REST peer round-trip on appserver cluster', async () => {
    for (const wfid of asMembers) c.send({ type: 'subscribe', workflowId: wfid });
    await new Promise((r) => setTimeout(r, 100));
    const r = await fetch(`${REST_BASE}/api/clusters/${asClusterId}/peer/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: asSourceWfid, to: asMembers[1], content: 'appserver peer test' }),
    });
    assertEq(r.status, 200, `appserver peer/send returned 200 (got ${r.status})`);
    const drainR = await fetch(`${REST_BASE}/api/clusters/${asClusterId}/peer/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowId: asMembers[1] }),
    });
    const drained = await drainR.json() as Array<{ content: string }>;
    assertEq(drained.length, 1, 'one message drained from appserver recipient');
    assertEq(drained[0].content, 'appserver peer test', 'content matches');
  });

  await step('B5: teardown appserver cluster', async () => {
    c.send({ type: 'cluster_delete', clusterId: asClusterId });
    await c.waitFor(
      (x) => x.type === 'cluster_deleted' && x.clusterId === asClusterId,
      3000,
      'cluster_deleted (B5)',
    );
    for (const id of asMembers) c.send({ type: 'remove_workflow', workflowId: id });
  });

  // ── Path C: Mixed Native Claude + Codex exec cluster ────────────────────

  let nativeWfid = '';
  let codexWfid = '';
  let mixedClusterId = '';

  await step('C1: create Native Claude workflow', async () => {
    c.send({
      type: 'create_workflow',
      config: {
        name: 'Smoke 4 Native Claude',
        primaryProvider: 'claude',
        primaryModel: 'claude-opus-4-7',
        primaryEffort: 'normal',
        skipPermissions: true,
        workingDirectory: cwd,
        claudeTransport: 'native',
      },
    });
    const m = await c.waitFor(
      (x) => x.type === 'workflow_created' && (x.config as { name?: string }).name === 'Smoke 4 Native Claude',
      8000,
      'workflow_created (C1)',
    );
    nativeWfid = m.workflowId as string;
  });

  await step('C2: create standalone Codex exec workflow', async () => {
    c.send({
      type: 'create_workflow',
      config: {
        name: 'Smoke 4 Codex Standalone',
        primaryProvider: 'codex',
        primaryModel: 'gpt-5-codex',
        primaryEffort: 'medium',
        skipPermissions: true,
        workingDirectory: cwd,
        codexTransport: 'exec',
      },
    });
    const m = await c.waitFor(
      (x) => x.type === 'workflow_created' && (x.config as { name?: string }).name === 'Smoke 4 Codex Standalone',
      8000,
      'workflow_created (C2)',
    );
    codexWfid = m.workflowId as string;
  });

  await step('C3: REST POST /api/clusters with mixed members + cluster_subscribe', async () => {
    const r = await fetch(`${REST_BASE}/api/clusters`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd, memberWorkflowIds: [nativeWfid, codexWfid] }),
    });
    assertEq(r.status, 200, `REST POST /api/clusters returned 200 (got ${r.status})`);
    const body = await r.json() as { clusterId: string; members: string[] };
    mixedClusterId = body.clusterId;
    assertEq(body.members.length, 2, 'mixed cluster has 2 members');
    // REST create doesn't auto-subscribe the WS to the cluster's broadcast
    // channel (that's only the WS-create handlers' side-effect). Send an
    // explicit cluster_subscribe so plan/role/state events reach this WS.
    c.send({ type: 'cluster_subscribe', clusterId: mixedClusterId });
    await new Promise((r) => setTimeout(r, 100));
  });

  await step('C4: plan + role + peer round-trip on mixed cluster', async () => {
    c.send({ type: 'cluster_plan_set', clusterId: mixedClusterId, body: '# Mixed plan\n' });
    await c.waitFor(
      (x) => x.type === 'cluster_plan_changed' && x.clusterId === mixedClusterId,
      3000,
      'cluster_plan_changed (C4)',
    );
    c.send({ type: 'cluster_member_role_set', clusterId: mixedClusterId, workflowId: nativeWfid, role: 'Mixed director' });
    await c.waitFor(
      (x) => x.type === 'cluster_state' && x.clusterId === mixedClusterId &&
        ((x.state as { members: Array<{ workflowId: string; role?: string }> }).members.find((m) => m.workflowId === nativeWfid)?.role === 'Mixed director'),
      3000,
      'cluster_state with role (C4)',
    );
    for (const wfid of [nativeWfid, codexWfid]) c.send({ type: 'subscribe', workflowId: wfid });
    await new Promise((r) => setTimeout(r, 100));
    // Native → Codex direction
    let r = await fetch(`${REST_BASE}/api/clusters/${mixedClusterId}/peer/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: nativeWfid, to: codexWfid, content: 'native → codex' }),
    });
    assertEq(r.status, 200, `Native → Codex peer/send returned 200 (got ${r.status})`);
    let drainR = await fetch(`${REST_BASE}/api/clusters/${mixedClusterId}/peer/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowId: codexWfid }),
    });
    let drained = await drainR.json() as Array<{ content: string }>;
    assertEq(drained.length, 1, 'Codex member drained 1 message');
    assertEq(drained[0].content, 'native → codex', 'content matches');
    // Codex → Native direction
    r = await fetch(`${REST_BASE}/api/clusters/${mixedClusterId}/peer/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: codexWfid, to: nativeWfid, content: 'codex → native' }),
    });
    assertEq(r.status, 200, `Codex → Native peer/send returned 200 (got ${r.status})`);
    drainR = await fetch(`${REST_BASE}/api/clusters/${mixedClusterId}/peer/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowId: nativeWfid }),
    });
    drained = await drainR.json() as Array<{ content: string }>;
    assertEq(drained.length, 1, 'Native member drained 1 message');
    assertEq(drained[0].content, 'codex → native', 'content matches');
  });

  await step('C5: teardown mixed cluster + workflows + cwd', async () => {
    c.send({ type: 'cluster_delete', clusterId: mixedClusterId });
    await c.waitFor(
      (x) => x.type === 'cluster_deleted' && x.clusterId === mixedClusterId,
      3000,
      'cluster_deleted (C5)',
    );
    for (const id of [nativeWfid, codexWfid]) c.send({ type: 'remove_workflow', workflowId: id });
    await new Promise((r) => setTimeout(r, 100));
    await c.close();
    rmSync(cwd, { recursive: true, force: true });
  });

  summary('Phase 4 smoke');
}

main().catch((err) => {
  console.error('Phase 4 smoke crashed:', err);
  process.exit(2);
});
