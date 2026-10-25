// ARCO_OPS_PLAN.md §K2 — arco-management hub smoke.
//
// Wires a REAL K1 agent (scripts/agent/agent.ts) to a REAL hub
// (scripts/management/hub.ts) in-process — no VPS, no systemctl (the agent runs
// an injected fake runner). Asserts the spine end-to-end:
//
//   1. The agent connects + registers; the hub registry shows it ONLINE.
//   2. The hub SIGNS a lifecycle command and routes it; the agent verifies +
//      execs (fake runner captures argv) and the result returns by nonce.
//   3. Unknown instance → no-such-instance; closed socket → instance-offline.
//   4. The HTTP control API: GET /api/instances + POST .../lifecycle round-trip.
//   5. routeAction forwards to the owning socket (true) / unknown (false).
//   6. Registry online/stale/offline derivation (pure, injected clock).
//
// Run: npm run smoke:management-hub  (no dev server, no hub deploy)

import { step, assert, assertEq, summary } from './lib.js';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Local poll-until helper (the smoke lib has no waitFor).
async function until(pred: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}
import { generateHubKeypair } from '../agent/signing.js';
import { createAgentConnection } from '../agent/agent.js';
import { createHub } from '../management/hub.js';
import { InstanceRegistry } from '../management/registry.js';
import { parseManagementArgs, renderManagementUnit } from '../management/unit.js';
import type { CommandRunner } from '../agent/handle.js';
import type { ManagedArcoInstance } from '../../shared/src/protocol/remoteManagement.js';

const INSTANCE_ID = 'cccccccc-dddd-eeee-ffff-000000000000';

function recordingRunner(): { runner: CommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: CommandRunner = async (spec) => {
    calls.push([spec.cmd, ...spec.args]);
    return { exitCode: 0, stdout: 'ok', stderr: '' };
  };
  return { runner, calls };
}

function instanceDescriptor(): ManagedArcoInstance {
  return {
    instanceId: INSTANCE_ID,
    name: 'hub-smoke-box',
    platform: 'linux',
    hostname: 'smoke',
    version: '0.0.0',
    gitRevision: 'deadbee',
    serviceMode: 'systemd',
    capabilities: {
      workflows: true,
      requests: true,
      approvals: true,
      serviceRestart: true,
      diagnostics: true,
      resourceStats: true,
    },
    lastHeartbeatAt: 0,
  };
}

async function main() {
  const vaultRoot = mkdtempSync(path.join(tmpdir(), 'arco-management-vault-'));
  process.env.ARCO_CLUSTER_VAULT_DIR = vaultRoot;
  const { publicKey, privateKey } = generateHubKeypair();
  const { runner, calls } = recordingRunner();

  // Generous online window so the round-trips never race the heartbeat clock;
  // offline derivation is tested separately with the pure registry.
  const hub = createHub({
    privateKeyPem: privateKey,
    host: '127.0.0.1',
    port: 0,
    heartbeatIntervalMs: 5000,
    commandTimeoutMs: 3000,
  });
  const { host, port } = await hub.listen();
  const base = `http://${host}:${port}`;

  const agent = createAgentConnection({
    hubUrl: `ws://${host}:${port}/agent`,
    instance: instanceDescriptor(),
    publicKeyPem: publicKey,
    runner,
    heartbeatMs: 1000,
  });

  await step('agent connects + registers; hub shows it online', async () => {
    agent.start();
    await until(() => hub.registry.has(INSTANCE_ID), 3000);
    const snap = hub.snapshot();
    assertEq(snap.length, 1, 'one instance registered');
    assertEq(snap[0].instance.instanceId, INSTANCE_ID, 'right instance');
    assertEq(snap[0].state, 'online', 'derived online');
  });

  await step('hub signs + routes a lifecycle command; agent execs; result returns', async () => {
    const d = await hub.sendLifecycleCommand(INSTANCE_ID, 'arco.restart');
    assert(d.ok, `dispatch should succeed: ${JSON.stringify(d)}`);
    assert(d.result?.ok === true, 'agent reported ok');
    assertEq(d.result?.cmd, 'arco.restart', 'result carries the command');
    assert(
      calls.some((c) => c.join(' ') === 'systemctl --user restart arco.service'),
      `agent ran the allowlisted argv; calls=${JSON.stringify(calls)}`,
    );
  });

  await step('unknown instance → no-such-instance', async () => {
    const d = await hub.sendLifecycleCommand('nope-not-here', 'arco.status');
    assert(!d.ok, 'should fail');
    assertEq(d.error, 'no-such-instance', 'reason');
  });

  await step('HTTP control API: GET /api/instances + POST lifecycle', async () => {
    const list = await fetch(`${base}/api/instances`).then((r) => r.json());
    assertEq((list as { instances: unknown[] }).instances.length, 1, 'one instance over HTTP');

    const before = calls.length;
    const res = await fetch(`${base}/api/instances/${INSTANCE_ID}/lifecycle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cmd: 'arco.start' }),
    });
    assertEq(res.status, 200, 'POST ok');
    const body = (await res.json()) as { ok: boolean; result?: { cmd?: string } };
    assert(body.ok, 'dispatch ok over HTTP');
    assertEq(body.result?.cmd, 'arco.start', 'result cmd');
    assert(calls.length === before + 1, 'agent executed exactly one more command');
    assertEq(calls[calls.length - 1].join(' '), 'systemctl --user start arco.service', 'argv');
  });

  await step('HTTP cluster vault: duplicate rejected; id-pinned replacement updates one row', async () => {
    const upload = async (bytes: Buffer, replaceId?: string) => {
      const metadata = {
        name: 'Hub smoke snapshot',
        createdAt: new Date().toISOString(),
        memberCount: 2,
        sourceDevice: 'smoke',
        sourcePlatform: 'linux',
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
      return fetch(`${base}/api/cluster-vault`, {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-arco-vault-meta': Buffer.from(JSON.stringify(metadata)).toString('base64url'),
          ...(replaceId ? { 'x-arco-vault-replace-id': replaceId } : {}),
        },
        body: bytes,
      });
    };
    const firstBytes = Buffer.from('ARCOCV01 first opaque payload long enough');
    const first = await upload(firstBytes);
    assertEq(first.status, 201, 'first cloud save created');
    const firstRow = (await first.json()) as { snapshot: { id: string } };

    const rejected = await upload(Buffer.from('ARCOCV01 duplicate opaque payload long enough'));
    assertEq(rejected.status, 400, 'unconfirmed duplicate rejected by hub');

    const replacement = Buffer.from('ARCOCV01 replacement opaque payload long enough');
    const replaced = await upload(replacement, firstRow.snapshot.id);
    assertEq(replaced.status, 201, 'confirmed replacement accepted');
    const replacedRow = (await replaced.json()) as { snapshot: { id: string } };
    assertEq(replacedRow.snapshot.id, firstRow.snapshot.id, 'cloud id remains stable');

    const list = await fetch(`${base}/api/cluster-vault`).then((r) => r.json()) as { snapshots: unknown[] };
    assertEq(list.snapshots.length, 1, 'one same-name cloud row remains');
    const downloaded = Buffer.from(await fetch(`${base}/api/cluster-vault/${firstRow.snapshot.id}`).then((r) => r.arrayBuffer()));
    assert(downloaded.equals(replacement), 'download returns replacement bytes');
  });

  await step('routeWorkflowAction with no service socket → unsupported', async () => {
    // This instance registered only as an agent (lifecycle), not a service —
    // so there is no workflow channel and a workflow action can't be routed.
    const r = await hub.routeWorkflowAction(INSTANCE_ID, { type: 'stop', workflowId: 'wf1' });
    assert(!r.ok, 'should fail without a service connection');
    assertEq(r.error, 'unsupported', 'reason');
  });

  await step('closed socket → instance-offline', async () => {
    agent.stop();
    // Give the close event a beat to propagate to the hub's socket map.
    await new Promise((r) => setTimeout(r, 300));
    const d = await hub.sendLifecycleCommand(INSTANCE_ID, 'arco.status');
    assert(!d.ok, 'should fail with no live socket');
    assertEq(d.error, 'instance-offline', 'reason');
  });

  await step('registry derives online/stale/offline by heartbeat age', async () => {
    const reg = new InstanceRegistry({ heartbeatIntervalMs: 1000 });
    const t0 = 1_000_000;
    reg.register(instanceDescriptor(), t0);
    assertEq(reg.deriveState(t0, t0), 'online', 'fresh = online');
    assertEq(reg.deriveState(t0, t0 + 2500), 'stale', '2.5x interval = stale');
    assertEq(reg.deriveState(t0, t0 + 10_000), 'offline', '10x interval = offline');
    // offline never deletes the entry.
    assert(reg.has(INSTANCE_ID), 'offline keeps the entry (last-seen)');
  });

  await step('server-rendered console (K3) serves HTML/CSS/JS', async () => {
    const html = await fetch(`${base}/`);
    assertEq(html.status, 200, 'GET / ok');
    assert((html.headers.get('content-type') || '').includes('text/html'), 'html content-type');
    const htmlBody = await html.text();
    assert(htmlBody.includes('Arco'), 'title present');
    assert(htmlBody.includes('/console.css') && htmlBody.includes('/console.js'), 'links assets');

    const css = await fetch(`${base}/console.css`);
    assert((css.headers.get('content-type') || '').includes('text/css'), 'css content-type');
    const cssBody = await css.text();
    assert(cssBody.includes('#4af066'), 'lifts the Arco phosphor-green token');

    const js = await fetch(`${base}/console.js`);
    assert((js.headers.get('content-type') || '').includes('javascript'), 'js content-type');
    const jsBody = await js.text();
    assert(jsBody.includes('/api/instances') && jsBody.includes('arco.restart'), 'js drives the control API');

    const manifest = await fetch(`${base}/manifest.webmanifest`);
    assert((manifest.headers.get('content-type') || '').includes('manifest'), 'manifest content-type');
    const mBody = (await manifest.json()) as { display?: string; icons?: unknown[] };
    assertEq(mBody.display, 'standalone', 'PWA standalone display');
    assert(Array.isArray(mBody.icons) && mBody.icons.length > 0, 'manifest has an icon');
    assert(htmlBody.includes('rel="manifest"'), 'html links the manifest');

    const icon = await fetch(`${base}/icon.svg`);
    assert((icon.headers.get('content-type') || '').includes('svg'), 'icon is svg');

    const missing = await fetch(`${base}/nope`);
    assertEq(missing.status, 404, 'unknown path 404s');
  });

  await step('hub unit renders tailnet-bound + args parse', async () => {
    const unit = renderManagementUnit({
      repoRoot: '/srv/arco',
      host: '100.64.0.20',
      port: 3500,
      privateKeyPath: '/root/.arco/hub/hub.key',
    });
    assert(unit.includes('Description=arco-management'), 'description');
    assert(unit.includes('serve --host 100.64.0.20 --port 3500'), 'binds the tailnet ip:port');
    assert(unit.includes('Environment=ARCO_HUB_KEY=/root/.arco/hub/hub.key'), 'private key env');
    assert(unit.includes('Restart=always'), 'service restarts always');

    const a = parseManagementArgs(['serve', '--host', '100.64.0.20', '--port', '3500']);
    assertEq(a.command, 'serve', 'parsed command');
    assertEq(a.host, '100.64.0.20', 'parsed host');
    assertEq(a.port, 3500, 'parsed port');
  });

  await hub.close();
  rmSync(vaultRoot, { recursive: true, force: true });
  delete process.env.ARCO_CLUSTER_VAULT_DIR;
  summary('K2 arco-management hub');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
