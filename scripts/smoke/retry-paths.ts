// ARCO_OPS_PLAN.md §C2 — targeted retry paths acceptance.
//
// Pure-deriver smoke (no live server, no provider spend, deterministic — same
// shape as runtime-states.ts). Imports the §C1 derivers + the §C2
// recoveryActionFor and asserts every observable state maps to its ONE correct
// targeted action, plus the load-bearing §C2 contrast: a killed server and a
// silent worker — which §C1 already proved derive DIFFERENT states — must also
// resolve to DIFFERENT recovery actions (reprobe vs cancel-turn). The wrong
// action is worse than none: re-probing a hung worker or cancelling a dead
// server's turn would both be lies.

import { step, assert, assertEq, summary } from './lib';
import {
  deriveConnectionState,
  deriveWorkflowState,
  recoveryActionFor,
  STUCK_THRESHOLD_MS,
  REPLAY_RECOVERED_WINDOW_MS,
  type ConnectionState,
  type WorkflowRuntimeState,
  type RecoveryActionId,
} from '../../client/src/runtime/runtimeState';

const T0 = 1_000_000_000_000;

// Convenience: derive the action id (or 'null') for an explicit state pair.
function actionId(connection: ConnectionState, workflow: WorkflowRuntimeState): RecoveryActionId | 'null' {
  return recoveryActionFor({ connection, workflow })?.id ?? 'null';
}

async function main(): Promise<void> {
  // ── Per-state mapping ──

  await step('disconnected → reconnect', () => {
    assertEq<RecoveryActionId | 'null'>(actionId('disconnected', 'idle'), 'reconnect', 'a live-server WS drop offers RECONNECT');
  });

  await step('server-down → reprobe', () => {
    assertEq<RecoveryActionId | 'null'>(actionId('server-down', 'idle'), 'reprobe', 'a dead server process offers RE-PROBE, not RESTART');
  });

  await step('online + stuck → cancel-turn', () => {
    assertEq<RecoveryActionId | 'null'>(actionId('online', 'stuck'), 'cancel-turn', 'a hung worker offers CANCEL TURN (cancel-and-resend)');
  });

  await step('online + replay-recovered → dismiss-recovered', () => {
    assertEq<RecoveryActionId | 'null'>(actionId('online', 'replay-recovered'), 'dismiss-recovered', 'the recovered notice offers DISMISS');
  });

  await step('idle / busy / online → null (no targeted action)', () => {
    assertEq<RecoveryActionId | 'null'>(actionId('online', 'idle'), 'null', 'idle has no targeted recovery');
    assertEq<RecoveryActionId | 'null'>(actionId('online', 'busy'), 'null', 'busy has no targeted recovery');
    assertEq<RecoveryActionId | 'null'>(actionId('connecting', 'idle'), 'null', 'still-connecting boot has no targeted recovery');
  });

  await step('connection layer dominates: disconnected outranks stuck workflow', () => {
    // While offline the per-workflow state is unknowable; the connection action wins.
    assertEq<RecoveryActionId | 'null'>(actionId('disconnected', 'stuck'), 'reconnect', 'connection action takes precedence over workflow state');
    assertEq<RecoveryActionId | 'null'>(actionId('server-down', 'stuck'), 'reprobe', 'server-down outranks any workflow state');
  });

  // ── Action descriptor sanity (label + hint are operator-visible) ──

  await step('each action carries a label and a hint', () => {
    for (const [c, w] of [
      ['disconnected', 'idle'],
      ['server-down', 'idle'],
      ['online', 'stuck'],
      ['online', 'replay-recovered'],
    ] as Array<[ConnectionState, WorkflowRuntimeState]>) {
      const a = recoveryActionFor({ connection: c, workflow: w });
      assert(a !== null, `${c}/${w} must yield an action`);
      assert(a!.label.length > 0, `${c}/${w} action has a label`);
      assert(a!.hint.length > 0, `${c}/${w} action has a hint`);
    }
  });

  // ── Acceptance contrast (the §C2 headline) ──

  await step('ACCEPTANCE: killed server vs silent worker yield DIFFERENT actions', () => {
    // Operator killed the Arco server process: socket closed + healthz down.
    const killedServerState = deriveConnectionState({
      wsState: 'closed',
      everOpened: true,
      healthzReachable: false,
    });
    assertEq<ConnectionState>(killedServerState, 'server-down', 'dead server → server-down');
    const killedServerAction = recoveryActionFor({ connection: killedServerState, workflow: 'idle' });

    // A provider worker went silent but the server is fine: online + busy +
    // stale primary emission.
    const silentWorkerState = deriveWorkflowState({
      connection: 'online',
      busy: true,
      lastPrimaryEventAt: T0 - (STUCK_THRESHOLD_MS + 10_000),
      recoveredAt: null,
      now: T0,
    });
    assertEq<WorkflowRuntimeState>(silentWorkerState, 'stuck', 'silent worker on a live server → stuck');
    const silentWorkerAction = recoveryActionFor({ connection: 'online', workflow: silentWorkerState });

    assertEq<RecoveryActionId | undefined>(killedServerAction?.id, 'reprobe', 'killed server → RE-PROBE');
    assertEq<RecoveryActionId | undefined>(silentWorkerAction?.id, 'cancel-turn', 'silent worker → CANCEL TURN');
    assert(
      killedServerAction?.id !== silentWorkerAction?.id,
      'the two failures must NOT collapse to the same recovery action',
    );
  });

  // The recovered window expiring removes the targeted action (back to idle/null).
  await step('replay-recovered past its window → no action (idle)', () => {
    const s = deriveWorkflowState({
      connection: 'online',
      busy: false,
      lastPrimaryEventAt: null,
      recoveredAt: T0 - (REPLAY_RECOVERED_WINDOW_MS + 2_000),
      now: T0,
    });
    assertEq<WorkflowRuntimeState>(s, 'idle', 'past the window → idle');
    assertEq<RecoveryActionId | 'null'>(actionId('online', s), 'null', 'idle has no targeted action');
  });

  summary('retry-paths');
}

void main();
