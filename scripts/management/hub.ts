// arco-management §2/§5/§6 — the hub core.
//
// One tailnet-only service that:
//   - accepts OUTBOUND WS connections from Arco instances / arco-agents at
//     path /agent (instance_register, instance_heartbeat, lifecycle_result),
//   - keeps an InstanceRegistry with online/stale/offline derivation,
//   - SIGNS lifecycle commands with the hub Ed25519 private key and routes them
//     to the owning agent's socket, correlating the reply by nonce,
//   - forwards workflow-scoped actions to the owning instance (the instance
//     re-validates — the hub is a router, never an authority on validity).
//
// The hub holds the PRIVATE key; agents only ever have hub.pub. Everything I/O
// is injectable (clock, http/ws servers via node) so the smoke wires a REAL K1
// agent to a REAL hub in-process. Bind host defaults to loopback for tests; the
// deployed hub binds the tailnet interface only (never 0.0.0.0, never Funnel).

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { WebSocketServer, type WebSocket } from 'ws';
import { signCommand, newNonce } from '../agent/signing.js';
import { renderSshLifecycle, type SshTarget } from './sshLifecycle.js';
import type { CommandSpec } from '../agent/allowlist.js';
import { InstanceRegistry, type RegistrySnapshotEntry } from './registry.js';
import { consoleHtml, consoleCss, consoleJs, transcriptHtml, chatHtml, consoleManifest, consoleIconSvg } from './console.js';
import {
  deleteCloudSnapshot,
  listCloudSnapshots,
  MAX_VAULT_BLOB_BYTES,
  readCloudSnapshot,
  saveCloudSnapshot,
  type CloudClusterSnapshot,
} from './clusterVault.js';
import type {
  ClusterActionRequest,
  ClusterActionResult,
  ClusterReadKind,
  ClusterReadResponseMessage,
  ClusterSummary,
  InstanceActionRequest,
  InstanceActionResult,
  LifecycleCommand,
  LifecycleResult,
  TranscriptResponseMessage,
  WorkflowActionRequest,
  WorkflowActionResult,
} from '../../shared/src/protocol/remoteManagement.js';

export interface HubOptions {
  privateKeyPem: string;
  host?: string; // default '127.0.0.1' (tests); deploy passes the tailnet IP
  port?: number; // default 3500
  now?: () => number;
  heartbeatIntervalMs?: number;
  commandTimeoutMs?: number; // wait for lifecycle_result (default 30s)
  log?: (msg: string) => void;
  // K4 — Tailscale-SSH last-resort targets, keyed by instanceId OR friendly
  // name. When the agent socket is down (instance-offline) but a target exists,
  // a lifecycle command is run over SSH instead. Absent → no SSH fallback.
  sshTargets?: Record<string, SshTarget>;
  // Injectable for the smoke; defaults to spawning `ssh` via child_process.
  sshExec?: SshExec;
}

export type SshExec = (spec: CommandSpec) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export interface LifecycleDispatch {
  ok: boolean;
  result?: LifecycleResult;
  error?: 'no-such-instance' | 'instance-offline' | 'timeout' | 'ssh-failed';
  // How the command reached the host. 'ssh' = the K4 last-resort path (agent
  // was down). Absent on a pure error before either path ran.
  via?: 'agent' | 'ssh';
}

// Default SSH runner: spawn the rendered `ssh …` argv, capture bounded output.
function defaultSshExec(spec: CommandSpec): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(spec.cmd, spec.args, { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (e) => resolve({ exitCode: -1, stdout, stderr: `${stderr}${String(e)}`.slice(0, 8000) }));
    child.on('close', (code) => resolve({ exitCode: code ?? -1, stdout: stdout.slice(0, 8000), stderr: stderr.slice(0, 8000) }));
  });
}

export interface Hub {
  listen(): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
  registry: InstanceRegistry;
  snapshot(): RegistrySnapshotEntry[];
  sendLifecycleCommand(instanceId: string, cmd: LifecycleCommand): Promise<LifecycleDispatch>;
  routeWorkflowAction(instanceId: string, action: WorkflowActionRequest): Promise<WorkflowActionResult>;
  routeInstanceAction(instanceId: string, action: InstanceActionRequest): Promise<InstanceActionResult>;
  requestClusterRead(instanceId: string, clusterId: string, kind: ClusterReadKind): Promise<ClusterReadResponseMessage | null>;
  routeClusterAction(instanceId: string, clusterId: string, action: ClusterActionRequest): Promise<ClusterActionResult>;
  requestTranscript(instanceId: string, workflowId: string, sinceTurn?: number): Promise<TranscriptResponseMessage | null>;
}

const DEFAULT_PORT = 3500;
const DEFAULT_TIMEOUT_MS = 30_000;

export function createHub(opts: HubOptions): Hub {
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? (() => {});
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? DEFAULT_PORT;
  const commandTimeoutMs = opts.commandTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sshTargets = opts.sshTargets ?? {};
  const sshExec = opts.sshExec ?? defaultSshExec;
  const registry = new InstanceRegistry(
    opts.heartbeatIntervalMs !== undefined ? { heartbeatIntervalMs: opts.heartbeatIntervalMs } : {},
  );

  // One machine has up to two connections: the lifecycle agent (/agent) and the
  // live Arco service (/instance, workflow layer). Tracked separately, both
  // keyed by instanceId, merged into one registry card.
  const agentSockets = new Map<string, WebSocket>();
  const serviceSockets = new Map<string, WebSocket>();
  // nonce → resolver for an in-flight lifecycle command.
  const pending = new Map<string, (r: LifecycleResult) => void>();
  // actionId → resolver for an in-flight workflow action.
  const pendingActions = new Map<string, (r: WorkflowActionResult) => void>();
  // requestId → resolver for an in-flight transcript request.
  const pendingTranscripts = new Map<string, (r: TranscriptResponseMessage) => void>();
  // A2 — actionId → resolver for an in-flight instance action (remote re-auth).
  const pendingInstanceActions = new Map<string, (r: InstanceActionResult) => void>();
  // R3 — requestId → resolver for an in-flight cluster read.
  const pendingClusterReads = new Map<string, (r: ClusterReadResponseMessage) => void>();
  // R4 — actionId → resolver for an in-flight cluster action.
  const pendingClusterActions = new Map<string, (r: ClusterActionResult) => void>();

  const httpServer = createServer((req, res) => handleHttp(req, res));
  // Accept WS upgrades on any path (conventionally /agent for the lifecycle
  // agent, /instance for the live Arco service) — the `role` on register
  // disambiguates, so the path is cosmetic. HTTP control routes are separate
  // (non-upgrade requests handled by handleHttp).
  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (socket) => {
    let boundInstanceId: string | null = null;
    let boundRole: 'agent' | 'service' = 'agent';

    socket.on('message', (data) => {
      let msg: { type?: string; [k: string]: unknown };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      switch (msg.type) {
        case 'instance_register': {
          const m = msg as { role?: 'agent' | 'service'; instance: Parameters<InstanceRegistry['register']>[0] };
          const instance = m.instance;
          if (!instance?.instanceId) return;
          boundInstanceId = instance.instanceId;
          boundRole = m.role === 'service' ? 'service' : 'agent';
          registry.register(instance, now());
          (boundRole === 'service' ? serviceSockets : agentSockets).set(instance.instanceId, socket);
          log(`registered ${instance.name} (${instance.instanceId}) as ${boundRole}`);
          break;
        }
        case 'instance_heartbeat': {
          const { instanceId, rollup } = msg as {
            instanceId: string;
            rollup?: Parameters<InstanceRegistry['heartbeat']>[2];
          };
          registry.heartbeat(instanceId, now(), rollup);
          break;
        }
        case 'instance_workflows': {
          const { instanceId, workflows } = msg as {
            instanceId: string;
            workflows: Parameters<InstanceRegistry['setWorkflows']>[1];
          };
          registry.setWorkflows(instanceId, workflows ?? [], now());
          break;
        }
        case 'instance_clusters': {
          const { instanceId, clusters } = msg as { instanceId: string; clusters: ClusterSummary[] };
          registry.setClusters(instanceId, clusters ?? [], now());
          break;
        }
        case 'lifecycle_result': {
          const result = (msg as { result: LifecycleResult }).result;
          const resolve = result?.nonce ? pending.get(result.nonce) : undefined;
          if (resolve) {
            pending.delete(result.nonce);
            resolve(result);
          }
          break;
        }
        case 'workflow_action_result': {
          const result = (msg as { result: WorkflowActionResult }).result;
          const resolve = result?.actionId ? pendingActions.get(result.actionId) : undefined;
          if (resolve) {
            pendingActions.delete(result.actionId);
            resolve(result);
          }
          break;
        }
        case 'cluster_action_result': {
          const result = (msg as { result: ClusterActionResult }).result;
          const resolve = result?.actionId ? pendingClusterActions.get(result.actionId) : undefined;
          if (resolve) {
            pendingClusterActions.delete(result.actionId);
            resolve(result);
          }
          break;
        }
        case 'cluster_read_response': {
          const m = msg as unknown as ClusterReadResponseMessage;
          const resolve = m?.requestId ? pendingClusterReads.get(m.requestId) : undefined;
          if (resolve) {
            pendingClusterReads.delete(m.requestId);
            resolve(m);
          }
          break;
        }
        case 'instance_action_result': {
          const result = (msg as { result: InstanceActionResult }).result;
          const resolve = result?.actionId ? pendingInstanceActions.get(result.actionId) : undefined;
          if (resolve) {
            pendingInstanceActions.delete(result.actionId);
            resolve(result);
          }
          break;
        }
        case 'transcript_response': {
          const m = msg as unknown as TranscriptResponseMessage;
          const resolve = m?.requestId ? pendingTranscripts.get(m.requestId) : undefined;
          if (resolve) {
            pendingTranscripts.delete(m.requestId);
            resolve(m);
          }
          break;
        }
        default:
          break;
      }
    });

    socket.on('close', () => {
      // Drop the socket mapping but KEEP the registry entry (offline shows
      // last-seen). Only clear if this socket is still the bound one.
      if (!boundInstanceId) return;
      const map = boundRole === 'service' ? serviceSockets : agentSockets;
      if (map.get(boundInstanceId) === socket) {
        map.delete(boundInstanceId);
        log(`${boundRole} socket closed for ${boundInstanceId}`);
      }
    });
  });

  function instanceOnline(instanceId: string): boolean {
    const e = registry.get(instanceId);
    return !!e && registry.deriveState(e.lastHeartbeatAt, now()) !== 'offline';
  }

  // K4 — resolve an SSH target for an instance by id, then by friendly name.
  function sshTargetFor(instanceId: string): SshTarget | undefined {
    if (sshTargets[instanceId]) return sshTargets[instanceId];
    const name = registry.get(instanceId)?.instance.name;
    return name ? sshTargets[name] : undefined;
  }

  // K4 — run a lifecycle command over Tailscale SSH (the agent socket is down).
  // NOT Ed25519-signed: the tailnet + ACLs are the auth here, and the rendered
  // command is always an allowlist template (renderSshLifecycle returns null for
  // anything off-platform / off-allowlist).
  async function sshLifecycleFallback(
    instanceId: string,
    cmd: LifecycleCommand,
    target: SshTarget,
  ): Promise<LifecycleDispatch> {
    const spec = renderSshLifecycle(target, cmd);
    if (!spec) {
      return { ok: false, error: 'instance-offline', via: 'ssh' }; // unsupported on the target platform
    }
    log(`⤳ ${instanceId}: ${cmd} via ssh ${target.host} (agent offline)`);
    const r = await sshExec(spec);
    const result: LifecycleResult = {
      cmd,
      instanceId,
      nonce: 'ssh', // no signed nonce on the SSH path
      ok: r.exitCode === 0,
      executed: true,
      exitCode: r.exitCode,
      stdout: r.stdout,
      stderr: r.stderr,
    };
    return { ok: result.ok, result, via: 'ssh', ...(result.ok ? {} : { error: 'ssh-failed' as const }) };
  }

  async function sendLifecycleCommand(
    instanceId: string,
    cmd: LifecycleCommand,
  ): Promise<LifecycleDispatch> {
    const socket = agentSockets.get(instanceId);
    if (!registry.has(instanceId)) {
      return { ok: false, error: 'no-such-instance' };
    }
    if (!socket || socket.readyState !== socket.OPEN || !instanceOnline(instanceId)) {
      // Agent channel is down. Last resort: Tailscale SSH, if configured.
      const target = sshTargetFor(instanceId);
      if (target) return sshLifecycleFallback(instanceId, cmd, target);
      return { ok: false, error: 'instance-offline' };
    }
    const nonce = newNonce();
    const signed = signCommand(opts.privateKeyPem, {
      cmd,
      instanceId,
      nonce,
      issuedAt: now(),
    });
    log(`→ ${instanceId}: ${cmd} (nonce ${nonce.slice(0, 8)})`);
    return new Promise<LifecycleDispatch>((resolve) => {
      const timer = setTimeout(() => {
        if (pending.has(nonce)) {
          pending.delete(nonce);
          resolve({ ok: false, error: 'timeout' });
        }
      }, commandTimeoutMs);
      pending.set(nonce, (result) => {
        clearTimeout(timer);
        resolve({ ok: result.ok, result });
      });
      socket.send(JSON.stringify({ type: 'lifecycle_command', signed }));
    });
  }

  // Workflow-layer routing: forward an action to the owning live Arco SERVICE.
  // The service re-validates against its CURRENT workflow state before applying
  // (the hub is a router, never an authority on validity). Correlated by
  // actionId with a timeout, like lifecycle commands.
  function routeWorkflowAction(
    instanceId: string,
    action: WorkflowActionRequest,
  ): Promise<WorkflowActionResult> {
    const socket = serviceSockets.get(instanceId);
    if (!socket || socket.readyState !== socket.OPEN) {
      return Promise.resolve({
        actionId: '',
        workflowId: action.workflowId,
        ok: false,
        error: 'unsupported',
      });
    }
    const actionId = newNonce();
    log(`→ ${instanceId}: workflow ${action.type} (wf ${action.workflowId.slice(0, 8)})`);
    return new Promise<WorkflowActionResult>((resolve) => {
      const timer = setTimeout(() => {
        if (pendingActions.has(actionId)) {
          pendingActions.delete(actionId);
          resolve({ actionId, workflowId: action.workflowId, ok: false, error: 'failed' });
        }
      }, commandTimeoutMs);
      pendingActions.set(actionId, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      socket.send(JSON.stringify({ type: 'workflow_action', actionId, action }));
    });
  }

  // A2 — forward an instance-level action (remote re-auth) to the owning live
  // service. Correlated by actionId with a timeout, like workflow actions.
  function routeInstanceAction(
    instanceId: string,
    action: InstanceActionRequest,
  ): Promise<InstanceActionResult> {
    const socket = serviceSockets.get(instanceId);
    if (!socket || socket.readyState !== socket.OPEN) {
      return Promise.resolve({ actionId: '', ok: false, error: 'instance-offline' });
    }
    const actionId = newNonce();
    log(`→ ${instanceId}: instance ${action.type}`);
    return new Promise<InstanceActionResult>((resolve) => {
      const timer = setTimeout(() => {
        if (pendingInstanceActions.has(actionId)) {
          pendingInstanceActions.delete(actionId);
          resolve({ actionId, ok: false, error: 'timeout' });
        }
      }, commandTimeoutMs);
      pendingInstanceActions.set(actionId, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      socket.send(JSON.stringify({ type: 'instance_action', actionId, action }));
    });
  }

  // R4 — forward a cluster-scoped action to the owning live service (which
  // re-validates the cluster's remote switch + membership before applying).
  function routeClusterAction(
    instanceId: string,
    clusterId: string,
    action: ClusterActionRequest,
  ): Promise<ClusterActionResult> {
    const socket = serviceSockets.get(instanceId);
    if (!socket || socket.readyState !== socket.OPEN) {
      return Promise.resolve({ actionId: '', clusterId, ok: false, error: 'instance-offline' });
    }
    const actionId = newNonce();
    log(`→ ${instanceId}: cluster ${action.type} (${clusterId.slice(0, 8)})`);
    return new Promise<ClusterActionResult>((resolve) => {
      const timer = setTimeout(() => {
        if (pendingClusterActions.has(actionId)) {
          pendingClusterActions.delete(actionId);
          resolve({ actionId, clusterId, ok: false, error: 'timeout' });
        }
      }, commandTimeoutMs);
      pendingClusterActions.set(actionId, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      socket.send(JSON.stringify({ type: 'cluster_action', actionId, clusterId, action }));
    });
  }

  // R3 — correlated read-only cluster pull (mailbox / board / plan).
  function requestClusterRead(
    instanceId: string,
    clusterId: string,
    kind: ClusterReadKind,
  ): Promise<ClusterReadResponseMessage | null> {
    const socket = serviceSockets.get(instanceId);
    if (!socket || socket.readyState !== socket.OPEN) return Promise.resolve(null);
    const requestId = newNonce();
    return new Promise<ClusterReadResponseMessage | null>((resolve) => {
      const timer = setTimeout(() => {
        if (pendingClusterReads.has(requestId)) {
          pendingClusterReads.delete(requestId);
          resolve(null);
        }
      }, commandTimeoutMs);
      pendingClusterReads.set(requestId, (resp) => {
        clearTimeout(timer);
        resolve(resp);
      });
      socket.send(JSON.stringify({ type: 'cluster_read_request', requestId, clusterId, kind }));
    });
  }

  // Ask the owning service for a workflow's transcript, correlated by
  // requestId with a timeout. The service reconstructs it from events.jsonl.
  // R2 — sinceTurn slices for the chat screen's incremental poll.
  function requestTranscript(
    instanceId: string,
    workflowId: string,
    sinceTurn?: number,
  ): Promise<TranscriptResponseMessage | null> {
    const socket = serviceSockets.get(instanceId);
    if (!socket || socket.readyState !== socket.OPEN) return Promise.resolve(null);
    const requestId = newNonce();
    return new Promise<TranscriptResponseMessage | null>((resolve) => {
      const timer = setTimeout(() => {
        if (pendingTranscripts.has(requestId)) {
          pendingTranscripts.delete(requestId);
          resolve(null);
        }
      }, commandTimeoutMs);
      pendingTranscripts.set(requestId, (resp) => {
        clearTimeout(timer);
        resolve(resp);
      });
      socket.send(JSON.stringify({
        type: 'transcript_request',
        requestId,
        workflowId,
        ...(typeof sinceTurn === 'number' ? { sinceTurn } : {}),
      }));
    });
  }

  // ── thin tailnet HTTP control API (the K3 console consumes this) ──
  function handleHttp(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'hub'}`);
    const sendJson = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const sendText = (code: number, type: string, body: string) => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-cache' });
      res.end(body);
    };

    // ── server-rendered console (K3) ──
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      sendText(200, 'text/html; charset=utf-8', consoleHtml());
      return;
    }
    if (req.method === 'GET' && url.pathname === '/console.css') {
      sendText(200, 'text/css; charset=utf-8', consoleCss());
      return;
    }
    if (req.method === 'GET' && url.pathname === '/console.js') {
      sendText(200, 'application/javascript; charset=utf-8', consoleJs());
      return;
    }
    if (req.method === 'GET' && url.pathname === '/manifest.webmanifest') {
      sendText(200, 'application/manifest+json; charset=utf-8', consoleManifest());
      return;
    }
    if (req.method === 'GET' && url.pathname === '/icon.svg') {
      sendText(200, 'image/svg+xml; charset=utf-8', consoleIconSvg());
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/instances') {
      sendJson(200, { instances: snapshot() });
      return;
    }

    // Manual encrypted cluster vault. Tailnet-only like the rest of the hub;
    // blobs are AES-GCM envelopes produced locally, and the hub never has the
    // key. Kept outside instance routing so either workstation can list/fetch.
    if (req.method === 'GET' && url.pathname === '/api/cluster-vault') {
      listCloudSnapshots()
        .then((snapshots) => sendJson(200, { snapshots }))
        .catch(() => sendJson(500, { error: 'vault list failed' }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/cluster-vault') {
      const encoded = req.headers['x-arco-vault-meta'];
      const replaceId = req.headers['x-arco-vault-replace-id'];
      let metadata: Omit<CloudClusterSnapshot, 'id' | 'uploadedAt'>;
      try {
        if (typeof encoded !== 'string') throw new Error('missing metadata');
        if (replaceId !== undefined && typeof replaceId !== 'string') throw new Error('invalid replacement id');
        metadata = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as typeof metadata;
      } catch {
        sendJson(400, { error: 'invalid vault metadata' });
        return;
      }
      readBinaryBody(req, MAX_VAULT_BLOB_BYTES)
        .then((bytes) => saveCloudSnapshot(metadata, bytes, typeof replaceId === 'string' ? replaceId : undefined))
        .then((snapshot) => sendJson(201, { snapshot }))
        .catch((err) => sendJson(400, { error: err instanceof Error ? err.message : 'vault upload failed' }));
      return;
    }
    const vaultMatch = url.pathname.match(/^\/api\/cluster-vault\/([^/]+)$/);
    if (vaultMatch && req.method === 'GET') {
      readCloudSnapshot(decodeURIComponent(vaultMatch[1]))
        .then((bytes) => {
          if (!bytes) return sendJson(404, { error: 'snapshot not found' });
          res.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-length': String(bytes.length),
            'cache-control': 'no-store',
          });
          res.end(bytes);
        })
        .catch(() => sendJson(500, { error: 'vault read failed' }));
      return;
    }
    if (vaultMatch && req.method === 'DELETE') {
      deleteCloudSnapshot(decodeURIComponent(vaultMatch[1]))
        .then((removed) => sendJson(removed ? 200 : 404, removed ? { ok: true } : { error: 'snapshot not found' }))
        .catch(() => sendJson(500, { error: 'vault delete failed' }));
      return;
    }
    // POST /api/instances/:id/lifecycle  { cmd }
    const lifecycleMatch = url.pathname.match(/^\/api\/instances\/([^/]+)\/lifecycle$/);
    if (req.method === 'POST' && lifecycleMatch) {
      const instanceId = decodeURIComponent(lifecycleMatch[1]);
      readBody(req)
        .then((body) => {
          const cmd = (body as { cmd?: LifecycleCommand }).cmd;
          if (!cmd) return sendJson(400, { error: 'missing cmd' });
          return sendLifecycleCommand(instanceId, cmd).then((d) =>
            sendJson(d.ok ? 200 : 502, d),
          );
        })
        .catch(() => sendJson(400, { error: 'bad request' }));
      return;
    }
    // R4 — POST /api/instances/:id/clusters/:cid/action  { action }
    const clusterActionMatch = url.pathname.match(
      /^\/api\/instances\/([^/]+)\/clusters\/([^/]+)\/action$/,
    );
    if (req.method === 'POST' && clusterActionMatch) {
      const instanceId = decodeURIComponent(clusterActionMatch[1]);
      const clusterId = decodeURIComponent(clusterActionMatch[2]);
      readBody(req)
        .then((body) => {
          const action = (body as { action?: ClusterActionRequest }).action;
          if (!action || !action.type) return sendJson(400, { error: 'missing action {type}' });
          return routeClusterAction(instanceId, clusterId, action).then((r) =>
            sendJson(r.ok ? 200 : 502, r),
          );
        })
        .catch(() => sendJson(400, { error: 'bad request' }));
      return;
    }
    // R3 — GET /api/instances/:id/clusters/:cid/read?kind=mailbox|board|plan
    const clusterReadMatch = url.pathname.match(
      /^\/api\/instances\/([^/]+)\/clusters\/([^/]+)\/read$/,
    );
    if (req.method === 'GET' && clusterReadMatch) {
      const instanceId = decodeURIComponent(clusterReadMatch[1]);
      const clusterId = decodeURIComponent(clusterReadMatch[2]);
      const kind = url.searchParams.get('kind') as ClusterReadKind | null;
      if (kind !== 'mailbox' && kind !== 'board' && kind !== 'plan' && kind !== 'activity') {
        sendJson(400, { error: 'kind must be mailbox|board|plan|activity' });
        return;
      }
      requestClusterRead(instanceId, clusterId, kind)
        .then((resp) => {
          if (!resp) { sendJson(503, { error: 'instance unreachable' }); return; }
          sendJson(resp.ok ? 200 : 502, resp);
        })
        .catch(() => sendJson(500, { error: 'cluster read failed' }));
      return;
    }
    // A2 — POST /api/instances/:id/instance-action  { action } (remote re-auth)
    const instActionMatch = url.pathname.match(/^\/api\/instances\/([^/]+)\/instance-action$/);
    if (req.method === 'POST' && instActionMatch) {
      const instanceId = decodeURIComponent(instActionMatch[1]);
      readBody(req)
        .then((body) => {
          const action = (body as { action?: InstanceActionRequest }).action;
          if (!action || !action.type) return sendJson(400, { error: 'missing action {type}' });
          return routeInstanceAction(instanceId, action).then((r) =>
            sendJson(r.ok ? 200 : 502, r),
          );
        })
        .catch(() => sendJson(400, { error: 'bad request' }));
      return;
    }
    // POST /api/instances/:id/workflow-action  { action }
    const wfActionMatch = url.pathname.match(/^\/api\/instances\/([^/]+)\/workflow-action$/);
    if (req.method === 'POST' && wfActionMatch) {
      const instanceId = decodeURIComponent(wfActionMatch[1]);
      readBody(req)
        .then((body) => {
          const action = (body as { action?: WorkflowActionRequest }).action;
          if (!action || !action.type || !action.workflowId) {
            return sendJson(400, { error: 'missing action {type, workflowId}' });
          }
          return routeWorkflowAction(instanceId, action).then((r) =>
            sendJson(r.ok ? 200 : 502, r),
          );
        })
        .catch(() => sendJson(400, { error: 'bad request' }));
      return;
    }
    // R2 — GET /api/instances/:id/workflows/:wfid/convo?since=N — JSON turns
    // for the interactive chat screen's poll loop.
    const convoMatch = url.pathname.match(
      /^\/api\/instances\/([^/]+)\/workflows\/([^/]+)\/convo$/,
    );
    if (req.method === 'GET' && convoMatch) {
      const instanceId = decodeURIComponent(convoMatch[1]);
      const workflowId = decodeURIComponent(convoMatch[2]);
      const sinceRaw = url.searchParams.get('since');
      const since = sinceRaw !== null ? Number(sinceRaw) : undefined;
      requestTranscript(instanceId, workflowId, Number.isFinite(since) ? since : undefined)
        .then((resp) => {
          if (!resp) {
            sendJson(503, { error: 'instance unreachable' });
            return;
          }
          sendJson(200, {
            title: resp.title,
            turns: resp.turns,
            totalTurns: resp.totalTurns ?? resp.turns.length,
            busy: resp.busy === true,
          });
        })
        .catch(() => sendJson(500, { error: 'transcript failed' }));
      return;
    }
    // R2 — GET /api/instances/:id/workflows/:wfid/chat — the interactive
    // conversation screen (transcript + composer + incremental poll).
    const chatMatch = url.pathname.match(
      /^\/api\/instances\/([^/]+)\/workflows\/([^/]+)\/chat$/,
    );
    if (req.method === 'GET' && chatMatch) {
      const instanceId = decodeURIComponent(chatMatch[1]);
      const workflowId = decodeURIComponent(chatMatch[2]);
      const entry = registry.get(instanceId);
      const title = entry?.workflows?.find((w) => w.workflowId === workflowId)?.title ?? workflowId;
      sendText(200, 'text/html; charset=utf-8', chatHtml(instanceId, workflowId, title));
      return;
    }
    // GET /api/instances/:id/workflows/:wfid/transcript — full conversation in
    // a standalone read-only page (opened in a new tab by the console).
    const transcriptMatch = url.pathname.match(
      /^\/api\/instances\/([^/]+)\/workflows\/([^/]+)\/transcript$/,
    );
    if (req.method === 'GET' && transcriptMatch) {
      const instanceId = decodeURIComponent(transcriptMatch[1]);
      const workflowId = decodeURIComponent(transcriptMatch[2]);
      const entry = registry.get(instanceId);
      const title = entry?.workflows?.find((w) => w.workflowId === workflowId)?.title;
      requestTranscript(instanceId, workflowId)
        .then((resp) => {
          if (!resp) {
            sendText(503, 'text/html; charset=utf-8', transcriptHtml(title ?? workflowId, [], true));
            return;
          }
          sendText(200, 'text/html; charset=utf-8', transcriptHtml(resp.title ?? title ?? workflowId, resp.turns));
        })
        .catch(() => sendText(500, 'text/html; charset=utf-8', transcriptHtml(workflowId, [], true)));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/healthz') {
      sendJson(200, { ok: true, instances: registry.size() });
      return;
    }
    sendJson(404, { error: 'not found' });
  }

  function snapshot(): RegistrySnapshotEntry[] {
    return registry.snapshot(now());
  }

  return {
    listen(): Promise<{ host: string; port: number }> {
      return new Promise((resolve) => {
        httpServer.listen(port, host, () => {
          const addr = httpServer.address();
          const actual = typeof addr === 'object' && addr ? addr.port : port;
          log(`hub listening on ${host}:${actual} (tailnet-only)`);
          resolve({ host, port: actual });
        });
      });
    },
    close(): Promise<void> {
      return new Promise((resolve) => {
        for (const s of [...agentSockets.values(), ...serviceSockets.values()]) {
          try {
            s.close();
          } catch {
            /* best-effort */
          }
        }
        wss.close(() => httpServer.close(() => resolve()));
      });
    },
    registry,
    snapshot,
    sendLifecycleCommand,
    routeWorkflowAction,
    routeInstanceAction,
    requestClusterRead,
    routeClusterAction,
    requestTranscript,
  };
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 64 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function readBinaryBody(req: IncomingMessage, cap: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > cap) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
