// Singleton for the Archon-driven Antigravity desktop instance.
//
// Archon talks to Antigravity through its local language-server RPC (see
// antigravityRpc.ts). The desktop binary still needs to be running for that
// RPC endpoint to exist — this module:
//   - probes whether the desktop process is up by checking the localhost
//     debug-port for liveness (used as a cheap process-detection signal, not
//     as a transport),
//   - lazily spawns the desktop binary if not running (detached, no lifecycle
//     watchdog),
//   - exposes a tiny diagnostics() surface for the CONFIG tab.
//
// All composer-injection / DOM-scraping / lock semantics from the legacy CDP
// path are gone. RPC handles every primary and reviewer turn unconditionally.

import { spawn, type ChildProcess } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';
import { existsSync } from 'fs';
import {
  ANTIGRAVITY_CAPABILITIES,
  configuredAntigravityModelDisplayName,
  configuredAntigravityModelId,
  type AntigravityCapabilities,
} from './antigravityCapabilities.js';
import { archonHome } from '../archonHome.js';

const DEFAULT_PORT = 9222;
const DEFAULT_BINARY = process.env.ANTIGRAVITY_BINARY ?? '/opt/antigravity/antigravity';
const DEFAULT_USER_DATA = join(archonHome(), 'antigravity-data');
const DEFAULT_WORKSPACE = expandHome(process.env.ANTIGRAVITY_WORKSPACE?.trim() || join(homedir(), 'Projects'));
const SPAWN_WAIT_MS = 15_000;
const PROBE_INTERVAL_MS = 500;

function parsePort(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : fallback;
}

function envFlag(name: string): boolean {
  const raw = process.env[name];
  if (!raw) return false;
  return raw === '1' || raw.toLowerCase() === 'true' || raw.toLowerCase() === 'yes';
}

function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

function configuredUserDataDir(): string | null {
  if (envFlag('ANTIGRAVITY_USE_DEFAULT_PROFILE')) return null;
  const raw = process.env.ANTIGRAVITY_USER_DATA_DIR;
  if (!raw) return DEFAULT_USER_DATA;
  const normalized = raw.trim();
  if (!normalized) return DEFAULT_USER_DATA;
  const lower = normalized.toLowerCase();
  if (lower === 'default' || lower === 'none') return null;
  return expandHome(normalized);
}

// Minimal localhost liveness probe. The Antigravity desktop binary opens an
// HTTP debug endpoint on a configurable port; hitting `/json/version` tells us
// the process is alive and the language-server bridge is reachable. We do NOT
// use this connection for any transport — it's a one-shot "is the app
// running?" check.
export interface AntigravityProcessProbe {
  reachable: boolean;
  browser?: string;
  error?: string;
}

async function probeProcess(host: string, port: number): Promise<AntigravityProcessProbe> {
  try {
    const res = await fetch(`http://${host}:${port}/json/version`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return { reachable: false, error: `HTTP ${res.status}` };
    const data = (await res.json()) as { Browser?: string };
    return { reachable: true, browser: data.Browser };
  } catch (err) {
    return { reachable: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface AntigravityDiagnostics {
  available: boolean;
  installed: boolean;
  cdpPort: number;
  cdp: AntigravityProcessProbe;
  profileMode: 'default' | 'isolated' | 'custom';
  userDataDir?: string;
  workspace: string;
  reason?: string;
  // Phase A — static capability surface, plus the configured RPC model id so
  // the CONFIG/auth UI can show what the provider is set to dispatch.
  capabilities: AntigravityCapabilities;
  configuredModelId: string;
  configuredModelDisplayName?: string;
  // Ground-truth label/enum resolved from Antigravity's live GetAvailableModels
  // catalog (only when reachable; cached). Distinct from the hardcoded
  // configuredModelDisplayName fallback.
  catalogModelDisplayName?: string;
  catalogModelEnum?: string;
  // Step-trace env flags, surfaced so the operator can see tracing is on.
  traceEnabled: boolean;
  rawTraceEnabled: boolean;
}

export class AntigravityManager {
  private port = parsePort(process.env.ANTIGRAVITY_CDP_PORT, DEFAULT_PORT);
  private userDataDir = configuredUserDataDir();
  private child: ChildProcess | null = null;
  private childIsOurs = false;

  installed(): boolean {
    return existsSync(DEFAULT_BINARY);
  }

  async diagnostics(): Promise<AntigravityDiagnostics> {
    const cdp = await probeProcess('localhost', this.port);
    const installed = this.installed();
    const profileMode = this.userDataDir
      ? (this.userDataDir === DEFAULT_USER_DATA ? 'isolated' : 'custom')
      : 'default';
    const base = {
      installed,
      cdpPort: this.port,
      cdp,
      profileMode,
      ...(this.userDataDir ? { userDataDir: this.userDataDir } : {}),
      workspace: DEFAULT_WORKSPACE,
      capabilities: ANTIGRAVITY_CAPABILITIES,
      configuredModelId: configuredAntigravityModelId(),
      ...(configuredAntigravityModelDisplayName() ? { configuredModelDisplayName: configuredAntigravityModelDisplayName() } : {}),
      traceEnabled: process.env.ANTIGRAVITY_RPC_TRACE_STEPS === '1',
      rawTraceEnabled: process.env.ANTIGRAVITY_RPC_TRACE_RAW === '1',
    } satisfies Omit<AntigravityDiagnostics, 'available' | 'reason' | 'catalogModelDisplayName' | 'catalogModelEnum'>;
    if (!installed) {
      return { ...base, available: false, installed: false, reason: `binary not found at ${DEFAULT_BINARY}` };
    }
    if (!cdp.reachable) {
      return { ...base, available: false, installed: true, reason: `Antigravity desktop not reachable on :${this.port}` };
    }
    // Reachable — resolve the ground-truth model label/enum from the live
    // catalog (cached). Safe here because the desktop is up, so the resolver's
    // ensureRunning() is a no-op probe rather than a spawn.
    const { cachedConfiguredModelCatalog } = await import('./antigravityRpc.js');
    const catalog = await cachedConfiguredModelCatalog();
    return {
      ...base,
      available: true,
      installed: true,
      ...(catalog.displayName ? { catalogModelDisplayName: catalog.displayName } : {}),
      ...(catalog.modelEnum ? { catalogModelEnum: catalog.modelEnum } : {}),
    };
  }

  async ensureRunning(): Promise<void> {
    const initial = await probeProcess('localhost', this.port);
    if (initial.reachable) return;
    if (!this.installed()) {
      throw new Error(`Antigravity binary not found at ${DEFAULT_BINARY}. Install Antigravity or set ANTIGRAVITY_BINARY in the environment.`);
    }
    // Spawn detached so the child survives if the Archon server dies.
    const args = [
      ...(this.userDataDir ? [`--user-data-dir=${this.userDataDir}`] : []),
      `--remote-debugging-port=${this.port}`,
      DEFAULT_WORKSPACE,
    ];
    this.child = spawn(DEFAULT_BINARY, args, {
      detached: true,
      stdio: 'ignore',
    });
    this.child.unref();
    this.childIsOurs = true;

    const deadline = Date.now() + SPAWN_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, PROBE_INTERVAL_MS));
      const probe = await probeProcess('localhost', this.port);
      if (probe.reachable) return;
    }
    throw new Error(`Antigravity spawn timed out after ${SPAWN_WAIT_MS}ms — desktop process still unreachable on :${this.port}.`);
  }

  // For server shutdown hygiene — but only kill what we spawned. If the
  // operator launched Antigravity manually, leave it alone.
  shutdown(): void {
    if (this.child && this.childIsOurs && !this.child.killed) {
      try {
        if (this.child.pid) process.kill(-this.child.pid, 'SIGTERM');
      } catch { /* already dead */ }
    }
    this.child = null;
    this.childIsOurs = false;
  }
}

// Server-wide singleton. Constructed on import; survives the life of the
// Archon server process.
export const antigravityManager = new AntigravityManager();
