// ARCHON_OPS_PLAN.md §K4 — Tailscale-SSH last-resort lifecycle smoke.
//
// Pure (no real ssh, no VPS): exercises the renderer + the hub's SSH fallback
// with an injected fake sshExec. Asserts:
//
//   1. renderSshLifecycle wraps the allowlist template into an ssh argv
//      (BatchMode, dest, `--`, then the EXACT remote argv); user@host; null for
//      an off-platform command.
//   2. parseSshTargets accepts valid entries, drops garbage / bad platform,
//      returns {} for non-JSON.
//   3. Hub SSH fallback: when the agent socket is ABSENT, a lifecycle command
//      runs over ssh (via:'ssh') with the right argv; resolves by instanceId
//      AND by friendly name; a non-zero ssh exit → ok:false + 'ssh-failed';
//      no target → 'instance-offline' (unchanged).
//
// Run: npm run smoke:ssh-lifecycle

import { step, assert, assertEq, summary } from './lib.js';
import { generateHubKeypair } from '../agent/signing.js';
import { createHub, type SshExec } from '../management/hub.js';
import { renderSshLifecycle, parseSshTargets } from '../management/sshLifecycle.js';
import type { CommandSpec } from '../agent/allowlist.js';
import type { ManagedArchonInstance } from '../../shared/src/protocol/remoteManagement.js';

const INSTANCE_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function descriptor(name = 'ssh-box'): ManagedArchonInstance {
  return {
    instanceId: INSTANCE_ID,
    name,
    platform: 'linux',
    hostname: 'sshbox',
    version: '0.0.0',
    serviceMode: 'systemd',
    capabilities: { workflows: true, requests: true, approvals: true, serviceRestart: true, diagnostics: true, resourceStats: true },
    lastHeartbeatAt: 0,
  };
}

function recordingSshExec(exitCode = 0): { exec: SshExec; calls: CommandSpec[] } {
  const calls: CommandSpec[] = [];
  const exec: SshExec = async (spec) => {
    calls.push(spec);
    return { exitCode, stdout: exitCode === 0 ? 'ok' : '', stderr: exitCode === 0 ? '' : 'boom' };
  };
  return { exec, calls };
}

async function main() {
  await step('renderSshLifecycle wraps the allowlist template into an ssh argv', () => {
    const spec = renderSshLifecycle({ host: 'workstation', platform: 'linux' }, 'archon.restart');
    assert(spec !== null, 'linux restart renders');
    assertEq(spec!.cmd, 'ssh', 'invokes ssh');
    const a = spec!.args;
    assert(a.includes('BatchMode=yes'), 'non-interactive');
    const sep = a.indexOf('--');
    assert(sep > 0, 'has a -- separator');
    assertEq(a[sep - 1], 'workstation', 'destination right before --');
    assertEq(a.slice(sep + 1).join(' '), 'systemctl --user restart archon.service', 'exact remote argv after --');
  });

  await step('renderSshLifecycle honors user@host + returns null off-platform', () => {
    const withUser = renderSshLifecycle({ host: 'mac', user: 'operator', platform: 'macos' }, 'archon.restart');
    assert(withUser !== null, 'macos restart renders');
    assert(withUser!.args.includes('operator@mac'), 'user@host destination');
    assertEq(withUser!.args.slice(withUser!.args.indexOf('--') + 1).join(' '), 'launchctl kickstart -k gui/0/com.archon.app', 'mac restart template');
    // agent self-restart is unsupported on macOS in v1 → null
    assertEq(renderSshLifecycle({ host: 'mac', platform: 'macos' }, 'archon-agent.restart'), null, 'off-platform → null');
  });

  await step('parseSshTargets accepts valid, drops garbage', () => {
    const raw = JSON.stringify({
      good: { host: 'workstation', platform: 'linux', user: 'operator' },
      badPlatform: { host: 'x', platform: 'beos' },
      noHost: { platform: 'linux' },
      macL: { host: 'mac', platform: 'macos', macLabel: 'com.example' },
    });
    const t = parseSshTargets(raw);
    assertEq(Object.keys(t).length, 2, 'only the two valid entries survive');
    assertEq(t.good.user, 'operator', 'user parsed');
    assertEq(t.macL.macLabel, 'com.example', 'override parsed');
    assertEq(Object.keys(parseSshTargets('not json{')).length, 0, 'non-json → empty map');
  });

  // ── Hub SSH fallback (no agent socket) ──
  const { privateKey } = generateHubKeypair();

  await step('hub falls back to ssh by instanceId when the agent is offline', async () => {
    const { exec, calls } = recordingSshExec(0);
    const hub = createHub({
      privateKeyPem: privateKey,
      port: 0,
      sshTargets: { [INSTANCE_ID]: { host: 'workstation', platform: 'linux' } },
      sshExec: exec,
    });
    hub.registry.register(descriptor(), Date.now());
    const d = await hub.sendLifecycleCommand(INSTANCE_ID, 'archon.restart');
    assert(d.ok, `ssh dispatch ok: ${JSON.stringify(d)}`);
    assertEq(d.via, 'ssh', 'reported via ssh');
    assertEq(d.result?.cmd, 'archon.restart', 'result carries cmd');
    assertEq(d.result?.executed, true, 'executed');
    assertEq(calls.length, 1, 'one ssh exec');
    assertEq(calls[0].cmd, 'ssh', 'spawned ssh');
    await hub.close();
  });

  await step('hub resolves the ssh target by friendly NAME too', async () => {
    const { exec, calls } = recordingSshExec(0);
    const hub = createHub({
      privateKeyPem: privateKey,
      port: 0,
      sshTargets: { workstation: { host: '100.64.0.10', platform: 'linux' } }, // keyed by name, not id
      sshExec: exec,
    });
    hub.registry.register(descriptor('workstation'), Date.now());
    const d = await hub.sendLifecycleCommand(INSTANCE_ID, 'archon.status');
    assert(d.ok && d.via === 'ssh', `resolved by name: ${JSON.stringify(d)}`);
    assert(calls[0].args.includes('100.64.0.10'), 'used the name-keyed target host');
    await hub.close();
  });

  await step('non-zero ssh exit → ok:false + ssh-failed', async () => {
    const { exec } = recordingSshExec(1);
    const hub = createHub({ privateKeyPem: privateKey, port: 0, sshTargets: { [INSTANCE_ID]: { host: 'h', platform: 'linux' } }, sshExec: exec });
    hub.registry.register(descriptor(), Date.now());
    const d = await hub.sendLifecycleCommand(INSTANCE_ID, 'archon.restart');
    assertEq(d.ok, false, 'failed');
    assertEq(d.error, 'ssh-failed', 'reason ssh-failed');
    assertEq(d.via, 'ssh', 'still via ssh');
    await hub.close();
  });

  await step('no ssh target → instance-offline (unchanged behavior)', async () => {
    const hub = createHub({ privateKeyPem: privateKey, port: 0 }); // no sshTargets
    hub.registry.register(descriptor(), Date.now());
    const d = await hub.sendLifecycleCommand(INSTANCE_ID, 'archon.restart');
    assert(!d.ok, 'fails');
    assertEq(d.error, 'instance-offline', 'offline when no agent + no ssh');
    assert(d.via === undefined, 'no via set');
    await hub.close();
  });

  summary('K4 ssh-lifecycle');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
