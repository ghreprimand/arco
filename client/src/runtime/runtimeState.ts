// Observable runtime-state deriver (ARCO_OPS_PLAN.md §C1).
//
// Why pure: this module is the single source of truth for the operator-visible
// connection / workflow states, and the C1 acceptance ("killing the server vs
// killing a provider worker show different, correct states") is proven at the
// deriver level by a headless smoke. To stay testable from a node script with
// no DOM, no clock, and no store, the functions here take everything as plain
// arguments — in particular `now` is ALWAYS injected, never read from
// `Date.now()` inside. Keep it that way: the moment a clock read sneaks in, the
// smoke stops being deterministic and the invariant rots.

// Two orthogonal axes. The connection layer dominates the display — when the
// socket isn't open, the per-workflow state is not meaningful (see
// deriveWorkflowState), so the header's connection badge is what the operator
// reads first.

export type ConnectionState =
  // (a is split across the next two) WS has never opened yet — initial boot.
  | 'connecting'
  // WS OPEN — talking to Arco.
  | 'online'
  // (a) WS closed BUT /healthz reachable → a browser/network/WS-layer drop;
  // the Arco server process is alive and will accept a reconnect.
  | 'disconnected'
  // (b) WS closed AND /healthz unreachable → the Arco server process itself
  // is gone/unresponsive; RESTART/RECONNECT won't help until it's back.
  | 'server-down';

export type WorkflowRuntimeState =
  // (e) busy === false, outside the replay-recovered window → operator's turn.
  | 'idle'
  // (c) busy === true with primary content emitted recently → actively working.
  | 'busy'
  // (d) busy === true but no primary content for ≥ STUCK_THRESHOLD_MS while
  // online → the worker may be hung / not emitting.
  | 'stuck'
  // (f) just rehydrated from disk/replay, within REPLAY_RECOVERED_WINDOW_MS →
  // a transient "context came back from the event log" badge.
  | 'replay-recovered';

// How long a busy workflow can emit nothing before we call it stuck. Tuned
// high enough to clear a long-but-live tool call (big build, slow test run)
// yet low enough that a genuinely hung worker surfaces within a turn the
// operator would still be watching. 30s is the same order as the auto-handoff
// warn cadence — comfortable headroom over normal streaming gaps.
export const STUCK_THRESHOLD_MS = 30_000;

// How long the replay-recovered badge lingers after a rehydrate. Long enough
// for the operator to notice "this tab came back from disk", short enough that
// it doesn't shadow the idle state once they've re-engaged. First operator
// interaction clears recoveredAt upstream, so this is just the upper bound.
export const REPLAY_RECOVERED_WINDOW_MS = 12_000;

// AbortSignal.timeout budget for the /healthz probe fired on WS close. Kept
// short: a slow probe would stall the disconnected→server-down transition and
// leave the operator staring at an optimistic "disconnected" while the server
// is actually dead. 2s clears a healthy localhost round-trip with margin.
export const HEALTHZ_PROBE_TIMEOUT_MS = 2_000;

// `healthzReachable === null` means "not yet probed". A closed socket with a
// null probe is treated as `disconnected` (optimistic — assume the server is
// alive and we just dropped) until the probe resolves; only an explicit
// `false` escalates to `server-down`. This avoids a spurious SERVER DOWN flash
// in the gap between the socket closing and the first probe completing.
export function deriveConnectionState(input: {
  wsState: 'connecting' | 'open' | 'closed';
  everOpened: boolean;
  healthzReachable: boolean | null;
}): ConnectionState {
  if (input.wsState === 'open') return 'online';
  if (input.wsState === 'connecting' && !input.everOpened) return 'connecting';
  // Socket is closed (or reconnecting after a prior open). The probe decides.
  if (input.healthzReachable === false) return 'server-down';
  return 'disconnected';
}

export function deriveWorkflowState(input: {
  connection: ConnectionState;
  busy: boolean;
  lastPrimaryEventAt: number | null;
  recoveredAt: number | null;
  now: number;
}): WorkflowRuntimeState {
  // Connection layer dominates: when we're not online the per-workflow state
  // is unknowable (no live telemetry), so collapse to idle and let the header's
  // connection badge carry the failure.
  if (input.connection !== 'online') return 'idle';

  // busy/stuck take precedence over replay-recovered: a recovered workflow that
  // immediately picks up a turn should read as working, not as "just recovered".
  if (input.busy) {
    const last = input.lastPrimaryEventAt;
    // No primary content at all yet this turn → only call it stuck once the
    // turn itself is old enough; without a lastPrimaryEventAt we fall back to
    // recoveredAt as the turn-age anchor, else treat as freshly-busy.
    const anchor = last ?? input.recoveredAt ?? input.now;
    return input.now - anchor >= STUCK_THRESHOLD_MS ? 'stuck' : 'busy';
  }

  // Not busy: replay-recovered wins over idle while inside the window.
  if (input.recoveredAt !== null && input.now - input.recoveredAt < REPLAY_RECOVERED_WINDOW_MS) {
    return 'replay-recovered';
  }
  return 'idle';
}

// ARCO_OPS_PLAN.md §C2 — targeted retry paths per state.
//
// C1 made each failure observable; C2 maps each observable state to its ONE
// correct recovery action instead of a generic "retry". The honest mapping
// matters because the wrong action is worse than none: a server-down can't be
// helped by a WS RECONNECT or an /api/restart (the process that would serve
// either is gone), and a hung provider can't be poked awake — the only honest
// recovery is to cancel the dead turn and re-send. Kept pure (no clock, no DOM,
// no store) for the same reason as the derivers: the §C2 acceptance contrast
// (killed-server vs silent-worker yield DIFFERENT actions) is proven headlessly.
export type RecoveryActionId =
  | 'reconnect'         // disconnected — force a WS reconnect (server is reachable).
  | 'reprobe'           // server-down — re-check /healthz; RESTART can't be delivered yet.
  | 'cancel-turn'       // stuck — cancel the hung turn so the operator can re-send.
  | 'dismiss-recovered'; // replay-recovered — acknowledge the informational notice.

export interface RecoveryAction {
  id: RecoveryActionId;
  label: string;
  hint: string;
}

// Connection layer dominates (same precedence as deriveWorkflowState): a down
// connection's action is the right one regardless of the per-workflow state,
// which is unknowable while offline anyway. Returns null for idle/busy/online —
// normal chrome (composer spinner, idle state) already covers those; a targeted
// recovery button would be redundant noise.
export function recoveryActionFor(input: {
  connection: ConnectionState;
  workflow: WorkflowRuntimeState;
}): RecoveryAction | null {
  if (input.connection === 'disconnected') {
    return {
      id: 'reconnect',
      label: 'RECONNECT',
      hint: 'Force a WebSocket reconnect now (server is reachable).',
    };
  }
  if (input.connection === 'server-down') {
    return {
      id: 'reprobe',
      label: 'RE-PROBE',
      hint: "Re-check /healthz — the server process looked unreachable. RESTART can't help until it answers.",
    };
  }
  // connecting / online → the workflow state decides.
  if (input.workflow === 'stuck') {
    return {
      id: 'cancel-turn',
      label: 'CANCEL TURN',
      hint: 'No output for a while — cancel the hung turn, then re-send your prompt.',
    };
  }
  if (input.workflow === 'replay-recovered') {
    return {
      id: 'dismiss-recovered',
      label: 'DISMISS',
      hint: 'Acknowledge the replay-recovered notice.',
    };
  }
  return null;
}

// Short human label per state. UI strings that need richer markup / tooltips
// live in the component; these are the terse fallbacks the smoke can assert on.
export function runtimeStateLabel(state: ConnectionState | WorkflowRuntimeState): string {
  switch (state) {
    case 'connecting': return 'CONNECTING…';
    case 'online': return 'ONLINE';
    case 'disconnected': return 'OFFLINE';
    case 'server-down': return 'SERVER DOWN';
    case 'idle': return 'IDLE';
    case 'busy': return 'BUSY';
    case 'stuck': return 'STUCK';
    case 'replay-recovered': return 'RECOVERED';
  }
}
