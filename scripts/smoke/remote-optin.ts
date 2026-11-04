// REMOTE_MANAGEMENT.md §1.4 — per-workflow REMOTE opt-in smoke (Phase A).
//
// Pure (no dev server, no network): exercises the ntfy transport's per-workflow
// gate end to end with an injected fake fetch + isRemoteEnabled predicate.
// Asserts the load-bearing notification rule of the opt-in:
//
//   1. A workflow-scoped notice for an OPTED-OUT workflow does NOT push.
//   2. A workflow-scoped notice for an OPTED-IN workflow DOES push.
//   3. An instance-level notice (no workflowId) ALWAYS pushes, regardless.
//   4. With no predicate injected, the gate is inert (back-compat): all push.
//
// The snapshotWorkflows() visibility filter and the applyAction() 'remote-disabled'
// guard are plain `if (!wf.config.remoteEnabled)` checks covered by typecheck +
// the live acceptance in the plan (they live in initHubLink, which pulls the turn
// engine, so they're not unit-imported here).
//
// Run: npm run smoke:remote-optin

import { tmpdir } from 'os';
import { join } from 'path';
import { step, assert, assertEq, summary } from './lib.js';
import {
  initNotifications,
  emit,
  _resetTransportsForTest,
  _setMutesPathForTest,
} from '../../server/src/notifications.js';
import { initNtfyTransport } from '../../server/src/ntfyTransport.js';

function fakePost() {
  const calls: Array<{ url: string }> = [];
  const fetchImpl = (async (url: string | URL) => {
    calls.push({ url: String(url) });
    return new Response('1', { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const NTFY_ENV = { ARCO_NTFY_URL: 'http://hub:3501/arco-x', ARCO_HUB_URL: 'ws://hub:3500/agent' };

async function main() {
  _setMutesPathForTest(join(tmpdir(), `arco-remote-optin-smoke-${process.pid}.json`));
  await initNotifications(() => { /* swallow in-app broadcasts */ });

  await step('opted-IN set gates per-workflow: only enabled workflows push', async () => {
    _resetTransportsForTest();
    const { calls, fetchImpl } = fakePost();
    const enabled = new Set<string>(['wf-on']);
    const active = initNtfyTransport({
      env: NTFY_ENV,
      fetchImpl,
      instanceLabel: 'workstation',
      isRemoteEnabled: (id) => enabled.has(id),
    });
    assertEq(active, true, 'transport active');

    // Opted-OUT workflow → suppressed.
    emit({ category: 'turn-finished', severity: 'success', title: 'off-wf turn', workflowId: 'wf-off' });
    await new Promise((r) => setTimeout(r, 30));
    assertEq(calls.length, 0, 'opted-OUT workflow notice does NOT push');

    // Opted-IN workflow → pushes.
    emit({ category: 'turn-finished', severity: 'success', title: 'on-wf turn', workflowId: 'wf-on' });
    await new Promise((r) => setTimeout(r, 30));
    assertEq(calls.length, 1, 'opted-IN workflow notice pushes');
  });

  await step('instance-level notice (no workflowId) always pushes', async () => {
    _resetTransportsForTest();
    const { calls, fetchImpl } = fakePost();
    initNtfyTransport({
      env: NTFY_ENV,
      fetchImpl,
      instanceLabel: 'workstation',
      isRemoteEnabled: () => false, // everything opted out…
    });
    // …but an instance-level notice carries no workflowId, so it's unaffected.
    emit({ category: 'quota-recovered', severity: 'success', title: 'claude quota recovered' });
    await new Promise((r) => setTimeout(r, 30));
    assertEq(calls.length, 1, 'instance-level notice pushes even when all workflows opted out');
  });

  await step('no predicate → gate inert (back-compat): workflow notices push', async () => {
    _resetTransportsForTest();
    const { calls, fetchImpl } = fakePost();
    initNtfyTransport({ env: NTFY_ENV, fetchImpl, instanceLabel: 'workstation' });
    emit({ category: 'turn-finished', severity: 'success', title: 'ungated', workflowId: 'wf-any' });
    await new Promise((r) => setTimeout(r, 30));
    assertEq(calls.length, 1, 'without a predicate, workflow-scoped notices still push');
  });

  _resetTransportsForTest();
  summary('Phase A — per-workflow REMOTE opt-in');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
