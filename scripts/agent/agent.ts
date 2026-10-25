// archon-agent §4/§6 — the outbound hub connection: register, heartbeat, and
// dispatch inbound signed lifecycle commands.
//
// The connection is OUTBOUND from the agent to the hub (no inbound port on the
// workstation). On open it sends `instance_register`, then `instance_heartbeat`
// on a fixed interval; inbound `lifecycle_command` messages run through
// handleSignedCommand and the result is sent back as `lifecycle_result`.
//
// Everything testable is injected — the WebSocket factory, the runner, the
// clock, the rollup source — so the smoke drives a real register+command
// round-trip against an in-process fake hub WITHOUT systemctl or a real hub.
// The live hub it connects to is K2; this loop is wire-ready for it.

import WebSocket from 'ws';
import type {
  InstanceRollup,
  LifecycleCommandMessage,
  ManagedArchonInstance,
} from '../../shared/src/protocol/remoteManagement.js';
import {
  handleSignedCommand,
  NonceStore,
  type CommandRunner,
  type HandleContext,
} from './handle.js';
import type { RenderOptions } from './allowlist.js';

export interface AgentConnectionOptions {
  hubUrl: string;
  instance: ManagedArchonInstance;
  publicKeyPem: string;
  runner: CommandRunner;
  // Optional injections (defaults are production-sane).
  now?: () => number;
  rollup?: () => InstanceRollup;
  heartbeatMs?: number;
  reconnectMs?: number;
  skewMs?: number;
  render?: RenderOptions;
  nonceStore?: NonceStore;
  log?: (msg: string) => void;
  // Test seam: a custom socket factory (the smoke passes one that points at its
  // in-process server). Defaults to `new WebSocket(url)`.
  socketFactory?: (url: string) => WebSocket;
}

export interface AgentConnection {
  start(): void;
  stop(): void;
}

const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_RECONNECT_MS = 5_000;

export function createAgentConnection(opts: AgentConnectionOptions): AgentConnection {
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? (() => {});
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const reconnectMs = opts.reconnectMs ?? DEFAULT_RECONNECT_MS;
  const nonceStore = opts.nonceStore ?? new NonceStore();
  const makeSocket = opts.socketFactory ?? ((url: string) => new WebSocket(url));
  const defaultRollup = (): InstanceRollup => ({
    health: 'ok',
    activeWorkflows: 0,
    waitingRequests: 0,
  });
  const rollup = opts.rollup ?? defaultRollup;

  const ctx: HandleContext = {
    publicKeyPem: opts.publicKeyPem,
    instanceId: opts.instance.instanceId,
    platform: opts.instance.platform,
    now,
    nonceStore,
    runner: opts.runner,
    ...(opts.skewMs !== undefined ? { skewMs: opts.skewMs } : {}),
    ...(opts.render ? { render: opts.render } : {}),
  };

  let ws: WebSocket | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  function clearTimers(): void {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function send(obj: unknown): void {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  }

  function sendHeartbeat(): void {
    send({
      type: 'instance_heartbeat',
      instanceId: opts.instance.instanceId,
      at: now(),
      rollup: rollup(),
    });
  }

  async function onCommand(msg: LifecycleCommandMessage): Promise<void> {
    const result = await handleSignedCommand(msg.signed, ctx);
    send({ type: 'lifecycle_result', result });
    if (result.rejectedReason) {
      log(`rejected ${result.cmd ?? '?'}: ${result.rejectedReason}`);
    } else {
      log(`executed ${result.cmd} → exit ${result.exitCode}`);
    }
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
      log('hub connected — registering');
      send({ type: 'instance_register', instance: opts.instance });
      sendHeartbeat();
      heartbeatTimer = setInterval(sendHeartbeat, heartbeatMs);
    });

    socket.on('message', (data: WebSocket.RawData) => {
      let msg: { type?: string };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return; // ignore non-JSON
      }
      if (msg.type === 'lifecycle_command') {
        void onCommand(msg as LifecycleCommandMessage);
      }
    });

    socket.on('close', () => {
      log('hub disconnected');
      clearTimers();
      scheduleReconnect();
    });

    socket.on('error', (err: Error) => {
      log(`hub socket error: ${err.message}`);
      // 'close' fires after 'error'; reconnect is scheduled there.
    });
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
  };
}

// Production runner: spawn the allowlisted argv, capture stdout/stderr, never
// shell. Used by archon-agent.ts `run`. The smoke injects a fake runner instead.
export function systemctlRunner(): CommandRunner {
  // Lazy import keeps this module importable in tests without node:child_process
  // spawning anything.
  return async (spec) => {
    const { execFile } = await import('node:child_process');
    return await new Promise((resolve) => {
      execFile(
        spec.cmd,
        spec.args,
        { timeout: 30_000, maxBuffer: 1024 * 1024 },
        (err, stdout, stderr) => {
          const exitCode =
            err && typeof (err as NodeJS.ErrnoException & { code?: number }).code === 'number'
              ? ((err as unknown as { code: number }).code)
              : err
                ? 1
                : 0;
          resolve({ exitCode, stdout: String(stdout), stderr: String(stderr) });
        },
      );
    });
  };
}
