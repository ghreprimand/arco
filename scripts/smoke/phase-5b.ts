// docs/PROTOCOL_CLUSTER.md - auto-turn-on-mailbox detector smoke.
//
// Covers (protocol-only, no real LLM turns):
//   1. Toggle ON flips cluster_state.autoTurnOnMailboxEnabled.
//   2. A peer_message_sent on an idle recipient fires
//      cluster_auto_turn_fired with fired=true, chainDepth=1.
//   3. A synthetic injection at chainDepth == cap (env-overridden depth=2 →
//      inject at depth 2) refuses to fire (reason=depth_capped, fired=false).
//   4. A burst of (rate_cap + 1) injections at chainDepth 0 against different
//      recipients (avoid cooldown) produces exactly rate_cap fires and one
//      rate_capped skip.
//   5. Toggle OFF → next peer_send produces no cluster_auto_turn_fired.
//
// Boot the smoke server with:
//   ARCO_PORT=3002 ARCO_TEST=1 \
//   ARCO_TEST_NO_AUTO_TURN_DISPATCH=1 \
//   ARCO_CLUSTER_AUTO_TURN_COOLDOWN_MS=200 \
//   ARCO_CLUSTER_AUTO_TURN_RATE_CAP_PER_MINUTE=3 \
//   ARCO_CLUSTER_AUTO_TURN_MAX_CHAIN_DEPTH=2 \
//   npx tsx watch server/src/index.ts
//
// ARCO_TEST_NO_AUTO_TURN_DISPATCH=1 skips the real handleUserMessage
// dispatch so the recipient never goes busy; lets us measure the detector's
// audit events cleanly without spinning workers we can't drive headless.

import { connect, step, assert, assertEq, summary } from './lib.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = parseInt(process.env.ARCO_PORT || '3001', 10);
const REST_BASE = `http://127.0.0.1:${PORT}`;

// Smoke env overrides — mirror the server-side defaults (see
// clusterAutoTurn.ts). The script reads them so the asserts adapt when the
// caller runs with different values.
const RATE_CAP = parseInt(process.env.ARCO_CLUSTER_AUTO_TURN_RATE_CAP_PER_MINUTE || '3', 10);
const DEPTH_CAP = parseInt(process.env.ARCO_CLUSTER_AUTO_TURN_MAX_CHAIN_DEPTH || '2', 10);
const COOLDOWN_MS = parseInt(process.env.ARCO_CLUSTER_AUTO_TURN_COOLDOWN_MS || '200', 10);

async function main(): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), 'arco-smoke-5b-'));
  console.log(`Phase 5b smoke — cwd ${cwd} (rate=${RATE_CAP}, depth=${DEPTH_CAP}, cooldown=${COOLDOWN_MS}ms)`);
  console.log('');

  const c = await connect(`ws://localhost:${PORT}/ws`);

  let sourceWfid = '';
  let clusterId = '';
  let members: string[] = [];

  await step('1: create Native source workflow', async () => {
    c.send({
      type: 'create_workflow',
      config: {
        name: 'Smoke 5b Native Source',
        primaryProvider: 'claude',
        primaryModel: 'claude-opus-4-7',
        primaryEffort: 'normal',
        skipPermissions: true,
        workingDirectory: cwd,
        claudeTransport: 'native',
      },
    });
    const m = await c.waitFor(
      (x) => x.type === 'workflow_created' && (x.config as { name?: string }).name === 'Smoke 5b Native Source',
      8000,
      'workflow_created (1)',
    );
    sourceWfid = m.workflowId as string;
    assert(sourceWfid.length > 0, 'source workflowId returned');
  });

  // Need at least RATE_CAP+1 idle recipients to test rate cap without
  // colliding with the cooldown gate. Cluster with rate_cap+2 members:
  // members[0] is the sender, members[1..rate_cap+1] are recipients.
  // additionalCount = (rate_cap + 2) - 1.
  const additionalCount = RATE_CAP + 1;

  await step(`2: cluster_create_with_fresh_workers (+${additionalCount} siblings)`, async () => {
    c.send({
      type: 'cluster_create_with_fresh_workers',
      sourceWorkflowId: sourceWfid,
      additionalCount,
      name: 'Phase 5b Cluster',
    });
    const m = await c.waitFor(
      (x) => x.type === 'cluster_created',
      15000,
      'cluster_created (2)',
    );
    clusterId = m.clusterId as string;
    const state = m.state as { members: Array<{ workflowId: string }> };
    members = state.members.map((mem) => mem.workflowId);
    assertEq(members.length, additionalCount + 1, `cluster has ${additionalCount + 1} members`);
    for (const wfid of members) c.send({ type: 'subscribe', workflowId: wfid });
    await new Promise((r) => setTimeout(r, 100));
  });

  await step('3: toggle auto-turn ON → cluster_state.autoTurnOnMailboxEnabled === true', async () => {
    const ackP = c.waitFor(
      (x) => x.type === 'cluster_state' && x.clusterId === clusterId &&
        (x.state as { autoTurnOnMailboxEnabled?: boolean }).autoTurnOnMailboxEnabled === true,
      3000,
      'cluster_state with auto-turn enabled',
    );
    c.send({ type: 'cluster_auto_turn_toggle', clusterId, enabled: true });
    await ackP;
  });

  await step('4: peer_send A→B (depth 0) → cluster_auto_turn_fired fired=true, chainDepth=1', async () => {
    const fireP = c.waitFor(
      (x) => x.type === 'cluster_auto_turn_fired' &&
        x.clusterId === clusterId &&
        x.workflowId === members[1] &&
        (x as { fired?: boolean }).fired === true,
      5000,
      'cluster_auto_turn_fired (first)',
    );
    const r = await fetch(`${REST_BASE}/api/clusters/${clusterId}/peer/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: members[0], to: members[1], content: 'auto-turn trigger 1' }),
    });
    assertEq(r.status, 200, `peer/send 200 (got ${r.status})`);
    const fire = await fireP;
    assertEq(fire.chainDepth, 1, 'chainDepth stamped to 1 (parent depth 0 + 1)');
    assertEq(fire.sender, members[0], 'sender recorded');
    assertEq(fire.reason, 'mailbox_arrival', 'reason is mailbox_arrival');
  });

  await step(`5: inject at depth=${DEPTH_CAP} → depth_capped (no fire)`, async () => {
    // Wait past cooldown so the recipient isn't blocked by the cooldown guard
    // — the depth guard should fire first regardless, but we want a clean
    // depth_capped reason.
    await new Promise((r) => setTimeout(r, COOLDOWN_MS + 100));
    const skipP = c.waitFor(
      (x) => x.type === 'cluster_auto_turn_fired' &&
        x.clusterId === clusterId &&
        (x as { fired?: boolean }).fired === false &&
        x.reason === 'depth_capped',
      3000,
      'cluster_auto_turn_fired (depth_capped)',
    );
    c.send({
      type: '__debug_cluster_auto_turn_inject',
      clusterId,
      senderWfid: members[0],
      recipientWfid: members[2],
      chainDepth: DEPTH_CAP,   // == cap → refused (guard is `>=`)
    });
    const skip = await skipP;
    assertEq(skip.fired, false, 'fired=false on depth cap');
  });

  await step(`6: rate cap — fire ${RATE_CAP}, expect rate_capped on the ${RATE_CAP + 1}th`, async () => {
    // The first peer_send in step 4 already consumed one slot in the
    // rolling 60s window. Wait past cooldown so a different recipient can
    // fire. We fire against members[1] again (cooldown_ms elapsed) plus
    // (RATE_CAP - 1) more fresh recipients to consume the budget, then a
    // final inject expecting rate_capped.
    await new Promise((r) => setTimeout(r, COOLDOWN_MS + 100));

    // Fire RATE_CAP - 1 more (step 4 already burned 1 slot). Use a fresh
    // recipient each time so cooldown doesn't bite.
    // Available fresh recipients after step 4 and step 5 (step 5 was
    // depth-capped so it didn't consume a slot): members[2..] minus
    // members[1] which we already burned.
    let fired = 1; // from step 4
    let i = 2;
    while (fired < RATE_CAP) {
      const target = members[i];
      const fireP = c.waitFor(
        (x) => x.type === 'cluster_auto_turn_fired' &&
          x.clusterId === clusterId &&
          x.workflowId === target &&
          (x as { fired?: boolean }).fired === true,
        3000,
        `cluster_auto_turn_fired (rate-cap fill #${fired + 1})`,
      );
      const r = await fetch(`${REST_BASE}/api/clusters/${clusterId}/peer/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: members[0], to: target, content: `rate-cap fill ${fired + 1}` }),
      });
      assertEq(r.status, 200, `peer/send 200 (got ${r.status})`);
      await fireP;
      fired += 1;
      i += 1;
    }

    // Now the next inject must be rate-capped. Use a fresh recipient + the
    // debug hook so we don't have to navigate around the peer_send budget
    // (peerSend has its own per-turn cap that's independent of auto-turn).
    const skipP = c.waitFor(
      (x) => x.type === 'cluster_auto_turn_fired' &&
        x.clusterId === clusterId &&
        (x as { fired?: boolean }).fired === false &&
        x.reason === 'rate_capped',
      3000,
      'cluster_auto_turn_fired (rate_capped)',
    );
    c.send({
      type: '__debug_cluster_auto_turn_inject',
      clusterId,
      senderWfid: members[0],
      recipientWfid: members[i],   // fresh recipient — no cooldown to confound
      chainDepth: 0,
    });
    const skip = await skipP;
    assertEq(skip.fired, false, 'fired=false on rate cap');
    assertEq(skip.reason, 'rate_capped', 'reason=rate_capped');
  });

  await step('7: toggle auto-turn OFF → no further fires', async () => {
    c.send({ type: 'cluster_auto_turn_toggle', clusterId, enabled: false });
    await c.waitFor(
      (x) => x.type === 'cluster_state' && x.clusterId === clusterId &&
        (x.state as { autoTurnOnMailboxEnabled?: boolean }).autoTurnOnMailboxEnabled !== true,
      3000,
      'cluster_state with auto-turn disabled',
    );
    // Fire a peer_send that would have triggered an auto-turn. Wait long
    // enough that any auto-turn would have shown up.
    const r = await fetch(`${REST_BASE}/api/clusters/${clusterId}/peer/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: members[0], to: members[1], content: 'should NOT auto-turn' }),
    });
    assertEq(r.status, 200, `peer/send 200 (got ${r.status})`);
    let unexpected = false;
    try {
      await c.waitFor(
        (x) => x.type === 'cluster_auto_turn_fired' && x.clusterId === clusterId,
        1500,
        'cluster_auto_turn_fired (after disable — should NOT arrive)',
      );
      unexpected = true;
    } catch {
      // Timeout = success.
    }
    assert(!unexpected, 'no cluster_auto_turn_fired after toggle off');
  });

  await step('8: teardown — close + cluster delete + cwd rm', async () => {
    for (const wfid of members) c.send({ type: 'remove_workflow', workflowId: wfid });
    // Without this the cluster dir outlived the run — every past run sat in
    // the +NEW creator's cluster list pointing at a deleted /tmp cwd.
    if (clusterId) c.send({ type: 'cluster_delete', clusterId });
    await new Promise((r) => setTimeout(r, 200));
    await c.close();
    rmSync(cwd, { recursive: true, force: true });
  });

  summary('Phase 5b smoke');
}

main().catch((err) => {
  console.error('Phase 5b smoke crashed:', err);
  process.exit(2);
});
