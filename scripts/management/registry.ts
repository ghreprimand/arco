// archon-management §3/§4 — the instance registry.
//
// Tracks every registered Archon instance + its last heartbeat/rollup, and
// derives online/stale/offline from heartbeat recency. PURE of I/O (no sockets,
// no timers) so the smoke can assert state transitions with an injected clock;
// the hub (hub.ts) owns the sockets and feeds this.
//
// online : now - lastHeartbeat <  2 × interval
// stale  : within an additional grace window (≤ 4 × interval)
// offline: older than that — NEVER deleted (we keep last-seen so the operator
//          knows which machine is asleep).

import type {
  ClusterSummary,
  InstanceRollup,
  ManagedArchonInstance,
  WorkflowSummary,
} from '../../shared/src/protocol/remoteManagement.js';

export type InstanceLiveState = 'online' | 'stale' | 'offline';

export interface RegistryEntry {
  instance: ManagedArchonInstance;
  lastHeartbeatAt: number;
  rollup?: InstanceRollup;
  workflows?: WorkflowSummary[]; // pushed by the service connection (workflow layer)
  clusters?: ClusterSummary[]; // R3 — remote-enabled clusters (same push cadence)
}

export interface RegistrySnapshotEntry extends RegistryEntry {
  state: InstanceLiveState;
}

export interface RegistryOptions {
  heartbeatIntervalMs?: number; // expected agent cadence (default 15s)
}

const DEFAULT_INTERVAL_MS = 15_000;

export class InstanceRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly intervalMs: number;

  constructor(opts: RegistryOptions = {}) {
    this.intervalMs = opts.heartbeatIntervalMs ?? DEFAULT_INTERVAL_MS;
  }

  // Register (or re-register) an instance. Re-registration after a reconnect
  // refreshes the descriptor and stamps the heartbeat; never duplicates.
  register(instance: ManagedArchonInstance, now: number): void {
    const existing = this.entries.get(instance.instanceId);
    this.entries.set(instance.instanceId, {
      instance: { ...instance, lastHeartbeatAt: now },
      lastHeartbeatAt: now,
      ...(existing?.rollup ? { rollup: existing.rollup } : {}),
      ...(existing?.workflows ? { workflows: existing.workflows } : {}),
      ...(existing?.clusters ? { clusters: existing.clusters } : {}),
    });
  }

  // The service connection (workflow layer) pushes the current workflow set.
  // Also refreshes the heartbeat — a workflow push proves the service is live.
  setWorkflows(instanceId: string, workflows: WorkflowSummary[], now: number): boolean {
    const entry = this.entries.get(instanceId);
    if (!entry) return false;
    entry.workflows = workflows;
    entry.lastHeartbeatAt = now;
    entry.instance.lastHeartbeatAt = now;
    return true;
  }

  // R3 — the service pushes its remote-enabled clusters alongside workflows.
  setClusters(instanceId: string, clusters: ClusterSummary[], now: number): boolean {
    const entry = this.entries.get(instanceId);
    if (!entry) return false;
    entry.clusters = clusters;
    entry.lastHeartbeatAt = now;
    entry.instance.lastHeartbeatAt = now;
    return true;
  }

  heartbeat(instanceId: string, now: number, rollup?: InstanceRollup): boolean {
    const entry = this.entries.get(instanceId);
    if (!entry) return false; // heartbeat before register — ignored
    entry.lastHeartbeatAt = now;
    entry.instance.lastHeartbeatAt = now;
    if (rollup) entry.rollup = rollup;
    return true;
  }

  get(instanceId: string): RegistryEntry | undefined {
    return this.entries.get(instanceId);
  }

  has(instanceId: string): boolean {
    return this.entries.has(instanceId);
  }

  // Explicit removal (e.g. operator detaches an instance). Distinct from
  // offline — offline keeps the entry; remove drops it entirely.
  remove(instanceId: string): boolean {
    return this.entries.delete(instanceId);
  }

  deriveState(lastHeartbeatAt: number, now: number): InstanceLiveState {
    const age = now - lastHeartbeatAt;
    if (age < 2 * this.intervalMs) return 'online';
    if (age <= 4 * this.intervalMs) return 'stale';
    return 'offline';
  }

  // Console-facing snapshot: every known instance with its derived live state.
  snapshot(now: number): RegistrySnapshotEntry[] {
    return [...this.entries.values()]
      .map((e) => ({ ...e, state: this.deriveState(e.lastHeartbeatAt, now) }))
      .sort((a, b) => a.instance.name.localeCompare(b.instance.name));
  }

  size(): number {
    return this.entries.size;
  }
}
