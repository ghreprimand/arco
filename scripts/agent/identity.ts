// arco-agent §13.4 — instance identity + descriptor assembly.
//
// instanceId is a persisted UUID at ~/.arco/instance-id so a hostname/friendly
// rename never orphans history. The friendly name (operator-assigned) is read
// from ~/.arco/instance-name (or ARCO_INSTANCE_NAME), falling back to the
// hostname. Capabilities reflect that this is the AGENT host — it can restart
// the service; the workflow/approval capabilities belong to the Arco process
// and are reported true here because the agent's presence is what makes remote
// lifecycle + (via the live Arco) workflow control reachable.

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir, hostname, platform as osPlatform } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import type {
  ManagedArcoInstance,
  Platform,
  ServiceMode,
} from '../../shared/src/protocol/remoteManagement.js';
import { arcoHome } from '../../server/src/arcoHome.js';

function arcoDir(): string {
  return arcoHome();
}
function instanceIdPath(): string {
  return process.env.ARCO_INSTANCE_ID_FILE || join(arcoDir(), 'instance-id');
}
function instanceNamePath(): string {
  return join(arcoDir(), 'instance-name');
}

export function detectPlatform(): Platform {
  switch (osPlatform()) {
    case 'linux':
      return 'linux';
    case 'darwin':
      return 'macos';
    case 'win32':
      return 'windows';
    default:
      return 'unknown';
  }
}

// systemd on Linux, launchd on macOS — what the agent would drive. 'manual' when
// we can't tell. This is the agent's view of how the LOCAL service is managed.
export function detectServiceMode(): ServiceMode {
  const p = detectPlatform();
  if (p === 'linux') return 'systemd';
  if (p === 'macos') return 'launchd';
  return 'manual';
}

// Load the persisted instance UUID, creating it on first run. Idempotent.
export function loadOrCreateInstanceId(): string {
  const path = instanceIdPath();
  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf8').trim();
    if (existing) return existing;
  }
  const id = randomUUID();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, id + '\n', 'utf8');
  return id;
}

export function loadFriendlyName(): string {
  if (process.env.ARCO_INSTANCE_NAME && process.env.ARCO_INSTANCE_NAME.trim()) {
    return process.env.ARCO_INSTANCE_NAME.trim();
  }
  const path = instanceNamePath();
  if (existsSync(path)) {
    const name = readFileSync(path, 'utf8').trim();
    if (name) return name;
  }
  return hostname();
}

function shortGitRevision(repoRoot: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
  } catch {
    return 'unknown';
  }
}

// Best-effort Tailscale identity (MagicDNS short name + tailnet IP). Never
// throws; absent when tailscale isn't installed/up. Used only for display.
export function detectTailscale(): { magicDns?: string; ip?: string } | undefined {
  try {
    const raw = execFileSync('tailscale', ['status', '--json'], {
      encoding: 'utf8',
      timeout: 2000,
    });
    const j = JSON.parse(raw) as {
      Self?: { DNSName?: string; TailscaleIPs?: string[] };
    };
    const dns = j.Self?.DNSName?.replace(/\.$/, '');
    const ip = j.Self?.TailscaleIPs?.[0];
    if (!dns && !ip) return undefined;
    return { ...(dns ? { magicDns: dns } : {}), ...(ip ? { ip } : {}) };
  } catch {
    return undefined;
  }
}

export interface BuildInstanceOptions {
  repoRoot: string;
  version: string;
  serviceRestart: boolean; // true once the agent unit is the supervisor path
}

export function buildInstanceDescriptor(opts: BuildInstanceOptions): ManagedArcoInstance {
  const tailscale = detectTailscale();
  return {
    instanceId: loadOrCreateInstanceId(),
    name: loadFriendlyName(),
    platform: detectPlatform(),
    hostname: hostname(),
    ...(tailscale ? { tailscale } : {}),
    version: opts.version,
    gitRevision: shortGitRevision(opts.repoRoot),
    serviceMode: detectServiceMode(),
    capabilities: {
      workflows: true,
      requests: true,
      approvals: true,
      serviceRestart: opts.serviceRestart,
      diagnostics: true,
      resourceStats: true,
    },
    lastHeartbeatAt: 0, // stamped by the hub on receipt
  };
}
