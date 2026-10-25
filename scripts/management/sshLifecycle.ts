// archon-management §K4 — Tailscale-SSH last-resort lifecycle path.
//
// PURE renderer: wraps the SAME allowlisted lifecycle template
// (scripts/agent/allowlist.ts) into an `ssh` argv for the rare case where BOTH
// Archon AND its agent are down on a host — the agent socket can't carry the
// command, so the hub reaches the box directly over Tailscale SSH and runs the
// identical systemctl/launchctl template. No shell strings: ssh receives the
// remote argv as separate args after `--` (no interpolation surface), the same
// discipline as the agent allowlist.
//
// TRUST: this path is NOT Ed25519-signed (there's no agent to verify it). It is
// authenticated at the NETWORK layer by Tailscale SSH + the operator's tailnet
// ACLs (hub-host → host, scoped). The remote command is always an allowlist
// template, never free-form — so even a compromised hub can only run the fixed
// lifecycle verbs on the box. Import path for smokes: '../management/sshLifecycle.js'.

import type { LifecycleCommand, Platform } from '../../shared/src/protocol/remoteManagement.js';
import { renderLifecycleCommand, type CommandSpec, type RenderOptions } from '../agent/allowlist.js';

export interface SshTarget {
  host: string;        // tailnet host/IP (e.g. "workstation" or its tailnet IP)
  platform: Platform;  // which allowlist template family to render
  user?: string;       // ssh user; omit to use ssh's default
  sshOpts?: string[];  // extra ssh flags (rare)
  // Unit/label overrides forwarded to the allowlist renderer.
  archonUnit?: string;
  agentUnit?: string;
  macLabel?: string;
  uid?: number;
  logLines?: number;
}

// Non-interactive by default: BatchMode fails fast instead of hanging on a
// password prompt; ConnectTimeout bounds an unreachable host; accept-new trusts
// a first-seen tailnet host key without a prompt (the tailnet is the trust
// boundary, not the host-key TOFU here).
const DEFAULT_SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=accept-new'];

export function renderSshLifecycle(target: SshTarget, command: LifecycleCommand): CommandSpec | null {
  const renderOpts: RenderOptions = {
    ...(target.archonUnit ? { archonUnit: target.archonUnit } : {}),
    ...(target.agentUnit ? { agentUnit: target.agentUnit } : {}),
    ...(target.macLabel ? { macLabel: target.macLabel } : {}),
    ...(target.uid !== undefined ? { uid: target.uid } : {}),
    ...(target.logLines !== undefined ? { logLines: target.logLines } : {}),
  };
  const remote = renderLifecycleCommand(command, target.platform, renderOpts);
  if (!remote) return null; // command unsupported on the platform
  const dest = target.user ? `${target.user}@${target.host}` : target.host;
  return {
    cmd: 'ssh',
    args: [...DEFAULT_SSH_OPTS, ...(target.sshOpts ?? []), dest, '--', remote.cmd, ...remote.args],
  };
}

// Load the operator's instance→target map. Keyed by instanceId OR friendly name
// (the hub tries both). Best-effort: a missing/garbage file or a malformed entry
// yields an empty map / drops the entry — never throws.
export function parseSshTargets(raw: string): Record<string, SshTarget> {
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return {};
    const out: Record<string, SshTarget> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const t = v as Partial<SshTarget>;
      if (t && typeof t.host === 'string' && t.host && (t.platform === 'linux' || t.platform === 'macos')) {
        out[k] = {
          host: t.host,
          platform: t.platform,
          ...(typeof t.user === 'string' ? { user: t.user } : {}),
          ...(Array.isArray(t.sshOpts) ? { sshOpts: t.sshOpts.filter((s): s is string => typeof s === 'string') } : {}),
          ...(typeof t.archonUnit === 'string' ? { archonUnit: t.archonUnit } : {}),
          ...(typeof t.agentUnit === 'string' ? { agentUnit: t.agentUnit } : {}),
          ...(typeof t.macLabel === 'string' ? { macLabel: t.macLabel } : {}),
          ...(typeof t.uid === 'number' ? { uid: t.uid } : {}),
          ...(typeof t.logLines === 'number' ? { logLines: t.logLines } : {}),
        };
      }
    }
    return out;
  } catch {
    return {};
  }
}
