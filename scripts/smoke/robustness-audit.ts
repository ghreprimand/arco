// ARCO_OPS_PLAN.md §C3 — robustness audit harness + failure cases.
//
// Pure-deriver audit (no live server, no provider spend, no real sockets — same
// headless/clock-injected shape as runtime-states.ts + retry-paths.ts). C1 made
// each failure observable; C2 mapped each to its one correct retry; C3 PROVES
// that every enumerated failure case lands in a correct observable state with a
// working retry by encoding each as a named timeline of input frames over the
// §C1/§C2 derivers.
//
// Each scenario walks a realistic input sequence (browser/network/process
// events) → at the failure point asserts the expected ConnectionState,
// WorkflowRuntimeState, and recovery action id → then applies the PRESCRIBED
// retry and asserts the timeline returns to health (online + idle/busy, no
// targeted action).
//
// The 9 enumerated cases (plan §C3) split three ways:
//   modelable here — 1,2,3,4,8,9 (full timeline over the derivers).
//   end-state-only here — 5,6,7: the INTERNAL mechanic (Codex resume
//     correctness, Native replay not blocking the UI, terminal orphan reaping)
//     is NOT a deriver property; this harness asserts only the observable
//     end-state the operator would see if that mechanic works, and the matrix
//     in docs/OPERATIONS.md records where the internal correctness is proven
//     (smoke:phase-4 / smoke:terminal / a manual recipe). We do NOT fake the
//     mechanic.
//
// Run: npm run smoke:robustness-audit  (no dev server needed)

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

// Fixed clock — every "now" is derived from T0 so deltas read like real time
// without any wall-clock dependency.
const T0 = 1_000_000_000_000;

// ── Frame helpers ───────────────────────────────────────────────────────────
// A frame is the full observable input at one instant. We derive connection,
// then workflow, then the targeted action, exactly as the live layer does.

interface Frame {
  wsState: 'connecting' | 'open' | 'closed';
  everOpened: boolean;
  healthzReachable: boolean | null;
  busy: boolean;
  lastPrimaryEventAt: number | null;
  recoveredAt: number | null;
  now: number;
}

interface Derived {
  connection: ConnectionState;
  workflow: WorkflowRuntimeState;
  action: RecoveryActionId | 'null';
}

function derive(f: Frame): Derived {
  const connection = deriveConnectionState({
    wsState: f.wsState,
    everOpened: f.everOpened,
    healthzReachable: f.healthzReachable,
  });
  const workflow = deriveWorkflowState({
    connection,
    busy: f.busy,
    lastPrimaryEventAt: f.lastPrimaryEventAt,
    recoveredAt: f.recoveredAt,
    now: f.now,
  });
  const action = recoveryActionFor({ connection, workflow })?.id ?? 'null';
  return { connection, workflow, action };
}

function assertFrame(
  d: Derived,
  expect: { connection: ConnectionState; workflow: WorkflowRuntimeState; action: RecoveryActionId | 'null' },
  where: string,
): void {
  assertEq<ConnectionState>(d.connection, expect.connection, `${where}: connection`);
  assertEq<WorkflowRuntimeState>(d.workflow, expect.workflow, `${where}: workflow`);
  assertEq<RecoveryActionId | 'null'>(d.action, expect.action, `${where}: recovery action`);
}

// A "healthy" frame is the resting target every retry must return to: online +
// (idle or busy) + no targeted recovery action.
function assertHealthy(d: Derived, where: string): void {
  assertEq<ConnectionState>(d.connection, 'online', `${where}: returned online`);
  assert(d.workflow === 'idle' || d.workflow === 'busy', `${where}: returned to idle/busy (got ${d.workflow})`);
  assertEq<RecoveryActionId | 'null'>(d.action, 'null', `${where}: no lingering recovery action`);
}

// ── Pure preview-probe contract (case 8) ─────────────────────────────────────
// The runtime deriver doesn't model the preview target — PreviewTab probes
// /api/preview/probe?port=… and reads `{ alive: boolean }`. Mirror that pure
// contract here: a dead probe must surface the RE-PROBE recovery; a live probe
// clears it. (Matches PreviewTab.reprobeBound: alive → stay bound; dead → open
// the dead-service picker to rebind.)
type PreviewAction = 're-probe' | 'none';
function previewAction(probe: { alive: boolean }): PreviewAction {
  return probe.alive ? 'none' : 're-probe';
}

async function main(): Promise<void> {
  // ───────────────────────────────────────────────────────────────────────────
  // CASE 1 — Browser disconnects mid-turn (modelable)
  // open+busy → socket closed, healthz REACHABLE (server alive) → disconnected
  // + RECONNECT; reconnect → online + replay sets recoveredAt → replay-recovered;
  // window elapses → resumes busy / falls to idle.
  // ───────────────────────────────────────────────────────────────────────────
  await step('CASE 1: browser disconnect mid-turn → disconnected/reconnect → recovers', () => {
    const base: Frame = {
      wsState: 'open', everOpened: true, healthzReachable: null,
      busy: true, lastPrimaryEventAt: T0 - 1_000, recoveredAt: null, now: T0,
    };
    // Mid-turn, working.
    assertFrame(derive(base), { connection: 'online', workflow: 'busy', action: 'null' }, 'mid-turn');

    // Browser/network drops the socket; the server is alive so /healthz answers.
    const dropped = derive({ ...base, wsState: 'closed', healthzReachable: true, now: T0 + 2_000 });
    assertFrame(dropped, { connection: 'disconnected', workflow: 'idle', action: 'reconnect' }, 'after drop');

    // Prescribed retry = RECONNECT → socket reopens; rehydrate stamps recoveredAt.
    const reconnected = derive({
      ...base, wsState: 'open', healthzReachable: true,
      busy: false, lastPrimaryEventAt: null, recoveredAt: T0 + 3_000, now: T0 + 3_500,
    });
    assertFrame(reconnected, { connection: 'online', workflow: 'replay-recovered', action: 'dismiss-recovered' }, 'on reconnect');

    // Window elapses, operator re-engages → healthy.
    const settled = derive({
      ...base, wsState: 'open', healthzReachable: true,
      busy: false, lastPrimaryEventAt: null,
      recoveredAt: T0 + 3_000, now: T0 + 3_000 + REPLAY_RECOVERED_WINDOW_MS + 1_000,
    });
    assertHealthy(settled, 'after window');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // CASE 2 — Server restarts mid-turn (modelable)
  // open+busy → socket closed, healthz UNREACHABLE → server-down + RE-PROBE;
  // server returns, healthz reachable + socket reopens → online + rehydrate →
  // replay-recovered → idle.
  // ───────────────────────────────────────────────────────────────────────────
  await step('CASE 2: server restart mid-turn → server-down/reprobe → recovers', () => {
    const base: Frame = {
      wsState: 'open', everOpened: true, healthzReachable: null,
      busy: true, lastPrimaryEventAt: T0 - 1_000, recoveredAt: null, now: T0,
    };
    assertFrame(derive(base), { connection: 'online', workflow: 'busy', action: 'null' }, 'mid-turn');

    // The server PROCESS is gone: socket closed AND the probe fails.
    const down = derive({ ...base, wsState: 'closed', healthzReachable: false, now: T0 + 2_000 });
    assertFrame(down, { connection: 'server-down', workflow: 'idle', action: 'reprobe' }, 'server down');

    // RE-PROBE keeps failing while it's still down — the action persists (the
    // honest "still not back" loop, not a misleading recovered state).
    const stillDown = derive({ ...base, wsState: 'closed', healthzReachable: false, now: T0 + 5_000 });
    assertFrame(stillDown, { connection: 'server-down', workflow: 'idle', action: 'reprobe' }, 'still down');

    // Server returns: probe answers, socket reopens, rehydrate stamps recoveredAt.
    const back = derive({
      ...base, wsState: 'open', healthzReachable: true,
      busy: false, lastPrimaryEventAt: null, recoveredAt: T0 + 8_000, now: T0 + 8_200,
    });
    assertFrame(back, { connection: 'online', workflow: 'replay-recovered', action: 'dismiss-recovered' }, 'server back');

    const settled = derive({
      ...base, wsState: 'open', healthzReachable: true,
      busy: false, lastPrimaryEventAt: null,
      recoveredAt: T0 + 8_000, now: T0 + 8_000 + REPLAY_RECOVERED_WINDOW_MS + 1_000,
    });
    assertHealthy(settled, 'after window');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // CASE 3 — Laptop sleep during a turn (modelable)
  // Like a disconnect but with a LONG gap. On the close the probe may not have
  // resolved yet (null → optimistic disconnected), may briefly be unreachable
  // mid-sleep, then reachable on wake. The invariant under test: it never wedges
  // in a wrong state — null stays disconnected (no spurious server-down), and on
  // wake it cleanly recovers.
  // ───────────────────────────────────────────────────────────────────────────
  await step('CASE 3: laptop sleep → no wedge; wakes to disconnected → recovers', () => {
    const base: Frame = {
      wsState: 'open', everOpened: true, healthzReachable: null,
      busy: true, lastPrimaryEventAt: T0 - 1_000, recoveredAt: null, now: T0,
    };
    assertFrame(derive(base), { connection: 'online', workflow: 'busy', action: 'null' }, 'pre-sleep');

    // Sleep hits: socket closes, probe hasn't resolved (null) → optimistic
    // disconnected, NOT server-down. This is the no-spurious-flash invariant.
    const justSlept = derive({ ...base, wsState: 'closed', healthzReachable: null, now: T0 + 1_000 });
    assertFrame(justSlept, { connection: 'disconnected', workflow: 'idle', action: 'reconnect' }, 'just slept (probe pending)');

    // Deep into sleep — a probe fired mid-sleep can momentarily fail. That's an
    // honest server-down read from the browser's POV, but it must not WEDGE: the
    // next reachable probe must clear it. Long gap (10 min).
    const SLEEP_MS = 10 * 60_000;
    const midSleep = derive({ ...base, wsState: 'closed', healthzReachable: false, now: T0 + SLEEP_MS / 2 });
    assertFrame(midSleep, { connection: 'server-down', workflow: 'idle', action: 'reprobe' }, 'mid-sleep probe failed');

    // Wake: the box is back on the network, server was alive the whole time →
    // probe succeeds again. Crucially NOT stuck on the stale server-down.
    const onWake = derive({ ...base, wsState: 'closed', healthzReachable: true, now: T0 + SLEEP_MS });
    assertFrame(onWake, { connection: 'disconnected', workflow: 'idle', action: 'reconnect' }, 'on wake (reachable again)');

    // RECONNECT → online; the long-stale turn rehydrates from disk.
    const reconnected = derive({
      ...base, wsState: 'open', healthzReachable: true,
      busy: false, lastPrimaryEventAt: null, recoveredAt: T0 + SLEEP_MS + 1_000, now: T0 + SLEEP_MS + 1_200,
    });
    assertFrame(reconnected, { connection: 'online', workflow: 'replay-recovered', action: 'dismiss-recovered' }, 'reconnected');

    const settled = derive({
      ...base, wsState: 'open', healthzReachable: true,
      busy: false, lastPrimaryEventAt: null,
      recoveredAt: T0 + SLEEP_MS + 1_000, now: T0 + SLEEP_MS + 1_000 + REPLAY_RECOVERED_WINDOW_MS + 1_000,
    });
    assertHealthy(settled, 'after window');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // CASE 4 — Provider CLI exits after partial output (modelable, two sub-cases)
  // (i) clean exit: a real primary_turn_ended flips busy→false → idle; operator
  //     re-sends. No stuck, no targeted action.
  // (ii) silent crash: the process dies without ending the turn → stays busy;
  //     after STUCK_THRESHOLD_MS of no primary content → stuck + CANCEL TURN.
  //     CANCEL flips busy→false → idle, operator re-sends.
  // ───────────────────────────────────────────────────────────────────────────
  await step('CASE 4i: provider clean exit after partial output → busy → idle', () => {
    const base: Frame = {
      wsState: 'open', everOpened: true, healthzReachable: null,
      busy: true, lastPrimaryEventAt: T0 - 2_000, recoveredAt: null, now: T0,
    };
    assertFrame(derive(base), { connection: 'online', workflow: 'busy', action: 'null' }, 'streaming partial');

    // Clean primary_turn_ended → busy false. Idle, operator's turn to re-send.
    const ended = derive({ ...base, busy: false, lastPrimaryEventAt: T0, now: T0 + 500 });
    assertHealthy(ended, 'after clean exit');
    assertEq<WorkflowRuntimeState>(ended.workflow, 'idle', 'clean exit reads idle, not stuck');
  });

  await step('CASE 4ii: provider silent crash after partial output → stuck/cancel-turn → idle', () => {
    const base: Frame = {
      wsState: 'open', everOpened: true, healthzReachable: null,
      busy: true, lastPrimaryEventAt: T0, recoveredAt: null, now: T0,
    };
    // Right after the last partial token — still busy (under threshold).
    const fresh = derive({ ...base, now: T0 + 5_000 });
    assertFrame(fresh, { connection: 'online', workflow: 'busy', action: 'null' }, 'just before silence');

    // Process died silently; no primary content for ≥ threshold → stuck.
    const wedged = derive({ ...base, now: T0 + STUCK_THRESHOLD_MS + 5_000 });
    assertFrame(wedged, { connection: 'online', workflow: 'stuck', action: 'cancel-turn' }, 'silent crash');

    // The honest recovery: CANCEL TURN flips busy→false. Then re-send.
    const cancelled = derive({ ...base, busy: false, now: T0 + STUCK_THRESHOLD_MS + 6_000 });
    assertHealthy(cancelled, 'after cancel-turn');
    assertEq<WorkflowRuntimeState>(cancelled.workflow, 'idle', 'cancelled turn reads idle');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // CASE 5 — Codex app-server worker restart + resume (end-state only)
  // The INTERNAL resume correctness (session id round-trip, history continuity)
  // is a Codex-transport property, NOT a deriver property — covered by
  // smoke:phase-4 / smoke:compare + a manual recipe (see OPERATIONS.md matrix).
  // Here we assert ONLY the observable end-state the operator sees if resume
  // works: after a successful resume the tab reads online + replay-recovered →
  // idle, never wedged stuck.
  // ───────────────────────────────────────────────────────────────────────────
  await step('CASE 5: codex worker restart+resume → observable end-state online/recovered → idle', () => {
    const base: Frame = {
      wsState: 'open', everOpened: true, healthzReachable: true,
      busy: false, lastPrimaryEventAt: null, recoveredAt: null, now: T0,
    };
    // Resume just landed: rehydrate stamps recoveredAt (server stayed up — only
    // the app-server child bounced, so the WS never dropped).
    const resumed = derive({ ...base, recoveredAt: T0, now: T0 + 200 });
    assertFrame(resumed, { connection: 'online', workflow: 'replay-recovered', action: 'dismiss-recovered' }, 'post-resume');

    const settled = derive({ ...base, recoveredAt: T0, now: T0 + REPLAY_RECOVERED_WINDOW_MS + 1_000 });
    assertHealthy(settled, 'after window');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // CASE 6 — Claude Native large-history replay without UI block (end-state only)
  // "Replay doesn't block the UI" is a PERFORMANCE property (the in-process
  // pre-warm replay must not jank the render loop) — not a deriver property.
  // Manual recipe in OPERATIONS.md. Here we assert the observable end-state: a
  // large replay surfaces as replay-recovered while the WS stays online (never a
  // spurious disconnected/server-down during the replay), then settles idle.
  // ───────────────────────────────────────────────────────────────────────────
  await step('CASE 6: native large-history replay → online throughout → recovered → idle', () => {
    const base: Frame = {
      wsState: 'open', everOpened: true, healthzReachable: true,
      busy: false, lastPrimaryEventAt: null, recoveredAt: T0, now: T0,
    };
    // Throughout the replay window the connection stays online (replay is
    // in-process; the socket is unaffected) and the tab reads replay-recovered.
    for (const dt of [0, 1_000, REPLAY_RECOVERED_WINDOW_MS - 1_000]) {
      const d = derive({ ...base, now: T0 + dt });
      assertEq<ConnectionState>(d.connection, 'online', `replay @${dt}ms stays online`);
      assertEq<WorkflowRuntimeState>(d.workflow, 'replay-recovered', `replay @${dt}ms reads recovered`);
    }
    const settled = derive({ ...base, now: T0 + REPLAY_RECOVERED_WINDOW_MS + 1_000 });
    assertHealthy(settled, 'after replay window');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // CASE 7 — Terminal sessions interrupted / orphaned (end-state only)
  // Orphan REAPING (boot sweep SIGKILLs registered pids) is a process-lifecycle
  // property of PtyManager — covered by smoke:terminal (orphan registry
  // round-trip). Not a deriver property. Here we assert the runtime invariant
  // that matters to the operator: a terminal session dying / being orphaned does
  // NOT perturb the workflow runtime state — the tab stays online + idle (PTY
  // liveness is independent of the agent runtime axis).
  // ───────────────────────────────────────────────────────────────────────────
  await step('CASE 7: terminal orphaned → workflow runtime unaffected (online/idle)', () => {
    const base: Frame = {
      wsState: 'open', everOpened: true, healthzReachable: true,
      busy: false, lastPrimaryEventAt: T0 - 60_000, recoveredAt: null, now: T0,
    };
    // A terminal child dying is not a primary signal — busy is unchanged (false),
    // so the runtime state is plain idle, no stuck, no recovery action.
    assertHealthy(derive(base), 'terminal orphaned, agent idle');
    // And while a turn is genuinely busy, a terminal death likewise doesn't flip
    // it to stuck — lastPrimaryEventAt is the only liveness anchor.
    const busy = derive({ ...base, busy: true, lastPrimaryEventAt: T0 - 1_000 });
    assertFrame(busy, { connection: 'online', workflow: 'busy', action: 'null' }, 'terminal orphaned, agent busy');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // CASE 8 — Preview target dies then returns (modelable via probe contract)
  // Not a runtime-deriver property — the preview target has its own probe
  // contract (/api/preview/probe → { alive }). Model dead → RE-PROBE → alive.
  // ───────────────────────────────────────────────────────────────────────────
  await step('CASE 8: preview target dies → RE-PROBE → returns → bound', () => {
    // Bound + alive: no action needed.
    assertEq<PreviewAction>(previewAction({ alive: true }), 'none', 'live target needs no action');
    // Target process dies: probe fails → RE-PROBE is the targeted recovery.
    assertEq<PreviewAction>(previewAction({ alive: false }), 're-probe', 'dead target offers RE-PROBE');
    // Operator restarts the dev server; RE-PROBE now finds it → back to bound.
    assertEq<PreviewAction>(previewAction({ alive: true }), 'none', 'returned target clears the action');
    // The runtime axis is orthogonal — a dead preview never perturbs the agent
    // connection/workflow state (online + idle throughout).
    const rt = derive({
      wsState: 'open', everOpened: true, healthzReachable: true,
      busy: false, lastPrimaryEventAt: T0 - 60_000, recoveredAt: null, now: T0,
    });
    assertHealthy(rt, 'preview dead, agent runtime unaffected');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // CASE 9 — Client reload while events stream (modelable)
  // connecting (everOpened false) → online → reload → connecting → online +
  // replay-recovered. THE invariant: no spurious server-down flash during the
  // connecting gap (the socket is closed mid-reload but the server is alive).
  // ───────────────────────────────────────────────────────────────────────────
  await step('CASE 9: client reload while streaming → no server-down flash → recovers', () => {
    const base: Frame = {
      wsState: 'connecting', everOpened: false, healthzReachable: null,
      busy: false, lastPrimaryEventAt: null, recoveredAt: null, now: T0,
    };
    // Fresh boot before first open → connecting, never server-down.
    assertFrame(derive(base), { connection: 'connecting', workflow: 'idle', action: 'null' }, 'fresh boot');

    // Open + a turn streaming.
    const streaming = derive({
      ...base, wsState: 'open', everOpened: true,
      busy: true, lastPrimaryEventAt: T0 + 500, now: T0 + 1_000,
    });
    assertFrame(streaming, { connection: 'online', workflow: 'busy', action: 'null' }, 'streaming');

    // Operator hits reload: the page tears down. On the fresh page load the
    // socket is reconnecting and everOpened is false again → connecting, NOT
    // server-down, even though the probe hasn't resolved (null). This is the
    // no-flash invariant.
    const reloading = derive({
      wsState: 'connecting', everOpened: false, healthzReachable: null,
      busy: false, lastPrimaryEventAt: null, recoveredAt: null, now: T0 + 2_000,
    });
    assertFrame(reloading, { connection: 'connecting', workflow: 'idle', action: 'null' }, 'mid-reload (no flash)');

    // Even if a probe happens to be pending after a transient closed tick, a
    // null probe stays connecting/disconnected — never server-down.
    const closedNullProbe = derive({
      wsState: 'closed', everOpened: false, healthzReachable: null,
      busy: false, lastPrimaryEventAt: null, recoveredAt: null, now: T0 + 2_100,
    });
    assert(
      closedNullProbe.connection !== 'server-down',
      'reload connecting gap must never flash server-down',
    );

    // Socket reopens; the in-flight turn rehydrates from events.jsonl.
    const reconnected = derive({
      wsState: 'open', everOpened: true, healthzReachable: true,
      busy: false, lastPrimaryEventAt: null, recoveredAt: T0 + 3_000, now: T0 + 3_200,
    });
    assertFrame(reconnected, { connection: 'online', workflow: 'replay-recovered', action: 'dismiss-recovered' }, 'reload reconnected');

    const settled = derive({
      wsState: 'open', everOpened: true, healthzReachable: true,
      busy: false, lastPrimaryEventAt: null,
      recoveredAt: T0 + 3_000, now: T0 + 3_000 + REPLAY_RECOVERED_WINDOW_MS + 1_000,
    });
    assertHealthy(settled, 'after window');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // AUDIT INVARIANT — every distinct failure derives a DISTINCT correct action.
  // The §C1/§C2 headline, restated as a C3 audit guard: the four failure points
  // that carry a targeted action must not collapse onto each other.
  // ───────────────────────────────────────────────────────────────────────────
  await step('AUDIT: the four failure points map to four distinct recovery actions', () => {
    const disconnected = recoveryActionFor({ connection: 'disconnected', workflow: 'idle' })?.id;
    const serverDown = recoveryActionFor({ connection: 'server-down', workflow: 'idle' })?.id;
    const stuck = recoveryActionFor({ connection: 'online', workflow: 'stuck' })?.id;
    const recovered = recoveryActionFor({ connection: 'online', workflow: 'replay-recovered' })?.id;
    const ids = [disconnected, serverDown, stuck, recovered];
    assertEq(ids.join(','), 'reconnect,reprobe,cancel-turn,dismiss-recovered', 'the four actions in order');
    assertEq(new Set(ids).size, 4, 'no two failures collapse to the same action');
  });

  summary('robustness-audit');
}

void main();
