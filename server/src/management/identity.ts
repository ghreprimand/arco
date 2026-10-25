// Workflow-reporting layer — instance descriptor for the live Archon SERVICE.
//
// Reuses the SAME identity files as the lifecycle agent (~/.archon/instance-id +
// ~/.archon/instance-name) so the service and the agent register under one
// instanceId and the hub merges them into a single card. Capabilities differ:
// the service reports workflows/requests/approvals (it is the live Archon);
// serviceRestart belongs to the agent, not here.

import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir, hostname, platform as osPlatform } from 'node:os';
import { join, dirname } from 'node:path';
import type { ManagedArchonInstance, Platform, ServiceMode } from '@archon/shared';

function archonDir(): string {
  return join(homedir(), '.archon');
}
function instanceIdPath(): string {
  return process.env.ARCHON_INSTANCE_ID_FILE || join(archonDir(), 'instance-id');
}

function detectPlatform(): Platform {
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

function loadOrCreateInstanceId(): string {
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
  if (process.env.ARCHON_INSTANCE_NAME && process.env.ARCHON_INSTANCE_NAME.trim()) {
    return process.env.ARCHON_INSTANCE_NAME.trim();
  }
  const path = join(archonDir(), 'instance-name');
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

function detectTailscale(): { magicDns?: string; ip?: string } | undefined {
  try {
    const raw = execFileSync('tailscale', ['status', '--json'], { encoding: 'utf8', timeout: 2000 });
    const j = JSON.parse(raw) as { Self?: { DNSName?: string; TailscaleIPs?: string[] } };
    const dns = j.Self?.DNSName?.replace(/\.$/, '');
    const ip = j.Self?.TailscaleIPs?.[0];
    if (!dns && !ip) return undefined;
    return { ...(dns ? { magicDns: dns } : {}), ...(ip ? { ip } : {}) };
  } catch {
    return undefined;
  }
}

export function buildServiceInstanceDescriptor(repoRoot: string, version: string): ManagedArchonInstance {
  const tailscale = detectTailscale();
  const serviceMode: ServiceMode = process.env.NODE_ENV === 'production' ? 'systemd' : 'dev';
  return {
    instanceId: loadOrCreateInstanceId(),
    name: loadFriendlyName(),
    platform: detectPlatform(),
    hostname: hostname(),
    ...(tailscale ? { tailscale } : {}),
    version,
    gitRevision: shortGitRevision(repoRoot),
    serviceMode,
    capabilities: {
      workflows: true,
      requests: true,
      approvals: true,
      serviceRestart: false, // the lifecycle agent owns restart, not the service
      diagnostics: true,
      resourceStats: true,
    },
    lastHeartbeatAt: 0,
  };
}
