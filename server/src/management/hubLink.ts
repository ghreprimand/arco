// Workflow-reporting layer — the live Arco SERVICE's outbound link to the
// management hub (docs/REMOTE_MANAGEMENT.md §2 workflow layer, §8 K3).
//
// Distinct from the lifecycle agent (scripts/agent): the agent restarts a DEAD
// Arco; this link reports a LIVE Arco's workflow + pending-request state and
// applies routed reply/stop/continue actions. It connects to the hub at
// /instance and registers with role 'service'. One machine thus has two hub
// connections (agent + service), merged into one card by instanceId.
//
// Everything Arco-specific is INJECTED (snapshotWorkflows + applyAction), so
// this module never imports the turn engine and the smoke drives it against a
// real hub with fakes. index.ts wires the real deps (gated on ARCO_HUB_URL).

import { WebSocket } from 'ws';
import type {
  ClusterActionMessage,
  ClusterActionRequest,
  ClusterActionResult,
  ClusterReadKind,
  ClusterReadRequestMessage,
  ClusterReadResponseMessage,
  ClusterSummary,
  InstanceActionMessage,
  InstanceActionRequest,
  InstanceActionResult,
  InstanceRollup,
  ManagedArcoInstance,
  TranscriptRequestMessage,
  TranscriptTurn,
  WorkflowActionMessage,
  WorkflowActionRequest,
  WorkflowActionResult,
  WorkflowSummary,
} from '@arco/shared';

export interface HubLinkOptions {
  hubUrl: string; // ws://<hub>:<port>/instance
  instance: ManagedArcoInstance;
  // Arco-specific seams (injected so this module stays turn-engine-free):
  snapshotWorkflows: () => WorkflowSummary[];
  applyAction: (action: WorkflowActionRequest, actionId: string) => Promise<WorkflowActionResult>;
  // A2 — instance-level actions (remote re-auth). Optional: omit to reject
  // every instance_action as unsupported.
  applyInstanceAction?: (action: InstanceActionRequest, actionId: string) => Promise<InstanceActionResult>;
  // R3 — remote-enabled clusters, pushed alongside the workflow snapshot on
  // the same cadence. Async because mailbox depths are file reads.
  snapshotClusters?: () => Promise<ClusterSummary[]>;
  // R3 — correlated read-only cluster pulls (mailbox peek / board / plan).
  clusterRead?: (
    clusterId: string,
    kind: ClusterReadKind,
  ) => Promise<Pick<ClusterReadResponseMessage, 'ok' | 'error' | 'mailbox' | 'board' | 'plan' | 'activity'>>;
  // R4 — cluster-scoped actions (broadcast / nudge / peer-send / knobs / board).
  applyClusterAction?: (
    clusterId: string,
    action: ClusterActionRequest,
    actionId: string,
  ) => Promise<ClusterActionResult>;
  // Reconstruct a workflow's conversation for the transcript page + R2 chat
  // screen. `sinceTurn` slices for incremental polling; `totalTurns`/`busy`
  // feed the chat screen's resync + running indicator. Optional — omit to
  // disable transcript serving.
  getTranscript?: (
    workflowId: string,
    sinceTurn?: number,
  ) => { title?: string; turns: TranscriptTurn[]; totalTurns?: number; busy?: boolean };
  rollup?: () => InstanceRollup;
  now?: () => number;
  heartbeatMs?: number;
  workflowsPushMs?: number;
  reconnectMs?: number;
  log?: (msg: string) => void;
  socketFactory?: (url: string) => WebSocket;
  // Connection-state callback for the desktop UI indicator (open=true/close=false).
  onStatus?: (connected: boolean) => void;
}

export interface HubLink {
  start(): void;
  stop(): void;
  // Force an immediate workflow-snapshot push to the hub (no-op if the socket
  // isn't open). Used when a per-workflow `remoteEnabled` toggle flips so the
  // VPS console reflects the change at once instead of on the next 4s tick.
  pushNow(): void;
}

const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_WORKFLOWS_PUSH_MS = 4_000;
const DEFAULT_RECONNECT_MS = 5_000;

export function createHubLink(opts: HubLinkOptions): HubLink {
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? (() => {});
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const pushMs = opts.workflowsPushMs ?? DEFAULT_WORKFLOWS_PUSH_MS;
  const reconnectMs = opts.reconnectMs ?? DEFAULT_RECONNECT_MS;
  const makeSocket = opts.socketFactory ?? ((url: string) => new WebSocket(url));
  const instanceId = opts.instance.instanceId;

  let ws: WebSocket | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let pushTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  function clearTimers(): void {
    for (const t of [heartbeatTimer, pushTimer]) if (t) clearInterval(t);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    heartbeatTimer = pushTimer = reconnectTimer = null;
  }

  function send(obj: unknown): void {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  function defaultRollup(): InstanceRollup {
    const wfs = safeSnapshot();
    return {
      health: 'ok',
      activeWorkflows: wfs.filter((w) => w.busy).length,
      waitingRequests: wfs.filter((w) => !w.busy).length,
    };
  }

  function safeSnapshot(): WorkflowSummary[] {
    try {
      return opts.snapshotWorkflows();
    } catch (err) {
      log(`snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  function pushWorkflows(): void {
    send({ type: 'instance_workflows', instanceId, workflows: safeSnapshot() });
    pushClusters();
  }

  // R3 — fire-and-forget async cluster push riding the workflow cadence.
  let clustersPushing = false;
  function pushClusters(): void {
    if (!opts.snapshotClusters || clustersPushing) return;
    clustersPushing = true;
    opts.snapshotClusters()
      .then((clusters) => send({ type: 'instance_clusters', instanceId, clusters }))
      .catch((err) => log(`cluster snapshot failed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => { clustersPushing = false; });
  }

  async function onClusterAction(msg: ClusterActionMessage): Promise<void> {
    let result: ClusterActionResult;
    try {
      result = opts.applyClusterAction
        ? await opts.applyClusterAction(msg.clusterId, msg.action, msg.actionId)
        : { actionId: msg.actionId, clusterId: msg.clusterId, ok: false, error: 'unsupported' };
    } catch (err) {
      result = {
        actionId: msg.actionId,
        clusterId: msg.clusterId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    send({ type: 'cluster_action_result', result: { ...result, actionId: msg.actionId } });
    log(`cluster ${msg.action.type} (${msg.clusterId.slice(0, 8)}) → ${result.ok ? 'ok' : result.error}`);
  }

  async function onClusterRead(msg: ClusterReadRequestMessage): Promise<void> {
    let payload: Pick<ClusterReadResponseMessage, 'ok' | 'error' | 'mailbox' | 'board' | 'plan' | 'activity'>;
    try {
      payload = opts.clusterRead
        ? await opts.clusterRead(msg.clusterId, msg.kind)
        : { ok: false, error: 'unsupported' };
    } catch (err) {
      payload = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    send({
      type: 'cluster_read_response',
      requestId: msg.requestId,
      clusterId: msg.clusterId,
      kind: msg.kind,
      ...payload,
    });
  }

  function sendHeartbeat(): void {
    const rollup = opts.rollup ? opts.rollup() : defaultRollup();
    send({ type: 'instance_heartbeat', instanceId, at: now(), rollup });
  }

  function onTranscriptRequest(msg: TranscriptRequestMessage): void {
    let title: string | undefined;
    let turns: TranscriptTurn[] = [];
    let totalTurns: number | undefined;
    let busy: boolean | undefined;
    try {
      const r = opts.getTranscript?.(msg.workflowId, msg.sinceTurn);
      if (r) {
        title = r.title;
        turns = r.turns;
        totalTurns = r.totalTurns;
        busy = r.busy;
      }
    } catch (err) {
      log(`getTranscript failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    send({
      type: 'transcript_response',
      requestId: msg.requestId,
      workflowId: msg.workflowId,
      ...(title ? { title } : {}),
      turns,
      ...(totalTurns !== undefined ? { totalTurns } : {}),
      ...(busy !== undefined ? { busy } : {}),
    });
  }

  async function onInstanceAction(msg: InstanceActionMessage): Promise<void> {
    let result: InstanceActionResult;
    try {
      result = opts.applyInstanceAction
        ? await opts.applyInstanceAction(msg.action, msg.actionId)
        : { actionId: msg.actionId, ok: false, error: 'unsupported' };
    } catch (err) {
      result = {
        actionId: msg.actionId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    send({ type: 'instance_action_result', result: { ...result, actionId: msg.actionId } });
    log(`instance ${msg.action.type} → ${result.ok ? 'ok' : result.error}`);
  }

  async function onAction(msg: WorkflowActionMessage): Promise<void> {
    let result: WorkflowActionResult;
    try {
      result = await opts.applyAction(msg.action, msg.actionId);
    } catch (err) {
      result = {
        actionId: msg.actionId,
        workflowId: msg.action.workflowId,
        ok: false,
        error: 'failed',
      };
      log(`applyAction threw: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Ensure the actionId round-trips even if applyAction returned a partial.
    send({ type: 'workflow_action_result', result: { ...result, actionId: msg.actionId } });
    log(`workflow ${msg.action.type} (${msg.action.workflowId.slice(0, 8)}) → ${result.ok ? 'ok' : result.error}`);
  }

  function connect(): void {
    if (stopped) return;
    log(`connecting to hub ${opts.hubUrl}`);
    let socket: WebSocket;
    try {
      socket = makeSocket(opts.hubUrl);
    } catch (err) {
      log(`socket create failed: ${err instanceof Error ? err.message : String(err)}`);
      scheduleReconnect();
      return;
    }
    ws = socket;

    socket.on('open', () => {
      log('hub connected — registering (service)');
      opts.onStatus?.(true);
      send({ type: 'instance_register', role: 'service', instance: opts.instance });
      pushWorkflows();
      sendHeartbeat();
      heartbeatTimer = setInterval(sendHeartbeat, heartbeatMs);
      pushTimer = setInterval(pushWorkflows, pushMs);
    });

    socket.on('message', (data: WebSocket.RawData) => {
      let msg: { type?: string };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type === 'workflow_action') void onAction(msg as WorkflowActionMessage);
      else if (msg.type === 'transcript_request') onTranscriptRequest(msg as TranscriptRequestMessage);
      else if (msg.type === 'instance_action') void onInstanceAction(msg as InstanceActionMessage);
      else if (msg.type === 'cluster_read_request') void onClusterRead(msg as ClusterReadRequestMessage);
      else if (msg.type === 'cluster_action') void onClusterAction(msg as ClusterActionMessage);
    });

    socket.on('close', () => {
      log('hub disconnected');
      opts.onStatus?.(false);
      clearTimers();
      scheduleReconnect();
    });
    socket.on('error', (err: Error) => log(`hub socket error: ${err.message}`));
  }

  function scheduleReconnect(): void {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectMs);
  }

  return {
    start(): void {
      stopped = false;
      connect();
    },
    stop(): void {
      stopped = true;
      clearTimers();
      if (ws) {
        try {
          ws.close();
        } catch {
          /* best-effort */
        }
        ws = null;
      }
    },
    pushNow(): void {
      pushWorkflows();
    },
  };
}
