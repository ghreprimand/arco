// docs/ARCHITECTURE.md - arco-agent host-side smoke.
//
// Tests the security-load-bearing core directly (no hub, no systemctl), then a
// full register + signed-command round-trip against an in-process fake hub:
//
//   1. A valid signed command verifies, renders the allowlisted argv, and execs
//      via an injected runner (captures the exact argv — no systemctl).
//   2. Forged signature / stale / future / replayed nonce / wrong-instance /
//      non-allowlisted cmd / malformed envelope are ALL rejected with the right
//      reason and NEVER reach the runner.
//   3. The nonce store is single-use (a replay of a consumed nonce is rejected)
//      and prunes by TTL.
//   4. End-to-end: the agent connects to a fake ws hub, sends instance_register
//      then a heartbeat; the hub sends a signed lifecycle_command; the agent
//      execs (fake runner) and returns a lifecycle_result with ok:true.
//   5. Unit render + arg parse are well-formed.
//
// Run: npm run smoke:arco-agent  (no dev server, no hub, cross-platform)

import { step, assert, assertEq, summary } from './lib.js';
import { WebSocketServer } from 'ws';
import { generateHubKeypair, signCommand, newNonce } from '../agent/signing.js';
import {
  handleSignedCommand,
  NonceStore,
  type CommandRunner,
  type HandleContext,
  type RunnerOutput,
} from '../agent/handle.js';
import { createAgentConnection } from '../agent/agent.js';
import { renderLifecycleCommand } from '../agent/allowlist.js';
import { parseAgentArgs, renderAgentUnit } from '../agent/unit.js';
import type {
  LifecycleCommandPayload,
  ManagedArcoInstance,
} from '../../shared/src/protocol/remoteManagement.js';

const INSTANCE_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const FIXED_NOW = 1_900_000_000_000; // fixed clock for determinism

// A runner that records dispatched argv instead of spawning anything.
function recordingRunner(): { runner: CommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: CommandRunner = async (spec): Promise<RunnerOutput> => {
    calls.push([spec.cmd, ...spec.args]);
    return { exitCode: 0, stdout: 'ok', stderr: '' };
  };
  return { runner, calls };
}

function ctxFor(
  publicKeyPem: string,
  runner: CommandRunner,
  nonceStore: NonceStore,
  now = FIXED_NOW,
): HandleContext {
  return {
    publicKeyPem,
    instanceId: INSTANCE_ID,
    platform: 'linux', // assert on the Linux allowlist deterministically
    now: () => now,
    nonceStore,
    runner,
  };
}

function payload(over: Partial<LifecycleCommandPayload> = {}): LifecycleCommandPayload {
  return {
    cmd: 'arco.status',
    instanceId: INSTANCE_ID,
    nonce: newNonce(),
    issuedAt: FIXED_NOW,
    ...over,
  };
}

async function main() {
  const { publicKey, privateKey } = generateHubKeypair();

  // ── 1. valid command execs ──
  await step('valid signed command verifies → renders → execs', async () => {
    const { runner, calls } = recordingRunner();
    const store = new NonceStore();
    const signed = signCommand(privateKey, payload({ cmd: 'arco.restart' }));
    const res = await handleSignedCommand(signed, ctxFor(publicKey, runner, store));
    assert(res.ok, `expected ok, got ${JSON.stringify(res)}`);
    assert(res.executed, 'should be executed');
    assertEq(res.exitCode, 0, 'exit code 0');
    assertEq(calls.length, 1, 'runner called exactly once');
    assertEq(
      calls[0].join(' '),
      'systemctl --user restart arco.service',
      'dispatched the allowlisted restart argv',
    );
  });

  // ── 2. rejections never reach the runner ──
  await step('forged signature rejected (bad-signature)', async () => {
    const { runner, calls } = recordingRunner();
    const signed = signCommand(privateKey, payload());
    const forged = {
      payload: signed.payload,
      // Flip a LEADING data char — the trailing '=' padding decodes to identical
      // bytes, so corrupting it would NOT actually change the signature.
      signature: signed.signature.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')),
    };
    const res = await handleSignedCommand(forged, ctxFor(publicKey, runner, new NonceStore()));
    assertEq(res.rejectedReason, 'bad-signature', 'reason');
    assert(!res.executed, 'must not execute');
    assertEq(calls.length, 0, 'runner never called');
  });

  await step('stale command rejected', async () => {
    const { runner, calls } = recordingRunner();
    const signed = signCommand(privateKey, payload({ issuedAt: FIXED_NOW - 5 * 60_000 }));
    const res = await handleSignedCommand(signed, ctxFor(publicKey, runner, new NonceStore()));
    assertEq(res.rejectedReason, 'stale', 'reason');
    assertEq(calls.length, 0, 'runner never called');
  });

  await step('future-dated command rejected', async () => {
    const signed = signCommand(privateKey, payload({ issuedAt: FIXED_NOW + 5 * 60_000 }));
    const res = await handleSignedCommand(signed, ctxFor(publicKey, recordingRunner().runner, new NonceStore()));
    assertEq(res.rejectedReason, 'future', 'reason');
  });

  await step('wrong-instance command rejected', async () => {
    const signed = signCommand(privateKey, payload({ instanceId: 'some-other-box' }));
    const res = await handleSignedCommand(signed, ctxFor(publicKey, recordingRunner().runner, new NonceStore()));
    assertEq(res.rejectedReason, 'wrong-instance', 'reason');
  });

  await step('non-allowlisted command rejected', async () => {
    const { runner, calls } = recordingRunner();
    // Sign a payload with a bogus cmd (cast through unknown — a hostile hub).
    const bogus = { cmd: 'rm.rf.root', instanceId: INSTANCE_ID, nonce: newNonce(), issuedAt: FIXED_NOW };
    const signed = signCommand(privateKey, bogus as unknown as LifecycleCommandPayload);
    const res = await handleSignedCommand(signed, ctxFor(publicKey, runner, new NonceStore()));
    assertEq(res.rejectedReason, 'not-allowlisted', 'reason');
    assertEq(calls.length, 0, 'runner never called');
  });

  await step('malformed envelope rejected', async () => {
    const res = await handleSignedCommand({ nope: true }, ctxFor(publicKey, recordingRunner().runner, new NonceStore()));
    assertEq(res.rejectedReason, 'malformed', 'reason');
  });

  // ── 3. nonce single-use + prune ──
  await step('replayed nonce rejected after first use', async () => {
    const { runner, calls } = recordingRunner();
    const store = new NonceStore();
    const p = payload({ cmd: 'arco.start' });
    const signed = signCommand(privateKey, p);
    const first = await handleSignedCommand(signed, ctxFor(publicKey, runner, store));
    assert(first.ok, 'first use ok');
    const second = await handleSignedCommand(signed, ctxFor(publicKey, runner, store));
    assertEq(second.rejectedReason, 'replay', 'second use is replay');
    assertEq(calls.length, 1, 'runner called only once across the replay');
  });

  await step('nonce store prunes by TTL', async () => {
    const store = new NonceStore(1000); // 1s ttl
    store.record('n1', FIXED_NOW - 5000); // well past ttl
    store.record('n2', FIXED_NOW);
    store.prune(FIXED_NOW);
    assert(!store.has('n1'), 'old nonce pruned');
    assert(store.has('n2'), 'fresh nonce retained');
  });

  // ── 4. end-to-end against a fake hub ──
  await step('agent registers + executes a signed command from a fake hub', async () => {
    const { runner, calls } = recordingRunner();
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((res) => wss.on('listening', () => res()));
    const port = (wss.address() as { port: number }).port;

    const instance: ManagedArcoInstance = {
      instanceId: INSTANCE_ID,
      name: 'smoke-box',
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

    let registered = false;
    let result: { ok?: boolean; cmd?: string; exitCode?: number } | null = null;

    const done = new Promise<void>((resolveDone) => {
      wss.on('connection', (sock) => {
        sock.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'instance_register') {
            registered = true;
            assertEq(msg.instance.instanceId, INSTANCE_ID, 'registered the right instance');
            // Send a signed command back.
            const signed = signCommand(privateKey, payload({ cmd: 'arco.status' }));
            sock.send(JSON.stringify({ type: 'lifecycle_command', signed }));
          } else if (msg.type === 'lifecycle_result') {
            result = msg.result;
            resolveDone();
          }
        });
      });
    });

    const conn = createAgentConnection({
      hubUrl: `ws://127.0.0.1:${port}`,
      instance,
      publicKeyPem: publicKey,
      runner,
      now: () => FIXED_NOW,
      heartbeatMs: 1000,
    });
    conn.start();

    await done;
    conn.stop();
    await new Promise<void>((res) => wss.close(() => res()));

    assert(registered, 'agent registered with the hub');
    assert(result !== null && result!.ok === true, `result ok, got ${JSON.stringify(result)}`);
    assertEq(result!.cmd, 'arco.status', 'result carries the command');
    assertEq(calls.length, 1, 'command executed once');
    assertEq(calls[0].join(' '), 'systemctl --user status arco.service --no-pager', 'right argv');
  });

  // ── 5. unit + args ──
  await step('agent unit renders + args parse', async () => {
    const unit = renderAgentUnit({ repoRoot: '/srv/arco', hubUrl: 'ws://hub:3500', publicKeyPath: '/h/hub.pub' });
    assert(unit.includes('Description=arco-agent'), 'has description');
    assert(unit.includes('Restart=always'), 'supervisor restarts always');
    assert(unit.includes('Environment=ARCO_HUB_URL=ws://hub:3500'), 'bakes hub url');
    assert(unit.includes('arco-agent.ts run'), 'execs the run subcommand');

    const a = parseAgentArgs(['install', '--enable', '--hub', 'ws://x:1']);
    assertEq(a.command, 'install', 'parsed command');
    assert(a.enable, 'parsed --enable');
    assertEq(a.hubUrl, 'ws://x:1', 'parsed --hub');

    // Sanity: every Linux template is non-null.
    for (const cmd of ['arco.status', 'arco.start', 'arco.stop', 'arco.restart', 'arco.logs.tail', 'arco-agent.status', 'arco-agent.restart'] as const) {
      assert(renderLifecycleCommand(cmd, 'linux') !== null, `${cmd} has a linux template`);
    }
  });

  summary('K1 arco-agent');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
