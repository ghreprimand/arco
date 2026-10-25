// CLUSTER_MODE_PLAN.md Phase 3 — headless WS+REST smoke.
//
// Covers the protocol-only steps of Phase 3's acceptance recipe:
//   1. create a CLI Claude workflow
//   2. cluster it with one fresh CLI sibling
//   3. set a plan + role
//   4. POST /api/clusters/:id/peer/send (simulate what the MCP child does)
//      and assert peer_message_sent broadcast
//   5. POST /api/clusters/:id/peer/read for the recipient — assert payload +
//      peer_message_received broadcast on drain
//   6. peer_send 9 KB content → expect content-too-large reject
//   7. peer_send to a workflow outside the cluster → expect rejection
//   8. teardown: cluster_delete + remove_workflow per member + rm cwd; assert
//      mcp-config.json was never created on disk (we never spawned a real
//      claude turn) — but verify the cleanup helper accepts missing files
//
// Skips (manual-only):
//   - Real `claude --mcp-config` invocation. Costs API tokens; the manual
//     6-step recipe in DEVLOG documents this.
//   - UI affordances (right-click create from CLI tab, etc.) — unchanged
//     from Phase 2.5 / 2.6 smoke.
//
// Run with the dev server up:
//   npm run dev:server &
//   npm run smoke:cluster-3
//
// Exits 0 on all-pass, 1 on any failure.

import { connect, step, assert, assertEq, summary, type AnyMessage } from './lib.js';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_CONTENT_BYTES } from '../../server/src/clusterMailbox.js';

const PORT = parseInt(process.env.ARCHON_PORT || '3001', 10);
const REST_BASE = `http://127.0.0.1:${PORT}`;

async function main(): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), 'archon-smoke-3-'));
  console.log(`Phase 3 smoke — cwd ${cwd}`);
  console.log('');

  const c = await connect();

  let sourceWfid = '';
  let clusterId = '';
  let memberIds: string[] = [];

  await step('connect + create CLI Claude source workflow', async () => {
    c.send({
      type: 'create_workflow',
      config: {
        name: 'Smoke 3 Source',
        primaryProvider: 'claude',
        primaryModel: 'claude-opus-4-7',
        primaryEffort: 'normal',
        skipPermissions: true,
        workingDirectory: cwd,
        // Phase 3 — CLI Claude cluster members are now supported.
        claudeTransport: 'cli',
      },
    });
    const m = await c.waitFor((x) => x.type === 'workflow_created', 8000, 'workflow_created');
    sourceWfid = m.workflowId as string;
    assert(typeof sourceWfid === 'string' && sourceWfid.length > 0, 'workflowId returned');
  });

  await step('cluster_create_with_fresh_workers (+1 CLI sibling)', async () => {
    c.send({
      type: 'cluster_create_with_fresh_workers',
      sourceWorkflowId: sourceWfid,
      additionalCount: 1,
      name: 'Smoke 3 Cluster',
    });
    const m = await c.waitFor((x) => x.type === 'cluster_created', 8000, 'cluster_created');
    clusterId = m.clusterId as string;
    const state = m.state as { members: Array<{ workflowId: string }> };
    memberIds = state.members.map((mem) => mem.workflowId);
    assert(clusterId.length > 0, 'clusterId returned');
    assertEq(memberIds.length, 2, 'cluster has 2 members (source + 1 fresh CLI)');
    assertEq(memberIds[0], sourceWfid, 'source is first member');
  });

  const planBody = '# Smoke 3 plan\n\nDirector: source\nWorker: sibling\n';
  await step('cluster_plan_set propagates via cluster_plan_changed', async () => {
    c.send({ type: 'cluster_plan_set', clusterId, body: planBody });
    const changed = await c.waitFor((x) => x.type === 'cluster_plan_changed', 3000, 'cluster_plan_changed') as AnyMessage & { body: string; bodyLength: number };
    assertEq(changed.body, planBody, 'cluster_plan_changed.body matches');
  });

  await step('cluster_member_role_set propagates via cluster_state', async () => {
    c.send({ type: 'cluster_member_role_set', clusterId, workflowId: sourceWfid, role: 'CLI Coordinator' });
    await c.waitFor(
      (x) => {
        if (x.type !== 'cluster_state') return false;
        const members = (x.state as { members: Array<{ workflowId: string; role?: string }> }).members;
        const me = members.find((m) => m.workflowId === sourceWfid);
        return me?.role === 'CLI Coordinator';
      },
      3000,
      'cluster_state with role applied',
    );
  });

  // The smoke runs WS+REST in parallel; subscribe the WS to both members'
  // event streams so peer_message_sent (sender side) + peer_message_received
  // (recipient side) both flow into the buffer.
  await step('subscribe to both members for event capture', async () => {
    for (const wfid of memberIds) {
      c.send({ type: 'subscribe', workflowId: wfid });
    }
    // Drain the optimistic "subscribed" replies if any (best-effort).
    await new Promise((r) => setTimeout(r, 100));
  });

  // Phase 3 step 4 — REST POST /api/clusters/:id/peer/send simulates what
  // the MCP child does when the model calls peer_send. Assert the
  // peer_message_sent broadcast lands on the sender's WS channel.
  await step('REST peer/send fires peer_message_sent broadcast', async () => {
    const sendP = c.waitFor(
      (x) => x.type === 'peer_message_sent' && (x as { from?: string }).from === sourceWfid,
      3000,
      'peer_message_sent',
    );
    const r = await fetch(`${REST_BASE}/api/clusters/${clusterId}/peer/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: sourceWfid, to: memberIds[1], content: 'hello from CLI peer.send' }),
    });
    assertEq(r.status, 200, `REST peer/send returned 200 (got ${r.status})`);
    const body = await r.json() as { msgId: string; to: string };
    assert(typeof body.msgId === 'string', 'msgId returned');
    assertEq(body.to, memberIds[1], 'recipient matches');
    const ev = await sendP;
    assertEq((ev as { to: string }).to, memberIds[1], 'peer_message_sent.to matches');
  });

  // Phase 3 step 5 — REST POST /api/clusters/:id/peer/read for member B.
  // Expect the message in payload + peer_message_received broadcast.
  await step('REST peer/read returns drained + fires peer_message_received', async () => {
    const recvP = c.waitFor(
      (x) => x.type === 'peer_message_received' && (x as { workflowId?: string }).workflowId === memberIds[1],
      3000,
      'peer_message_received',
    );
    const r = await fetch(`${REST_BASE}/api/clusters/${clusterId}/peer/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowId: memberIds[1] }),
    });
    assertEq(r.status, 200, `REST peer/read returned 200 (got ${r.status})`);
    const body = await r.json() as Array<{ content: string; fromName: string }>;
    assertEq(body.length, 1, 'one message drained');
    assertEq(body[0].content, 'hello from CLI peer.send', 'content matches');
    await recvP;
  });

  // Phase 3 step 6 — over-cap content → content_too_large reject. Sized off the
  // real MAX_CONTENT_BYTES rather than a literal: this step hard-coded 9 KB
  // against an 8 KB cap and silently started passing 200 when the cap was
  // bumped to 16 KB (9e80806, 2026-05-11).
  await step('REST peer/send rejects over-cap content', async () => {
    const oversized = 'x'.repeat(MAX_CONTENT_BYTES + 1024);
    const r = await fetch(`${REST_BASE}/api/clusters/${clusterId}/peer/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: sourceWfid, to: memberIds[1], content: oversized }),
    });
    assertEq(r.status, 400, `REST peer/send returned 400 (got ${r.status})`);
    const body = await r.json() as { error: string };
    assert(
      body.error === 'content_too_large' || body.error === 'enqueue_failed',
      `error code is content_too_large (got "${body.error}")`,
    );
  });

  // Phase 3 step 7 — peer_send to a non-member workflowId. Resolver returns
  // undefined → unknown_peer rejection.
  await step('REST peer/send rejects unknown peer', async () => {
    const r = await fetch(`${REST_BASE}/api/clusters/${clusterId}/peer/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: sourceWfid, to: '00000000-0000-0000-0000-000000000000', content: 'will fail' }),
    });
    assertEq(r.status, 400, `REST peer/send returned 400 (got ${r.status})`);
    const body = await r.json() as { error: string };
    assertEq(body.error, 'unknown_peer', 'error code is unknown_peer');
  });

  // peer/list — returns roster excluding self.
  await step('REST peer/list returns roster', async () => {
    const r = await fetch(`${REST_BASE}/api/clusters/${clusterId}/peer/list?workflowId=${encodeURIComponent(sourceWfid)}`);
    assertEq(r.status, 200, `REST peer/list returned 200 (got ${r.status})`);
    const rows = await r.json() as Array<{ workflowId: string }>;
    assertEq(rows.length, 1, 'one peer (the sibling)');
    assertEq(rows[0].workflowId, memberIds[1], 'sibling workflowId in roster');
  });

  // cluster_plan_tick — REST POST /api/clusters/:id/peer/plan-tick.
  // Set a checkbox plan, flip by taskText, assert before/after + that the
  // cluster_plan_changed broadcast lands. Then exercise the error codes.
  await step('REST peer/plan-tick flips a checkbox + broadcasts cluster_plan_changed', async () => {
    const checkboxPlan = '# Plan\n\n- [ ] Phase 1.1 wire setter\n- [ ] Phase 1.2 dispatch\n- [x] Phase 0 plumbing\n';
    c.send({ type: 'cluster_plan_set', clusterId, body: checkboxPlan });
    await c.waitFor((x) => x.type === 'cluster_plan_changed' && (x as { body: string }).body === checkboxPlan, 3000, 'cluster_plan_changed (initial)');

    // taskText match — expect line 2 (0-based) to flip [ ] → [x].
    const changedP = c.waitFor(
      (x) => x.type === 'cluster_plan_changed' && (x as { body: string }).body.includes('- [x] Phase 1.1'),
      3000,
      'cluster_plan_changed (after tick)',
    );
    const r = await fetch(`${REST_BASE}/api/clusters/${clusterId}/peer/plan-tick`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowId: sourceWfid, taskText: 'Phase 1.1' }),
    });
    assertEq(r.status, 200, `plan-tick returned 200 (got ${r.status})`);
    const body = await r.json() as { toggledLine: number; before: string; after: string };
    assertEq(body.before, '[ ]', 'before is unchecked');
    assertEq(body.after, '[x]', 'after is checked');
    assertEq(body.toggledLine, 2, 'toggled line index matches (after blank line + heading)');
    await changedP;

    // task_not_found
    const nf = await fetch(`${REST_BASE}/api/clusters/${clusterId}/peer/plan-tick`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowId: sourceWfid, taskText: "doesn't exist" }),
    });
    assertEq(nf.status, 400, `task_not_found returned 400 (got ${nf.status})`);
    const nfBody = await nf.json() as { error: string };
    assertEq(nfBody.error, 'task_not_found', 'error code is task_not_found');

    // ambiguous_task — "Phase 1" matches both 1.1 and 1.2.
    const amb = await fetch(`${REST_BASE}/api/clusters/${clusterId}/peer/plan-tick`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowId: sourceWfid, taskText: 'Phase 1' }),
    });
    assertEq(amb.status, 400, `ambiguous_task returned 400 (got ${amb.status})`);
    const ambBody = await amb.json() as { error: string };
    assertEq(ambBody.error, 'ambiguous_task', 'error code is ambiguous_task');

    // lineIndex path — flip back via 0-based offset.
    const ti = await fetch(`${REST_BASE}/api/clusters/${clusterId}/peer/plan-tick`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowId: sourceWfid, lineIndex: 2 }),
    });
    assertEq(ti.status, 200, `plan-tick by lineIndex returned 200 (got ${ti.status})`);
    const tiBody = await ti.json() as { before: string; after: string };
    assertEq(tiBody.before, '[x]', 'lineIndex toggle: before is checked');
    assertEq(tiBody.after, '[ ]', 'lineIndex toggle: after is unchecked');

    // not_a_checkbox_line — line 0 is "# Plan" (the heading).
    const nc = await fetch(`${REST_BASE}/api/clusters/${clusterId}/peer/plan-tick`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowId: sourceWfid, lineIndex: 0 }),
    });
    assertEq(nc.status, 400, `not_a_checkbox_line returned 400 (got ${nc.status})`);
    const ncBody = await nc.json() as { error: string };
    assertEq(ncBody.error, 'not_a_checkbox_line', 'error code is not_a_checkbox_line');
  });

  // peer/send from a non-member workflowId → rejected up-front.
  await step('REST peer/send rejects non-cluster sender', async () => {
    const r = await fetch(`${REST_BASE}/api/clusters/${clusterId}/peer/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: '00000000-0000-0000-0000-000000000000', to: memberIds[1], content: 'nope' }),
    });
    assertEq(r.status, 400, `REST peer/send returned 400 (got ${r.status})`);
  });

  // 2026-05-11 — displayName fallback. Rename sibling to "Seedbank" then
  // send by friendly name (lowercased to also cover case-insensitive
  // matching). Resolution must succeed and recipient wfid is the sibling.
  await step('peer/send: resolves by displayName (case-insensitive exact)', async () => {
    c.send({ type: 'rename_workflow', workflowId: memberIds[1], name: 'Seedbank' });
    await c.waitFor(
      (x) => x.type === 'workflow_renamed' && (x as { workflowId?: string }).workflowId === memberIds[1],
      3000,
      'workflow_renamed for sibling',
    );
    const sendP = c.waitFor(
      (x) => x.type === 'peer_message_sent'
        && (x as { from?: string; to?: string }).from === sourceWfid
        && (x as { to?: string }).to === memberIds[1],
      3000,
      'peer_message_sent (displayName fallback)',
    );
    const r = await fetch(`${REST_BASE}/api/clusters/${clusterId}/peer/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: sourceWfid, to: 'seedbank', content: 'hi via displayName' }),
    });
    assertEq(r.status, 200, `REST peer/send returned 200 (got ${r.status})`);
    const body = await r.json() as { to: string };
    assertEq(body.to, memberIds[1], 'recipient wfid resolved from "seedbank"');
    await sendP;
    // Drain the resulting mailbox entry so it doesn't bleed into the
    // teardown-time depth assertions.
    await fetch(`${REST_BASE}/api/clusters/${clusterId}/peer/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowId: memberIds[1] }),
    });
  });

  // 2026-05-11 — unknown displayName returns unknown_peer with a hint
  // listing available members.
  await step('peer/send: unknown displayName surfaces roster hint', async () => {
    const r = await fetch(`${REST_BASE}/api/clusters/${clusterId}/peer/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: sourceWfid, to: 'nonexistent', content: 'should miss' }),
    });
    assertEq(r.status, 400, `REST peer/send returned 400 (got ${r.status})`);
    const body = await r.json() as { error: string; message?: string };
    assertEq(body.error, 'unknown_peer', 'unknown_peer code returned');
    assert(
      typeof body.message === 'string' && body.message.toLowerCase().includes('available peers'),
      'rejection message includes "available peers" hint',
    );
  });

  // Teardown. We never spawned a real `claude` turn so no mcp-config.json
  // should exist on disk — but the cleanup helper still runs on cluster
  // delete (best-effort `fs.rm({ force: true })`).
  await step('teardown: cluster_delete + remove_workflow + rm cwd', async () => {
    c.send({ type: 'cluster_delete', clusterId });
    await c.waitFor((x) => x.type === 'cluster_deleted', 3000, 'cluster_deleted');
    for (const id of memberIds) c.send({ type: 'remove_workflow', workflowId: id });
    // mcp-config.json should not exist (never spawned a CLI turn against
    // this cluster). Cleanup is best-effort regardless.
    for (const id of memberIds) {
      const cfgPath = join(cwd, '.archon', id, 'mcp-config.json');
      assert(!existsSync(cfgPath), `mcp-config.json absent for ${id.slice(0, 8)} (got ${cfgPath})`);
    }
    await c.close();
    rmSync(cwd, { recursive: true, force: true });
  });

  summary('Phase 3 smoke');
}

main().catch((err) => {
  console.error('Phase 3 smoke crashed:', err);
  process.exit(2);
});
