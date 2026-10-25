// archon-agent §6 — handle a signed lifecycle command end-to-end:
//   verify (signature/freshness/replay/instance) → render allowlisted argv →
//   execute via an injectable runner → return a LifecycleResult.
//
// The runner is injected so the smoke can assert which argv was dispatched
// WITHOUT spawning systemctl (and so it runs on macOS too). archon-agent.ts
// supplies the real systemctl/journalctl runner.
//
// Import path for scripts/smoke: '../agent/handle.js'

import type {
  LifecycleResult,
  Platform,
  SignedLifecycleCommand,
} from '../../shared/src/protocol/remoteManagement.js';
import { verifyCommand } from './signing.js';
import { renderLifecycleCommand, type CommandSpec, type RenderOptions } from './allowlist.js';

export interface RunnerOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}
export type CommandRunner = (spec: CommandSpec) => Promise<RunnerOutput>;

// Single-use nonce store with TTL pruning. The window only needs to cover the
// freshness skew: a nonce older than (now - skew) can never pass freshness
// again, so it is safe to forget. In-memory is sufficient for K1 — a process
// restart also invalidates every in-flight nonce, which fails closed.
export class NonceStore {
  private readonly seen = new Map<string, number>(); // nonce -> issuedAt
  constructor(private readonly ttlMs: number = 120_000) {}

  has(nonce: string): boolean {
    return this.seen.has(nonce);
  }

  record(nonce: string, issuedAt: number): void {
    this.seen.set(nonce, issuedAt);
  }

  // Drop nonces whose issuedAt is older than now - ttl. Call opportunistically.
  prune(now: number): void {
    const floor = now - this.ttlMs;
    for (const [nonce, issuedAt] of this.seen) {
      if (issuedAt < floor) this.seen.delete(nonce);
    }
  }
}

export interface HandleContext {
  publicKeyPem: string;
  instanceId: string;
  platform: Platform;
  now: () => number; // injectable clock
  nonceStore: NonceStore;
  runner: CommandRunner;
  skewMs?: number;
  render?: RenderOptions; // platform render overrides (uid, units, log lines)
}

function rejection(
  signed: SignedLifecycleCommand | unknown,
  instanceId: string,
  reason: LifecycleResult['rejectedReason'],
): LifecycleResult {
  const payload =
    signed && typeof signed === 'object'
      ? (signed as SignedLifecycleCommand).payload
      : undefined;
  return {
    cmd: payload && typeof payload.cmd === 'string' ? (payload.cmd as LifecycleResult['cmd']) : null,
    instanceId: payload?.instanceId ?? instanceId,
    nonce: payload?.nonce ?? '',
    ok: false,
    executed: false,
    exitCode: -1,
    rejectedReason: reason,
  };
}

// Verify + (on success) execute. NEVER throws — a forged/stale/replayed/
// unsupported command yields a rejected LifecycleResult, an exec failure yields
// ok:false with the captured exit/stderr. The nonce is recorded only AFTER a
// clean verification (so a forged signature can't poison the replay set) and
// BEFORE exec (so a slow/duplicate command in flight cannot double-run).
export async function handleSignedCommand(
  signed: SignedLifecycleCommand | unknown,
  ctx: HandleContext,
): Promise<LifecycleResult> {
  const now = ctx.now();
  ctx.nonceStore.prune(now);

  const v = verifyCommand(signed, {
    publicKeyPem: ctx.publicKeyPem,
    expectInstanceId: ctx.instanceId,
    now,
    skewMs: ctx.skewMs,
    seenNonce: (nonce) => ctx.nonceStore.has(nonce),
  });
  if (!v.ok) return rejection(signed, ctx.instanceId, v.failure);

  const { payload } = signed as SignedLifecycleCommand;
  const spec = renderLifecycleCommand(payload.cmd, ctx.platform, ctx.render);
  if (!spec) {
    return rejection(signed, ctx.instanceId, 'unsupported-platform');
  }

  // Consume the nonce now: a verified command is committed, so any duplicate
  // (even one already executing) is rejected as replay rather than re-run.
  ctx.nonceStore.record(payload.nonce, payload.issuedAt);

  let out: RunnerOutput;
  try {
    out = await ctx.runner(spec);
  } catch (err) {
    return {
      cmd: payload.cmd,
      instanceId: payload.instanceId,
      nonce: payload.nonce,
      ok: false,
      executed: true,
      exitCode: 1,
      stderr: err instanceof Error ? err.message : String(err),
    };
  }

  return {
    cmd: payload.cmd,
    instanceId: payload.instanceId,
    nonce: payload.nonce,
    ok: out.exitCode === 0,
    executed: true,
    exitCode: out.exitCode,
    stdout: out.stdout,
    stderr: out.stderr,
  };
}
