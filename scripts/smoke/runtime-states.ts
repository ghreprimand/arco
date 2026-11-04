// docs/ARCHITECTURE.md - observable runtime-state acceptance.
//
// Pure-deriver smoke: no live server, no provider spend, fully deterministic.
// It imports the §C1 deriver directly and asserts every (a)-(f) state plus the
// load-bearing acceptance contrast ("killing the server vs killing a provider
// worker show different, correct states"), proven at the deriver level so it
// doesn't depend on flaky timing against a real socket.

import { step, assert, assertEq, summary } from './lib';
import {
  deriveConnectionState,
  deriveWorkflowState,
  STUCK_THRESHOLD_MS,
  REPLAY_RECOVERED_WINDOW_MS,
  type ConnectionState,
  type WorkflowRuntimeState,
} from '../../client/src/runtime/runtimeState';

// Fixed clock — all "now" values are derived from this so the assertions read
// like the real time-deltas without any wall-clock dependency.
const T0 = 1_000_000_000_000;

async function main(): Promise<void> {
  // ── Connection axis ──

  await step('connecting baseline (never opened)', () => {
    const s = deriveConnectionState({ wsState: 'connecting', everOpened: false, healthzReachable: null });
    assertEq<ConnectionState>(s, 'connecting', 'fresh boot before first open is connecting');
  });

  await step('online when socket open', () => {
    const s = deriveConnectionState({ wsState: 'open', everOpened: true, healthzReachable: null });
    assertEq<ConnectionState>(s, 'online', 'open socket is online');
  });

  await step('(a) closed + healthz reachable → disconnected (server alive)', () => {
    const s = deriveConnectionState({ wsState: 'closed', everOpened: true, healthzReachable: true });
    assertEq<ConnectionState>(s, 'disconnected', 'WS drop with live server is a disconnect, not a server-down');
  });

  await step('(b) closed + healthz unreachable → server-down', () => {
    const s = deriveConnectionState({ wsState: 'closed', everOpened: true, healthzReachable: false });
    assertEq<ConnectionState>(s, 'server-down', 'dead server process is server-down');
  });

  await step('closed + healthz not-yet-probed (null) → disconnected (optimistic)', () => {
    const s = deriveConnectionState({ wsState: 'closed', everOpened: true, healthzReachable: null });
    assertEq<ConnectionState>(s, 'disconnected', 'unprobed close stays optimistic until the probe resolves');
  });

  // ── Workflow axis (only meaningful while online) ──

  await step('(c) online + busy + recent emission → busy', () => {
    const s = deriveWorkflowState({
      connection: 'online',
      busy: true,
      lastPrimaryEventAt: T0 - (STUCK_THRESHOLD_MS - 5_000), // 5s under threshold
      recoveredAt: null,
      now: T0,
    });
    assertEq<WorkflowRuntimeState>(s, 'busy', 'recent primary content reads as busy');
  });

  await step('(d) online + busy + stale emission → stuck', () => {
    const s = deriveWorkflowState({
      connection: 'online',
      busy: true,
      lastPrimaryEventAt: T0 - (STUCK_THRESHOLD_MS + 5_000), // 5s over threshold
      recoveredAt: null,
      now: T0,
    });
    assertEq<WorkflowRuntimeState>(s, 'stuck', 'silence past the threshold reads as stuck');
  });

  await step('stuck boundary is inclusive at exactly the threshold', () => {
    const s = deriveWorkflowState({
      connection: 'online',
      busy: true,
      lastPrimaryEventAt: T0 - STUCK_THRESHOLD_MS,
      recoveredAt: null,
      now: T0,
    });
    assertEq<WorkflowRuntimeState>(s, 'stuck', 'now - last === threshold is stuck (>=)');
  });

  await step('(e) online + not busy → idle', () => {
    const s = deriveWorkflowState({
      connection: 'online',
      busy: false,
      lastPrimaryEventAt: T0 - 60_000,
      recoveredAt: null,
      now: T0,
    });
    assertEq<WorkflowRuntimeState>(s, 'idle', 'not busy, no recovery window → idle');
  });

  await step('connection layer dominates: not-online → idle regardless of busy', () => {
    for (const c of ['disconnected', 'server-down', 'connecting'] as ConnectionState[]) {
      const s = deriveWorkflowState({
        connection: c,
        busy: true,
        lastPrimaryEventAt: T0 - (STUCK_THRESHOLD_MS + 60_000),
        recoveredAt: null,
        now: T0,
      });
      assertEq<WorkflowRuntimeState>(s, 'idle', `connection=${c} collapses workflow state to idle`);
    }
  });

  // ── (f) replay-recovered ──

  await step('(f) replay-recovered within window → replay-recovered', () => {
    const s = deriveWorkflowState({
      connection: 'online',
      busy: false,
      lastPrimaryEventAt: null,
      recoveredAt: T0 - (REPLAY_RECOVERED_WINDOW_MS - 2_000),
      now: T0,
    });
    assertEq<WorkflowRuntimeState>(s, 'replay-recovered', 'inside the window the recovered badge shows');
  });

  await step('replay-recovered past window → idle', () => {
    const s = deriveWorkflowState({
      connection: 'online',
      busy: false,
      lastPrimaryEventAt: null,
      recoveredAt: T0 - (REPLAY_RECOVERED_WINDOW_MS + 2_000),
      now: T0,
    });
    assertEq<WorkflowRuntimeState>(s, 'idle', 'past the window it falls back to idle');
  });

  await step('recovered-but-then-busy → busy (busy wins over recovered)', () => {
    const s = deriveWorkflowState({
      connection: 'online',
      busy: true,
      lastPrimaryEventAt: T0 - 1_000, // just emitted
      recoveredAt: T0 - 1_000, // also just recovered
      now: T0,
    });
    assertEq<WorkflowRuntimeState>(s, 'busy', 'a recovered workflow that picks up a turn reads as busy');
  });

  // ── Acceptance contrast (the §C1 headline) ──

  await step('ACCEPTANCE: killing the server vs a silent worker derive different states', () => {
    // Operator killed the Arco server process: socket closed + healthz down.
    const killedServer = deriveConnectionState({
      wsState: 'closed',
      everOpened: true,
      healthzReachable: false,
    });
    // A provider worker went silent but the server is fine: online + busy +
    // stale primary emission.
    const silentWorker = deriveWorkflowState({
      connection: 'online',
      busy: true,
      lastPrimaryEventAt: T0 - (STUCK_THRESHOLD_MS + 10_000),
      recoveredAt: null,
      now: T0,
    });
    assertEq<ConnectionState>(killedServer, 'server-down', 'dead server → server-down');
    assertEq<WorkflowRuntimeState>(silentWorker, 'stuck', 'silent worker on a live server → stuck');
    assert((killedServer as string) !== (silentWorker as string), 'the two failures must NOT collapse to the same state');
  });

  summary('runtime-states');
}

void main();
